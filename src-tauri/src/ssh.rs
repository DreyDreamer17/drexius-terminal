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
use std::sync::mpsc::{self, Receiver, Sender, TryRecvError};
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
    tx: Sender<Cmd>,
    info: SessionInfo,
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
        h.tx.send(cmd).map_err(|_| AppError::SessionNotFound(session_id.into()))
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// Connection helpers (shared with sftp.rs)
// ─────────────────────────────────────────────────────────────────────────────

/// Normalize a distro id (`/etc/os-release` ID= / banner token) to a short key
/// the frontend maps to an icon. Unknown → None (UI shows generic server).
fn normalize_os_id(id: &str) -> Option<String> {
    let s = id.trim().to_lowercase();
    let key = if s.contains("ubuntu") {
        "ubuntu"
    } else if s.contains("debian") || s.contains("raspbian") {
        "debian"
    } else if s.contains("arch") || s.contains("manjaro") || s.contains("endeavour") {
        "arch"
    } else if s.contains("fedora") {
        "fedora"
    } else if s.contains("centos") || s.contains("rhel") || s.contains("red hat") {
        "centos"
    } else if s.contains("rocky") || s.contains("alma") {
        "rocky"
    } else if s.contains("alpine") {
        "alpine"
    } else if s.contains("amazon") {
        "amazon"
    } else if s.contains("opensuse") || s.contains("suse") {
        "suse"
    } else if s.contains("darwin") || s.contains("macos") || s == "mac" {
        "macos"
    } else if s.contains("windows") || s.contains("mingw") || s.contains("msys") || s.contains("cygwin") {
        "windows"
    } else if s == "linux" || s.contains("gnu/linux") {
        "linux"
    } else {
        return None;
    };
    Some(key.to_string())
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

    let tcp = if let Some(jump_id) = &host.jump_host_id {
        let trimmed_jump = jump_id.trim();
        if !trimmed_jump.is_empty() {
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

            // Run proxy for the direct-tcpip channel
            std::thread::Builder::new()
                .name(format!("jump-proxy-{}", &host.id[..8.min(host.id.len())]))
                .spawn(move || {
                    if let Ok((mut client_stream, _)) = listener.accept() {
                        let _ = client_stream.set_nodelay(true);
                        if let Ok(mut channel) = jump_sess_clone.channel_direct_tcpip(&target_host, target_port, None) {
                            let mut client_clone = match client_stream.try_clone() {
                                Ok(c) => c,
                                Err(_) => return,
                            };
                            let mut channel_clone = channel.clone();
                            std::thread::spawn(move || {
                                let mut buf = [0u8; 8192];
                                while let Ok(n) = channel_clone.read(&mut buf) {
                                    if n == 0 || client_clone.write_all(&buf[..n]).is_err() {
                                        break;
                                    }
                                }
                            });
                            let mut buf = [0u8; 8192];
                            while let Ok(n) = client_stream.read(&mut buf) {
                                if n == 0 || channel.write_all(&buf[..n]).is_err() {
                                    break;
                                }
                            }
                        }
                    }
                })
                .map_err(|e| AppError::Io(e))?;

            // Connect local TcpStream to the forwarded loopback port
            let tcp = TcpStream::connect_timeout(&local_addr, Duration::from_secs(10))
                .map_err(|e| AppError::Network(format!("Failed to connect to jump proxy: {e}")))?;
            tcp.set_nodelay(true)?;
            tcp
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
        None => return Err(AppError::UnknownHostKey { fingerprint }),
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
    let (tx, rx) = mpsc::channel::<Cmd>();

    // Login bootstrap: OSC-7 hook + optional resume of snapshotted cwd.
    let mut init = String::from(OSC7_HOOK);
    if req.resume {
        if let Some(snap) = snaps.get(&host.id).or_else(|| vault.load_snapshot(&host.id).ok().flatten()) {
            init.push_str(&format!(" cd {} 2>/dev/null; clear\n", shell_quote(&snap.cwd)));
        }
    }
    let _ = tx.send(Cmd::Write(init.into_bytes()));

    let info = SessionInfo {
        session_id: session_id.clone(),
        host_id: host.id.clone(),
        started_at: chrono::Utc::now().timestamp(),
    };
    mgr.sessions.lock().insert(session_id.clone(), SessionHandle { tx, info });

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
    thread::Builder::new()
        .name(format!("ssh-io-{}", &sid[..8]))
        .spawn(move || {
            let (reason, resumable) = io_loop(sess, channel, rx, &on_event, &snaps, &host_id, &sid);
            let _ = app.state::<Vault>().log_end(&sid, &reason);
            let _ = on_event.send(SshEvent::Disconnected { reason, resumable });
            app.state::<SshManager>().sessions.lock().remove(&sid);
            app.state::<crate::sftp::SftpManager>().close(&sid);
        })?;

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
    mgr.send(&session_id, Cmd::Close)
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
) -> (String, bool) {
    let mut buf = vec![0u8; 64 * 1024];
    let mut osc = Osc7Parser::default();
    let mut line = String::new();
    let mut next_keepalive = Instant::now() + Duration::from_secs(15);

    loop {
        let mut idle = true;

        // 1. Drain UI commands.
        loop {
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
                (_, 0x1b) => 1,
                _ => 0,
            };
        }
        found
    }
}

fn parse_file_url(raw: &[u8]) -> Option<String> {
    let s = std::str::from_utf8(raw).ok()?;
    let rest = s.strip_prefix("file://")?;
    let path = &rest[rest.find('/')?..];
    // minimal percent-decoding
    let mut out = Vec::with_capacity(path.len());
    let bytes = path.as_bytes();
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' && i + 2 < bytes.len() {
            if let Ok(v) = u8::from_str_radix(&path[i + 1..i + 3], 16) {
                out.push(v);
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
    fn tracks_submitted_command() {
        let mut line = String::new();
        let mut got = vec![];
        track_command(&mut line, b"ls -lx\x7fa\r", |c| got.push(c.to_string()));
        assert_eq!(got, vec!["ls -la"]);
    }
}
