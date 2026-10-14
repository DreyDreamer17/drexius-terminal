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

/// Shell hook injected at login: emits OSC-7 (`ESC ] 7 ; file://host/cwd BEL`)
/// on every prompt so we can snapshot the working directory. Idempotent and
/// prefixed with a space so it stays out of shell history (HISTCONTROL=ignorespace).
const OSC7_HOOK: &str = concat!(
    " __nx_osc7(){ printf '\\033]7;file://%s%s\\007' \"${HOSTNAME:-$(hostname)}\" \"$PWD\"; };",
    " case \"$PROMPT_COMMAND\" in *__nx_osc7*) ;; *) PROMPT_COMMAND=\"__nx_osc7${PROMPT_COMMAND:+;$PROMPT_COMMAND}\";; esac;",
    " [ -n \"$ZSH_VERSION\" ] && precmd_functions+=(__nx_osc7); clear\n"
);

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
    Close,
}

struct SessionHandle {
    tx: SyncSender<Cmd>,
    info: SessionInfo,
    stop: Arc<AtomicBool>,
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
/// Opens a short-lived exec channel: `cat /etc/os-release; uname -s`.
/// Never fails the connection — returns None on any error/timeout.
fn detect_remote_os(sess: &Session, banner: Option<&str>) -> Option<String> {
    let mut ch = sess.channel_session().ok()?;
    // Short timeout so a hung exec doesn't stall connect.
    let _ = sess.set_timeout(4000);
    ch.exec("cat /etc/os-release 2>/dev/null; echo ---; uname -s 2>/dev/null").ok()?;
    let mut out = String::new();
    let _ = (&mut ch).take(64 * 1024).read_to_string(&mut out);
    let _ = ch.wait_close();
    if let Some(os) = parse_os_release(&out) {
        return Some(os);
    }
    parse_banner_os(banner)
}

const MAX_JUMP_DEPTH: usize = 8;

/// TCP connect → handshake → host-key verification (TOFU) → authentication.
/// Returns a *blocking* authenticated session.
pub fn open_authenticated(
    host: &HostProfile,
    secret: &HostSecret,
    vault: &Vault,
) -> AppResult<(Session, String)> {
    let mut visited = std::collections::HashSet::new();
    visited.insert(host.id.clone());
    open_authenticated_inner(host, secret, vault, &mut visited, 0)
}

fn open_authenticated_inner(
    host: &HostProfile,
    secret: &HostSecret,
    vault: &Vault,
    visited: &mut std::collections::HashSet<String>,
    depth: usize,
) -> AppResult<(Session, String)> {
    if depth >= MAX_JUMP_DEPTH {
        return Err(AppError::Other(format!(
            "Jump host recursion depth exceeded limit ({MAX_JUMP_DEPTH})"
        )));
    }

    let tcp = if let Some(trimmed_jump) = host.jump_host_id.as_deref().map(str::trim).filter(|s| !s.is_empty()) {
        if !visited.insert(trimmed_jump.to_string()) {
            return Err(AppError::Other(format!(
                "Jump host cycle detected involving host ID '{trimmed_jump}'"
            )));
        }
        // Retrieve Jump Host profile and secret
        let (jump_host, jump_secret) = vault.host_with_secret(trimmed_jump)?;
        // Authenticate jump session (handles nested jumps with cycle prevention)
        let (jump_sess, _) = open_authenticated_inner(&jump_host, &jump_secret, vault, visited, depth + 1)?;

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
                let _ = jump_sess_clone.set_blocking(false);
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
                s.set_nodelay(true)?;
                s
            }
            Err(e) => {
                // Connect failed - poke listener so thread doesn't hang indefinitely
                let _ = TcpStream::connect(&local_addr);
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
        tcp.set_nodelay(true)?;
        tcp
    };

    let mut sess = Session::new()?;
    sess.set_tcp_stream(tcp);
    sess.set_timeout(20_000);
    sess.set_compress(true);
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
    let _ = client.set_nonblocking(true);
    let mut up = [0u8; 16 * 1024];
    let mut down = [0u8; 16 * 1024];
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
                            std::thread::sleep(Duration::from_millis(2));
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
                            std::thread::sleep(Duration::from_millis(2));
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
            if last_activity.elapsed() > IDLE_TIMEOUT {
                break;
            }
            std::thread::sleep(Duration::from_millis(15));
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
    let _ = sess.set_timeout(20_000);
    // Persist so the sidebar shows the icon without reconnecting.
    if let Some(ref os_id) = os {
        let _ = vault.set_host_os(&host.id, os_id);
    }

    let mut channel = sess.channel_session()?;
    channel.request_pty("xterm-256color", None, Some((req.cols, req.rows, 0, 0)))?;
    channel.handle_extended_data(ExtendedData::Merge)?; // stderr → same stream
    channel.shell()?;
    sess.set_keepalive(true, 15);
    sess.set_blocking(false);

    let session_id = uuid::Uuid::new_v4().to_string();
    let (tx, rx) = mpsc::sync_channel::<Cmd>(256);
    let stop = Arc::new(AtomicBool::new(false));

    // Login bootstrap: OSC-7 hook + optional resume of snapshotted cwd.
    let mut init = String::from(OSC7_HOOK);
    if req.resume {
        if let Some(snap) = snaps.get(&host.id).or_else(|| vault.load_snapshot(&host.id).ok().flatten()) {
            init.push_str(&format!(" cd {} 2>/dev/null; clear\n", cd_path_quote(&snap.cwd)));
        }
    }
    let _ = tx.try_send(Cmd::Write(init.into_bytes()));

    let info = SessionInfo {
        session_id: session_id.clone(),
        host_id: host.id.clone(),
        started_at: chrono::Utc::now().timestamp(),
    };
    mgr.sessions.lock().insert(session_id.clone(), SessionHandle { tx, info, stop: stop.clone() });

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
    if let Err(e) = thread::Builder::new()
        .name(format!("ssh-io-{}", &sid[..8]))
        .spawn(move || {
            let (reason, resumable) = io_loop(sess, channel, rx, &on_event, &snaps, &host_id, &sid, stop_thread);
            let _ = app.state::<Vault>().log_end(&sid, &reason);
            let _ = on_event.send(SshEvent::Disconnected { reason, resumable });
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

fn io_loop(
    sess: Session,
    mut ch: Channel,
    rx: Receiver<Cmd>,
    events: &IpcChannel<SshEvent>,
    snaps: &SnapshotStore,
    host_id: &str,
    session_id: &str,
    stop: Arc<AtomicBool>,
) -> (String, bool) {
    let mut buf = vec![0u8; 64 * 1024];
    let mut osc = Osc7Parser::default();
    let mut line = String::new();
    let mut next_keepalive = Instant::now() + Duration::from_secs(15);

    loop {
        if stop.load(Ordering::Relaxed) {
            let _ = ch.send_eof();
            let _ = ch.close();
            return ("closed by user".into(), false);
        }

        let mut idle = true;

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
                    let _ = ch.request_pty_size(c, r, None, None);
                }
                Ok(Cmd::Close) | Err(TryRecvError::Disconnected) => {
                    let _ = ch.send_eof();
                    let _ = ch.close();
                    return ("closed by user".into(), false);
                }
                Err(TryRecvError::Empty) => break,
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
                    let _ = events.send(SshEvent::Cwd { path: cwd });
                }
                if events.send(SshEvent::Output { b64: B64.encode(chunk) }).is_err() {
                    // Frontend went away (window closed / reload) — tear down.
                    let _ = ch.close();
                    return ("frontend detached".into(), true);
                }
            }
            Err(e) if e.kind() == ErrorKind::WouldBlock || e.kind() == ErrorKind::Interrupted => {}
            Err(e) => return (format!("connection lost: {e}"), true),
        }

        // 3. Keep-alive → detects silently dropped links (Wi-Fi switch, NAT timeout).
        if Instant::now() >= next_keepalive {
            match sess.keepalive_send() {
                Ok(secs) => next_keepalive = Instant::now() + Duration::from_secs(secs.max(5) as u64),
                Err(e) if e.code() == ssh2::ErrorCode::Session(-37) => {} // EAGAIN
                Err(e) => return (format!("keep-alive failed: {e}"), true),
            }
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
struct Osc7Parser {
    state: u8,
    acc: Vec<u8>,
}

impl Osc7Parser {
    fn feed(&mut self, data: &[u8]) -> Option<String> {
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
}
