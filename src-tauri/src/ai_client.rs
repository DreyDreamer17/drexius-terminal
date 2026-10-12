//! AI HTTP relay.
//!
//! Provider API keys and proxy credentials live ONLY in the encrypted vault and in this
//! module's memory. The webview refers to a provider by `provider_id` and an [`AiAuth`] kind;
//! this module picks a key + proxy from the pool (round-robin / random / P2C), injects the
//! auth headers, retries on rate limits / proxy failures, and streams the response back as
//! [`AiStreamEvent`]s. The UI only ever sees masked values.

use crate::vault::{query_all_ai_configs, Vault};
use parking_lot::Mutex;
use rand::Rng;
use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};
use std::sync::{Arc, OnceLock};
use std::time::{Duration, Instant};
use tauri::State;
use tokio::sync::Notify;

/// Max idle time between two streamed chunks before the request is considered stalled.
const STREAM_IDLE_TIMEOUT: Duration = Duration::from_secs(90);
/// How long a rate-limited key / failing proxy is skipped by the balancer.
const COOLDOWN: Duration = Duration::from_secs(60);

// ───────────────────────── Stream cancellation ─────────────────────────

/// In-flight stream cancellation handles, keyed by the frontend-provided stream id.
fn cancels() -> &'static Mutex<HashMap<String, Arc<Notify>>> {
    static CANCELS: OnceLock<Mutex<HashMap<String, Arc<Notify>>>> = OnceLock::new();
    CANCELS.get_or_init(|| Mutex::new(HashMap::new()))
}

/// Removes the cancellation handle when the stream ends, however it ends.
struct CancelGuard(Option<String>);
impl Drop for CancelGuard {
    fn drop(&mut self) {
        if let Some(id) = &self.0 {
            cancels().lock().remove(id);
        }
    }
}

// ───────────────────────── Wire types ─────────────────────────

/// How the backend should authenticate the upstream request with a pooled key.
#[derive(Debug, Clone, Copy, Deserialize, Default, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum AiAuth {
    /// No key injection (e.g. local Ollama).
    #[default]
    None,
    /// `Authorization: Bearer <key>` (OpenAI-compatible).
    Bearer,
    /// `x-api-key: <key>` (Anthropic).
    Anthropic,
    /// Both `Authorization: Bearer` and `x-goog-api-key` (Gemini OpenAI-compat endpoint).
    Gemini,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AiProxyRequest {
    pub url: String,
    pub method: String,
    pub headers: HashMap<String, String>,
    pub body: Option<String>,
    /// Optional id so the frontend can cancel an in-flight stream via `ai_stream_cancel`.
    #[serde(default)]
    pub stream_id: Option<String>,
    /// Provider whose pooled keys/proxies should be used.
    #[serde(default)]
    pub provider_id: Option<String>,
    #[serde(default)]
    pub auth: AiAuth,
    /// Explicit proxy override (e.g. local SSH SOCKS5 tunnel).
    #[serde(default)]
    pub proxy_url: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AiProxyResponse {
    pub status: u16,
    pub body: String,
}

/// Events pushed to the frontend over the IPC channel while streaming.
#[derive(Debug, Serialize)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum AiStreamEvent {
    /// A chunk of the upstream response body.
    Data { text: String },
    /// Which (masked) key / proxy served this attempt.
    Meta {
        #[serde(rename = "keyMask")]
        key_mask: Option<String>,
        #[serde(rename = "proxyMask")]
        proxy_mask: Option<String>,
    },
    /// An attempt failed and the backend is rotating to another key/proxy.
    Failover { reason: String, next: String },
}

// ───────────────────────── Masking ─────────────────────────

pub fn mask_secret(key: &str) -> String {
    let t = key.trim();
    let chars: Vec<char> = t.chars().collect();
    let len = chars.len();
    if len == 0 {
        return String::new();
    }
    if len <= 8 {
        let tail: String = chars[len.saturating_sub(3)..].iter().collect();
        return format!("****{tail}");
    }
    let prefix: String = chars[..8.min(len / 3)].iter().collect();
    let suffix: String = chars[len - 4..].iter().collect();
    format!("{prefix}...{suffix}")
}

pub fn mask_proxy(proxy: &str) -> String {
    let t = proxy.trim();
    if let Ok(u) = reqwest::Url::parse(t) {
        if !u.username().is_empty() || u.password().is_some() {
            let host = u.host_str().unwrap_or("");
            let port = u.port().map(|p| format!(":{p}")).unwrap_or_default();
            let path = if u.path() == "/" { "" } else { u.path() };
            return format!("{}://***:***@{host}{port}{path}", u.scheme());
        }
        return t.to_string();
    }
    match (t.find("://"), t.find('@')) {
        (Some(sc), Some(at)) if at > sc => format!("{}://***:***@{}", &t[..sc], &t[at + 1..]),
        _ => t.to_string(),
    }
}

// ───────────────────────── Key / proxy pools ─────────────────────────

#[derive(Default)]
struct Stat {
    in_flight: u32,
    total: u64,
    cooldown_until: Option<Instant>,
}

#[derive(Default)]
struct Pools {
    keys: HashMap<String, Stat>,
    proxies: HashMap<String, Stat>,
    rr: HashMap<String, usize>,
}

fn pools() -> &'static Mutex<Pools> {
    static P: OnceLock<Mutex<Pools>> = OnceLock::new();
    P.get_or_init(|| Mutex::new(Pools::default()))
}

fn stat<'a>(p: &'a mut Pools, is_key: bool, item: &str) -> &'a mut Stat {
    let m = if is_key { &mut p.keys } else { &mut p.proxies };
    m.entry(item.to_string()).or_default()
}

fn cool(is_key: bool, item: &str) {
    let mut p = pools().lock();
    stat(&mut p, is_key, item).cooldown_until = Some(Instant::now() + COOLDOWN);
}

/// Pick one item according to `strategy`, skipping `tried` items and items on cooldown
/// (if everything is cooling down, the one that recovers first is used).
fn select(
    scope: &str,
    items: &[String],
    tried: &HashSet<String>,
    strategy: &str,
    is_key: bool,
) -> Option<String> {
    let cands: Vec<&String> = items.iter().filter(|i| !tried.contains(*i)).collect();
    if cands.is_empty() {
        return None;
    }
    if cands.len() == 1 {
        return Some(cands[0].clone());
    }

    let mut p = pools().lock();
    let now = Instant::now();
    let avail: Vec<&String> = cands
        .iter()
        .copied()
        .filter(|i| stat(&mut p, is_key, i).cooldown_until.map_or(true, |t| t <= now))
        .collect();

    if avail.is_empty() {
        let best = cands
            .iter()
            .copied()
            .min_by_key(|i| stat(&mut p, is_key, i).cooldown_until)
            .unwrap();
        return Some(best.clone());
    }
    if avail.len() == 1 {
        return Some(avail[0].clone());
    }

    match strategy {
        "round_robin" => {
            let k = format!("{}:{}", if is_key { 'k' } else { 'p' }, scope);
            let ptr = p.rr.entry(k).or_insert(0);
            let chosen = avail[*ptr % avail.len()].clone();
            *ptr = (*ptr + 1) % avail.len();
            Some(chosen)
        }
        "random" => {
            let i = rand::thread_rng().gen_range(0..avail.len());
            Some(avail[i].clone())
        }
        // Power of two random choices: compare two distinct candidates, take the less loaded.
        _ => {
            let mut rng = rand::thread_rng();
            let a = rng.gen_range(0..avail.len());
            let mut b = rng.gen_range(0..avail.len());
            if a == b {
                b = (a + 1) % avail.len();
            }
            let (ia, ib) = (avail[a].clone(), avail[b].clone());
            let score = |p: &mut Pools, i: &str| {
                let s = stat(p, is_key, i);
                s.in_flight as u64 * 100_000 + s.total
            };
            let (sa, sb) = (score(&mut p, &ia), score(&mut p, &ib));
            Some(if sa <= sb { ia } else { ib })
        }
    }
}

/// Tracks in-flight load for the selected key/proxy for the lifetime of an attempt/stream.
struct AttemptGuard {
    key: Option<String>,
    proxy: Option<String>,
}

impl AttemptGuard {
    fn new(key: Option<String>, proxy: Option<String>) -> Self {
        let mut p = pools().lock();
        if let Some(k) = &key {
            let s = stat(&mut p, true, k);
            s.in_flight += 1;
            s.total += 1;
        }
        if let Some(x) = &proxy {
            let s = stat(&mut p, false, x);
            s.in_flight += 1;
            s.total += 1;
        }
        Self { key, proxy }
    }
}

impl Drop for AttemptGuard {
    fn drop(&mut self) {
        let mut p = pools().lock();
        if let Some(k) = &self.key {
            let s = stat(&mut p, true, k);
            s.in_flight = s.in_flight.saturating_sub(1);
        }
        if let Some(x) = &self.proxy {
            let s = stat(&mut p, false, x);
            s.in_flight = s.in_flight.saturating_sub(1);
        }
    }
}

// ───────────────────────── Routing ─────────────────────────

struct Route {
    provider_id: String,
    name: String,
    keys: Vec<String>,
    proxies: Vec<String>,
    key_strategy: String,
    proxy_strategy: String,
    /// Whether to inject a pooled key into the upstream request.
    inject: bool,
}

fn is_auth_header(k: &str) -> bool {
    matches!(
        k.to_ascii_lowercase().as_str(),
        "authorization" | "x-api-key" | "x-goog-api-key"
    )
}

fn has_explicit_auth(h: &HashMap<String, String>) -> bool {
    h.iter().any(|(k, v)| is_auth_header(k) && !v.trim().is_empty())
}

fn is_loopback_socks5(url: &str) -> bool {
    if let Ok(u) = reqwest::Url::parse(url.trim()) {
        let scheme = u.scheme();
        let host = u.host_str().unwrap_or("");
        (scheme == "socks5" || scheme == "socks5h") && (host == "127.0.0.1" || host == "localhost")
    } else {
        false
    }
}

fn resolve_route(req: &AiProxyRequest, vault: &Vault) -> Result<Route, String> {
    let provider_id = req.provider_id.clone().unwrap_or_default();
    let mut route = Route {
        provider_id: provider_id.clone(),
        name: provider_id.clone(),
        keys: vec![],
        proxies: vec![],
        key_strategy: "p2c".into(),
        proxy_strategy: "p2c".into(),
        inject: false,
    };

    let cfg = if provider_id.is_empty() {
        None
    } else {
        vault
            .with(|c| {
                Ok(query_all_ai_configs(c)?
                    .into_iter()
                    .find(|x| x.provider_id == provider_id))
            })
            .map_err(|e| e.to_string())?
    };

    let wants_injection =
        !provider_id.is_empty() && req.auth != AiAuth::None && !has_explicit_auth(&req.headers);
    // Any credential-bearing request (pooled key or WebView-supplied header) must target the provider's endpoint.
    let carries_auth = wants_injection || has_explicit_auth(&req.headers);

    if let Some(cfg) = &cfg {
        route.name = cfg.name.clone();
        route.key_strategy = cfg.balance_strategy.clone();
        route.proxy_strategy = cfg.proxy_strategy.clone();
        if carries_auth {
            // Destination allowlist: pooled keys are only ever sent to the provider's own
            // configured endpoint, never to an arbitrary URL supplied by the webview.
            let origin = |u: &reqwest::Url| {
                (u.scheme().to_string(), u.host_str().map(str::to_ascii_lowercase), u.port_or_known_default())
            };
            let base = reqwest::Url::parse(cfg.base_url.trim())
                .map_err(|e| format!("Provider '{}' has an invalid base URL: {e}", cfg.name))?;
            let target = reqwest::Url::parse(&req.url).map_err(|e| format!("Invalid URL: {e}"))?;
            if origin(&base) != origin(&target) {
                return Err(format!(
                    "Blocked: API keys for {} can only be sent to its configured endpoint ({}).",
                    cfg.name,
                    base.host_str().unwrap_or("?")
                ));
            }
        }
        if wants_injection {
            let mut seen = HashSet::new();
            route.keys = cfg
                .api_keys
                .iter()
                .map(|k| k.trim().to_string())
                .filter(|k| !k.is_empty() && seen.insert(k.clone()))
                .collect();
        }
        if cfg.use_proxies {
            route.proxies = cfg
                .proxy_urls
                .iter()
                .map(|p| p.trim().to_string())
                .filter(|p| !p.is_empty())
                .collect();
        }
    }
    route.inject = wants_injection;

    // Allow an explicit local SSH SOCKS5 proxy override (e.g. from an active dynamic SSH port forward).
    // Restricted strictly to local loopback SOCKS5 to prevent key exfiltration to arbitrary external proxies.
    if let Some(proxy) = &req.proxy_url {
        let trimmed = proxy.trim();
        if is_loopback_socks5(trimmed) {
            route.proxies = vec![trimmed.to_string()];
            route.proxy_strategy = "first".into();
        }
    }

    if carries_auth && cfg.is_none() {
        return Err("Requests that carry credentials must name a configured provider.".into());
    }

    if route.inject && route.keys.is_empty() {
        return Err(format!(
            "No API keys configured for {}. Please add an API key in AI Settings.",
            route.name
        ));
    }
    Ok(route)
}

// ───────────────────────── HTTP plumbing ─────────────────────────

fn validate_request(request: &AiProxyRequest) -> Result<(), String> {
    let url = reqwest::Url::parse(&request.url).map_err(|e| format!("Invalid URL: {e}"))?;
    if url.scheme() != "http" && url.scheme() != "https" {
        return Err(format!(
            "Blocked URL scheme '{}': only http/https are allowed",
            url.scheme()
        ));
    }
    match request.method.to_uppercase().as_str() {
        "GET" | "POST" => Ok(()),
        m => Err(format!("Blocked HTTP method '{m}'")),
    }
}

/// `timeout_secs = None` means no total deadline (used for streaming, where a long
/// generation must not be cut off; stalls are caught by `STREAM_IDLE_TIMEOUT` instead).
fn build_client(proxy_url: Option<&str>, timeout_secs: Option<u64>) -> Result<reqwest::Client, String> {
    // Never follow redirects: a provider redirect could otherwise carry pooled keys to another host.
    let mut builder = reqwest::Client::builder()
        .connect_timeout(Duration::from_secs(20))
        .redirect(reqwest::redirect::Policy::none());
    if let Some(t) = timeout_secs {
        builder = builder.timeout(Duration::from_secs(t));
    }

    if let Some(proxy_str) = proxy_url {
        let trimmed = proxy_str.trim();
        if !trimmed.is_empty() {
            let proxy = reqwest::Proxy::all(trimmed)
                .map_err(|e| format!("Invalid proxy URL '{}': {}", mask_proxy(trimmed), e))?;
            builder = builder.proxy(proxy);
        }
    }

    builder.build().map_err(|e| e.to_string())
}

fn format_reqwest_error(e: reqwest::Error) -> String {
    let mut chain = String::new();
    let mut source = std::error::Error::source(&e);
    while let Some(s) = source {
        chain.push_str(&format!(" (caused by: {})", s));
        source = std::error::Error::source(s);
    }
    format!("AI connection failed: {}{}", e.without_url(), chain)
}

fn build_request(
    client: &reqwest::Client,
    req: &AiProxyRequest,
    inject_key: Option<&str>,
) -> reqwest::RequestBuilder {
    let mut rb = match req.method.to_uppercase().as_str() {
        "GET" => client.get(&req.url),
        _ => client.post(&req.url),
    };

    for (k, v) in &req.headers {
        // Drop empty auth headers always; drop non-empty ones when we inject our own.
        if is_auth_header(k) && (v.trim().is_empty() || inject_key.is_some()) {
            continue;
        }
        rb = rb.header(k, v);
    }

    if let Some(key) = inject_key {
        rb = match req.auth {
            AiAuth::Bearer => rb.header("Authorization", format!("Bearer {key}")),
            AiAuth::Anthropic => rb.header("x-api-key", key),
            AiAuth::Gemini => rb
                .header("Authorization", format!("Bearer {key}"))
                .header("x-goog-api-key", key),
            AiAuth::None => rb,
        };
    }

    if let Some(b) = &req.body {
        rb = rb.body(b.clone());
    }
    rb
}

/// Sends the request, rotating keys/proxies on HTTP 429 and proxy/network failures.
/// Returns `Ok(None)` if cancelled. A non-success final response is returned as-is so the
/// caller decides how to surface it.
async fn send_with_failover(
    req: &AiProxyRequest,
    route: &Route,
    timeout_secs: Option<u64>,
    cancel: Option<&Notify>,
    emit: &(dyn Fn(AiStreamEvent) + Send + Sync),
) -> Result<Option<(reqwest::Response, AttemptGuard)>, String> {
    let max_attempts = route.keys.len().min(3).max(route.proxies.len().min(3)).max(1);
    let mut tried_k: HashSet<String> = HashSet::new();
    let mut tried_p: HashSet<String> = HashSet::new();

    for attempt in 0..max_attempts {
        let last = attempt + 1 >= max_attempts;

        let key = select(&route.provider_id, &route.keys, &tried_k, &route.key_strategy, true)
            .or_else(|| route.keys.first().cloned());
        if let Some(k) = &key {
            tried_k.insert(k.clone());
        }
        // Never silently fall back to a direct connection when proxies are configured.
        let proxy = select(&route.provider_id, &route.proxies, &tried_p, &route.proxy_strategy, false)
            .or_else(|| {
                select(&route.provider_id, &route.proxies, &HashSet::new(), &route.proxy_strategy, false)
            });
        if let Some(p) = &proxy {
            tried_p.insert(p.clone());
        }

        let guard = AttemptGuard::new(key.clone(), proxy.clone());
        emit(AiStreamEvent::Meta {
            key_mask: key.as_deref().map(mask_secret),
            proxy_mask: proxy.as_deref().map(mask_proxy),
        });

        let more_keys = || route.keys.iter().find(|k| !tried_k.contains(*k)).cloned();
        let more_proxies = || {
            if route.proxies.len() > 1 {
                route.proxies.iter().find(|p| !tried_p.contains(*p)).cloned()
            } else {
                None
            }
        };

        let client = match build_client(proxy.as_deref(), timeout_secs) {
            Ok(c) => c,
            Err(e) => {
                if let Some(p) = &proxy {
                    cool(false, p);
                }
                if !last && more_proxies().is_some() {
                    continue;
                }
                return Err(e);
            }
        };

        let rb = build_request(&client, req, key.as_deref().filter(|_| route.inject));
        let sent = match cancel {
            Some(n) => tokio::select! {
                r = rb.send() => r,
                _ = n.notified() => return Ok(None),
            },
            None => rb.send().await,
        };

        match sent {
            Ok(resp) => {
                if resp.status().as_u16() == 429 {
                    if let Some(k) = &key {
                        cool(true, k);
                    }
                    if route.proxies.len() > 1 {
                        if let Some(p) = &proxy {
                            cool(false, p);
                        }
                    }
                    let (nk, np) = (more_keys(), more_proxies());
                    if !last && (nk.is_some() || np.is_some()) {
                        let key_mask = key.as_deref().map(mask_secret).unwrap_or_default();
                        let (reason, next) = match (&nk, &np) {
                            (Some(k), _) => (
                                format!("Rate limit hit on key {key_mask}. Rotating to next pooled key..."),
                                mask_secret(k),
                            ),
                            (None, Some(p)) => (
                                "Quota hit in current region. Rotating proxy...".to_string(),
                                mask_proxy(p),
                            ),
                            _ => unreachable!(),
                        };
                        emit(AiStreamEvent::Failover { reason, next });
                        continue;
                    }
                }
                return Ok(Some((resp, guard)));
            }
            Err(e) => {
                if let Some(p) = &proxy {
                    cool(false, p);
                }
                if !last {
                    if let Some(np) = more_proxies() {
                        let pm = proxy.as_deref().map(mask_proxy).unwrap_or_default();
                        emit(AiStreamEvent::Failover {
                            reason: format!("Proxy {pm} failed. Rotating to next proxy..."),
                            next: mask_proxy(&np),
                        });
                        continue;
                    }
                }
                return Err(format_reqwest_error(e));
            }
        }
    }
    Err("AI request failed".to_string())
}

// ───────────────────────── Commands ─────────────────────────

#[tauri::command]
pub async fn ai_stream_proxy(
    request: AiProxyRequest,
    channel: tauri::ipc::Channel<AiStreamEvent>,
    vault: State<'_, Vault>,
) -> Result<(), String> {
    validate_request(&request)?;
    let route = resolve_route(&request, &vault)?;

    let cancel = Arc::new(Notify::new());
    let _cancel_guard = CancelGuard(request.stream_id.clone());
    if let Some(id) = &request.stream_id {
        cancels().lock().insert(id.clone(), cancel.clone());
    }

    let emit = |ev: AiStreamEvent| {
        let _ = channel.send(ev);
    };
    let send_data = |text: String| -> Result<(), String> {
        channel
            .send(AiStreamEvent::Data { text })
            .map_err(|e| format!("Channel send error: {}", e))
    };

    let Some((mut resp, _attempt)) =
        send_with_failover(&request, &route, None, Some(cancel.as_ref()), &emit).await?
    else {
        return Ok(());
    };

    let status = resp.status();
    if !status.is_success() {
        let err_text = resp.text().await.unwrap_or_default();
        return Err(format!("HTTP {}: {}", status.as_u16(), err_text));
    }

    let mut byte_buf: Vec<u8> = Vec::with_capacity(16 * 1024);

    loop {
        let next = tokio::select! {
            r = tokio::time::timeout(STREAM_IDLE_TIMEOUT, resp.chunk()) => match r {
                Ok(inner) => inner.map_err(|e| format!("Stream read error: {}", e))?,
                Err(_) => return Err("Stream read error: timed out waiting for data".to_string()),
            },
            _ = cancel.notified() => return Ok(()),
        };
        let Some(chunk) = next else { break };
        byte_buf.extend_from_slice(&chunk);

        match std::str::from_utf8(&byte_buf) {
            Ok(valid_str) => {
                if !valid_str.is_empty() {
                    send_data(valid_str.to_string())?;
                }
                byte_buf.clear();
            }
            Err(err) => {
                let valid_up_to = err.valid_up_to();
                if valid_up_to > 0 {
                    let valid_str = String::from_utf8_lossy(&byte_buf[..valid_up_to]).to_string();
                    send_data(valid_str)?;
                    byte_buf.drain(..valid_up_to);
                }

                // If error_len is Some, there's truly invalid data, not just an incomplete sequence
                if let Some(err_len) = err.error_len() {
                    let lossy = String::from_utf8_lossy(&byte_buf[..err_len]).to_string();
                    send_data(lossy)?;
                    byte_buf.drain(..err_len);
                }
            }
        }
    }

    // Flush any trailing bytes
    if !byte_buf.is_empty() {
        send_data(String::from_utf8_lossy(&byte_buf).to_string())?;
    }

    Ok(())
}

/// Cancels an in-flight `ai_stream_proxy` call (no-op if it already finished).
#[tauri::command]
pub fn ai_stream_cancel(stream_id: String) {
    if let Some(n) = cancels().lock().get(&stream_id) {
        n.notify_one();
    }
}

#[tauri::command]
pub async fn ai_fetch_proxy(
    request: AiProxyRequest,
    vault: State<'_, Vault>,
) -> Result<AiProxyResponse, String> {
    validate_request(&request)?;
    let route = resolve_route(&request, &vault)?;

    let emit = |_ev: AiStreamEvent| {};
    let Some((resp, _attempt)) = send_with_failover(&request, &route, Some(20), None, &emit).await?
    else {
        return Err("Request cancelled".to_string());
    };

    let status = resp.status().as_u16();
    let body = resp.text().await.unwrap_or_default();

    Ok(AiProxyResponse { status, body })
}
