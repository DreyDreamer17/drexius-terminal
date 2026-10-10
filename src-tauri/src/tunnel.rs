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

    let stop_flag = Arc::new(AtomicBool::new(false));
    let bytes_up = Arc::new(AtomicU64::new(0));
    let bytes_down = Arc::new(AtomicU64::new(0));

    let running_tunnel = RunningTunnel {
        stop_flag: stop_flag.clone(),
        bytes_up: bytes_up.clone(),
        bytes_down: bytes_down.clone(),
        _session: session.clone(),
    };

    mgr.running.lock().insert(id.clone(), running_tunnel);

    let stop = stop_flag.clone();
    let up = bytes_up.clone();
    let down = bytes_down.clone();
    let t_cfg = tunnel.clone();

    thread::Builder::new()
        .name(format!("tunnel-{}", &id[..8.min(id.len())]))
        .spawn(move || {
            while !stop.load(Ordering::Relaxed) {
                match listener.accept() {
                    Ok((stream, _)) => {
                        let sess = session.clone();
                        let stop_c = stop.clone();
                        let up_c = up.clone();
                        let down_c = down.clone();
                        let cfg = t_cfg.clone();
                        thread::spawn(move || {
                            let _ = handle_client(stream, sess, cfg, stop_c, up_c, down_c);
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

    Ok(mgr.status(&id))
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
                match sess.channel_direct_tcpip(&dest_host, dest_port, None) {
                    Ok(ch) => {
                        // SOCKS5 success response: version 5, rep 0 (succeeded), rsv 0, atyp 1 (IPv4 0.0.0.0:0)
                        let _ = client.write_all(&[5, 0, 0, 1, 0, 0, 0, 0, 0, 0]);
                        ch
                    }
                    Err(_) => {
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
    let _ = client.set_read_timeout(Some(Duration::from_millis(100)));
    let mut client_clone = match client.try_clone() {
        Ok(c) => c,
        Err(_) => return,
    };

    let stop_1 = stop.clone();
    let up = bytes_up.clone();

    // Thread 1: Client -> SSH Channel (Upload)
    let t1 = thread::spawn(move || {
        let mut buf = [0u8; 16 * 1024];
        while !stop_1.load(Ordering::Relaxed) {
            match client.read(&mut buf) {
                Ok(0) => break,
                Ok(n) => {
                    if channel.write_all(&buf[..n]).is_err() || channel.flush().is_err() {
                        break;
                    }
                    up.fetch_add(n as u64, Ordering::Relaxed);
                }
                Err(e) if e.kind() == std::io::ErrorKind::WouldBlock || e.kind() == std::io::ErrorKind::TimedOut => {
                    continue;
                }
                Err(_) => break,
            }
        }
        let _ = channel.send_eof();
    });

    // Thread 2: SSH Channel -> Client (Download)
    let stop_2 = stop.clone();
    let down = bytes_down.clone();
    let mut buf = [0u8; 16 * 1024];
    while !stop_2.load(Ordering::Relaxed) {
        match client_clone.read(&mut buf) {
            Ok(0) => break,
            Ok(n) => {
                down.fetch_add(n as u64, Ordering::Relaxed);
            }
            Err(e) if e.kind() == std::io::ErrorKind::WouldBlock || e.kind() == std::io::ErrorKind::TimedOut => {
                continue;
            }
            Err(_) => break,
        }
    }

    let _ = t1.join();
}
