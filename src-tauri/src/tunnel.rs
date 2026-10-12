//! SSH Port Forwarding manager (Local, Remote & Dynamic SOCKS5 tunnels).
//!
//! Three forward types:
//!   • "local"    — listen on localHost:localPort; each connection opens a `direct-tcpip`
//!                  channel to remoteHost:remotePort via the SSH session.
//!   • "dynamic"  — local SOCKS5 proxy on localHost:localPort; clients specify the
//!                  destination and we open `direct-tcpip` channels.
//!   • "remote"   — ask the SSH server to listen on remoteHost:remotePort; each inbound
//!                  connection arrives via a `forwarded-tcpip` channel and we relay it to
//!                  localHost:localPort (reverse tunnel).
//!
//! Local/dynamic use a `TcpListener` and sessions established *to* us. Remote forwards use
//! ssh2's `Listener` (from `Session::channel_forward_listen`) and channels that the server
//! pushes *to* us.

use crate::error::{AppError, AppResult};
use crate::ssh::open_authenticated;
use crate::vault::{TunnelConfig, Vault};
use parking_lot::Mutex;
use serde::Serialize;
use ssh2::Session;
use std::collections::{HashMap, HashSet};
use std::io::{Read, Write};
use std::net::{TcpListener, TcpStream, ToSocketAddrs};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::Arc;
use std::thread;
use std::time::Duration;
use tauri::State;

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ActiveTunnelInfo {
    pub id: String,
    pub running: bool,
    pub bytes_up: u64,
    pub bytes_down: u64,
    pub error: Option<String>,
    /// For remote forwards, the port the SSH server actually bound (may differ from the
    /// configured port when the server allocates an ephemeral port). For local/dynamic this
    /// is the same as the configured local port.
    #[serde(default)]
    pub bound_port: u16,
}

struct RunningTunnel {
    stop_flag: Arc<AtomicBool>,
    bytes_up: Arc<AtomicU64>,
    bytes_down: Arc<AtomicU64>,
    _session: Session,
    local_port: u16,
    /// For remote forwards: the port the remote server actually bound (may differ from
    /// the requested port when the server allocates one, e.g. remote_port = 0).
    bound_remote_port: u16,
}

#[derive(Default)]
pub struct TunnelManager {
    running: Mutex<HashMap<String, RunningTunnel>>,
    starting: Mutex<HashSet<String>>,
}

impl TunnelManager {
    #[allow(dead_code)]
    pub fn is_running(&self, id: &str) -> bool {
        self.running.lock().contains_key(id)
    }

    pub fn try_claim_starting(&self, id: &str) -> bool {
        let mut starting = self.starting.lock();
        let running = self.running.lock();
        if running.contains_key(id) || starting.contains(id) {
            return false;
        }
        starting.insert(id.to_string());
        true
    }

    pub fn release_starting(&self, id: &str) {
        self.starting.lock().remove(id);
    }

    pub fn stop(&self, id: &str) {
        self.starting.lock().remove(id);
        if let Some(t) = self.running.lock().remove(id) {
            t.stop_flag.store(true, Ordering::Relaxed);
        }
    }

    pub fn status(&self, id: &str) -> ActiveTunnelInfo {
        let guard = self.running.lock();
        if let Some(t) = guard.get(id) {
            ActiveTunnelInfo {
                id: id.to_string(),
                running: true,
                bytes_up: t.bytes_up.load(Ordering::Relaxed),
                bytes_down: t.bytes_down.load(Ordering::Relaxed),
                error: None,
                bound_port: if t.bound_remote_port > 0 { t.bound_remote_port } else { t.local_port },
            }
        } else {
            ActiveTunnelInfo {
                id: id.to_string(),
                running: false,
                bytes_up: 0,
                bytes_down: 0,
                error: None,
                bound_port: 0,
            }
        }
    }

    pub fn all_statuses(&self) -> Vec<ActiveTunnelInfo> {
        let guard = self.running.lock();
        guard
            .iter()
            .map(|(id, t)| ActiveTunnelInfo {
                id: id.clone(),
                running: true,
                bytes_up: t.bytes_up.load(Ordering::Relaxed),
                bytes_down: t.bytes_down.load(Ordering::Relaxed),
                error: None,
                bound_port: if t.bound_remote_port > 0 { t.bound_remote_port } else { t.local_port },
            })
            .collect()
    }
}

#[tauri::command(async)]
pub fn tunnel_start(
    id: String,
    mgr: State<'_, TunnelManager>,
    vault: State<'_, Vault>,
) -> AppResult<ActiveTunnelInfo> {
    if !mgr.try_claim_starting(&id) {
        return Ok(mgr.status(&id));
    }

    let res = (|| {
        let tunnel = vault.tunnel_get(&id)?;
        let (host, secret) = vault.host_with_secret(&tunnel.host_id)?;
        let (session, _) = open_authenticated(&host, &secret, &vault)?;

        match tunnel.forward_type.as_str() {
            "remote" => spawn_remote_worker(id.clone(), session, tunnel, &mgr)?,
            _ => {
                // local | dynamic — bind a local TcpListener
                let bind_addr = format!("{}:{}", tunnel.local_host, tunnel.local_port);
                let listener = TcpListener::bind(&bind_addr)
                    .map_err(|e| AppError::Network(format!("Failed to bind {bind_addr}: {e}")))?;
                listener
                    .set_nonblocking(true)
                    .map_err(|e| AppError::Io(e))?;
                let local_port = tunnel.local_port;
                spawn_local_worker(
                    id.clone(),
                    format!("tunnel-{}", &id[..8.min(id.len())]),
                    listener,
                    session,
                    tunnel,
                    local_port,
                    &mgr,
                )?;
            }
        }
        Ok::<(), AppError>(())
    })();

    mgr.release_starting(&id);
    res?;

    Ok(mgr.status(&id))
}

/// Worker for local + dynamic (SOCKS5) forwards: accepts TCP connections on a local
/// listener and opens `direct-tcpip` channels over the SSH session for each.
fn spawn_local_worker(
    tunnel_id: String,
    thread_name: String,
    listener: TcpListener,
    session: Session,
    cfg: TunnelConfig,
    local_port: u16,
    mgr: &TunnelManager,
) -> AppResult<()> {
    session.set_blocking(false);

    let stop_flag = Arc::new(AtomicBool::new(false));
    let bytes_up = Arc::new(AtomicU64::new(0));
    let bytes_down = Arc::new(AtomicU64::new(0));
    let transport_lock = Arc::new(parking_lot::Mutex::new(()));

    let running_tunnel = RunningTunnel {
        stop_flag: stop_flag.clone(),
        bytes_up: bytes_up.clone(),
        bytes_down: bytes_down.clone(),
        _session: session.clone(),
        local_port,
        bound_remote_port: 0,
    };

    mgr.running.lock().insert(tunnel_id, running_tunnel);

    let stop = stop_flag;
    let up = bytes_up;
    let down = bytes_down;
    let t_lock = transport_lock;

    thread::Builder::new()
        .name(thread_name)
        .spawn(move || {
            while !stop.load(Ordering::Relaxed) {
                match listener.accept() {
                    Ok((stream, _)) => {
                        let sess = session.clone();
                        let stop_c = stop.clone();
                        let up_c = up.clone();
                        let down_c = down.clone();
                        let c = cfg.clone();
                        let tl = t_lock.clone();
                        thread::spawn(move || {
                            let _ = handle_client(stream, sess, c, stop_c, up_c, down_c, tl);
                        });
                    }
                    Err(e) if e.kind() == std::io::ErrorKind::WouldBlock => {
                        thread::sleep(Duration::from_millis(25));
                    }
                    Err(_) => break,
                }
            }
        })
        .map_err(|e| AppError::Io(e))?;

    Ok(())
}

/// Worker for remote (reverse) forwards: asks the SSH server to listen on
/// `remote_host:remote_port`, then for each `forwarded-tcpip` channel pushed by the server
/// dials a local TCP connection to `local_host:local_port` and relays bytes bidirectionally.
fn spawn_remote_worker(
    tunnel_id: String,
    session: Session,
    cfg: TunnelConfig,
    mgr: &TunnelManager,
) -> AppResult<()> {
    // Ask the server to start listening. Passing port 0 lets the server allocate one;
    // (Listener, bound_port) tells us which port it picked.
    let host = if cfg.remote_host.is_empty() || cfg.remote_host == "0.0.0.0" {
        None
    } else {
        Some(cfg.remote_host.as_str())
    };
    let (mut listener, bound_port) = session
        .channel_forward_listen(cfg.remote_port, host, None)
        .map_err(AppError::Ssh)?;

    let stop_flag = Arc::new(AtomicBool::new(false));
    let bytes_up = Arc::new(AtomicU64::new(0));
    let bytes_down = Arc::new(AtomicU64::new(0));

    let running_tunnel = RunningTunnel {
        stop_flag: stop_flag.clone(),
        bytes_up: bytes_up.clone(),
        bytes_down: bytes_down.clone(),
        _session: session.clone(),
        local_port: cfg.local_port,
        bound_remote_port: bound_port,
    };
    mgr.running.lock().insert(tunnel_id.clone(), running_tunnel);

    let thread_name = format!("rtun-{}", &tunnel_id[..8.min(tunnel_id.len())]);
    let stop = stop_flag;
    let up = bytes_up;
    let down = bytes_down;
    let local_target = format!("{}:{}", cfg.local_host, cfg.local_port);

    thread::Builder::new()
        .name(thread_name)
        .spawn(move || {
            // Use non-blocking mode on the session so we can poll Listener::accept
            // cooperatively and react promptly to the stop flag. We poll with a
            // short sleep rather than blocking indefinitely.
            let _ = session.set_blocking(false);
            loop {
                if stop.load(Ordering::Relaxed) {
                    break;
                }
                // Accept the next forwarded-tcpip channel from the server.
                let channel = match listener.accept() {
                    Ok(ch) => ch,
                    Err(e) => {
                        let io_err = std::io::Error::from(e);
                        if io_err.kind() == std::io::ErrorKind::WouldBlock {
                            thread::sleep(Duration::from_millis(25));
                            continue;
                        }
                        // Either the session died (server cancelled forward, network
                        // drop) or stop was requested.
                        log::debug!("remote forward accept failed: {io_err}");
                        if stop.load(Ordering::Relaxed) {
                            break;
                        }
                        thread::sleep(Duration::from_millis(200));
                        if !session.authenticated() {
                            break;
                        }
                        continue;
                    }
                };

                // Open a local TCP connection to the forward target (e.g. 127.0.0.1:8080).
                let addr = match local_target.to_socket_addrs().ok().and_then(|mut i| i.next()) {
                    Some(a) => a,
                    None => {
                        log::debug!("remote forward: cannot resolve local target {local_target}");
                        continue;
                    }
                };
                let local = match TcpStream::connect_timeout(&addr, Duration::from_secs(5)) {
                    Ok(s) => s,
                    Err(e) => {
                        log::debug!("remote forward: failed to connect to {}: {e}", addr);
                        continue;
                    }
                };

                let stop_c = stop.clone();
                let up_c = up.clone();
                let down_c = down.clone();
                let _ = local.set_nonblocking(true);
                thread::spawn(move || {
                    // For remote forwards, the SSH channel is what the remote client
                    // speaks into (bytes arriving "down" from the server), and the local
                    // TCP stream is what we forward those bytes to (bytes going "up"
                    // toward the local service). proxy_remote_channel wires them up
                    // with the byte counters matching that orientation.
                    proxy_remote_channel(local, channel, stop_c, up_c, down_c);
                });
            }
        })
        .map_err(|e| AppError::Io(e))?;

    Ok(())
}

#[tauri::command]
pub fn tunnel_stop(id: String, mgr: State<'_, TunnelManager>) -> ActiveTunnelInfo {
    mgr.stop(&id);
    mgr.status(&id)
}

#[tauri::command]
pub fn tunnel_status_all(mgr: State<'_, TunnelManager>) -> Vec<ActiveTunnelInfo> {
    mgr.all_statuses()
}

#[tauri::command(async)]
pub fn ai_tunnel_start(
    host_id: String,
    mgr: State<'_, TunnelManager>,
    vault: State<'_, Vault>,
) -> AppResult<u16> {
    let tunnel_id = format!("ai_auto_{}", host_id);
    if !mgr.try_claim_starting(&tunnel_id) {
        let guard = mgr.running.lock();
        if let Some(t) = guard.get(&tunnel_id) {
            return Ok(t.local_port);
        }
    }

    let res = (|| {
        let (host, secret) = vault.host_with_secret(&host_id)?;
        let (session, _) = open_authenticated(&host, &secret, &vault)?;

        // Bind loopback on an OS-assigned port (not a fixed, guessable one).
        let listener = TcpListener::bind("127.0.0.1:0")
            .map_err(|e| AppError::Network(format!("Failed to bind local port: {e}")))?;

        let local_port = listener.local_addr().map_err(|e| AppError::Io(e))?.port();
        listener
            .set_nonblocking(true)
            .map_err(|e| AppError::Io(e))?;

        let cfg = TunnelConfig {
            id: tunnel_id.clone(),
            label: format!("AI Proxy ({})", host.label),
            host_id: host_id.clone(),
            forward_type: "dynamic".to_string(),
            local_host: "127.0.0.1".to_string(),
            local_port,
            remote_host: "127.0.0.1".to_string(),
            remote_port: 0,
            updated_at: 0,
            vault_id: None,
        };

        spawn_local_worker(
            tunnel_id.clone(),
            format!("ai-tun-{}", local_port),
            listener,
            session,
            cfg,
            local_port,
            &mgr,
        )?;

        log::info!("AI SOCKS5 tunnel active on 127.0.0.1:{} for host {}", local_port, host_id);
        Ok::<u16, AppError>(local_port)
    })();

    mgr.release_starting(&tunnel_id);
    res
}

#[tauri::command]
pub fn ai_tunnel_stop(host_id: String, mgr: State<'_, TunnelManager>) -> bool {
    let tunnel_id = format!("ai_auto_{}", host_id);
    mgr.stop(&tunnel_id);
    true
}

fn handle_client(
    mut client: TcpStream,
    sess: Session,
    cfg: TunnelConfig,
    stop: Arc<AtomicBool>,
    up: Arc<AtomicU64>,
    down: Arc<AtomicU64>,
    transport_lock: Arc<parking_lot::Mutex<()>>,
) -> std::io::Result<()> {
    client.set_nodelay(true)?;

    let channel = if cfg.forward_type == "dynamic" {
        // Simple SOCKS5 handshake & request parser
        match socks5_handshake(&mut client) {
            Ok((dest_host, dest_port)) => {
                let open_res = {
                    let _guard = transport_lock.lock();
                    sess.channel_direct_tcpip(&dest_host, dest_port, Some(("127.0.0.1", cfg.local_port)))
                };
                match open_res {
                    Ok(ch) => {
                        // SOCKS5 success response: version 5, rep 0 (succeeded), rsv 0, atyp 1 (IPv4 0.0.0.0:0)
                        let _ = client.write_all(&[5, 0, 0, 1, 0, 0, 0, 0, 0, 0]);
                        ch
                    }
                    Err(e) => {
                        log::error!("direct-tcpip to {}:{} failed: {}", dest_host, dest_port, e);
                        // SOCKS5 reply 5: Connection refused
                        let _ = client.write_all(&[5, 5, 0, 1, 0, 0, 0, 0, 0, 0]);
                        return Ok(());
                    }
                }
            }
            Err(_) => return Ok(()),
        }
    } else {
        // Direct local port forward
        let open_res = {
            let _guard = transport_lock.lock();
            sess.channel_direct_tcpip(
                &cfg.remote_host,
                cfg.remote_port,
                Some((&cfg.local_host, cfg.local_port)),
            )
        };
        match open_res {
            Ok(ch) => ch,
            Err(e) => return Err(std::io::Error::new(std::io::ErrorKind::Other, e.to_string())),
        }
    };

    proxy_bidirectional(client, channel, stop, up, down);
    Ok(())
}

fn socks5_handshake(stream: &mut TcpStream) -> std::io::Result<(String, u16)> {
    stream.set_read_timeout(Some(Duration::from_secs(5)))?;
    let mut header = [0u8; 2];
    stream.read_exact(&mut header)?;
    if header[0] != 5 {
        return Err(std::io::Error::new(
            std::io::ErrorKind::InvalidData,
            "Not SOCKS5",
        ));
    }
    let nmethods = header[1] as usize;
    let mut methods = vec![0u8; nmethods];
    stream.read_exact(&mut methods)?;

    // Response: Version 5, Method 0 (no auth required)
    stream.write_all(&[5, 0])?;

    // Request: VER CMD RSV ATYP DST.ADDR DST.PORT
    let mut req = [0u8; 4];
    stream.read_exact(&mut req)?;
    if req[0] != 5 || req[1] != 1 {
        // CMD 1 = CONNECT
        return Err(std::io::Error::new(
            std::io::ErrorKind::InvalidData,
            "Only CONNECT supported",
        ));
    }

    let host = match req[3] {
        1 => {
            // IPv4 (4 bytes)
            let mut ip = [0u8; 4];
            stream.read_exact(&mut ip)?;
            format!("{}.{}.{}.{}", ip[0], ip[1], ip[2], ip[3])
        }
        3 => {
            // Domain name
            let mut len = [0u8; 1];
            stream.read_exact(&mut len)?;
            let mut domain = vec![0u8; len[0] as usize];
            stream.read_exact(&mut domain)?;
            String::from_utf8_lossy(&domain).to_string()
        }
        4 => {
            // IPv6 (16 bytes)
            let mut ip = [0u8; 16];
            stream.read_exact(&mut ip)?;
            let octets: Vec<String> = (0..8)
                .map(|i| format!("{:x}", u16::from_be_bytes([ip[i * 2], ip[i * 2 + 1]])))
                .collect();
            octets.join(":")
        }
        _ => {
            return Err(std::io::Error::new(
                std::io::ErrorKind::InvalidData,
                "Unknown ATYP",
            ))
        }
    };

    let mut port_bytes = [0u8; 2];
    stream.read_exact(&mut port_bytes)?;
    let port = u16::from_be_bytes(port_bytes);

    stream.set_read_timeout(None)?;
    Ok((host, port))
}

fn proxy_bidirectional(
    mut client: TcpStream,
    mut channel: ssh2::Channel,
    stop: Arc<AtomicBool>,
    bytes_up: Arc<AtomicU64>,
    bytes_down: Arc<AtomicU64>,
) {
    let _ = client.set_nonblocking(true);

    let mut client_buf = [0u8; 16 * 1024];
    let mut chan_buf = [0u8; 16 * 1024];

    while !stop.load(Ordering::Relaxed) {
        let mut had_activity = false;

        // 1. Client -> SSH Channel (Upload)
        match client.read(&mut client_buf) {
            Ok(0) => break,
            Ok(n) => {
                had_activity = true;
                bytes_up.fetch_add(n as u64, Ordering::Relaxed);
                let mut written = 0;
                while written < n {
                    match channel.write(&client_buf[written..n]) {
                        Ok(0) => break,
                        Ok(w) => written += w,
                        Err(e) if e.kind() == std::io::ErrorKind::WouldBlock => {
                            thread::sleep(Duration::from_millis(2));
                        }
                        Err(_) => break,
                    }
                }
                if written < n {
                    break;
                }
            }
            Err(e) if e.kind() == std::io::ErrorKind::WouldBlock || e.kind() == std::io::ErrorKind::TimedOut => {}
            Err(_) => break,
        }

        // 2. SSH Channel -> Client (Download)
        match channel.read(&mut chan_buf) {
            Ok(0) => {
                if channel.eof() {
                    break;
                }
            }
            Ok(n) => {
                had_activity = true;
                bytes_down.fetch_add(n as u64, Ordering::Relaxed);
                let mut written = 0;
                while written < n {
                    match client.write(&chan_buf[written..n]) {
                        Ok(0) => break,
                        Ok(w) => written += w,
                        Err(e) if e.kind() == std::io::ErrorKind::WouldBlock => {
                            thread::sleep(Duration::from_millis(2));
                        }
                        Err(_) => break,
                    }
                }
                if written < n {
                    break;
                }
            }
            Err(e) if e.kind() == std::io::ErrorKind::WouldBlock || e.kind() == std::io::ErrorKind::TimedOut => {}
            Err(_) => break,
        }

        if !had_activity {
            thread::sleep(Duration::from_millis(15));
        }
    }

    let _ = channel.send_eof();
}

/// Bidirectional relay for a **remote** (reverse) forward.
///
/// Traffic directions (opposite of `proxy_bidirectional`):
///   • SSH channel  →  local TCP stream  = remote client's request ("up" in the UI)
///   • Local stream →  SSH channel       = local service's response ("down" in the UI)
fn proxy_remote_channel(
    local: TcpStream,
    channel: ssh2::Channel,
    stop: Arc<AtomicBool>,
    bytes_up: Arc<AtomicU64>,
    bytes_down: Arc<AtomicU64>,
) {
    // In remote forwarding, the direction is inverted relative to local forwarding:
    //   • channel -> local: remote client inbound request (displayed as "up" in UI)
    //   • local -> channel: local service response (displayed as "down" in UI)
    // In proxy_bidirectional:
    //   • param 4 tracks local -> channel
    //   • param 5 tracks channel -> local
    // Therefore, we pass (bytes_down, bytes_up) so the UI counters reflect actual traffic accurately.
    let local_to_channel_counter = bytes_down;
    let channel_to_local_counter = bytes_up;
    proxy_bidirectional(local, channel, stop, local_to_channel_counter, channel_to_local_counter);
}
