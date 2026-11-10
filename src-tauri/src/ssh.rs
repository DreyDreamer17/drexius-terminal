//! SSH session manager.
//!
//! Each interactive session runs on its own OS thread that owns a *non-blocking*
//! libssh2 channel and multiplexes:
//!   • PTY output   → `tauri::ipc::Channel<SshEvent>` (ordered, fast, per-session)
//!   • UI commands  ← `std::sync::mpsc` (write / resize / close)
//!   • keep-alives  → dropped-link detection (feeds session snapshot/resume)
//!
//! Secrets are pulled from the encrypted vault *inside Rust* — the WebView only
//! ever passes an opaque `host_id`.

use crate::error::{AppError, AppResult};
use crate::snapshot::SnapshotStore;
use crate::vault::{AuthMethod, HostProfile, HostSecret, Vault};
use base64::{engine::general_purpose::STANDARD as B64, Engine};
use parking_lot::Mutex;
use serde::{Deserialize, Serialize};
use ssh2::{Channel, ExtendedData, HashType, MethodType, Session};
use std::collections::HashMap;
use std::io::{ErrorKind, Read, Write};
use std::net::{TcpStream, ToSocketAddrs};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::{self, Receiver, SyncSender, TryRecvError};
use std::sync::Arc;
use std::thread;
use std::time::{Duration, Instant};
use tauri::{ipc::Channel as IpcChannel, AppHandle, Manager, State};

/// Maximum per-session scrollback retained in Rust memory (256 KiB) so a WebView
/// reload or Android Activity recreation can re-attach without losing output.
const MAX_SCROLLBACK_BYTES: usize = 256 * 1024;

// ─────────────────────────────────────────────────────────────────────────────
// Public types
// ─────────────────────────────────────────────────────────────────────────────

#[derive(Clone, Serialize)]
#[serde(tag = "event", content = "data", rename_all = "camelCase")]
pub enum SshEvent {
    #[serde(rename_all = "camelCase")]
    Connected { session_id: String, fingerprint: String, banner: Option<String>, os: Option<String> },
    /// Raw PTY bytes, base64 encoded (JSON-safe, binary-safe).
    Output { b64: String },
    /// Working directory parsed from OSC-7.
    Cwd { path: String },
    #[serde(rename_all = "camelCase")]
    Disconnected { reason: String, resumable: bool },
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConnectRequest {
    pub host_id: String,
    pub cols: u32,
    pub rows: u32,
    /// Restore the last snapshotted cwd after login.
    #[serde(default)]
    pub resume: bool,
    /// Initial working directory to start the session in.
    #[serde(default)]
    pub cwd: Option<String>,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct SessionInfo {
    pub session_id: String,
    pub host_id: String,
    pub started_at: i64,
}

enum Cmd {
    Write(Vec<u8>),
    Resize(u32, u32),
    ForceResize(u32, u32),
    Close,
}

struct SessionHandle {
    tx: SyncSender<Cmd>,
    info: SessionInfo,
    stop: Arc<AtomicBool>,
    events: Arc<Mutex<IpcChannel<SshEvent>>>,
    scrollback: Arc<Mutex<Vec<u8>>>,
    modes: Arc<Mutex<TerminalModeTracker>>,
    cwd: Arc<Mutex<String>>,
    fingerprint: String,
    banner: Option<String>,
    os: Option<String>,
    _bg_guard: BackgroundSessionGuard,
}

static ACTIVE_BG_SESSIONS: std::sync::atomic::AtomicUsize = std::sync::atomic::AtomicUsize::new(0);

#[cfg(target_os = "android")]
pub fn load_android_app_class<'a>(
    env: &mut jni::JNIEnv<'a>,
    app_ctx: &jni::objects::JObject<'a>,
    class_dot_name: &str,
) -> Option<jni::objects::JClass<'a>> {
    let class_loader = env
        .call_method(app_ctx, "getClassLoader", "()Ljava/lang/ClassLoader;", &[])
        .ok()?
        .l()
        .ok()?;
    let class_name = env.new_string(class_dot_name).ok()?;
    let cls_obj = env
        .call_method(
            &class_loader,
            "loadClass",
            "(Ljava/lang/String;)Ljava/lang/Class;",
            &[(&class_name).into()],
        )
        .ok()?
        .l()
        .ok()?;
    Some(jni::objects::JClass::from(cls_obj))
}

fn notify_android_session_count(count: usize) {
    #[cfg(target_os = "android")]
    {
        let ctx = ndk_context::android_context();
        if !ctx.vm().is_null() && !ctx.context().is_null() {
            if let Ok(vm) = unsafe { jni::JavaVM::from_raw(ctx.vm() as *mut jni::sys::JavaVM) } {
                if let Ok(mut env) = vm.attach_current_thread() {
                    let app_ctx = std::mem::ManuallyDrop::new(unsafe {
                        jni::objects::JObject::from_raw(ctx.context() as jni::sys::jobject)
                    });
                    if let Some(cls) = load_android_app_class(
                        &mut env,
                        &*app_ctx,
                        "dev.drexius.terminal.SessionForegroundService",
                    ) {
                        let _ = env.call_static_method(
                            &cls,
                            "updateActiveSessions",
                            "(Landroid/content/Context;I)V",
                            &[
                                (&*app_ctx).into(),
                                jni::objects::JValue::Int(count as i32),
                            ],
                        );
                    }
                    if env.exception_check().unwrap_or(false) {
                        let _ = env.exception_clear();
                    }
                }
            }
        }
    }
    #[cfg(not(target_os = "android"))]
    {
        let _ = count;
    }
}

/// RAII guard that keeps the Android Foreground Service, `PARTIAL_WAKE_LOCK`, and
/// `WifiLock` active while at least one SSH, SFTP, Local PTY, or Tunnel session is alive.
pub struct BackgroundSessionGuard(());

impl BackgroundSessionGuard {
    pub fn acquire() -> Self {
        let count = ACTIVE_BG_SESSIONS.fetch_add(1, Ordering::SeqCst) + 1;
        notify_android_session_count(count);
        Self(())
    }
}

impl Drop for BackgroundSessionGuard {
    fn drop(&mut self) {
        let prev = ACTIVE_BG_SESSIONS.fetch_sub(1, Ordering::SeqCst);
        let count = prev.saturating_sub(1);
        notify_android_session_count(count);
    }
}

#[derive(Default)]
pub struct SshManager {
    sessions: Mutex<HashMap<String, SessionHandle>>,
}

impl SshManager {
    pub fn host_of(&self, session_id: &str) -> AppResult<String> {
        self.sessions
            .lock()
            .get(session_id)
            .map(|h| h.info.host_id.clone())
            .ok_or_else(|| AppError::SessionNotFound(session_id.into()))
    }

    fn send(&self, session_id: &str, cmd: Cmd) -> AppResult<()> {
        let guard = self.sessions.lock();
        let h = guard
            .get(session_id)
            .ok_or_else(|| AppError::SessionNotFound(session_id.into()))?;
        h.tx.try_send(cmd).map_err(|e| match e {
            mpsc::TrySendError::Full(_) =>
                AppError::Other("terminal input queue is full; try again in a moment".into()),
            mpsc::TrySendError::Disconnected(_) =>
                AppError::SessionNotFound(session_id.into()),
        })
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// Connection helpers (shared with sftp.rs)
// ─────────────────────────────────────────────────────────────────────────────

const OS_MAP: &[(&str, &[&str])] = &[
    ("ubuntu", &["ubuntu"]),
    ("debian", &["debian", "raspbian"]),
    ("arch", &["arch", "manjaro", "endeavour"]),
    ("fedora", &["fedora"]),
    ("centos", &["centos", "rhel", "red hat"]),
    ("rocky", &["rocky", "alma"]),
    ("alpine", &["alpine"]),
    ("amazon", &["amazon"]),
    ("suse", &["opensuse", "suse"]),
    ("android", &["android", "termux"]),
    ("macos", &["darwin", "macos", "mac"]),
    ("windows", &["windows", "mingw", "msys", "cygwin"]),
    ("linux", &["linux", "gnu/linux"]),
];

/// Normalize a distro id (`/etc/os-release` ID= / banner token) to a short key
/// the frontend maps to an icon. Unknown → None (UI shows generic server).
fn normalize_os_id(id: &str) -> Option<String> {
    let s = id.trim().to_lowercase();
    for (key, tokens) in OS_MAP {
        for &tok in *tokens {
            // Short identifiers ("mac", "arch", "linux") require exact match or word-token match
            // to prevent false positives like "machine", "research", or "hierarchy".
            let matched = if tok == "mac" || tok == "arch" || tok == "linux" {
                s == tok || s.split(&[' ', '-', '_', '/', '.'][..]).any(|w| w == tok)
            } else {
                s.contains(tok) || s == tok
            };
            if matched {
                return Some((*key).to_string());
            }
        }
    }
    None
}

fn parse_os_release(text: &str) -> Option<String> {
    for line in text.lines() {
        let t = line.trim();
        if let Some(v) = t.strip_prefix("ID=") {
            let id = v.trim().trim_matches('"').trim_matches('\'');
            if let Some(k) = normalize_os_id(id) {
                return Some(k);
            }
        }
    }
    // Fallback: match full text (NAME=, PRETTY_NAME=, uname output).
    normalize_os_id(text)
}

fn parse_banner_os(banner: Option<&str>) -> Option<String> {
    let b = banner?;
    // Typical: "SSH-2.0-OpenSSH_9.6p1 Ubuntu-5ubuntu1" / "... Debian-2".
    normalize_os_id(b)
}

/// Best-effort remote OS detection on an already-authenticated (blocking) session.
/// Opens a short-lived exec channel: `cat /etc/os-release; uname -o; uname -s`.
/// Never fails the connection — returns None on any error/timeout.
fn detect_remote_os(sess: &Session, banner: Option<&str>) -> Option<String> {
    let mut ch = sess.channel_session().ok()?;
    // Short timeout so a hung exec doesn't stall connect.
    sess.set_timeout(4000);
    ch.exec("cat /etc/os-release 2>/dev/null; echo ---; uname -o 2>/dev/null; uname -s 2>/dev/null").ok()?;
    let mut out = String::new();
    let _ = (&mut ch).take(64 * 1024).read_to_string(&mut out);
    let _ = ch.wait_close();
    if let Some(os) = parse_os_release(&out) {
        return Some(os);
    }
    parse_banner_os(banner)
}

const MAX_JUMP_DEPTH: usize = 8;

/// Enable `TCP_NODELAY` and OS-level `SO_KEEPALIVE` (45s idle, 15s interval, 10 retries)
/// so the kernel TCP stack maintains NAT state and survives mobile radio transitions
/// without relying on libssh2's non-blocking user-space keepalive_send.
pub fn configure_tcp_stream(tcp: &TcpStream) -> std::io::Result<()> {
    tcp.set_nodelay(true)?;
    let sock = socket2::SockRef::from(tcp);
    let ka = socket2::TcpKeepalive::new()
        .with_time(Duration::from_secs(45))
        .with_interval(Duration::from_secs(15));
    #[cfg(any(
        target_os = "linux",
        target_os = "android",
        target_os = "macos",
        target_os = "ios",
        target_os = "freebsd"
    ))]
    let ka = ka.with_retries(10);
    let _ = sock.set_tcp_keepalive(&ka);
    Ok(())
}

/// TCP connect → handshake → host-key verification (TOFU) → authentication.
/// Returns a *blocking* authenticated session with transport compression enabled.
pub fn open_authenticated(
    host: &HostProfile,
    secret: &HostSecret,
    vault: &Vault,
) -> AppResult<(Session, String)> {
    open_authenticated_with_options(host, secret, vault, true)
}

/// Like [`open_authenticated`], but with transport-level `zlib` compression
/// disabled so bulk SFTP file transfers are not bottlenecked by single-core
/// CPU compression on already-compressed or high-bandwidth streams.
pub fn open_authenticated_uncompressed(
    host: &HostProfile,
    secret: &HostSecret,
    vault: &Vault,
) -> AppResult<(Session, String)> {
    open_authenticated_with_options(host, secret, vault, false)
}

pub fn open_authenticated_with_options(
    host: &HostProfile,
    secret: &HostSecret,
    vault: &Vault,
    compress: bool,
) -> AppResult<(Session, String)> {
    let mut visited = std::collections::HashSet::new();
    visited.insert(host.id.clone());
    open_authenticated_inner(host, secret, vault, &mut visited, 0, compress)
}

pub fn expand_proxy_command(template: &str, host: &str, port: u16, user: &str) -> String {
    let mut out = String::with_capacity(template.len());
    let mut chars = template.chars().peekable();

    // Safely quote host and user if they contain any characters outside [a-zA-Z0-9._-]
    // to prevent shell command injection via hostile hostname/username values.
    let safe_host = if host.chars().all(|c| c.is_ascii_alphanumeric() || c == '.' || c == '-' || c == '_') {
        host.to_string()
    } else {
        shell_quote(host)
    };

    let safe_user = if user.chars().all(|c| c.is_ascii_alphanumeric() || c == '.' || c == '-' || c == '_') {
        user.to_string()
    } else {
        shell_quote(user)
    };

    while let Some(c) = chars.next() {
        if c == '%' {
            match chars.next() {
                Some('h') => out.push_str(&safe_host),
                Some('p') => out.push_str(&port.to_string()),
                Some('r') => out.push_str(&safe_user),
                Some('%') => out.push('%'),
                Some(other) => {
                    out.push('%');
                    out.push(other);
                }
                None => out.push('%'),
            }
        } else {
            out.push(c);
        }
    }
    out
}

fn connect_proxy_command(
    cmd_template: &str,
    target_host: &str,
    target_port: u16,
    username: &str,
) -> AppResult<TcpStream> {
    let expanded = expand_proxy_command(cmd_template, target_host, target_port, username);

    let listener = std::net::TcpListener::bind("127.0.0.1:0")
        .map_err(|e| AppError::Network(format!("Failed to bind proxy listener: {e}")))?;
    let local_addr = listener.local_addr()?;

    std::thread::Builder::new()
        .name(format!("proxy-cmd-{}", &target_host[..8.min(target_host.len())]))
        .spawn(move || {
            let (client_stream, _) = match listener.accept() {
                Ok(x) => x,
                Err(_) => return,
            };
            let _ = client_stream.set_nodelay(true);

            #[cfg(not(target_os = "windows"))]
            let mut child = match std::process::Command::new("/bin/sh")
                .arg("-c")
                .arg(&expanded)
                .stdin(std::process::Stdio::piped())
                .stdout(std::process::Stdio::piped())
                .stderr(std::process::Stdio::inherit())
                .spawn()
            {
                Ok(c) => c,
                Err(_) => return,
            };

            #[cfg(target_os = "windows")]
            let mut child = match std::process::Command::new("cmd.exe")
                .arg("/c")
                .arg(&expanded)
                .stdin(std::process::Stdio::piped())
                .stdout(std::process::Stdio::piped())
                .stderr(std::process::Stdio::inherit())
                .spawn()
            {
                Ok(c) => c,
                Err(_) => return,
            };

            let mut child_in = match child.stdin.take() {
                Some(i) => i,
                None => return,
            };
            let mut child_out = match child.stdout.take() {
                Some(o) => o,
                None => return,
            };

            let mut stream_writer = match client_stream.try_clone() {
                Ok(w) => w,
                Err(_) => return,
            };
            let mut stream_reader = client_stream;

            let t1 = std::thread::spawn(move || {
                let _ = std::io::copy(&mut child_out, &mut stream_writer);
                let _ = stream_writer.shutdown(std::net::Shutdown::Write);
            });

            let t2 = std::thread::spawn(move || {
                let _ = std::io::copy(&mut stream_reader, &mut child_in);
            });

            let _ = t1.join();
            let _ = t2.join();
            let _ = child.kill();
            let _ = child.wait();
        })
        .map_err(AppError::Io)?;

    match TcpStream::connect_timeout(&local_addr, Duration::from_secs(10)) {
        Ok(s) => {
            configure_tcp_stream(&s)?;
            Ok(s)
        }
        Err(e) => {
            let _ = TcpStream::connect(local_addr);
            Err(AppError::Network(format!("Failed to connect to proxy process stream: {e}")))
        }
    }
}

fn open_authenticated_inner(
    host: &HostProfile,
    secret: &HostSecret,
    vault: &Vault,
    visited: &mut std::collections::HashSet<String>,
    depth: usize,
    compress: bool,
) -> AppResult<(Session, String)> {
    if depth >= MAX_JUMP_DEPTH {
        return Err(AppError::Other(format!(
            "Jump host recursion depth exceeded limit ({MAX_JUMP_DEPTH})"
        )));
    }

    let tcp = if let Some(trimmed_proxy) = host.proxy_command.as_deref().map(str::trim).filter(|s| !s.is_empty()) {
        connect_proxy_command(trimmed_proxy, &host.hostname, host.port, &host.username)?
    } else if let Some(trimmed_jump) = host.jump_host_id.as_deref().map(str::trim).filter(|s| !s.is_empty()) {
        if !visited.insert(trimmed_jump.to_string()) {
            return Err(AppError::Other(format!(
                "Jump host cycle detected involving host ID '{trimmed_jump}'"
            )));
        }
        // Retrieve Jump Host profile and secret
        let (jump_host, jump_secret) = vault.host_with_secret(trimmed_jump)?;
        // Authenticate jump session (handles nested jumps with cycle prevention)
        let (jump_sess, _) = open_authenticated_inner(&jump_host, &jump_secret, vault, visited, depth + 1, compress)?;

        // Bind ephemeral loopback listener
        let listener = std::net::TcpListener::bind("127.0.0.1:0")
            .map_err(|e| AppError::Network(format!("Failed to bind jump proxy listener: {e}")))?;
        let local_addr = listener.local_addr()?;
        let target_host = host.hostname.clone();
        let target_port = host.port;
        let jump_sess_clone = jump_sess.clone();

        // Proxy thread: opens ONE direct-tcpip channel to the target and relays
        // it to the loopback client on a SINGLE thread with a NON-BLOCKING
        // session. The previous design ran two relay threads sharing one
        // blocking session: ssh2 serializes session access through an internal
        // mutex, so a blocking read held it while the other direction waited to
        // write — stalling the tunnel.
        std::thread::Builder::new()
            .name(format!("jump-proxy-{}", &host.id[..8.min(host.id.len())]))
            .spawn(move || {
                let (client_stream, _) = match listener.accept() {
                    Ok(x) => x,
                    Err(_) => return,
                };
                let _ = client_stream.set_nodelay(true);
                jump_sess_clone.set_blocking(false);
                // Non-blocking open: EAGAIN means "still in flight" — retry
                // until the deadline instead of dropping the connection.
                let deadline = std::time::Instant::now() + Duration::from_secs(15);
                let channel = loop {
                    match jump_sess_clone.channel_direct_tcpip(&target_host, target_port, None) {
                        Ok(ch) => break ch,
                        Err(e) => {
                            if ssh2_would_block(&e) && std::time::Instant::now() < deadline {
                                std::thread::sleep(Duration::from_millis(5));
                                continue;
                            }
                            return;
                        }
                    }
                };
                relay_jump_stream(client_stream, channel);
            })
            .map_err(AppError::Io)?;

        // Connect local TcpStream to the forwarded loopback port
        match TcpStream::connect_timeout(&local_addr, Duration::from_secs(10)) {
            Ok(s) => {
                configure_tcp_stream(&s)?;
                s
            }
            Err(e) => {
                // Connect failed - poke listener so thread doesn't hang indefinitely
                let _ = TcpStream::connect(local_addr);
                return Err(AppError::Network(format!("Failed to connect to jump proxy: {e}")));
            }
        }
    } else {
        let addr = (host.hostname.as_str(), host.port)
            .to_socket_addrs()
            .map_err(|e| AppError::Network(format!("DNS lookup failed: {e}")))?
            .next()
            .ok_or_else(|| AppError::Network("no address resolved".into()))?;

        let tcp = TcpStream::connect_timeout(&addr, Duration::from_secs(10))
            .map_err(|e| AppError::Network(format!("{addr}: {e}")))?;
        configure_tcp_stream(&tcp)?;
        tcp
    };

    let mut sess = Session::new()?;
    sess.set_tcp_stream(tcp);
    sess.set_timeout(20_000);
    sess.set_compress(compress);
    let _ = sess.method_pref(MethodType::Kex, "curve25519-sha256,curve25519-sha256@libssh.org,ecdh-sha2-nistp256,diffie-hellman-group14-sha256,diffie-hellman-group-exchange-sha256");
    let _ = sess.method_pref(MethodType::CryptCs, "chacha20-poly1305@openssh.com,aes256-gcm@openssh.com,aes128-gcm@openssh.com,aes256-ctr,aes192-ctr,aes128-ctr");
    let _ = sess.method_pref(MethodType::CryptSc, "chacha20-poly1305@openssh.com,aes256-gcm@openssh.com,aes128-gcm@openssh.com,aes256-ctr,aes192-ctr,aes128-ctr");
    sess.handshake()?;

    // ── Host key verification (trust-on-first-use, pinned in the vault) ──
    let fingerprint = sess
        .host_key_hash(HashType::Sha256)
        .map(|h| B64.encode(h).trim_end_matches('=').to_string())
        .ok_or_else(|| AppError::Other("server sent no host key".into()))?;

    match vault.known_host(&host.hostname, host.port)? {
        Some(pinned) if pinned == fingerprint => {}
        Some(pinned) => {
            return Err(AppError::HostKeyMismatch { expected: pinned, actual: fingerprint })
        }
        None => {
            // Remember the offered key so `host_trust_key` can only pin a
            // fingerprint this installation actually saw (TOFU anchor that the
            // WebView cannot fake).
            crate::vault::record_pending_trust(&host.hostname, host.port, &fingerprint);
            return Err(AppError::UnknownHostKey { fingerprint });
        }
    }

    // ── Authentication ──
    let user = host.username.as_str();
    match host.auth_method {
        AuthMethod::Password => {
            let pw = secret.password.as_deref().unwrap_or_default();
            sess.userauth_password(user, pw)?;
        }
        AuthMethod::Key => {
            // Private key (RSA / ED25519 / ECDSA, OpenSSH or PEM) decrypted only in memory.
            let key = secret
                .private_key
                .as_deref()
                .ok_or_else(|| AppError::Other("no private key stored for host".into()))?;
            sess.userauth_pubkey_memory(user, None, key, secret.passphrase.as_deref())?;
        }
        AuthMethod::Agent => {
            sess.userauth_agent(user)?;
        }
    }
    if !sess.authenticated() {
        return Err(AppError::AuthFailed);
    }
    Ok((sess, fingerprint))
}

pub fn shell_quote(s: &str) -> String {
    format!("'{}'", s.replace('\'', "'\\''"))
}

/// True when a libssh2 call failed only because the session is non-blocking
/// and the operation is still in flight (`LIBSSH2_ERROR_EAGAIN == -37`, the
/// same mapping ssh2's `From<Error> for io::Error` uses for `WouldBlock`).
/// Such errors mean "retry", not "failed".
pub(crate) fn ssh2_would_block(e: &ssh2::Error) -> bool {
    e.code() == ssh2::ErrorCode::Session(-37)
}

/// Bidirectional relay between the jump-proxy loopback client and the
/// direct-tcpip channel. Runs on one thread against a non-blocking session
/// (`WouldBlock` is normal and just means "try again"). An idle timeout keeps
/// dead connections from pinning the thread forever.
fn relay_jump_stream(mut client: std::net::TcpStream, mut channel: ssh2::Channel) {
    const IDLE_TIMEOUT: Duration = Duration::from_secs(600);
    const RELAY_BUF_SIZE: usize = 128 * 1024;
    let _ = client.set_nonblocking(true);
    let mut up = vec![0u8; RELAY_BUF_SIZE];
    let mut down = vec![0u8; RELAY_BUF_SIZE];
    let mut last_activity = std::time::Instant::now();

    loop {
        let mut busy = false;

        // client -> channel
        match client.read(&mut up) {
            Ok(0) => break,
            Ok(n) => {
                busy = true;
                let mut w = 0;
                while w < n {
                    match channel.write(&up[w..n]) {
                        Ok(0) => return,
                        Ok(k) => w += k,
                        Err(e) if e.kind() == std::io::ErrorKind::WouldBlock => {
                            std::thread::sleep(Duration::from_micros(200));
                        }
                        Err(_) => return,
                    }
                }
            }
            Err(e)
                if e.kind() == std::io::ErrorKind::WouldBlock
                    || e.kind() == std::io::ErrorKind::TimedOut => {}
            Err(_) => break,
        }

        // channel -> client
        match channel.read(&mut down) {
            Ok(0) => {
                if channel.eof() {
                    break;
                }
            }
            Ok(n) => {
                busy = true;
                let mut w = 0;
                while w < n {
                    match client.write(&down[w..n]) {
                        Ok(0) => return,
                        Ok(k) => w += k,
                        Err(e) if e.kind() == std::io::ErrorKind::WouldBlock => {
                            std::thread::sleep(Duration::from_micros(200));
                        }
                        Err(_) => return,
                    }
                }
            }
            Err(e)
                if e.kind() == std::io::ErrorKind::WouldBlock
                    || e.kind() == std::io::ErrorKind::TimedOut => {}
            Err(_) => break,
        }

        if busy {
            last_activity = std::time::Instant::now();
        } else {
            let idle_for = last_activity.elapsed();
            if idle_for > IDLE_TIMEOUT {
                break;
            }
            // Adaptive poll: sub-millisecond sleep while recently active so bulk
            // SFTP streams don't stall on 15ms gaps, backing off when idle.
            if idle_for < Duration::from_millis(50) {
                std::thread::sleep(Duration::from_micros(500));
            } else {
                std::thread::sleep(Duration::from_millis(10));
            }
        }
    }

    let _ = channel.send_eof();
}

/// Quote a path for a `cd` command while keeping a leading `~` expandable.
/// Tilde expansion does not happen inside quotes, so `cd '~'` silently fails;
/// emit `~` / `~/'rest'` instead, and plain quoting for everything else.
fn cd_path_quote(p: &str) -> String {
    if p == "~" {
        return "~".to_string();
    }
    if let Some(rest) = p.strip_prefix("~/") {
        return format!("~/'{}'", rest.replace('\'', "'\\''"));
    }
    shell_quote(p)
}

// ─────────────────────────────────────────────────────────────────────────────
// Commands
// ─────────────────────────────────────────────────────────────────────────────

/// Establish an encrypted SSH session and pipe its PTY to `on_event`.
/// Runs off the main thread (`async`) since the handshake is blocking I/O.
#[tauri::command(async)]
pub fn ssh_connect(
    app: AppHandle,
    req: ConnectRequest,
    on_event: IpcChannel<SshEvent>,
    mgr: State<'_, SshManager>,
    vault: State<'_, Vault>,
    snaps: State<'_, SnapshotStore>,
) -> AppResult<String> {
    let (host, secret) = vault.host_with_secret(&req.host_id)?;
    let (sess, fingerprint) = open_authenticated(&host, &secret, &vault)?;
    drop(secret); // HostSecret is ZeroizeOnDrop

    let banner = sess.banner().map(str::to_owned);

    // Best-effort OS fingerprint (exec channel, ~ms). Never fails connect.
    let os = detect_remote_os(&sess, banner.as_deref());
    sess.set_timeout(20_000);
    // Persist so the sidebar shows the icon without reconnecting.
    if let Some(ref os_id) = os {
        let _ = vault.set_host_os(&host.id, os_id);
    }

    let target_cwd = req
        .cwd
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty() && *s != "~")
        .map(str::to_owned)
        .or_else(|| {
            if req.resume {
                snaps
                    .get(&host.id)
                    .or_else(|| vault.load_snapshot(&host.id).ok().flatten())
                    .map(|s| s.cwd)
                    .filter(|cwd| !cwd.is_empty() && cwd != "~" && !cwd.starts_with("/home/") && cwd != "/root")
            } else {
                None
            }
        });

    let initial_size = (req.cols, req.rows);
    let mut channel = sess.channel_session()?;
    let px_w = req.cols.saturating_mul(9);
    let px_h = req.rows.saturating_mul(18);
    channel.request_pty("xterm-256color", None, Some((req.cols, req.rows, px_w, px_h)))?;
    channel.handle_extended_data(ExtendedData::Merge)?; // stderr → same stream

    let is_windows = os.as_deref() == Some("windows");
    let mut started_via_exec = false;
    if let Some(ref cwd) = target_cwd {
        if !is_windows {
            let quoted = cd_path_quote(cwd);
            let start_cmd = format!("cd {quoted} 2>/dev/null; exec ${{SHELL:-/bin/sh}} -l");
            if channel.exec(&start_cmd).is_ok() {
                started_via_exec = true;
            }
        }
    }
    if !started_via_exec {
        channel.shell()?;
    }
    // CRITICAL: Disable libssh2's user-space keepalive_send (`keepalive.c:74`).
    // In libssh2, `libssh2_keepalive_send` passes a stack-allocated `keepalive_data[]` buffer
    // to `_libssh2_transport_send`. If the non-blocking socket returns EAGAIN, libssh2 saves
    // the dangling stack pointer in `session->packet.odata` (`transport.c:1296`) and ignores
    // EAGAIN, causing all subsequent writes (`send_existing` at `transport.c:919`) to fail
    // with "Address is different, returning EAGAIN".
    // Dead-peer detection and NAT keepalive are handled at the kernel TCP layer via
    // `configure_tcp_stream` (`SO_KEEPALIVE`).
    sess.set_keepalive(false, 0);
    sess.set_blocking(false);

    let session_id = uuid::Uuid::new_v4().to_string();
    let (tx, rx) = mpsc::sync_channel::<Cmd>(256);
    let stop = Arc::new(AtomicBool::new(false));

    let mut initial_cwd = target_cwd.clone().unwrap_or_else(|| String::from("~"));
    if !started_via_exec && req.resume {
        if let Some(snap) = snaps.get(&host.id).or_else(|| vault.load_snapshot(&host.id).ok().flatten()) {
            initial_cwd = snap.cwd.clone();
            // Only cd if the snapshotted directory is not home
            if !snap.cwd.is_empty() && snap.cwd != "~" && !snap.cwd.starts_with("/home/") && snap.cwd != "/root" {
                let cmd = format!(" cd {} 2>/dev/null\n", cd_path_quote(&snap.cwd));
                let _ = tx.try_send(Cmd::Write(cmd.into_bytes()));
            }
        }
    }

    let events_shared = Arc::new(Mutex::new(on_event.clone()));
    let scrollback = Arc::new(Mutex::new(Vec::with_capacity(16 * 1024)));
    let modes_shared = Arc::new(Mutex::new(TerminalModeTracker::default()));
    let cwd_shared = Arc::new(Mutex::new(initial_cwd));

    let info = SessionInfo {
        session_id: session_id.clone(),
        host_id: host.id.clone(),
        started_at: chrono::Utc::now().timestamp(),
    };
    mgr.sessions.lock().insert(
        session_id.clone(),
        SessionHandle {
            tx,
            info,
            stop: stop.clone(),
            events: events_shared.clone(),
            scrollback: scrollback.clone(),
            modes: modes_shared.clone(),
            cwd: cwd_shared.clone(),
            fingerprint: fingerprint.clone(),
            banner: banner.clone(),
            os: os.clone(),
            _bg_guard: BackgroundSessionGuard::acquire(),
        },
    );

    let _ = vault.log_start(&session_id, Some(&host.id), &host.label, &host.username, &host.hostname);

    let _ = on_event.send(SshEvent::Connected {
        session_id: session_id.clone(),
        fingerprint,
        banner,
        os,
    });

    let sid = session_id.clone();
    let snaps = snaps.inner().clone();
    let host_id = host.id.clone();
    let stop_thread = stop.clone();
    let events_for_thread = events_shared.clone();
    if let Err(e) = thread::Builder::new()
        .name(format!("ssh-io-{}", &sid[..8]))
        .spawn(move || {
            let (reason, resumable) = io_loop(
                sess,
                channel,
                rx,
                &events_for_thread,
                &scrollback,
                &modes_shared,
                &cwd_shared,
                &snaps,
                &host_id,
                &sid,
                stop_thread,
                initial_size,
            );
            let _ = app.state::<Vault>().log_end(&sid, &reason);
            let _ = events_for_thread.lock().send(SshEvent::Disconnected { reason, resumable });
            app.state::<SshManager>().sessions.lock().remove(&sid);
            app.state::<crate::sftp::SftpManager>().close(&sid);
        })
    {
        // Spawn failed — remove stale manager entry (Finding #30).
        mgr.sessions.lock().remove(&session_id);
        return Err(AppError::Io(e));
    }

    Ok(session_id)
}

/// Re-attach a remounted `TerminalPane` (e.g. after an Android Activity/WebView
/// recreation or tab switch) to an already-running SSH session in `SshManager`.
/// Swaps in the new `on_event` channel and replays the retained scrollback buffer.
#[tauri::command]
pub fn ssh_attach(
    session_id: String,
    cols: u32,
    rows: u32,
    on_event: IpcChannel<SshEvent>,
    mgr: State<'_, SshManager>,
) -> AppResult<bool> {
    let guard = mgr.sessions.lock();
    let Some(h) = guard.get(&session_id) else {
        return Ok(false);
    };
    if h.stop.load(Ordering::Relaxed) {
        return Ok(false);
    }
    *h.events.lock() = on_event.clone();
    let _ = on_event.send(SshEvent::Connected {
        session_id: session_id.clone(),
        fingerprint: h.fingerprint.clone(),
        banner: h.banner.clone(),
        os: h.os.clone(),
    });
    let cwd = h.cwd.lock().clone();
    if !cwd.is_empty() {
        let _ = on_event.send(SshEvent::Cwd { path: cwd });
    }
    let (replay, in_alt_screen) = {
        let sb = h.scrollback.lock();
        let modes = h.modes.lock();
        (modes.build_attach_replay(&sb), modes.in_alt_screen())
    };
    if !replay.is_empty() {
        let _ = on_event.send(SshEvent::Output {
            b64: B64.encode(&replay),
        });
    }
    if cols > 0 && rows > 0 {
        let cmd = if in_alt_screen {
            Cmd::ForceResize(cols, rows)
        } else {
            Cmd::Resize(cols, rows)
        };
        let _ = h.tx.try_send(cmd);
    }
    Ok(true)
}

#[tauri::command]
pub fn ssh_write(session_id: String, data: String, mgr: State<'_, SshManager>) -> AppResult<()> {
    mgr.send(&session_id, Cmd::Write(data.into_bytes()))
}

#[tauri::command]
pub fn ssh_resize(session_id: String, cols: u32, rows: u32, mgr: State<'_, SshManager>) -> AppResult<()> {
    mgr.send(&session_id, Cmd::Resize(cols, rows))
}

#[tauri::command]
pub fn ssh_disconnect(session_id: String, mgr: State<'_, SshManager>) -> AppResult<()> {
    if let Some(h) = mgr.sessions.lock().get(&session_id) {
        h.stop.store(true, Ordering::SeqCst);
        let _ = h.tx.try_send(Cmd::Close);
    }
    Ok(())
}

#[tauri::command]
pub fn ssh_sessions(mgr: State<'_, SshManager>) -> Vec<SessionInfo> {
    mgr.sessions.lock().values().map(|h| h.info.clone()).collect()
}

// ─────────────────────────────────────────────────────────────────────────────
// I/O loop
// ─────────────────────────────────────────────────────────────────────────────

fn write_all_nb(ch: &mut Channel, mut data: &[u8]) -> std::io::Result<()> {
    let deadline = Instant::now() + Duration::from_secs(10);
    while !data.is_empty() {
        match ch.write(data) {
            Ok(0) => return Err(ErrorKind::WriteZero.into()),
            Ok(n) => data = &data[n..],
            Err(e) if e.kind() == ErrorKind::WouldBlock || e.kind() == ErrorKind::Interrupted => {
                if Instant::now() > deadline {
                    return Err(ErrorKind::TimedOut.into());
                }
                thread::sleep(Duration::from_millis(1));
            }
            Err(e) => return Err(e),
        }
    }
    // CRITICAL: Do NOT call ch.flush() here!
    // In ssh2-rs, Channel::flush() calls libssh2_channel_flush_ex(), which flushes (discards)
    // the CHANNEL READ BUFFER. Calling it on rapid keystrokes/backspaces discards in-flight
    // inbound packets from the server, corrupting the packet decryption state machine and
    // triggering "transport read" (LIBSSH2_ERROR_SOCKET_RECV) disconnections.
    Ok(())
}

/// Complete a non-blocking PTY resize request, retrying on `LIBSSH2_ERROR_EAGAIN` (-37).
///
/// In libssh2 (`channel.c:1066` / `transport.c:1296`), `_libssh2_channel_request_pty_size`
/// stores `channel->reqPTY_state = libssh2_NB_state_created` and `session->packet.odata =
/// channel->reqPTY_packet` if `_libssh2_transport_send` returns `EAGAIN`. Ignoring `EAGAIN`
/// leaves `session->packet.total_num > 0` pointing at `reqPTY_packet`, causing subsequent
/// writes (`send_existing` at `transport.c:919`) to fail with "Address is different" (`EAGAIN`).
fn request_pty_size_nb(ch: &mut Channel, cols: u32, rows: u32) -> std::io::Result<()> {
    let deadline = Instant::now() + Duration::from_secs(5);
    let px_w = cols.saturating_mul(9);
    let px_h = rows.saturating_mul(18);
    loop {
        match ch.request_pty_size(cols, rows, Some(px_w), Some(px_h)) {
            Ok(()) => return Ok(()),
            Err(e) if ssh2_would_block(&e) => {
                if Instant::now() > deadline {
                    return Err(ErrorKind::TimedOut.into());
                }
                thread::sleep(Duration::from_millis(1));
            }
            Err(e) => return Err(std::io::Error::other(e.to_string())),
        }
    }
}

#[allow(clippy::too_many_arguments)]
fn io_loop(
    _sess: Session,
    mut ch: Channel,
    rx: Receiver<Cmd>,
    events: &Arc<Mutex<IpcChannel<SshEvent>>>,
    scrollback: &Arc<Mutex<Vec<u8>>>,
    modes_state: &Arc<Mutex<TerminalModeTracker>>,
    cwd_state: &Arc<Mutex<String>>,
    snaps: &SnapshotStore,
    host_id: &str,
    session_id: &str,
    stop: Arc<AtomicBool>,
    initial_size: (u32, u32),
) -> (String, bool) {
    let mut buf = vec![0u8; 64 * 1024];
    let mut osc = Osc7Parser::default();
    let mut line = String::new();
    let mut last_size = initial_size;

    loop {
        if stop.load(Ordering::Relaxed) {
            let _ = ch.send_eof();
            let _ = ch.close();
            return ("closed by user".into(), false);
        }

        let mut idle = true;
        let mut pending_resize: Option<(u32, u32, bool)> = None;

        // 1. Drain UI commands (capped per tick to prevent starvation).
        for _ in 0..32 {
            match rx.try_recv() {
                Ok(Cmd::Write(bytes)) => {
                    idle = false;
                    track_command(&mut line, &bytes, |cmd| snaps.record_command(host_id, session_id, cmd));
                    if let Err(e) = write_all_nb(&mut ch, &bytes) {
                        return (format!("write failed: {e}"), true);
                    }
                }
                Ok(Cmd::Resize(c, r)) => {
                    if c > 0 && r > 0 {
                        let force = pending_resize.is_some_and(|(_, _, f)| f);
                        pending_resize = Some((c, r, force));
                    }
                }
                Ok(Cmd::ForceResize(c, r)) => {
                    if c > 0 && r > 0 {
                        pending_resize = Some((c, r, true));
                    }
                }
                Ok(Cmd::Close) | Err(TryRecvError::Disconnected) => {
                    let _ = ch.send_eof();
                    let _ = ch.close();
                    return ("closed by user".into(), false);
                }
                Err(TryRecvError::Empty) => break,
            }
        }

        if let Some((c, r, force)) = pending_resize {
            if force {
                idle = false;
                let _ = request_pty_size_nb(&mut ch, c, r.saturating_add(1));
                if let Err(e) = request_pty_size_nb(&mut ch, c, r) {
                    return (format!("resize failed: {e}"), true);
                }
                last_size = (c, r);
            } else if (c, r) != last_size {
                idle = false;
                if let Err(e) = request_pty_size_nb(&mut ch, c, r) {
                    return (format!("resize failed: {e}"), true);
                }
                last_size = (c, r);
            }
        }

        // 2. Pump PTY output.
        match ch.read(&mut buf) {
            Ok(0) => {
                if ch.eof() {
                    let code = ch.exit_status().unwrap_or(0);
                    return (format!("remote shell exited ({code})"), false);
                }
            }
            Ok(n) => {
                idle = false;
                let chunk = &buf[..n];
                if let Some(cwd) = osc.feed(chunk) {
                    snaps.record_cwd(host_id, session_id, &cwd);
                    *cwd_state.lock() = cwd.clone();
                    let _ = events.lock().send(SshEvent::Cwd { path: cwd });
                }
                modes_state.lock().feed(chunk);
                {
                    let mut sb = scrollback.lock();
                    sb.extend_from_slice(chunk);
                    trim_scrollback(&mut sb, MAX_SCROLLBACK_BYTES);
                }
                // Best-effort delivery to the currently attached WebView channel.
                // Never close the SSH channel if the WebView is temporarily detached
                // or recreating — the session stays alive in Rust and re-attaches via `ssh_attach`.
                let _ = events.lock().send(SshEvent::Output {
                    b64: B64.encode(chunk),
                });
            }
            Err(e) if e.kind() == ErrorKind::WouldBlock || e.kind() == ErrorKind::Interrupted => {}
            Err(e) => return (format!("connection lost: {e}"), true),
        }

        if idle {
            thread::sleep(Duration::from_millis(10));
        }
    }
}

/// Best-effort reconstruction of the last submitted command line from keystrokes.
fn track_command(line: &mut String, bytes: &[u8], mut on_submit: impl FnMut(&str)) {
    let s = String::from_utf8_lossy(bytes);
    let mut chars = s.chars().peekable();
    while let Some(c) = chars.next() {
        match c {
            '\r' | '\n' => {
                let cmd = line.trim();
                if !cmd.is_empty() && !cmd.starts_with("__nx") {
                    on_submit(cmd);
                }
                line.clear();
            }
            '\x7f' | '\x08' => {
                line.pop();
            }
            '\x1b' => {
                // skip CSI sequence (arrow keys etc.)
                while let Some(&n) = chars.peek() {
                    chars.next();
                    if n.is_ascii_alphabetic() || n == '~' {
                        break;
                    }
                }
            }
            '\x03' | '\x15' => line.clear(), // ^C / ^U
            c if !c.is_control() && line.len() < 4096 => line.push(c),
            _ => {}
        }
    }
}

/// Streaming parser for `ESC ] 7 ; file://host/path (BEL | ESC \)`.
#[derive(Default)]
pub(crate) struct Osc7Parser {
    state: u8,
    acc: Vec<u8>,
}

impl Osc7Parser {
    pub(crate) fn feed(&mut self, data: &[u8]) -> Option<String> {
        let mut found = None;
        for &b in data {
            self.state = match (self.state, b) {
                (0, 0x1b) => 1,
                (1, b']') => 2,
                (2, b'7') => 3,
                (3, b';') => {
                    self.acc.clear();
                    4
                }
                (4, 0x07) => {
                    found = parse_file_url(&self.acc);
                    0
                }
                (4, 0x1b) => 5,
                (5, b'\\') => {
                    found = parse_file_url(&self.acc);
                    0
                }
                (4, b) if self.acc.len() < 4096 => {
                    self.acc.push(b);
                    4
                }
                (4, _) => {
                    // Overflow cap reached (> 4KB cwd) - reset accumulator cleanly
                    self.acc.clear();
                    0
                }
                (_, 0x1b) => 1,
                _ => 0,
            };
        }
        found
    }
}

fn hex_val(b: u8) -> Option<u8> {
    match b {
        b'0'..=b'9' => Some(b - b'0'),
        b'a'..=b'f' => Some(b - b'a' + 10),
        b'A'..=b'F' => Some(b - b'A' + 10),
        _ => None,
    }
}

fn parse_file_url(raw: &[u8]) -> Option<String> {
    let s = std::str::from_utf8(raw).ok()?;
    let rest = s.strip_prefix("file://")?;
    let path = &rest[rest.find('/')?..];
    // Minimal percent-decoding, done on BYTES only. The previous version sliced
    // the `&str` at `path[i + 1..i + 3]`, which panics when those byte indices
    // fall inside a multi-byte UTF-8 character (e.g. `%€` sent in a crafted
    // OSC-7 sequence by a remote server) — a remote crash on the SSH I/O
    // thread (release builds abort on panic).
    let mut out = Vec::with_capacity(path.len());
    let bytes = path.as_bytes();
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' && i + 2 < bytes.len() {
            if let (Some(hi), Some(lo)) = (hex_val(bytes[i + 1]), hex_val(bytes[i + 2])) {
                out.push(hi * 16 + lo);
                i += 3;
                continue;
            }
        }
        out.push(bytes[i]);
        i += 1;
    }
    String::from_utf8(out).ok()
}

/// Trims `sb` so its length does not exceed `max_bytes`, advancing the cut point
/// past any leading UTF-8 continuation bytes (`0x80..0xBF`) or mid-CSI escape
/// parameters so replayed scrollback never begins with a torn escape sequence or
/// invalid UTF-8 codepoint fragment.
pub(crate) fn trim_scrollback(sb: &mut Vec<u8>, max_bytes: usize) {
    if sb.len() <= max_bytes {
        return;
    }
    let mut cut = sb.len() - max_bytes;
    let search_limit = (cut + 128).min(sb.len());

    // If `cut` falls inside an unfinished CSI/OSC sequence that started within the
    // preceding 64 bytes, advance `cut` past the end of that escape sequence.
    let back_start = cut.saturating_sub(64);
    if let Some(rel_esc) = sb[back_start..cut].iter().rposition(|&b| b == 0x1b) {
        let esc_idx = back_start + rel_esc;
        if esc_idx + 1 == cut {
            cut = (cut + 1).min(search_limit);
        } else if sb.get(esc_idx + 1) == Some(&b'[') {
            let csi_body = &sb[esc_idx + 2..cut];
            if csi_body.iter().all(|&b| (0x20..=0x3f).contains(&b)) {
                while cut < search_limit && (0x20..=0x3f).contains(&sb[cut]) {
                    cut += 1;
                }
                if cut < search_limit && (0x40..=0x7e).contains(&sb[cut]) {
                    cut += 1;
                }
            }
        }
    }

    // Advance past any UTF-8 continuation bytes (10xxxxxx).
    while cut < search_limit && (sb[cut] & 0b1100_0000) == 0b1000_0000 {
        cut += 1;
    }

    sb.drain(0..cut);
}

/// Tracks active DEC private modes (`DECSET` / `DECRST`) and keypad state across a
/// streaming PTY output session so that re-attaching a newly mounted `xterm.js`
/// instance (pop-out window, dock-back, or mobile WebView recreation) restores
/// alternate-screen and mouse-reporting state (`?1000`, `?1002`, `?1003`, `?1006`,
/// `?1015`, `?1049`, etc.) even after the startup sequences have been evicted from
/// the 256 KiB scrollback buffer (#41).
#[derive(Clone, Debug)]
pub(crate) struct TerminalModeTracker {
    state: u8,
    private_marker: u8,
    intermediate: u8,
    params: Vec<u8>,
    alt_screen: Option<u16>,
    app_cursor_keys: bool,
    autowrap: bool,
    cursor_visible: bool,
    app_keypad: bool,
    decnkm: bool,
    mouse_9: bool,
    mouse_1000: bool,
    mouse_1001: bool,
    mouse_1002: bool,
    mouse_1003: bool,
    last_mouse_protocol: Option<u16>,
    mouse_1005: bool,
    mouse_1006: bool,
    mouse_1015: bool,
    mouse_1016: bool,
    last_mouse_encoding: Option<u16>,
    focus_events: bool,
    alt_scroll: bool,
    bracketed_paste: bool,
}

impl Default for TerminalModeTracker {
    fn default() -> Self {
        Self {
            state: 0,
            private_marker: 0,
            intermediate: 0,
            params: Vec::with_capacity(32),
            alt_screen: None,
            app_cursor_keys: false,
            autowrap: true,
            cursor_visible: true,
            app_keypad: false,
            decnkm: false,
            mouse_9: false,
            mouse_1000: false,
            mouse_1001: false,
            mouse_1002: false,
            mouse_1003: false,
            last_mouse_protocol: None,
            mouse_1005: false,
            mouse_1006: false,
            mouse_1015: false,
            mouse_1016: false,
            last_mouse_encoding: None,
            focus_events: false,
            alt_scroll: false,
            bracketed_paste: false,
        }
    }
}

impl TerminalModeTracker {
    pub(crate) fn in_alt_screen(&self) -> bool {
        self.alt_screen.is_some()
    }

    fn reset_all(&mut self) {
        let state = self.state;
        *self = Self::default();
        self.state = state;
    }

    fn reset_soft(&mut self) {
        self.app_cursor_keys = false;
        self.autowrap = true;
        self.cursor_visible = true;
        self.app_keypad = false;
        self.decnkm = false;
    }

    fn apply_dec_mode(&mut self, mode: u16, enable: bool) {
        match mode {
            1 => self.app_cursor_keys = enable,
            7 => self.autowrap = enable,
            9 => {
                self.mouse_9 = enable;
                if enable {
                    self.last_mouse_protocol = Some(9);
                } else if self.last_mouse_protocol == Some(9) {
                    self.last_mouse_protocol = None;
                }
            }
            25 => self.cursor_visible = enable,
            47 | 1047 | 1049 => {
                if enable {
                    self.alt_screen = Some(mode);
                } else {
                    self.alt_screen = None;
                }
            }
            66 => self.decnkm = enable,
            1000 => {
                self.mouse_1000 = enable;
                if enable {
                    self.last_mouse_protocol = Some(1000);
                } else if self.last_mouse_protocol == Some(1000) {
                    self.last_mouse_protocol = None;
                }
            }
            1001 => {
                self.mouse_1001 = enable;
                if enable {
                    self.last_mouse_protocol = Some(1001);
                } else if self.last_mouse_protocol == Some(1001) {
                    self.last_mouse_protocol = None;
                }
            }
            1002 => {
                self.mouse_1002 = enable;
                if enable {
                    self.last_mouse_protocol = Some(1002);
                } else if self.last_mouse_protocol == Some(1002) {
                    self.last_mouse_protocol = None;
                }
            }
            1003 => {
                self.mouse_1003 = enable;
                if enable {
                    self.last_mouse_protocol = Some(1003);
                } else if self.last_mouse_protocol == Some(1003) {
                    self.last_mouse_protocol = None;
                }
            }
            1004 => self.focus_events = enable,
            1005 => {
                self.mouse_1005 = enable;
                if enable {
                    self.last_mouse_encoding = Some(1005);
                } else if self.last_mouse_encoding == Some(1005) {
                    self.last_mouse_encoding = None;
                }
            }
            1006 => {
                self.mouse_1006 = enable;
                if enable {
                    self.last_mouse_encoding = Some(1006);
                } else if self.last_mouse_encoding == Some(1006) {
                    self.last_mouse_encoding = None;
                }
            }
            1007 => self.alt_scroll = enable,
            1015 => {
                self.mouse_1015 = enable;
                if enable {
                    self.last_mouse_encoding = Some(1015);
                } else if self.last_mouse_encoding == Some(1015) {
                    self.last_mouse_encoding = None;
                }
            }
            1016 => {
                self.mouse_1016 = enable;
                if enable {
                    self.last_mouse_encoding = Some(1016);
                } else if self.last_mouse_encoding == Some(1016) {
                    self.last_mouse_encoding = None;
                }
            }
            2004 => self.bracketed_paste = enable,
            _ => {}
        }
    }

    pub(crate) fn feed(&mut self, data: &[u8]) {
        for &b in data {
            match self.state {
                // Ground
                0 => {
                    if b == 0x1b {
                        self.state = 1;
                    }
                }
                // ESC received
                1 => match b {
                    b'[' => {
                        self.params.clear();
                        self.private_marker = 0;
                        self.intermediate = 0;
                        self.state = 2;
                    }
                    b']' => {
                        self.state = 3;
                    }
                    b'=' => {
                        self.app_keypad = true;
                        self.state = 0;
                    }
                    b'>' => {
                        self.app_keypad = false;
                        self.state = 0;
                    }
                    b'c' => {
                        self.reset_all();
                        self.state = 0;
                    }
                    0x1b => {
                        self.state = 1;
                    }
                    _ => {
                        self.state = 0;
                    }
                },
                // CSI sequence
                2 => match b {
                    0x1b => {
                        self.state = 1;
                    }
                    b'?' | b'>' | b'<' | b'=' if self.params.is_empty() && self.private_marker == 0 => {
                        self.private_marker = b;
                    }
                    b'0'..=b'9' | b';' | b':' => {
                        if self.params.len() < 64 {
                            self.params.push(b);
                        }
                    }
                    0x20..=0x2f => {
                        self.intermediate = b;
                    }
                    0x40..=0x7e => {
                        if self.private_marker == b'?' && self.intermediate == 0 && (b == b'h' || b == b'l') {
                            let enable = b == b'h';
                            if let Ok(s) = std::str::from_utf8(&self.params) {
                                let modes: Vec<u16> = s
                                    .split(';')
                                    .filter_map(|p| p.parse::<u16>().ok())
                                    .collect();
                                for m in modes {
                                    self.apply_dec_mode(m, enable);
                                }
                            }
                        } else if self.private_marker == 0 && self.intermediate == b'!' && b == b'p' {
                            self.reset_soft();
                        }
                        self.state = 0;
                    }
                    0x00..=0x1f => {}
                    _ => {
                        self.state = 0;
                    }
                },
                // OSC string (skip until BEL or ST so digits inside titles/hyperlinks are ignored)
                3 => match b {
                    0x07 => self.state = 0,
                    0x1b => self.state = 4,
                    _ => {}
                },
                // ESC inside OSC
                4 => match b {
                    b'\\' => self.state = 0,
                    b'[' => {
                        self.params.clear();
                        self.private_marker = 0;
                        self.intermediate = 0;
                        self.state = 2;
                    }
                    0x1b => self.state = 4,
                    _ => self.state = 0,
                },
                _ => self.state = 0,
            }
        }
    }

    /// Synthesizes the escape sequences needed to restore all currently active
    /// input/cursor/mouse modes at the end of a scrollback replay.
    pub(crate) fn active_modes_suffix(&self) -> Vec<u8> {
        let mut out = Vec::new();
        if self.app_cursor_keys {
            out.extend_from_slice(b"\x1b[?1h");
        }
        if !self.autowrap {
            out.extend_from_slice(b"\x1b[?7l");
        }
        if !self.cursor_visible {
            out.extend_from_slice(b"\x1b[?25l");
        }
        if self.app_keypad {
            out.extend_from_slice(b"\x1b=");
        }
        if self.decnkm {
            out.extend_from_slice(b"\x1b[?66h");
        }

        let protocols = [
            (9u16, self.mouse_9),
            (1000, self.mouse_1000),
            (1001, self.mouse_1001),
            (1002, self.mouse_1002),
            (1003, self.mouse_1003),
        ];
        let mut last_proto_active = false;
        for (mode, active) in protocols {
            if active {
                if self.last_mouse_protocol == Some(mode) {
                    last_proto_active = true;
                } else {
                    out.extend_from_slice(format!("\x1b[?{mode}h").as_bytes());
                }
            }
        }
        if last_proto_active {
            if let Some(last) = self.last_mouse_protocol {
                out.extend_from_slice(format!("\x1b[?{last}h").as_bytes());
            }
        }

        let encodings = [
            (1005u16, self.mouse_1005),
            (1015, self.mouse_1015),
            (1006, self.mouse_1006),
            (1016, self.mouse_1016),
        ];
        let mut last_enc_active = false;
        for (mode, active) in encodings {
            if active {
                if self.last_mouse_encoding == Some(mode) {
                    last_enc_active = true;
                } else {
                    out.extend_from_slice(format!("\x1b[?{mode}h").as_bytes());
                }
            }
        }
        if last_enc_active {
            if let Some(last) = self.last_mouse_encoding {
                out.extend_from_slice(format!("\x1b[?{last}h").as_bytes());
            }
        }

        if self.focus_events {
            out.extend_from_slice(b"\x1b[?1004h");
        }
        if self.alt_scroll {
            out.extend_from_slice(b"\x1b[?1007h");
        }
        if self.bracketed_paste {
            out.extend_from_slice(b"\x1b[?2004h");
        }
        out
    }

    /// Builds the full replay buffer to send on `ssh_attach` / `local_pty_attach`.
    ///
    /// - If the session is currently in the alternate screen buffer (`?1049h` / `?1047h` / `?47h`)
    ///   and the retained `scrollback` no longer contains the alternate-screen entry sequence
    ///   (because >256 KiB of TUI frames were emitted since startup), prepends the alternate-screen
    ///   entry sequence so `scrollback` renders into `xterm.js`'s alternate buffer rather than
    ///   polluting normal scrollback.
    /// - Appends `active_modes_suffix()` so mouse tracking (`?1000h`, `?1002h`, `?1003h`, `?1006h`,
    ///   `?1015h`), application cursor keys (`?1h`), cursor visibility (`?25l`), and focus/paste
    ///   modes are guaranteed to be restored on the newly attached `xterm.js` instance.
    pub(crate) fn build_attach_replay(&self, scrollback: &[u8]) -> Vec<u8> {
        let suffix = self.active_modes_suffix();
        let mut prefix = Vec::new();
        if let Some(alt_mode) = self.alt_screen {
            let mut sb_tracker = Self::default();
            sb_tracker.feed(scrollback);
            if !sb_tracker.in_alt_screen() {
                prefix.extend_from_slice(format!("\x1b[?{alt_mode}h").as_bytes());
            }
        }
        if prefix.is_empty() && suffix.is_empty() {
            return scrollback.to_vec();
        }
        let mut out = Vec::with_capacity(prefix.len() + scrollback.len() + suffix.len());
        out.extend_from_slice(&prefix);
        out.extend_from_slice(scrollback);
        out.extend_from_slice(&suffix);
        out
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn osc7_split_across_chunks() {
        let mut p = Osc7Parser::default();
        assert_eq!(p.feed(b"hello \x1b]7;file://box/var/"), None);
        assert_eq!(p.feed(b"log%20s\x07$ "), Some("/var/log s".into()));
    }

    #[test]
    fn parse_file_url_multibyte_percent_no_panic() {
        // '%'+multi-byte UTF-8 must never panic (byte-index str slicing bug) and
        // must round-trip the literal text when it is not valid percent-encoding.
        assert_eq!(
            parse_file_url("file://box/tmp/%\u{20ac}x".as_bytes()),
            Some("/tmp/%\u{20ac}x".into())
        );
        assert_eq!(
            parse_file_url("file://box/tmp/%\u{20ac}".as_bytes()),
            Some("/tmp/%\u{20ac}".into())
        );
        // Lone '%' and short tails stay literal.
        assert_eq!(parse_file_url("file://box/tmp/a%".as_bytes()), Some("/tmp/a%".into()));
        assert_eq!(parse_file_url("file://box/tmp/a%2".as_bytes()), Some("/tmp/a%2".into()));
        // Valid percent-decoding still works (2-byte UTF-8 sequence).
        assert_eq!(
            parse_file_url("file://box/tmp/%C3%A9".as_bytes()),
            Some("/tmp/\u{e9}".into())
        );
    }

    #[test]
    fn tracks_submitted_command() {
        let mut line = String::new();
        let mut got = vec![];
        track_command(&mut line, b"ls -lx\x7fa\r", |c| got.push(c.to_string()));
        assert_eq!(got, vec!["ls -la"]);
    }

    #[test]
    fn android_os_detected_before_generic_linux() {
        assert_eq!(parse_os_release("---\nAndroid\nLinux\n"), Some("android".into()));
        assert_eq!(parse_os_release("ID=termux"), Some("android".into()));
        assert_eq!(parse_os_release("---\nGNU/Linux\nLinux\n"), Some("linux".into()));
    }

    #[test]
    fn expand_proxy_command_tokens() {
        assert_eq!(
            expand_proxy_command("cloudflared access ssh --hostname %h", "internal.corp.net", 22, "root"),
            "cloudflared access ssh --hostname internal.corp.net"
        );
        assert_eq!(
            expand_proxy_command("aws ssm start-session --target %h --parameters portNumber=%p", "i-0123456789abcdef0", 22, "ec2-user"),
            "aws ssm start-session --target i-0123456789abcdef0 --parameters portNumber=22"
        );
        assert_eq!(
            expand_proxy_command("nc -X 5 -x 127.0.0.1:1080 %h %p (user=%r, escaped=%%)", "10.0.0.5", 2222, "admin"),
            "nc -X 5 -x 127.0.0.1:1080 10.0.0.5 2222 (user=admin, escaped=%)"
        );
        // Hostile shell injection payloads are safely quoted
        assert_eq!(
            expand_proxy_command("connect %h", "evil.com; rm -rf /", 22, "root"),
            "connect 'evil.com; rm -rf /'"
        );
        assert_eq!(
            expand_proxy_command("connect %r@%h", "host.internal", 22, "admin; $(reboot)"),
            "connect 'admin; $(reboot)'@host.internal"
        );
    }

    #[test]
    fn mode_tracker_preserves_btop_mouse_and_alt_screen_after_scrollback_eviction() {
        let mut tracker = TerminalModeTracker::default();
        let mut scrollback = Vec::new();

        // 1. btop startup sequences: enter alternate screen, hide cursor, enable mouse tracking + SGR encoding
        let startup = b"\x1b[?1049h\x1b[?1000h\x1b[?1002h\x1b[?1015h\x1b[?1006h\x1b[?25l";
        tracker.feed(startup);
        scrollback.extend_from_slice(startup);

        // 2. Stream > 256 KiB of btop frame updates so startup sequences are evicted from scrollback
        let frame = b"\x1b[1;1H\x1b[38;2;0;255;128mCPU [|||||||||| 42%] Process List...\r\n".repeat(64);
        for _ in 0..80 {
            tracker.feed(&frame);
            scrollback.extend_from_slice(&frame);
            trim_scrollback(&mut scrollback, MAX_SCROLLBACK_BYTES);
        }

        // Startup sequences were evicted from the raw scrollback buffer:
        let raw_str = String::from_utf8_lossy(&scrollback);
        assert!(!raw_str.contains("\x1b[?1049h"));
        assert!(!raw_str.contains("\x1b[?1006h"));

        // 3. Building the attach replay restores ?1049h before scrollback and mouse/cursor modes after:
        let replay = tracker.build_attach_replay(&scrollback);
        assert!(replay.starts_with(b"\x1b[?1049h"));
        let replay_str = String::from_utf8_lossy(&replay);
        assert!(replay_str.ends_with("\x1b[?25l\x1b[?1000h\x1b[?1002h\x1b[?1015h\x1b[?1006h"));

        // 4. Exiting btop clears all tracked modes:
        let teardown = b"\x1b[?1000l\x1b[?1002l\x1b[?1015l\x1b[?1006l\x1b[?25h\x1b[?1049l";
        tracker.feed(teardown);
        assert!(!tracker.in_alt_screen());
        assert!(tracker.active_modes_suffix().is_empty());
    }

    #[test]
    fn mode_tracker_handles_compound_and_split_csi_sequences() {
        let mut tracker = TerminalModeTracker::default();
        // Split compound sequence `\x1b[?1049;1000;1003;1006;2004h` across three chunks:
        tracker.feed(b"normal output \x1b[?1049;10");
        tracker.feed(b"00;1003;100");
        tracker.feed(b"6;2004h\x1b=");

        assert!(tracker.in_alt_screen());
        let suffix = String::from_utf8(tracker.active_modes_suffix()).unwrap();
        assert_eq!(suffix, "\x1b=\x1b[?1000h\x1b[?1003h\x1b[?1006h\x1b[?2004h");
    }
}
