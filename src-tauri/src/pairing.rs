//! Direct Device-to-Device Pairing & LAN Sync (X25519 ECDH + HKDF + XChaCha20-Poly1305)
//!
//! Enables zero-cloud, direct device-to-device pairing between two NexusTerminal instances
//! over local Wi-Fi or LAN. Device A shows a QR code + 6-digit PIN and runs an ephemeral listener.
//! Device B connects with the PIN, executes an authenticated X25519 key exchange,
//! and clones the vault database directly device-to-device.

use std::time::Duration;

use base64::engine::general_purpose::STANDARD as B64;
use base64::Engine;
use chacha20poly1305::{
    aead::{Aead, KeyInit},
    XChaCha20Poly1305, XNonce,
};
use hkdf::Hkdf;
use parking_lot::Mutex;
use rand::{Rng, RngCore};
use rusqlite::params;
use serde::{Deserialize, Serialize};
use sha2::Sha256;
use tauri::{AppHandle, Emitter, Manager, State};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpListener;
use tokio::sync::oneshot;
use x25519_dalek::{PublicKey, StaticSecret};

use crate::error::{AppError, AppResult};
use crate::vault::{
    AuthMethod, HostProfile, HostSecret, KeychainItem, PairedDevice, Snippet,
    TunnelConfig, Vault, VaultRecord,
};

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PairingHostInfo {
    pub pin: String,
    pub ip: String,
    pub port: u16,
    pub device_name: String,
    pub qr_payload: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PairingJoinResult {
    pub success: bool,
    pub server_device_name: String,
    pub vaults_count: usize,
    pub hosts_count: usize,
    pub keys_count: usize,
    pub snippets_count: usize,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LocalDeviceInfo {
    pub device_name: String,
    pub os: String,
    pub ip: String,
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct HandshakeRequest {
    pub pin: String,
    pub client_public_key: String,
    pub client_device_name: String,
    pub client_os: String,
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct HandshakeResponse {
    pub status: String,
    pub server_public_key: String,
    pub nonce: String,
    pub encrypted_payload: String,
    pub server_device_name: String,
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct FullVaultArchive {
    pub version: u32,
    pub sender_device: String,
    pub vaults: Vec<VaultRecord>,
    pub hosts: Vec<(HostProfile, Option<HostSecret>)>,
    pub keychain: Vec<(KeychainItem, Option<HostSecret>)>,
    pub snippets: Vec<Snippet>,
    pub tunnels: Vec<TunnelConfig>,
}

pub struct PairingManager {
    shutdown_tx: Mutex<Option<oneshot::Sender<()>>>,
    active_host: Mutex<Option<PairingHostInfo>>,
}

impl Default for PairingManager {
    fn default() -> Self {
        Self {
            shutdown_tx: Mutex::new(None),
            active_host: Mutex::new(None),
        }
    }
}

pub fn get_local_ip() -> String {
    if let Ok(s) = std::net::UdpSocket::bind("0.0.0.0:0") {
        if s.connect("8.8.8.8:80").is_ok() {
            if let Ok(addr) = s.local_addr() {
                let ip = addr.ip().to_string();
                if ip != "0.0.0.0" && ip != "127.0.0.1" {
                    return ip;
                }
            }
        }
    }
    "127.0.0.1".to_string()
}

pub fn get_device_name() -> String {
    let host = std::env::var("HOSTNAME")
        .or_else(|_| std::env::var("HOST"))
        .unwrap_or_else(|_| {
            std::fs::read_to_string("/etc/hostname")
                .map(|s| s.trim().to_string())
                .unwrap_or_else(|_| "NexusDevice".to_string())
        });
    let os = std::env::consts::OS;
    format!("{} ({})", host, os)
}

fn dump_full_vault(vault: &Vault, sender_name: &str) -> AppResult<FullVaultArchive> {
    vault.with(|c| {
        // Vaults
        let mut st_v = c.prepare("SELECT id, name, kind, color, description, created_at FROM vaults")?;
        let vaults = st_v
            .query_map([], |r| {
                Ok(VaultRecord {
                    id: r.get(0)?,
                    name: r.get(1)?,
                    kind: r.get(2)?,
                    color: r.get(3)?,
                    description: r.get(4)?,
                    created_at: r.get(5)?,
                })
            })?
            .collect::<Result<Vec<_>, _>>()?;

        // Hosts with secrets
        let mut st_h = c.prepare(
            "SELECT h.id, h.label, h.hostname, h.port, h.username, h.auth_method, h.grp, h.tags,
                    h.color, h.os, h.keychain_id, h.jump_host_id, h.vault_id,
                    s.password, s.private_key, s.passphrase
             FROM hosts h
             LEFT JOIN secrets s ON s.host_id = h.id",
        )?;
        let hosts = st_h
            .query_map([], |r| {
                let auth: String = r.get(5)?;
                let tags: String = r.get(7)?;
                let profile = HostProfile {
                    id: r.get(0)?,
                    label: r.get(1)?,
                    hostname: r.get(2)?,
                    port: r.get(3)?,
                    username: r.get(4)?,
                    auth_method: AuthMethod::parse(&auth),
                    group: r.get(6)?,
                    tags: serde_json::from_str(&tags).unwrap_or_default(),
                    color: r.get(8)?,
                    os: r.get(9)?,
                    keychain_id: r.get(10)?,
                    jump_host_id: r.get(11)?,
                    vault_id: r.get(12)?,
                    has_secret: false,
                };
                let pwd: Option<String> = r.get(13)?;
                let key: Option<String> = r.get(14)?;
                let pass: Option<String> = r.get(15)?;
                let secret = if pwd.is_some() || key.is_some() || pass.is_some() {
                    Some(HostSecret {
                        password: pwd,
                        private_key: key,
                        passphrase: pass,
                    })
                } else {
                    None
                };
                Ok((profile, secret))
            })?
            .collect::<Result<Vec<_>, _>>()?;

        // Keychain with secrets
        let mut st_kc = c.prepare(
            "SELECT id, label, username, auth_method, password, private_key, passphrase, updated_at, vault_id FROM keychain",
        )?;
        let keychain = st_kc
            .query_map([], |r| {
                let auth: String = r.get(3)?;
                let pwd: Option<String> = r.get(4)?;
                let key: Option<String> = r.get(5)?;
                let pass: Option<String> = r.get(6)?;
                let has_secret = pwd.is_some() || key.is_some() || pass.is_some();
                let item = KeychainItem {
                    id: r.get(0)?,
                    label: r.get(1)?,
                    username: r.get(2)?,
                    auth_method: AuthMethod::parse(&auth),
                    has_secret,
                    updated_at: r.get(7)?,
                    vault_id: r.get(8)?,
                };
                let secret = if has_secret {
                    Some(HostSecret {
                        password: pwd,
                        private_key: key,
                        passphrase: pass,
                    })
                } else {
                    None
                };
                Ok((item, secret))
            })?
            .collect::<Result<Vec<_>, _>>()?;

        // Snippets
        let mut st_snips = c.prepare("SELECT id, name, command, folder, tags, vault_id FROM snippets")?;
        let snippets = st_snips
            .query_map([], |r| {
                let tags: String = r.get(4)?;
                Ok(Snippet {
                    id: r.get(0)?,
                    name: r.get(1)?,
                    command: r.get(2)?,
                    folder: r.get(3)?,
                    tags: serde_json::from_str(&tags).unwrap_or_default(),
                    vault_id: r.get(5)?,
                })
            })?
            .collect::<Result<Vec<_>, _>>()?;

        // Tunnels
        let mut st_tun = c.prepare(
            "SELECT id, label, host_id, forward_type, local_host, local_port, remote_host, remote_port, updated_at, vault_id FROM tunnels",
        )?;
        let tunnels = st_tun
            .query_map([], |r| {
                Ok(TunnelConfig {
                    id: r.get(0)?,
                    label: r.get(1)?,
                    host_id: r.get(2)?,
                    forward_type: r.get(3)?,
                    local_host: r.get(4)?,
                    local_port: r.get(5)?,
                    remote_host: r.get(6)?,
                    remote_port: r.get(7)?,
                    updated_at: r.get(8)?,
                    vault_id: r.get(9)?,
                })
            })?
            .collect::<Result<Vec<_>, _>>()?;

        Ok(FullVaultArchive {
            version: 1,
            sender_device: sender_name.to_string(),
            vaults,
            hosts,
            keychain,
            snippets,
            tunnels,
        })
    })
}

fn restore_full_vault(
    vault: &Vault,
    archive: FullVaultArchive,
    peer_name: &str,
    peer_ip: &str,
    peer_pk: &str,
) -> AppResult<()> {
    vault.with(|c| {
        let now = chrono::Utc::now().timestamp();

        // 1. Vaults
        for v in &archive.vaults {
            c.execute(
                "INSERT INTO vaults(id, name, kind, color, description, created_at)
                 VALUES(?1, ?2, ?3, ?4, ?5, ?6)
                 ON CONFLICT(id) DO UPDATE SET name=?2, kind=?3, color=?4, description=?5",
                params![v.id, v.name, v.kind, v.color, v.description, v.created_at],
            )?;
        }

        // 2. Hosts & Secrets
        for (h, sec) in &archive.hosts {
            c.execute(
                "INSERT INTO hosts(id, label, hostname, port, username, auth_method, grp, tags, color, os, keychain_id, jump_host_id, vault_id, updated_at)
                 VALUES(?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14)
                 ON CONFLICT(id) DO UPDATE SET label=?2, hostname=?3, port=?4, username=?5, auth_method=?6,
                     grp=?7, tags=?8, color=?9, os=?10, keychain_id=?11, jump_host_id=?12, vault_id=?13, updated_at=?14",
                params![
                    h.id, h.label, h.hostname, h.port, h.username, h.auth_method.as_str(),
                    h.group, serde_json::to_string(&h.tags).unwrap_or_else(|_| "[]".into()),
                    h.color, h.os, h.keychain_id, h.jump_host_id, h.vault_id.as_deref().unwrap_or("personal"), now
                ],
            )?;
            if let Some(s) = sec {
                c.execute(
                    "INSERT INTO secrets(host_id, password, private_key, passphrase)
                     VALUES(?1, ?2, ?3, ?4)
                     ON CONFLICT(host_id) DO UPDATE SET password=?2, private_key=?3, passphrase=?4",
                    params![h.id, s.password, s.private_key, s.passphrase],
                )?;
            }
        }

        // 3. Keychain
        for (k, sec) in &archive.keychain {
            let (pwd, pkey, pass) = if let Some(s) = sec {
                (s.password.as_deref(), s.private_key.as_deref(), s.passphrase.as_deref())
            } else {
                (None, None, None)
            };
            c.execute(
                "INSERT INTO keychain(id, label, username, auth_method, password, private_key, passphrase, updated_at, vault_id)
                 VALUES(?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)
                 ON CONFLICT(id) DO UPDATE SET label=?2, username=?3, auth_method=?4, password=?5, private_key=?6, passphrase=?7, updated_at=?8, vault_id=?9",
                params![
                    k.id, k.label, k.username, k.auth_method.as_str(), pwd, pkey, pass,
                    k.updated_at, k.vault_id.as_deref().unwrap_or("personal")
                ],
            )?;
        }

        // 4. Snippets
        for sn in &archive.snippets {
            c.execute(
                "INSERT INTO snippets(id, name, command, folder, tags, vault_id, updated_at)
                 VALUES(?1, ?2, ?3, ?4, ?5, ?6, ?7)
                 ON CONFLICT(id) DO UPDATE SET name=?2, command=?3, folder=?4, tags=?5, vault_id=?6, updated_at=?7",
                params![
                    sn.id, sn.name, sn.command, sn.folder,
                    serde_json::to_string(&sn.tags).unwrap_or_else(|_| "[]".into()),
                    sn.vault_id.as_deref().unwrap_or("personal"), now
                ],
            )?;
        }

        // 5. Tunnels
        for t in &archive.tunnels {
            c.execute(
                "INSERT INTO tunnels(id, label, host_id, forward_type, local_host, local_port, remote_host, remote_port, updated_at, vault_id)
                 VALUES(?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)
                 ON CONFLICT(id) DO UPDATE SET label=?2, host_id=?3, forward_type=?4, local_host=?5, local_port=?6, remote_host=?7, remote_port=?8, updated_at=?9, vault_id=?10",
                params![
                    t.id, t.label, t.host_id, t.forward_type, t.local_host, t.local_port,
                    t.remote_host, t.remote_port, t.updated_at, t.vault_id.as_deref().unwrap_or("personal")
                ],
            )?;
        }

        // 6. Record paired device
        let dev_id = uuid::Uuid::new_v4().to_string();
        c.execute(
            "INSERT INTO paired_devices(id, device_name, device_type, ip_address, public_key, paired_at, last_sync)
             VALUES(?1, ?2, ?3, ?4, ?5, ?6, ?7)",
            params![dev_id, peer_name, "desktop", peer_ip, peer_pk, now, now],
        )?;

        Ok(())
    })
}

// ── Commands ──

#[tauri::command]
pub async fn pairing_start_host(
    app: AppHandle,
    manager: State<'_, PairingManager>,
) -> AppResult<PairingHostInfo> {
    // 1. Check if already hosting
    if let Some(existing) = manager.active_host.lock().clone() {
        return Ok(existing);
    }

    // 2. Bind TCP listener on 48291, or dynamic port if unavailable
    let listener = match TcpListener::bind("0.0.0.0:48291").await {
        Ok(l) => l,
        Err(_) => TcpListener::bind("0.0.0.0:0")
            .await
            .map_err(|e| AppError::Other(format!("Failed to bind pairing listener: {e}")))?,
    };

    let port = listener
        .local_addr()
        .map_err(|e| AppError::Other(e.to_string()))?
        .port();

    let local_ip = get_local_ip();
    let device_name = get_device_name();

    // 3. Generate 6-digit numeric PIN
    let pin: u32 = rand::thread_rng().gen_range(100_000..999_999);
    let pin_str = format!("{pin}");

    // 4. Generate X25519 static secret
    let mut rng = rand::thread_rng();
    let server_secret = StaticSecret::random_from_rng(&mut rng);
    let server_public = PublicKey::from(&server_secret);
    let server_pk_hex = hex::encode(server_public.as_bytes());

    let qr_payload = format!(
        "nxpair://{}:{}?pin={}&pk={}&name={}",
        local_ip,
        port,
        pin_str,
        server_pk_hex,
        device_name.replace(' ', "%20")
    );

    let info = PairingHostInfo {
        pin: pin_str.clone(),
        ip: local_ip.clone(),
        port,
        device_name: device_name.clone(),
        qr_payload,
    };

    *manager.active_host.lock() = Some(info.clone());

    let (shutdown_tx, mut shutdown_rx) = oneshot::channel::<()>();
    *manager.shutdown_tx.lock() = Some(shutdown_tx);

    let app_clone = app.clone();
    let expected_pin = pin_str;
    let s_name = device_name;
    let s_pk_hex = server_pk_hex;

    // Background listener task
    tokio::spawn(async move {
        loop {
            tokio::select! {
                _ = &mut shutdown_rx => {
                    log::info!("Pairing listener shut down via signal");
                    break;
                }
                res = listener.accept() => {
                    match res {
                        Ok((mut stream, peer_addr)) => {
                            let app_h = app_clone.clone();
                            let s_secret = server_secret.clone();
                            let s_pk = s_pk_hex.clone();
                            let s_dev = s_name.clone();
                            let exp_pin = expected_pin.clone();

                            tokio::spawn(async move {
                                let vault = app_h.state::<Vault>();
                                if let Err(e) = handle_incoming_pairing(
                                    &mut stream,
                                    peer_addr,
                                    &exp_pin,
                                    &s_secret,
                                    &s_pk,
                                    &s_dev,
                                    &vault,
                                    &app_h,
                                ).await {
                                    log::warn!("Pairing connection error: {e}");
                                }
                            });
                        }
                        Err(e) => {
                            log::warn!("Listener accept error: {e}");
                            break;
                        }
                    }
                }
            }
        }
    });

    Ok(info)
}

async fn handle_incoming_pairing(
    stream: &mut tokio::net::TcpStream,
    peer_addr: std::net::SocketAddr,
    expected_pin: &str,
    server_secret: &StaticSecret,
    server_pk_hex: &str,
    server_name: &str,
    vault: &Vault,
    app_handle: &AppHandle,
) -> AppResult<()> {
    let mut buf = vec![0u8; 65536];
    let mut n_total = 0;

    while n_total < buf.len() {
        let n = stream
            .read(&mut buf[n_total..])
            .await
            .map_err(|e| AppError::Other(e.to_string()))?;
        if n == 0 {
            break;
        }
        n_total += n;

        if let Some(pos) = buf[..n_total].windows(4).position(|w| w == b"\r\n\r\n") {
            let headers_str = String::from_utf8_lossy(&buf[..pos]);
            if headers_str.starts_with("OPTIONS") {
                let resp = "HTTP/1.1 204 No Content\r\nAccess-Control-Allow-Origin: *\r\nAccess-Control-Allow-Methods: POST, GET, OPTIONS\r\nAccess-Control-Allow-Headers: Content-Type\r\nConnection: close\r\n\r\n";
                stream.write_all(resp.as_bytes()).await.map_err(|e| AppError::Other(e.to_string()))?;
                return Ok(());
            }

            let mut content_len = 0;
            for line in headers_str.lines() {
                if line.to_ascii_lowercase().starts_with("content-length:") {
                    if let Some(len_str) = line.split(':').nth(1) {
                        content_len = len_str.trim().parse().unwrap_or(0);
                    }
                }
            }

            let body_start = pos + 4;
            if n_total - body_start >= content_len {
                let body_slice = &buf[body_start..body_start + content_len];
                let req: HandshakeRequest = serde_json::from_slice(body_slice)
                    .map_err(|e| AppError::Other(format!("Invalid pairing request JSON: {e}")))?;

                if req.pin != expected_pin {
                    let err_resp = "HTTP/1.1 403 Forbidden\r\nContent-Type: application/json\r\nConnection: close\r\n\r\n{\"error\":\"Invalid PIN\"}";
                    let _ = stream.write_all(err_resp.as_bytes()).await;
                    return Ok(());
                }

                // PIN matches! Derive shared secret
                let client_pk_raw = hex::decode(&req.client_public_key)
                    .map_err(|_| AppError::Crypto("Invalid client public key hex".into()))?;
                if client_pk_raw.len() != 32 {
                    return Err(AppError::Crypto("Client public key must be 32 bytes".into()));
                }
                let mut client_pk_arr = [0u8; 32];
                client_pk_arr.copy_from_slice(&client_pk_raw);
                let client_public = PublicKey::from(client_pk_arr);

                let shared_secret = server_secret.diffie_hellman(&client_public);

                // HKDF-SHA256(pin, shared_secret) -> XChaCha20 session key
                let hk = Hkdf::<Sha256>::new(Some(expected_pin.as_bytes()), shared_secret.as_bytes());
                let mut session_key = [0u8; 32];
                hk.expand(b"nexus/pair/v1", &mut session_key)
                    .map_err(|e| AppError::Crypto(e.to_string()))?;

                // Dump current vault archive
                let archive = dump_full_vault(vault, server_name)?;
                let archive_json = serde_json::to_vec(&archive)
                    .map_err(|e| AppError::Other(format!("Archive serialize error: {e}")))?;

                // Encrypt with session key
                let cipher = XChaCha20Poly1305::new((&session_key).into());
                let mut nonce_bytes = [0u8; 24];
                rand::thread_rng().fill_bytes(&mut nonce_bytes);
                let nonce = XNonce::from_slice(&nonce_bytes);

                let ct = cipher
                    .encrypt(nonce, archive_json.as_ref())
                    .map_err(|e| AppError::Crypto(format!("Pairing encryption failed: {e}")))?;

                // Record peer in paired_devices
                let now = chrono::Utc::now().timestamp();
                let dev_id = uuid::Uuid::new_v4().to_string();
                let _ = vault.with(|c| {
                    c.execute(
                        "INSERT INTO paired_devices(id, device_name, device_type, ip_address, public_key, paired_at, last_sync)
                         VALUES(?1, ?2, ?3, ?4, ?5, ?6, ?7)",
                        params![dev_id, req.client_device_name, req.client_os, peer_addr.ip().to_string(), req.client_public_key, now, now],
                    )?;
                    Ok(())
                });

                let resp_obj = HandshakeResponse {
                    status: "ok".into(),
                    server_public_key: server_pk_hex.to_string(),
                    nonce: hex::encode(nonce_bytes),
                    encrypted_payload: B64.encode(ct),
                    server_device_name: server_name.to_string(),
                };

                let resp_body = serde_json::to_vec(&resp_obj)
                    .map_err(|e| AppError::Other(e.to_string()))?;

                let http_resp = format!(
                    "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nAccess-Control-Allow-Origin: *\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
                    resp_body.len()
                );

                stream.write_all(http_resp.as_bytes()).await.map_err(|e| AppError::Other(e.to_string()))?;
                stream.write_all(&resp_body).await.map_err(|e| AppError::Other(e.to_string()))?;
                stream.flush().await.map_err(|e| AppError::Other(e.to_string()))?;

                // Notify frontend of successful pairing
                let _ = app_handle.emit(
                    "pairing-success",
                    serde_json::json!({
                        "deviceName": req.client_device_name,
                        "ip": peer_addr.ip().to_string(),
                    }),
                );

                return Ok(());
            }
        }
    }

    Ok(())
}

#[tauri::command]
pub async fn pairing_stop_host(manager: State<'_, PairingManager>) -> AppResult<()> {
    if let Some(tx) = manager.shutdown_tx.lock().take() {
        let _ = tx.send(());
    }
    *manager.active_host.lock() = None;
    Ok(())
}

#[tauri::command]
pub async fn pairing_join_client(
    target_host: String,
    port: u16,
    pin: String,
    device_name: Option<String>,
    vault: State<'_, Vault>,
) -> AppResult<PairingJoinResult> {
    let clean_pin = pin.replace('-', "").trim().to_string();
    let my_device_name = device_name.unwrap_or_else(get_device_name);

    // 1. Generate client X25519 keypair
    let (client_secret, client_pk_hex) = {
        let mut rng = rand::thread_rng();
        let sec = StaticSecret::random_from_rng(&mut rng);
        let pubk = PublicKey::from(&sec);
        (sec, hex::encode(pubk.as_bytes()))
    };

    // 2. Connect to host
    let url = format!("http://{}:{}/pair/handshake", target_host, port);
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(10))
        .build()
        .map_err(|e| AppError::Network(e.to_string()))?;

    let req_body = HandshakeRequest {
        pin: clean_pin.clone(),
        client_public_key: client_pk_hex,
        client_device_name: my_device_name,
        client_os: std::env::consts::OS.to_string(),
    };

    let resp = client
        .post(&url)
        .json(&req_body)
        .send()
        .await
        .map_err(|e| AppError::Network(format!("Failed to connect to host {target_host}:{port} — {e}")))?;

    if resp.status() == reqwest::StatusCode::FORBIDDEN {
        return Err(AppError::Other("Incorrect 6-digit PIN code. Please verify the code displayed on your host device.".into()));
    }

    if !resp.status().is_success() {
        return Err(AppError::Network(format!("Pairing rejected by host: HTTP {}", resp.status())));
    }

    let handshake_resp: HandshakeResponse = resp
        .json()
        .await
        .map_err(|e| AppError::Network(format!("Failed to read handshake response: {e}")))?;

    // 3. Compute shared secret
    let server_pk_raw = hex::decode(&handshake_resp.server_public_key)
        .map_err(|_| AppError::Crypto("Invalid server public key".into()))?;
    if server_pk_raw.len() != 32 {
        return Err(AppError::Crypto("Server public key must be 32 bytes".into()));
    }
    let mut server_pk_arr = [0u8; 32];
    server_pk_arr.copy_from_slice(&server_pk_raw);
    let server_public = PublicKey::from(server_pk_arr);

    let shared_secret = client_secret.diffie_hellman(&server_public);

    // 4. Derive session key using HKDF-SHA256(pin, shared_secret)
    let hk = Hkdf::<Sha256>::new(Some(clean_pin.as_bytes()), shared_secret.as_bytes());
    let mut session_key = [0u8; 32];
    hk.expand(b"nexus/pair/v1", &mut session_key)
        .map_err(|e| AppError::Crypto(e.to_string()))?;

    // 5. Decrypt archive
    let nonce_raw = hex::decode(&handshake_resp.nonce)
        .map_err(|_| AppError::Crypto("Invalid nonce hex".into()))?;
    if nonce_raw.len() != 24 {
        return Err(AppError::Crypto("Nonce must be 24 bytes".into()));
    }
    let nonce = XNonce::from_slice(&nonce_raw);

    let ciphertext = B64
        .decode(&handshake_resp.encrypted_payload)
        .map_err(|_| AppError::Crypto("Invalid ciphertext base64".into()))?;

    let cipher = XChaCha20Poly1305::new((&session_key).into());
    let plaintext = cipher
        .decrypt(nonce, ciphertext.as_ref())
        .map_err(|_| AppError::Crypto("Failed to decrypt vault archive from peer".into()))?;

    let archive: FullVaultArchive = serde_json::from_slice(&plaintext)
        .map_err(|e| AppError::Other(format!("Failed to deserialize vault archive: {e}")))?;

    let vaults_count = archive.vaults.len();
    let hosts_count = archive.hosts.len();
    let keys_count = archive.keychain.len();
    let snippets_count = archive.snippets.len();

    // 6. Write archive to local database
    restore_full_vault(
        &vault,
        archive,
        &handshake_resp.server_device_name,
        &target_host,
        &handshake_resp.server_public_key,
    )?;

    Ok(PairingJoinResult {
        success: true,
        server_device_name: handshake_resp.server_device_name,
        vaults_count,
        hosts_count,
        keys_count,
        snippets_count,
    })
}

#[tauri::command]
pub fn pairing_list_devices(vault: State<'_, Vault>) -> AppResult<Vec<PairedDevice>> {
    vault.with(|c| {
        let mut st = c.prepare(
            "SELECT id, device_name, device_type, ip_address, public_key, paired_at, last_sync
             FROM paired_devices ORDER BY last_sync DESC",
        )?;
        let items = st
            .query_map([], |r| {
                Ok(PairedDevice {
                    id: r.get(0)?,
                    device_name: r.get(1)?,
                    device_type: r.get(2)?,
                    ip_address: r.get(3)?,
                    public_key: r.get(4)?,
                    paired_at: r.get(5)?,
                    last_sync: r.get(6)?,
                })
            })?
            .collect::<Result<Vec<_>, _>>()?;
        Ok(items)
    })
}

#[tauri::command]
pub fn pairing_revoke_device(id: String, vault: State<'_, Vault>) -> AppResult<()> {
    vault.with(|c| {
        c.execute("DELETE FROM paired_devices WHERE id = ?1", params![id])?;
        Ok(())
    })
}

#[tauri::command]
pub fn pairing_get_local_info() -> AppResult<LocalDeviceInfo> {
    Ok(LocalDeviceInfo {
        device_name: get_device_name(),
        os: std::env::consts::OS.to_string(),
        ip: get_local_ip(),
    })
}
