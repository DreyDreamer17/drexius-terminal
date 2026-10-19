//! Direct Device-to-Device Pairing & LAN Sync (X25519 ECDH + HKDF + XChaCha20-Poly1305)
//!
//! Enables zero-cloud, direct device-to-device pairing between two DrexiusTerminal instances
//! over local Wi-Fi or LAN. Device A shows a QR code + 6-digit PIN and runs an ephemeral listener.
//! Device B connects with the PIN, executes an authenticated X25519 key exchange,
//! and clones the vault database directly device-to-device.

use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::Arc;
use std::time::Duration;

const MAX_PAIRING_ATTEMPTS: u32 = 5;
const PAIRING_TIMEOUT_SECS: u64 = 600;
const MAX_PAIRING_CONNECTIONS: usize = 8;
const PAIRING_HANDSHAKE_TIMEOUT: Duration = Duration::from_secs(10);
const MAX_PAIRING_BODY_SIZE: usize = 64 * 1024;
const MAX_PAIRING_CIPHERTEXT_SIZE: usize = 50 * 1024 * 1024;

use base64::engine::general_purpose::STANDARD as B64;
use base64::Engine;
use chacha20poly1305::{
    aead::{Aead, KeyInit},
    XChaCha20Poly1305, XNonce,
};
use hkdf::Hkdf;
use hmac::{Hmac, Mac};
use parking_lot::Mutex;
use rand::{Rng, RngCore};
use rusqlite::{params, OptionalExtension};
use serde::{Deserialize, Serialize};
use sha2::Sha256;

type HmacSha256 = Hmac<Sha256>;
use tauri::{AppHandle, Emitter, Manager, State};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpListener;
use tokio::sync::oneshot;
use x25519_dalek::{PublicKey, StaticSecret};

use crate::error::{AppError, AppResult};
use crate::vault::{
    AiProviderConfig, AuthMethod, HostProfile, KeychainItem, PairedDevice, Snippet,
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
    pub sync_ready: bool,
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
    /// Client's ephemeral X25519 public key (hex).
    pub client_public_key: String,
    /// HMAC proof of PIN knowledge, bound to the ECDH secret and both public keys (hex).
    /// The PIN itself is never sent on the wire.
    pub client_proof: String,
    pub client_device_name: String,
    pub client_os: String,
    /// Stable per-device identity (the client's `sync_device_id`), used for the
    /// revocation blocklist. Legacy clients omit it (empty).
    #[serde(default)]
    pub client_device_id: String,
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

#[derive(Default, Clone, Serialize, Deserialize, zeroize::Zeroize, zeroize::ZeroizeOnDrop)]
#[serde(rename_all = "camelCase")]
struct PairingSecretDto {
    pub password: Option<String>,
    pub private_key: Option<String>,
    pub passphrase: Option<String>,
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct FullVaultArchive {
    pub version: u32,
    pub sender_device: String,
    pub vaults: Vec<VaultRecord>,
    pub hosts: Vec<(HostProfile, Option<PairingSecretDto>)>,
    pub keychain: Vec<(KeychainItem, Option<PairingSecretDto>)>,
    pub snippets: Vec<Snippet>,
    pub tunnels: Vec<TunnelConfig>,
    #[serde(default)]
    pub ai_configs: Vec<AiProviderConfig>,
    /// v2 enrollment, present only if the sender has configured relay sync.
    /// The entire archive is sealed under the authenticated pairing key.
    #[serde(default)]
    pub sync_seed: Option<String>,
    #[serde(default)]
    pub sync_relay_url: Option<String>,
    #[serde(default)]
    pub sync_relay_token: Option<String>,
    /// Last successfully applied relay cursor on the source. The snapshot
    /// already includes every change through this cursor.
    #[serde(default)]
    pub sync_cursor: Option<u64>,
}

struct PairingInner {
    generation: u64,
    active: Option<PairingHostInfo>,
    shutdown: Option<oneshot::Sender<()>>,
}

pub struct PairingManager {
    inner: Mutex<PairingInner>,
}

impl Default for PairingManager {
    fn default() -> Self {
        Self {
            inner: Mutex::new(PairingInner {
                generation: 0,
                active: None,
                shutdown: None,
            }),
        }
    }
}

impl PairingManager {
    fn active_cloned(&self) -> Option<PairingHostInfo> {
        self.inner.lock().active.clone()
    }
    /// Atomically install a new session (generation already claimed).
    /// Returns Ok(info) if installed or if another completed start won the
    /// race (idempotent reuse), Err if superseded by a newer generation.
    fn install(&self, generation: u64, info: PairingHostInfo, tx: oneshot::Sender<()>) -> AppResult<PairingHostInfo> {
        let mut inner = self.inner.lock();
        if inner.generation != generation {
            return Err(AppError::Other(
                "Pairing start superseded by a newer session".into(),
            ));
        }
        if let Some(existing) = inner.active.clone() {
            return Ok(existing);
        }
        inner.active = Some(info.clone());
        inner.shutdown = Some(tx);
        Ok(info)
    }
    /// Take shutdown sender + clear active only if `generation` still owns
    /// the session. Returns true if this caller owned the session.
    fn take_if_owner(&self, generation: u64) -> Option<oneshot::Sender<()>> {
        let mut inner = self.inner.lock();
        if inner.generation != generation {
            return None;
        }
        inner.active = None;
        inner.shutdown.take()
    }
    fn clear_if_owner(&self, generation: u64) {
        let mut inner = self.inner.lock();
        if inner.generation == generation {
            inner.active = None;
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
                .unwrap_or_else(|_| "DrexiusDevice".to_string())
        });
    let os = std::env::consts::OS;
    format!("{} ({})", host, os)
}

/// Derives the proof key and the session key from the ECDH secret, salted with the PIN.
/// Only a party holding the matching X25519 secret can derive either key.
fn derive_pairing_keys(pin: &str, shared: &[u8; 32]) -> AppResult<([u8; 32], [u8; 32])> {
    let hk = Hkdf::<Sha256>::new(Some(pin.as_bytes()), shared);
    let mut auth_key = [0u8; 32];
    let mut session_key = [0u8; 32];
    hk.expand(b"drexius/pair/v2/auth", &mut auth_key)
        .map_err(|e| AppError::Crypto(e.to_string()))?;
    hk.expand(b"drexius/pair/v2/session", &mut session_key)
        .map_err(|e| AppError::Crypto(e.to_string()))?;
    Ok((auth_key, session_key))
}

/// MAC over the handshake transcript, keyed by the auth key. The client uses it to prove PIN knowledge.
fn client_proof_mac(auth_key: &[u8; 32], client_pk: &[u8], server_pk: &[u8]) -> AppResult<HmacSha256> {
    let mut mac = <HmacSha256 as Mac>::new_from_slice(auth_key).map_err(|e| AppError::Crypto(e.to_string()))?;
    mac.update(b"drexius/pair/v2/client-proof");
    mac.update(client_pk);
    mac.update(server_pk);
    Ok(mac)
}

fn parse_x25519_public(hex_str: &str) -> AppResult<PublicKey> {
    let raw = hex::decode(hex_str.trim()).map_err(|_| AppError::Crypto("Invalid public key hex".into()))?;
    if raw.len() != 32 {
        return Err(AppError::Crypto("Public key must be 32 bytes".into()));
    }
    let mut arr = [0u8; 32];
    arr.copy_from_slice(&raw);
    Ok(PublicKey::from(arr))
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
                    h.color, h.os, h.keychain_id, h.jump_host_id, h.vault_id, h.startup_command, h.proxy_command,
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
                    startup_command: r.get(13)?,
                    proxy_command: r.get(14)?,
                    has_secret: false,
                };
                let pwd: Option<String> = r.get(15)?;
                let key: Option<String> = r.get(16)?;
                let pass: Option<String> = r.get(17)?;
                let secret = if pwd.is_some() || key.is_some() || pass.is_some() {
                    Some(PairingSecretDto {
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
                    Some(PairingSecretDto {
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

        // AI Configs: strip API keys and proxy URLs to ensure credentials never leak over LAN pairing
        let ai_configs = crate::vault::query_all_ai_configs(c)?
            .into_iter()
            .map(|mut cfg| {
                cfg.api_keys.clear();
                cfg.proxy_urls.clear();
                cfg
            })
            .collect();

        let sync_seed = crate::sync::sync_seed_if_configured(c)?;
        let (sync_relay_url, sync_relay_token) = if sync_seed.is_some() {
            let url: Option<String> = c.query_row(
                "SELECT value FROM ai_settings WHERE key='sync_relay_url'", [], |r| r.get(0),
            ).optional()?;
            let token: Option<String> = c.query_row(
                "SELECT value FROM ai_settings WHERE key='sync_device_token'", [], |r| r.get(0),
            ).optional()?;
            (url, token)
        } else { (None, None) };

        let sync_cursor = if sync_seed.is_some() {
            c.query_row("SELECT value FROM ai_settings WHERE key='sync_cursor_v2'", [], |r| r.get::<_, String>(0))
                .optional()?.and_then(|v| v.parse::<u64>().ok())
        } else { None };

        Ok(FullVaultArchive {
            version: 2,
            sender_device: sender_name.to_string(),
            vaults,
            hosts,
            keychain,
            snippets,
            tunnels,
            ai_configs,
            sync_seed,
            sync_relay_url,
            sync_relay_token,
            sync_cursor,
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
        let tx = c.unchecked_transaction()?;
        let now = chrono::Utc::now().timestamp();

        // Never merge a foreign sync group with existing data. Enroll only a
        // fresh vault or a device already carrying exactly this group seed.
        if let Some(ref incoming) = archive.sync_seed {
            if hex::decode(incoming).map(|v| v.len() != 32).unwrap_or(true) {
                return Err(AppError::Crypto("Invalid pairing sync seed".into()));
            }
            let url = archive.sync_relay_url.as_deref().ok_or_else(||
                AppError::Crypto("Pairing sync seed has no relay URL".into()))?;
            if !crate::sync::relay_url_is_allowed(url) {
                return Err(AppError::Crypto("Pairing relay URL is not allowed".into()));
            }
            let existing: Option<String> = tx.query_row(
                "SELECT value FROM ai_settings WHERE key='sync_seed_v2'", [], |r| r.get(0),
            ).optional()?;
            if let Some(seed) = existing {
                if seed.as_str() != incoming.as_str() {
                    return Err(AppError::Crypto("This vault belongs to a different sync group. Join from a new, empty vault instead.".into()));
                }
            } else {
                let existing_data: i64 = tx.query_row(
                    "SELECT (SELECT count(*) FROM hosts) + (SELECT count(*) FROM keychain) +
                            (SELECT count(*) FROM snippets) + (SELECT count(*) FROM tunnels)",
                    [], |r| r.get(0),
                )?;
                if existing_data != 0 {
                    return Err(AppError::Other("Sync enrollment requires an empty vault; existing data would conflict. This device was not changed.".into()));
                }
            }
        } else {
            let enrolled: Option<String> = tx.query_row(
                "SELECT value FROM ai_settings WHERE key='sync_seed_v2'", [], |r| r.get(0),
            ).optional()?;
            if enrolled.is_some() {
                return Err(AppError::Other("Cannot merge a one-time snapshot into an enrolled sync vault. This device was not changed.".into()));
            }
        }

        // 1. Vaults
        for v in &archive.vaults {
            tx.execute(
                "INSERT INTO vaults(id, name, kind, color, description, created_at)
                 VALUES(?1, ?2, ?3, ?4, ?5, ?6)
                 ON CONFLICT(id) DO UPDATE SET name=?2, kind=?3, color=?4, description=?5",
                params![v.id, v.name, v.kind, v.color, v.description, v.created_at],
            )?;
            crate::vault::log_sync_mutation(&tx, "vaults", &v.id)?;
        }

        // 2. Keychain (restored before hosts so foreign keys resolve)
        for (k, sec) in &archive.keychain {
            let (pwd, pkey, pass) = if let Some(s) = sec {
                (s.password.as_deref(), s.private_key.as_deref(), s.passphrase.as_deref())
            } else {
                (None, None, None)
            };
            tx.execute(
                "INSERT INTO keychain(id, label, username, auth_method, password, private_key, passphrase, updated_at, vault_id)
                 VALUES(?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)
                 ON CONFLICT(id) DO UPDATE SET label=?2, username=?3, auth_method=?4,
                     password=COALESCE(?5, password), private_key=COALESCE(?6, private_key),
                     passphrase=COALESCE(?7, passphrase), updated_at=?8, vault_id=?9",
                params![
                    k.id, k.label, k.username, k.auth_method.as_str(), pwd, pkey, pass,
                    k.updated_at, k.vault_id.as_deref().unwrap_or("personal")
                ],
            )?;
            crate::vault::log_sync_mutation(&tx, "keychain", &k.id)?;
        }

        // 3. Hosts & Secrets
        for (h, sec) in &archive.hosts {
            tx.execute(
                "INSERT INTO hosts(id, label, hostname, port, username, auth_method, grp, tags, color, os, keychain_id, jump_host_id, vault_id, startup_command, proxy_command, updated_at)
                 VALUES(?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16)
                 ON CONFLICT(id) DO UPDATE SET label=?2, hostname=?3, port=?4, username=?5, auth_method=?6,
                     grp=?7, tags=?8, color=?9, os=?10, keychain_id=?11, jump_host_id=?12, vault_id=?13, startup_command=?14, proxy_command=?15, updated_at=?16",
                params![
                    h.id, h.label, h.hostname, h.port, h.username, h.auth_method.as_str(),
                    h.group, serde_json::to_string(&h.tags).unwrap_or_else(|_| "[]".into()),
                    h.color, h.os, h.keychain_id, h.jump_host_id, h.vault_id.as_deref().unwrap_or("personal"),
                    h.startup_command,
                    h.proxy_command,
                    now
                ],
            )?;
            if let Some(s) = sec {
                tx.execute(
                    "INSERT INTO secrets(host_id, password, private_key, passphrase)
                     VALUES(?1, ?2, ?3, ?4)
                     ON CONFLICT(host_id) DO UPDATE SET password=COALESCE(?2, password),
                     private_key=COALESCE(?3, private_key), passphrase=COALESCE(?4, passphrase)",
                    params![h.id, s.password, s.private_key, s.passphrase],
                )?;
            }
            // Single-source invariant: only drop host secret if keychain identity actually exists
            if let Some(ref kid) = h.keychain_id.as_deref().filter(|v| !v.is_empty()) {
                let kc_exists: bool = tx
                    .query_row("SELECT 1 FROM keychain WHERE id=?1", [kid], |_| Ok(true))
                    .optional()?
                    .unwrap_or(false);
                if kc_exists {
                    tx.execute("DELETE FROM secrets WHERE host_id = ?1", [&h.id])?;
                } else {
                    tx.execute("UPDATE hosts SET keychain_id = NULL WHERE id = ?1", [&h.id])?;
                }
            }
            crate::vault::log_sync_mutation(&tx, "hosts", &h.id)?;
        }

        // 4. Snippets
        for sn in &archive.snippets {
            tx.execute(
                "INSERT INTO snippets(id, name, command, folder, tags, vault_id, updated_at)
                 VALUES(?1, ?2, ?3, ?4, ?5, ?6, ?7)
                 ON CONFLICT(id) DO UPDATE SET name=?2, command=?3, folder=?4, tags=?5, vault_id=?6, updated_at=?7",
                params![
                    sn.id, sn.name, sn.command, sn.folder,
                    serde_json::to_string(&sn.tags).unwrap_or_else(|_| "[]".into()),
                    sn.vault_id.as_deref().unwrap_or("personal"), now
                ],
            )?;
            crate::vault::log_sync_mutation(&tx, "snippets", &sn.id)?;
        }

        // 5. Tunnels
        for t in &archive.tunnels {
            tx.execute(
                "INSERT INTO tunnels(id, label, host_id, forward_type, local_host, local_port, remote_host, remote_port, updated_at, vault_id)
                 VALUES(?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)
                 ON CONFLICT(id) DO UPDATE SET label=?2, host_id=?3, forward_type=?4, local_host=?5, local_port=?6, remote_host=?7, remote_port=?8, updated_at=?9, vault_id=?10",
                params![
                    t.id, t.label, t.host_id, t.forward_type, t.local_host, t.local_port,
                    t.remote_host, t.remote_port, t.updated_at, t.vault_id.as_deref().unwrap_or("personal")
                ],
            )?;
            crate::vault::log_sync_mutation(&tx, "tunnels", &t.id)?;
        }

        // 6. AI Configs - preserve existing api_keys and proxy_urls only if origin matches
        for ai in &archive.ai_configs {
            let existing_base: Option<String> = tx
                .query_row(
                    "SELECT base_url FROM ai_configs WHERE provider_id = ?1",
                    [&ai.provider_id],
                    |r| r.get(0),
                )
                .optional()?
                .flatten();

            let parse_origin = |s: &str| {
                reqwest::Url::parse(s.trim())
                    .ok()
                    .map(|u| (u.scheme().to_string(), u.host_str().map(str::to_ascii_lowercase), u.port_or_known_default()))
            };

            let origin_matches = match &existing_base {
                Some(old_base) => parse_origin(old_base) == parse_origin(&ai.base_url),
                None => true,
            };

            // If origin changed and incoming archive has empty keys/proxies, retain the receiver's existing base_url
            // to avoid sending preserved local credentials/proxies to an untrusted endpoint.
            let effective_base_url = match &existing_base {
                Some(old_base) if !origin_matches && ai.api_keys.is_empty() => old_base.clone(),
                _ => ai.base_url.clone(),
            };

            let keys_json = serde_json::to_string(&ai.api_keys).unwrap_or_else(|_| "[]".into());
            let cache_json = serde_json::to_string(&ai.models_cache).unwrap_or_else(|_| "[]".into());
            let proxies_json = serde_json::to_string(&ai.proxy_urls).unwrap_or_else(|_| "[]".into());
            tx.execute(
                "INSERT INTO ai_configs(provider_id, name, base_url, api_keys, selected_model, models_cache, balance_strategy, enabled, updated_at, use_proxies, proxy_urls, proxy_strategy, auto_ssh_proxy, auto_ssh_host_id)
                 VALUES(?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14)
                 ON CONFLICT(provider_id) DO UPDATE SET name=?2, base_url=?3,
                     api_keys=CASE WHEN ?4 != '[]' AND ?4 != '' THEN ?4 ELSE ai_configs.api_keys END,
                     selected_model=?5, models_cache=?6, balance_strategy=?7, enabled=?8, updated_at=?9, use_proxies=?10,
                     proxy_urls=CASE WHEN ?11 != '[]' AND ?11 != '' THEN ?11 ELSE ai_configs.proxy_urls END,
                     proxy_strategy=?12, auto_ssh_proxy=?13, auto_ssh_host_id=?14",
                params![
                    ai.provider_id, ai.name, effective_base_url, keys_json,
                    ai.selected_model, cache_json, ai.balance_strategy,
                    if ai.enabled { 1 } else { 0 }, now,
                    if ai.use_proxies { 1 } else { 0 }, proxies_json, ai.proxy_strategy,
                    if ai.auto_ssh_proxy { 1 } else { 0 }, ai.auto_ssh_host_id
                ],
            )?;
        }

        // 7. Record paired device
        let dev_id = uuid::Uuid::new_v4().to_string();
        tx.execute(
            "INSERT INTO paired_devices(id, device_name, device_type, ip_address, public_key, paired_at, last_sync)
             VALUES(?1, ?2, ?3, ?4, ?5, ?6, ?7)",
            params![dev_id, peer_name, "desktop", peer_ip, peer_pk, now, now],
        )?;

        if let Some(ref seed) = archive.sync_seed {
            tx.execute(
                "INSERT INTO ai_settings(key,value) VALUES('sync_seed_v2',?1)
                 ON CONFLICT(key) DO UPDATE SET value=?1", [seed.as_str()],
            )?;
            if let Some(ref url) = archive.sync_relay_url {
                tx.execute(
                    "INSERT INTO ai_settings(key,value) VALUES('sync_relay_url',?1)
                     ON CONFLICT(key) DO UPDATE SET value=?1", [url.as_str()],
                )?;
            }
            if let Some(ref token) = archive.sync_relay_token {
                tx.execute(
                    "INSERT INTO ai_settings(key,value) VALUES('sync_device_token',?1)
                     ON CONFLICT(key) DO UPDATE SET value=?1", [token.as_str()],
                )?;
            }
            if let Some(source_cursor) = archive.sync_cursor {
                let current: Option<String> = tx.query_row(
                    "SELECT value FROM ai_settings WHERE key='sync_cursor_v2'", [], |r| r.get(0),
                ).optional()?;
                let next = source_cursor.max(current.and_then(|v| v.parse::<u64>().ok()).unwrap_or(0));
                tx.execute(
                    "INSERT INTO ai_settings(key,value) VALUES('sync_cursor_v2',?1)
                     ON CONFLICT(key) DO UPDATE SET value=?1", [next.to_string()],
                )?;
            }
        }
        tx.commit()?;
        Ok(())
    })
}

// ── Commands ──

#[tauri::command]
pub async fn pairing_start_host(
    app: AppHandle,
    manager: State<'_, PairingManager>,
) -> AppResult<PairingHostInfo> {
    // Fast path: already hosting (no generation bump; idempotent reuse).
    if let Some(existing) = manager.active_cloned() {
        return Ok(existing);
    }
    // Claim a session generation before the await points so overlapping
    // starts/stops can be ordered. A stop bumps the generation, invalidating
    // any in-flight start that has not yet installed its listener.
    let generation = {
        let mut inner = manager.inner.lock();
        inner.generation += 1;
        inner.generation
    };

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
        "drxpair://{}:{}?pin={}&pk={}&name={}",
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

    // Install session atomically (generation + active + shutdown under one
    // lock) so a concurrent stop cannot slip between publishing active_host
    // and storing the shutdown sender, which previously left an orphan listener.
    let (shutdown_tx, mut shutdown_rx) = oneshot::channel::<()>();
    let installed_info = manager.install(generation, info, shutdown_tx)?;
    if installed_info.pin != pin_str {
        // Another completed start won while we were binding; drop our
        // listener and reuse the winner (idempotent).
        return Ok(installed_info);
    }

    let app_clone = app.clone();
    let expected_pin = pin_str;
    let s_name = device_name;
    let s_pk_hex = server_pk_hex;
    let failed_attempts = Arc::new(AtomicU32::new(0));
    let permits = Arc::new(tokio::sync::Semaphore::new(MAX_PAIRING_CONNECTIONS));

    // Background listener task with auto-expiry and rate limiting
    tokio::spawn(async move {
        let session_gen = generation;
        let timeout = tokio::time::sleep(Duration::from_secs(PAIRING_TIMEOUT_SECS));
        tokio::pin!(timeout);

        loop {
            tokio::select! {
                _ = &mut shutdown_rx => {
                    log::info!("Pairing listener shut down via signal");
                    break;
                }
                _ = &mut timeout => {
                    log::info!("Pairing listener timed out after {} seconds", PAIRING_TIMEOUT_SECS);
                    let _ = app_clone.emit("pairing-expired", ());
                    break;
                }
                res = listener.accept() => {
                    match res {
                        Ok((mut stream, peer_addr)) => {
                            let permit = match permits.clone().try_acquire_owned() {
                                Ok(p) => p,
                                Err(_) => {
                                    log::warn!("Rejecting pairing connection from {peer_addr}: max concurrent pairing connections ({MAX_PAIRING_CONNECTIONS}) reached");
                                    let _ = stream.write_all(b"HTTP/1.1 503 Service Unavailable\r\nConnection: close\r\n\r\n").await;
                                    continue;
                                }
                            };

                            if failed_attempts.load(Ordering::SeqCst) >= MAX_PAIRING_ATTEMPTS {
                                log::warn!("Rejecting connection: max pairing attempts exceeded");
                                let err_resp = "HTTP/1.1 429 Too Many Requests\r\nContent-Type: application/json\r\nConnection: close\r\n\r\n{\"error\":\"Too many failed attempts. Pairing session locked.\"}";
                                let _ = stream.write_all(err_resp.as_bytes()).await;
                                continue;
                            }

                            let app_h = app_clone.clone();
                            let s_secret = server_secret.clone();
                            let s_pk = s_pk_hex.clone();
                            let s_dev = s_name.clone();
                            let exp_pin = expected_pin.clone();
                            let attempts_clone = failed_attempts.clone();
                            let hs_gen = session_gen;

                            tokio::spawn(async move {
                                let _permit = permit;
                                let vault = app_h.state::<Vault>();
                                match tokio::time::timeout(
                                    PAIRING_HANDSHAKE_TIMEOUT,
                                    handle_incoming_pairing(
                                        &mut stream,
                                        peer_addr,
                                        &exp_pin,
                                        &attempts_clone,
                                        &s_secret,
                                        &s_pk,
                                        &s_dev,
                                        &vault,
                                        &app_h,
                                        hs_gen,
                                    ),
                                ).await {
                                    Ok(Err(e)) => log::warn!("Pairing connection error from {peer_addr}: {e}"),
                                    Err(_) => {
                                        log::warn!("Pairing handshake timed out from {peer_addr}");
                                        let _ = stream.write_all(b"HTTP/1.1 408 Request Timeout\r\nConnection: close\r\n\r\n").await;
                                    }
                                    Ok(Ok(())) => {}
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
        let mgr = app_clone.state::<PairingManager>();
        // Only clear global state if this listener still owns the session.
        // A newer start would otherwise be wiped by an old listener exiting.
        mgr.clear_if_owner(session_gen);
    });

    Ok(installed_info)
}

async fn handle_incoming_pairing(
    stream: &mut tokio::net::TcpStream,
    peer_addr: std::net::SocketAddr,
    expected_pin: &str,
    failed_attempts: &Arc<AtomicU32>,
    server_secret: &StaticSecret,
    server_pk_hex: &str,
    server_name: &str,
    vault: &Vault,
    app_handle: &AppHandle,
    session_gen: u64,
) -> AppResult<()> {
    let mut buf = vec![0u8; 65536];
    let mut n_total = 0;
    let mut scan_from = 0usize;
    let mut header_pos = None;
    let mut content_len = 0;

    while n_total < buf.len() {
        let n = stream
            .read(&mut buf[n_total..])
            .await
            .map_err(|e| AppError::Other(e.to_string()))?;
        if n == 0 {
            break;
        }
        n_total += n;

        if header_pos.is_none() {
            if n_total >= 4 && scan_from + 3 <= n_total {
                if let Some(pos_rel) = buf[scan_from..n_total].windows(4).position(|w| w == b"\r\n\r\n") {
                    let pos = scan_from + pos_rel;
                    header_pos = Some(pos);
                    let headers_str = String::from_utf8_lossy(&buf[..pos]);
                    if headers_str.starts_with("OPTIONS") {
                        // No CORS headers: this is a native-client protocol, not a browser API.
                        let resp = "HTTP/1.1 204 No Content\r\nConnection: close\r\n\r\n";
                        stream.write_all(resp.as_bytes()).await.map_err(|e| AppError::Other(e.to_string()))?;
                        return Ok(());
                    }

                    for line in headers_str.lines() {
                        if line.to_ascii_lowercase().starts_with("content-length:") {
                            if let Some(len_str) = line.split(':').nth(1) {
                                content_len = len_str.trim().parse().unwrap_or(0);
                            }
                        }
                    }
                    if content_len > MAX_PAIRING_BODY_SIZE {
                        let err_resp = "HTTP/1.1 413 Payload Too Large\r\nConnection: close\r\n\r\n";
                        let _ = stream.write_all(err_resp.as_bytes()).await;
                        return Err(AppError::Other(format!("Pairing payload exceeds maximum allowed size ({content_len} > {MAX_PAIRING_BODY_SIZE})")));
                    }
                } else {
                    scan_from = n_total.saturating_sub(3);
                }
            }
        }

        if let Some(pos) = header_pos {
            let body_start = pos + 4;
            if body_start + content_len > buf.len() {
                let err_resp = "HTTP/1.1 413 Payload Too Large\r\nConnection: close\r\n\r\n";
                let _ = stream.write_all(err_resp.as_bytes()).await;
                return Err(AppError::Other("Pairing request body exceeds buffer size".into()));
            }
            if n_total - body_start >= content_len {
                let body_slice = &buf[body_start..body_start + content_len];
                let req: HandshakeRequest = serde_json::from_slice(body_slice)
                    .map_err(|e| AppError::Other(format!("Invalid pairing request JSON: {e}")))?;

                if failed_attempts.load(Ordering::SeqCst) >= MAX_PAIRING_ATTEMPTS {
                    let err_resp = "HTTP/1.1 429 Too Many Requests\r\nContent-Type: application/json\r\nConnection: close\r\n\r\n{\"error\":\"Too many failed attempts. Pairing session locked.\"}";
                    let _ = stream.write_all(err_resp.as_bytes()).await;
                    return Ok(());
                }

                // Derive keys from the ECDH secret, salted with the PIN. The client must prove PIN knowledge
                // with a MAC over the transcript. A MITM without the host's secret can't produce a valid proof.
                let client_public = parse_x25519_public(&req.client_public_key)?;
                let shared = server_secret.diffie_hellman(&client_public);
                if shared.as_bytes().iter().all(|b| *b == 0) {
                    return Err(AppError::Crypto("Rejected low-order client public key".into()));
                }
                let (auth_key, session_key) = derive_pairing_keys(expected_pin, shared.as_bytes())?;

                let server_public = PublicKey::from(server_secret);
                let proof_ok = match hex::decode(&req.client_proof) {
                    Ok(proof) => client_proof_mac(&auth_key, client_public.as_bytes(), server_public.as_bytes())?
                        .verify_slice(&proof)
                        .is_ok(),
                    Err(_) => false,
                };

                if !proof_ok {
                    let count = failed_attempts.fetch_add(1, Ordering::SeqCst) + 1;
                    let remaining = MAX_PAIRING_ATTEMPTS.saturating_sub(count);
                    let err_resp = if count >= MAX_PAIRING_ATTEMPTS {
                        log::warn!("Pairing locked out after {} failed attempts from {}", count, peer_addr);
                        let mgr = app_handle.state::<PairingManager>();
                        // Only the owning session may shut down the listener;
                        // a stale session's lockout must not kill a newer one.
                        if let Some(tx) = mgr.take_if_owner(session_gen) {
                            let _ = tx.send(());
                        }
                        "HTTP/1.1 429 Too Many Requests\r\nContent-Type: application/json\r\nConnection: close\r\n\r\n{\"error\":\"Too many failed attempts. Pairing locked out.\"}".to_string()
                    } else {
                        format!(
                            "HTTP/1.1 403 Forbidden\r\nContent-Type: application/json\r\nConnection: close\r\n\r\n{{\"error\":\"Invalid pairing code. {} attempts remaining.\"}}",
                            remaining
                        )
                    };
                    let _ = stream.write_all(err_resp.as_bytes()).await;
                    return Ok(());
                }

                // Revocation blocklist: a device marked revoked is refused even with a
                // valid PIN until the user allows it again. Checked after the PIN proof
                // so unauthenticated probes learn nothing from this path.
                if !req.client_device_id.trim().is_empty() {
                    let revoked: bool = vault.with(|c| {
                        Ok(c
                            .query_row(
                                "SELECT 1 FROM paired_devices
                                 WHERE device_id = ?1 AND revoked_at IS NOT NULL
                                 LIMIT 1",
                                params![req.client_device_id.trim()],
                                |_| Ok(()),
                            )
                            .optional()?
                            .is_some())
                    })?;
                    if revoked {
                        let err_resp = "HTTP/1.1 403 Forbidden\r\nContent-Type: application/json\r\nConnection: close\r\n\r\n{\"error\":\"This device was revoked on the host. Ask the host owner to allow it again before pairing.\"}";
                        let _ = stream.write_all(err_resp.as_bytes()).await;
                        log::warn!(
                            "Refused pairing from revoked device {} ({})",
                            req.client_device_name,
                            peer_addr
                        );
                        return Ok(());
                    }
                }

                // Dump current vault archive
                let archive = dump_full_vault(vault, server_name)?;
                let archive_json = serde_json::to_vec(&archive)
                    .map_err(|e| AppError::Other(format!("Archive serialize error: {e}")))?;

                // Encrypt with session key. The client can only decrypt if it derived the same DH secret.
                let cipher = XChaCha20Poly1305::new((&session_key).into());
                let mut nonce_bytes = [0u8; 24];
                rand::thread_rng().fill_bytes(&mut nonce_bytes);
                let nonce = XNonce::from_slice(&nonce_bytes);

                let ct = cipher
                    .encrypt(nonce, archive_json.as_ref())
                    .map_err(|e| AppError::Crypto(format!("Pairing encryption failed: {e}")))?;

                // Record peer in paired_devices. Peers with a stable device id are
                // upserted so re-pairing updates one row per device (and the blocklist
                // check above stays authoritative).
                let now = chrono::Utc::now().timestamp();
                let peer_device_id = req.client_device_id.trim().to_string();
                let _ = vault.with(|c| {
                    if peer_device_id.is_empty() {
                        let dev_id = uuid::Uuid::new_v4().to_string();
                        c.execute(
                            "INSERT INTO paired_devices(id, device_name, device_type, ip_address, public_key, paired_at, last_sync, device_id, revoked_at)
                             VALUES(?1, ?2, ?3, ?4, ?5, ?6, ?7, '', NULL)",
                            params![dev_id, req.client_device_name, req.client_os, peer_addr.ip().to_string(), req.client_public_key, now, now],
                        )?;
                    } else {
                        c.execute(
                            "INSERT INTO paired_devices(id, device_name, device_type, ip_address, public_key, paired_at, last_sync, device_id, revoked_at)
                             SELECT lower(hex(randomblob(16))), ?1, ?2, ?3, ?4, ?5, ?5, ?6, NULL
                             WHERE NOT EXISTS (SELECT 1 FROM paired_devices WHERE device_id = ?6 AND revoked_at IS NULL)",
                            params![req.client_device_name, req.client_os, peer_addr.ip().to_string(), req.client_public_key, now, peer_device_id],
                        )?;
                        c.execute(
                            "UPDATE paired_devices SET device_name=?1, device_type=?2, ip_address=?3, public_key=?4, last_sync=?5
                             WHERE device_id=?6 AND revoked_at IS NULL",
                            params![req.client_device_name, req.client_os, peer_addr.ip().to_string(), req.client_public_key, now, peer_device_id],
                        )?;
                    }
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
                    "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
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

                // Single-use PIN enforcement: shut down listener immediately after successful pairing
                // Only if this handshake still owns the session.
                let mgr = app_handle.state::<PairingManager>();
                if let Some(tx) = mgr.take_if_owner(session_gen) {
                    let _ = tx.send(());
                }

                return Ok(());
            }
        }
    }

    Ok(())
}

#[tauri::command]
pub async fn pairing_stop_host(
    expected_pin: Option<String>,
    manager: State<'_, PairingManager>,
) -> AppResult<()> {
    let mut inner = manager.inner.lock();
    if let Some(ref pin) = expected_pin {
        match &inner.active {
            Some(active) if &active.pin == pin => {
                // Pin matches active session; proceed to stop.
            }
            _ => {
                // Pin does not match active session (or no active session currently installed);
                // ignore stale stop request without invalidating pending starts.
                return Ok(());
            }
        }
    }
    // Bump generation so any in-flight start aborts instead of installing
    // a listener after this stop. Single lock with the take/clear makes
    // stop atomic against a concurrent install.
    inner.generation += 1;
    if let Some(tx) = inner.shutdown.take() {
        let _ = tx.send(());
    }
    inner.active = None;
    Ok(())
}

#[tauri::command]
pub async fn pairing_join_client(
    target_host: String,
    port: u16,
    pin: String,
    server_public_key: String,
    device_name: Option<String>,
    vault: State<'_, Vault>,
) -> AppResult<PairingJoinResult> {
    let clean_pin = pin.replace('-', "").trim().to_string();
    if clean_pin.len() != 6 || !clean_pin.chars().all(|c| c.is_ascii_digit()) {
        return Err(AppError::Other("The pairing code must be 6 digits.".into()));
    }

    // The host's public key comes from the pairing link, obtained out of band. It is pinned, not taken from the wire.
    let server_public = parse_x25519_public(&server_public_key)
        .map_err(|_| AppError::Other("The pairing link has an invalid host key.".into()))?;
    let server_pk_hex = hex::encode(server_public.as_bytes());

    let my_device_name = device_name.unwrap_or_else(get_device_name);

    // 1. Generate client X25519 keypair
    let client_secret = {
        let mut rng = rand::thread_rng();
        StaticSecret::random_from_rng(&mut rng)
    };
    let client_public = PublicKey::from(&client_secret);
    let client_pk_hex = hex::encode(client_public.as_bytes());

    // 2. Derive keys and compute the PIN proof. The PIN itself never leaves this device.
    let shared = client_secret.diffie_hellman(&server_public);
    if shared.as_bytes().iter().all(|b| *b == 0) {
        return Err(AppError::Crypto("Rejected low-order host public key".into()));
    }
    let (auth_key, session_key) = derive_pairing_keys(&clean_pin, shared.as_bytes())?;
    let proof = client_proof_mac(&auth_key, client_public.as_bytes(), server_public.as_bytes())?
        .finalize()
        .into_bytes();

    // 3. Send the handshake. Plain HTTP is acceptable here because the proof and the AEAD-encrypted
    //    archive are bound to the pinned host key, so a network attacker can't impersonate the host.
    let url = format!("http://{}:{}/pair/handshake", target_host, port);
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(10))
        .build()
        .map_err(|e| AppError::Network(e.to_string()))?;

    let req_body = HandshakeRequest {
        client_public_key: client_pk_hex,
        client_proof: hex::encode(proof),
        client_device_name: my_device_name,
        client_os: std::env::consts::OS.to_string(),
        client_device_id: vault.with(|c| Ok(crate::vault::get_or_create_device_id(c)))?,
    };

    let resp = client
        .post(&url)
        .json(&req_body)
        .send()
        .await
        .map_err(|e| AppError::Network(format!("Failed to connect to host {target_host}:{port} — {e}")))?;

    if resp.status() == reqwest::StatusCode::FORBIDDEN {
        // Surface the host's specific refusal (e.g. "this device was revoked") when present.
        let detail = resp
            .text()
            .await
            .ok()
            .and_then(|body| {
                serde_json::from_str::<serde_json::Value>(&body)
                    .ok()
                    .and_then(|v| v.get("error").and_then(|m| m.as_str()).map(String::from))
            })
            .filter(|m| !m.trim().is_empty());
        return Err(AppError::Other(detail.unwrap_or_else(|| {
            "Pairing refused. Check the 6-digit code, or copy the pairing link again from the host.".into()
        })));
    }

    if !resp.status().is_success() {
        return Err(AppError::Network(format!("Pairing rejected by host: HTTP {}", resp.status())));
    }

    let handshake_resp: HandshakeResponse = resp
        .json()
        .await
        .map_err(|e| AppError::Network(format!("Failed to read handshake response: {e}")))?;

    // 4. The responder must be the pinned host
    if !handshake_resp.server_public_key.eq_ignore_ascii_case(&server_pk_hex) {
        return Err(AppError::Crypto(
            "Host identity mismatch: the host key does not match the pairing link.".into(),
        ));
    }

    // 5. Decrypt the archive. AEAD success proves the responder holds the pinned host secret.
    let nonce_raw = hex::decode(&handshake_resp.nonce)
        .map_err(|_| AppError::Crypto("Invalid nonce hex".into()))?;
    if nonce_raw.len() != 24 {
        return Err(AppError::Crypto("Nonce must be 24 bytes".into()));
    }
    let nonce = XNonce::from_slice(&nonce_raw);

    let ciphertext = B64
        .decode(&handshake_resp.encrypted_payload)
        .map_err(|_| AppError::Crypto("Invalid ciphertext base64".into()))?;

    if ciphertext.len() > MAX_PAIRING_CIPHERTEXT_SIZE {
        return Err(AppError::Crypto(format!(
            "Pairing archive payload exceeds maximum allowed size ({} > {})",
            ciphertext.len(),
            MAX_PAIRING_CIPHERTEXT_SIZE
        )));
    }

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
    let sync_ready = archive.sync_seed.is_some();

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
        sync_ready,
    })
}

#[tauri::command]
pub fn pairing_list_devices(vault: State<'_, Vault>) -> AppResult<Vec<PairedDevice>> {
    vault.with(|c| {
        let mut st = c.prepare(
            "SELECT id, device_name, device_type, ip_address, public_key, paired_at, last_sync,
                    device_id, revoked_at
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
                    device_id: r.get(7)?,
                    revoked_at: r.get(8)?,
                })
            })?
            .collect::<Result<Vec<_>, _>>()?;
        Ok(items)
    })
}

/// Marks a paired device as revoked: future pairing attempts from it are refused
/// at the handshake even with a valid PIN. The record is kept (soft revoke) so the
/// blocklist survives restarts and the user can allow the device again.
///
/// Note: this cannot un-copy data the device already received during pairing —
/// rotate host credentials to fully cut its access to your infrastructure.
#[tauri::command]
pub fn pairing_revoke_device(id: String, vault: State<'_, Vault>) -> AppResult<()> {
    vault.with(|c| {
        let changed = c.execute(
            "UPDATE paired_devices SET revoked_at = ?2 WHERE id = ?1 AND revoked_at IS NULL",
            params![id, chrono::Utc::now().timestamp()],
        )?;
        if changed == 0 {
            return Err(AppError::Other("Device not found or already revoked.".into()));
        }
        Ok(())
    })
}

/// Clears a revocation so the device may pair again (it still needs a fresh PIN).
#[tauri::command]
pub fn pairing_allow_device(id: String, vault: State<'_, Vault>) -> AppResult<()> {
    vault.with(|c| {
        let changed = c.execute(
            "UPDATE paired_devices SET revoked_at = NULL WHERE id = ?1 AND revoked_at IS NOT NULL",
            params![id],
        )?;
        if changed == 0 {
            return Err(AppError::Other("Device not found or not revoked.".into()));
        }
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
