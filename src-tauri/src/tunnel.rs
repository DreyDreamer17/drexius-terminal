//! SSH Port Forwarding manager (Local & Dynamic SOCKS5 tunnels).
//! Multiplexes connections over authenticated SSH sessions.

use crate::error::{AppError, AppResult};
use crate::ssh::open_authenticated;
use crate::vault::{TunnelConfig, Vault};
use parking_lot::Mutex;
use serde::Serialize;
use ssh2::Session;
use std::collections::HashMap;
use std::io::{Read, Write};
use std::net::{TcpListener, TcpStream};
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
}

struct RunningTunnel {
    stop_flag: Arc<AtomicBool>,
    bytes_up: Arc<AtomicU64>,
    bytes_down: Arc<AtomicU64>,
    _session: Session,
    local_port: u16,
}

#[derive(Default)]
pub struct TunnelManager {
    running: Mutex<HashMap<String, RunningTunnel>>,
}

impl TunnelManager {
    pub fn is_running(&self, id: &str) -> bool {
        self.running.lock().contains_key(id)
    }

    pub fn stop(&self, id: &str) {
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
            }
        } else {
            ActiveTunnelInfo {
                id: id.to_string(),
                running: false,
                bytes_up: 0,
                bytes_down: 0,
                error: None,
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
    if mgr.is_running(&id) {
        return Ok(mgr.status(&id));
    }

    let tunnel = vault.tunnel_get(&id)?;
    let (host, secret) = vault.host_with_secret(&tunnel.host_id)?;
    let (session, _) = open_authenticated(&host, &secret, &vault)?;

    let bind_addr = format!("{}:{}", tunnel.local_host, tunnel.local_port);
    let listener = TcpListener::bind(&bind_addr)
        .map_err(|e| AppError::Network(format!("Failed to bind {bind_addr}: {e}")))?;
    listener
        .set_nonblocking(true)
        .map_err(|e| AppError::Io(e))?;

    let local_port = tunnel.local_port;
    spawn_tunnel_worker(
        id.clone(),
        format!("tunnel-{}", &id[..8.min(id.len())]),
        listener,
        session,
        tunnel,
        local_port,
        &mgr,
    )?;

    Ok(mgr.status(&id))
}

fn spawn_tunnel_worker(
    tunnel_id: String,
    thread_name: String,
    listener: TcpListener,
    session: Session,
    cfg: TunnelConfig,
    local_port: u16,
    mgr: &TunnelManager,
) -> AppResult<()> {
    let stop_flag = Arc::new(AtomicBool::new(false));
    let bytes_up = Arc::new(AtomicU64::new(0));
    let bytes_down = Arc::new(AtomicU64::new(0));

    let running_tunnel = RunningTunnel {
        stop_flag: stop_flag.clone(),
        bytes_up: bytes_up.clone(),
        bytes_down: bytes_down.clone(),
        _session: session.clone(),
        local_port,
    };

    mgr.running.lock().insert(tunnel_id, running_tunnel);

    let stop = stop_flag;
    let up = bytes_up;
    let down = bytes_down;

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
                        thread::spawn(move || {
                            let _ = handle_client(stream, sess, c, stop_c, up_c, down_c);
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
    if mgr.is_running(&tunnel_id) {
        let guard = mgr.running.lock();
        if let Some(t) = guard.get(&tunnel_id) {
            return Ok(t.local_port);
        }
    }

    let (host, secret) = vault.host_with_secret(&host_id)?;
    let (session, _) = open_authenticated(&host, &secret, &vault)?;

    // Bind to 127.0.0.1 on port 10885 (or dynamic port if 10885 is occupied)
    let listener = match TcpListener::bind("127.0.0.1:10885") {
        Ok(l) => l,
        Err(_) => TcpListener::bind("127.0.0.1:0")
            .map_err(|e| AppError::Network(format!("Failed to bind local port: {e}")))?,
    };
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

    spawn_tunnel_worker(
        tunnel_id,
        format!("ai-tun-{}", local_port),
        listener,
        session,
        cfg,
        local_port,
        &mgr,
    )?;

    log::info!("AI SOCKS5 tunnel active on 127.0.0.1:{} for host {}", local_port, host_id);
    Ok(local_port)
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
) -> std::io::Result<()> {
    client.set_nodelay(true)?;

    let channel = if cfg.forward_type == "dynamic" {
        // Simple SOCKS5 handshake & request parser
        match socks5_handshake(&mut client) {
            Ok((dest_host, dest_port)) => {
                match sess.channel_direct_tcpip(&dest_host, dest_port, Some(("127.0.0.1", cfg.local_port))) {
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
        match sess.channel_direct_tcpip(
            &cfg.remote_host,
            cfg.remote_port,
            Some((&cfg.local_host, cfg.local_port)),
        ) {
            Ok(ch) => ch,
            Err(e) => return Err(std::io::Error::new(std::io::ErrorKind::Other, e.to_string())),
        }
    };

    sess.set_blocking(false);
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
            thread::sleep(Duration::from_millis(5));
        }
    }

    let _ = channel.send_eof();
}
