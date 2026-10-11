//! Zero-knowledge, end-to-end encrypted sync.
//!
//!   K_root  ── vault master key (Argon2id)
//!   K_sync  = HKDF-SHA256(K_root, info="nexus/sync/v1")   → XChaCha20-Poly1305 key
//!   K_index = HKDF-SHA256(K_root, info="nexus/index/v1")  → HMAC key for blinded record ids
//!
//! The relay (any HTTP server implementing PUT/GET /blobs/:id, GET /changes?since=)
//! stores only:
//!   PUT /blobs/{hex(HMAC(K_index, table:id))}  body = nonce(24) || ciphertext || tag(16)
//! Payloads are padded to 256-byte buckets to hide record sizes.
//! Conflict resolution: Hybrid Logical Clock (last-writer-wins per record); on
//! tie, the device id breaks it lexicographically.

use crate::error::{AppError, AppResult};
use crate::vault::Vault;
use chacha20poly1305::{
    aead::{Aead, KeyInit, Payload},
    XChaCha20Poly1305, XNonce,
};
use hkdf::Hkdf;
use hmac::{Hmac, Mac};
use parking_lot::Mutex;
use rand::RngCore;
use rusqlite::OptionalExtension;
use serde::{Deserialize, Serialize};
use sha2::Sha256;
use std::collections::HashMap;
use zeroize::Zeroizing;

const PAD_BUCKET: usize = 256;
const SYNC_TABLES: &[&str] = &["hosts", "snippets", "keychain", "tunnels", "vaults"];

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SyncRecord {
    pub table: String,
    pub id: String,
    /// Hybrid logical clock: "<unix_ms>:<counter>:<device_id>"
    pub hlc: String,
    pub deleted: bool,
    pub body: serde_json::Value,
}

pub struct SyncKeys {
    enc: Zeroizing<[u8; 32]>,
    index: Zeroizing<[u8; 32]>,
}

impl SyncKeys {
    pub fn derive(root: &[u8; 32]) -> AppResult<Self> {
        let hk = Hkdf::<Sha256>::new(Some(b"nexus-terminal"), root);
        let mut enc = Zeroizing::new([0u8; 32]);
        let mut index = Zeroizing::new([0u8; 32]);
        hk.expand(b"nexus/sync/v1", enc.as_mut()).map_err(|e| AppError::Crypto(e.to_string()))?;
        hk.expand(b"nexus/index/v1", index.as_mut()).map_err(|e| AppError::Crypto(e.to_string()))?;
        Ok(Self { enc, index })
    }

    /// Opaque, deterministic blob name — the relay can't link it to a host/record.
    pub fn blind_id(&self, table: &str, id: &str) -> String {
        let mut mac = <Hmac<Sha256> as Mac>::new_from_slice(self.index.as_ref()).expect("hmac key");
        mac.update(table.as_bytes());
        mac.update(b":");
        mac.update(id.as_bytes());
        hex::encode(mac.finalize().into_bytes())
    }

    pub fn seal(&self, rec: &SyncRecord) -> AppResult<Vec<u8>> {
        let mut plain = Vec::new();
        ciborium::into_writer(rec, &mut plain).map_err(|e| AppError::Crypto(e.to_string()))?;
        // length-prefix + pad to bucket
        let len = plain.len() as u32;
        let mut padded = len.to_be_bytes().to_vec();
        padded.extend_from_slice(&plain);
        let target = padded.len().div_ceil(PAD_BUCKET) * PAD_BUCKET;
        padded.resize(target, 0);

        let cipher = XChaCha20Poly1305::new(self.enc.as_ref().into());
        let mut nonce = [0u8; 24];
        rand::thread_rng().fill_bytes(&mut nonce);
        let aad = self.blind_id(&rec.table, &rec.id);
        let ct = cipher
            .encrypt(XNonce::from_slice(&nonce), Payload { msg: &padded, aad: aad.as_bytes() })
            .map_err(|_| AppError::Crypto("encrypt failed".into()))?;
        let mut out = nonce.to_vec();
        out.extend(ct);
        Ok(out)
    }

    pub fn open(&self, blob_id: &str, blob: &[u8]) -> AppResult<SyncRecord> {
        if blob.len() < 24 + 16 {
            return Err(AppError::Crypto("blob too short".into()));
        }
        let (nonce, ct) = blob.split_at(24);
        let cipher = XChaCha20Poly1305::new(self.enc.as_ref().into());
        let padded = Zeroizing::new(
            cipher
                .decrypt(XNonce::from_slice(nonce), Payload { msg: ct, aad: blob_id.as_bytes() })
                .map_err(|_| AppError::Crypto("authentication tag mismatch".into()))?,
        );
        let len = u32::from_be_bytes(padded[..4].try_into().unwrap()) as usize;
        if 4 + len > padded.len() {
            return Err(AppError::Crypto("blob length mismatch".into()));
        }
        ciborium::from_reader(&padded[4..4 + len]).map_err(|e| AppError::Crypto(e.to_string()))
    }
}

/// Pluggable storage backend. The relay is *untrusted* — it only sees ciphertext.
#[allow(async_fn_in_trait)]
pub trait SyncTransport: Send + Sync {
    async fn put(&self, blob_id: &str, data: Vec<u8>) -> AppResult<()>;
    async fn get(&self, blob_id: &str) -> AppResult<Option<Vec<u8>>>;
    /// Returns (blob_id, server_cursor) pairs changed after `cursor`.
    async fn changes_since(&self, cursor: u64) -> AppResult<Vec<(String, u64)>>;
}

/// Reference HTTP relay transport. Works against any server exposing
/// `PUT/GET /blobs/:id` and `GET /changes?since=&device=`.
pub struct HttpRelay {
    pub base_url: String,
    pub client: reqwest::Client,
    pub device_token: String,
}

impl HttpRelay {
    pub fn new(base_url: String, device_token: String) -> Self {
        Self {
            base_url: base_url.trim_end_matches('/').to_string(),
            client: reqwest::Client::builder()
                .user_agent(concat!("nexus-terminal/", env!("CARGO_PKG_VERSION")))
                .timeout(std::time::Duration::from_secs(30))
                .build()
                .unwrap_or_default(),
            device_token,
        }
    }
}

#[derive(Deserialize)]
struct ChangesResponse {
    changes: Vec<ChangeEntry>,
}
#[derive(Deserialize)]
struct ChangeEntry {
    id: String,
    cursor: u64,
}

impl SyncTransport for HttpRelay {
    async fn put(&self, blob_id: &str, data: Vec<u8>) -> AppResult<()> {
        let r = self
            .client
            .put(format!("{}/blobs/{blob_id}", self.base_url))
            .bearer_auth(&self.device_token)
            .header("Content-Type", "application/octet-stream")
            .body(data)
            .send()
            .await
            .map_err(|e| AppError::Network(e.to_string()))?;
        if !r.status().is_success() {
            let code = r.status();
            let body = r.text().await.unwrap_or_default();
            return Err(AppError::Network(format!("relay PUT {code}: {body}")));
        }
        Ok(())
    }
    async fn get(&self, blob_id: &str) -> AppResult<Option<Vec<u8>>> {
        let r = self
            .client
            .get(format!("{}/blobs/{blob_id}", self.base_url))
            .bearer_auth(&self.device_token)
            .send()
            .await
            .map_err(|e| AppError::Network(e.to_string()))?;
        if r.status() == reqwest::StatusCode::NOT_FOUND {
            return Ok(None);
        }
        if !r.status().is_success() {
            return Err(AppError::Network(format!("relay GET {}", r.status())));
        }
        Ok(Some(r.bytes().await.map_err(|e| AppError::Network(e.to_string()))?.to_vec()))
    }
    async fn changes_since(&self, cursor: u64) -> AppResult<Vec<(String, u64)>> {
        let r = self
            .client
            .get(format!("{}/changes", self.base_url))
            .bearer_auth(&self.device_token)
            .query(&[("since", cursor.to_string())])
            .send()
            .await
            .map_err(|e| AppError::Network(e.to_string()))?;
        if r.status() == reqwest::StatusCode::NOT_FOUND || r.status() == reqwest::StatusCode::NOT_IMPLEMENTED {
            // Relay doesn't implement /changes — fall back to a full pull by
            // returning an empty list; the caller will need to push every local
            // record (it already does) but cannot discover new remote blobs
            // without knowing their ids. Return a sentinel empty list and let
            // the caller continue safely.
            return Ok(vec![]);
        }
        if !r.status().is_success() {
            return Err(AppError::Network(format!("relay changes {}", r.status())));
        }
        let parsed: ChangesResponse = r.json().await.map_err(|e| AppError::Network(e.to_string()))?;
        Ok(parsed.changes.into_iter().map(|c| (c.id, c.cursor)).collect())
    }
}

#[derive(Default, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct SyncStatus {
    pub enabled: bool,
    pub relay_url: Option<String>,
    pub device_id: String,
    pub last_sync: Option<i64>,
    pub cursor: u64,
    pub last_error: Option<String>,
    pub has_token: bool,
    #[serde(skip)]
    pub device_token: Option<String>,
}

pub struct SyncEngine {
    status: Mutex<SyncStatus>,
}

impl Default for SyncEngine {
    fn default() -> Self {
        let mut id_bytes = [0u8; 8];
        rand::thread_rng().fill_bytes(&mut id_bytes);
        let device_id = hex::encode(id_bytes);
        Self { status: Mutex::new(SyncStatus { device_id, ..Default::default() }) }
    }
}

#[tauri::command]
pub fn sync_status(engine: tauri::State<'_, SyncEngine>, vault: tauri::State<'_, Vault>) -> SyncStatus {
    let _ = vault.with(|conn| {
        let dev_id: Option<String> = conn
            .query_row(
                "SELECT value FROM ai_settings WHERE key = 'sync_device_id'",
                [],
                |r| r.get(0),
            )
            .optional()?;
        if let Some(id) = dev_id {
            if !id.is_empty() {
                engine.status.lock().device_id = id;
            }
        }

        let relay_url: Option<String> = conn
            .query_row(
                "SELECT value FROM ai_settings WHERE key = 'sync_relay_url'",
                [],
                |r| r.get(0),
            )
            .optional()?;
        let dev_tok: Option<String> = conn
            .query_row(
                "SELECT value FROM ai_settings WHERE key = 'sync_device_token'",
                [],
                |r| r.get(0),
            )
            .optional()?;

        let mut s = engine.status.lock();
        if s.relay_url.is_none() && relay_url.is_some() {
            s.relay_url = relay_url;
            s.enabled = s.relay_url.is_some();
        }
        if s.device_token.is_none() && dev_tok.is_some() {
            s.device_token = dev_tok;
        }
        s.has_token = s.device_token.as_ref().map(|t| !t.is_empty()).unwrap_or(false);
        Ok(())
    });
    let mut out = engine.status.lock().clone();
    out.has_token = out.device_token.as_ref().map(|t| !t.is_empty()).unwrap_or(false);
    out
}

#[tauri::command]
pub fn sync_configure(
    relay_url: Option<String>,
    device_token: Option<String>,
    engine: tauri::State<'_, SyncEngine>,
    vault: tauri::State<'_, Vault>,
) {
    let mut s = engine.status.lock();
    s.enabled = relay_url.is_some();
    s.relay_url = relay_url.clone();
    if let Some(ref tok) = device_token {
        if !tok.is_empty() {
            s.device_token = Some(tok.clone());
            s.last_error = None;
        } else {
            s.device_token = None;
        }
    }
    s.has_token = s.device_token.as_ref().map(|t| !t.is_empty()).unwrap_or(false);
    let dev_tok = s.device_token.clone();
    drop(s);

    let _ = vault.with(|conn| {
        if let Some(ref url) = relay_url {
            let _ = conn.execute(
                "INSERT INTO ai_settings(key, value) VALUES('sync_relay_url', ?1)
                 ON CONFLICT(key) DO UPDATE SET value = ?1",
                [url],
            );
        } else {
            let _ = conn.execute("DELETE FROM ai_settings WHERE key = 'sync_relay_url'", []);
        }

        if let Some(ref tok) = dev_tok {
            let _ = conn.execute(
                "INSERT INTO ai_settings(key, value) VALUES('sync_device_token', ?1)
                 ON CONFLICT(key) DO UPDATE SET value = ?1",
                [tok],
            );
        } else if device_token.is_some() {
            let _ = conn.execute("DELETE FROM ai_settings WHERE key = 'sync_device_token'", []);
        }
        Ok(())
    });
}

/// Extract every syncable record from a SQLite connection as a SyncRecord
/// using `updated_at` as a coarse cursor (HLC will be "<updated_at_ms>:0:<device>").
fn collect_local_records(conn: &rusqlite::Connection, device_id: &str) -> AppResult<Vec<SyncRecord>> {
    let mut out = Vec::new();
    for &tbl in SYNC_TABLES {
        let (id_col, body_cols): (&str, &[&str]) = match tbl {
            "hosts" => ("id", &["id","label","hostname","port","username","auth_method","grp","tags","color","os","keychain_id","jump_host_id","vault_id","startup_command","updated_at"]),
            "snippets" => ("id", &["id","name","command","folder","tags","vault_id","updated_at"]),
            "keychain" => ("id", &["id","label","username","auth_method","password","private_key","passphrase","vault_id","updated_at"]),
            "tunnels" => ("id", &["id","label","host_id","forward_type","local_host","local_port","remote_host","remote_port","vault_id","updated_at"]),
            "vaults" => ("id", &["id","name","kind","color","description","created_at"]),
            _ => continue,
        };
        let cols = body_cols.join(",");
        let sql = format!("SELECT {cols} FROM {tbl}");
        let mut stmt = conn.prepare(&sql).map_err(AppError::Db)?;
        let rows = stmt
            .query_map([], |row| {
                use rusqlite::types::ValueRef;
                let mut obj = serde_json::Map::new();
                for (i, name) in body_cols.iter().enumerate() {
                    let v = match row.get_ref(i)? {
                        ValueRef::Null => serde_json::Value::Null,
                        ValueRef::Integer(i) => serde_json::Value::from(i),
                        ValueRef::Real(f) => serde_json::Value::from(f),
                        ValueRef::Text(s) => serde_json::Value::String(String::from_utf8_lossy(s).into_owned()),
                        ValueRef::Blob(b) => serde_json::Value::String(hex::encode(b)),
                    };
                    obj.insert((*name).to_string(), v);
                }
                let id_val = obj.get(id_col).and_then(|v| v.as_str()).unwrap_or("").to_string();
                let updated = obj.get("updated_at").and_then(|v| v.as_i64()).unwrap_or(0);
                let created = obj.get("created_at").and_then(|v| v.as_i64()).unwrap_or(updated);
                let ts = if updated > 0 { updated * 1000 } else { created * 1000 };
                Ok(SyncRecord {
                    table: tbl.to_string(),
                    id: id_val,
                    hlc: format!("{ts}:0:{device_id}"),
                    deleted: false,
                    body: serde_json::Value::Object(obj),
                })
            })
            .map_err(AppError::Db)?;
        for r in rows {
            out.push(r.map_err(AppError::Db)?);
        }
    }
    Ok(out)
}

/// Apply a remote SyncRecord to the local database using HLC last-writer-wins.
fn apply_remote_record(conn: &rusqlite::Connection, rec: &SyncRecord) -> AppResult<()> {
    if rec.deleted {
        // Soft delete is not implemented per-table; just leave as-is for safety.
        return Ok(());
    }
    let obj = match &rec.body {
        serde_json::Value::Object(o) => o,
        _ => return Ok(()),
    };
    match rec.table.as_str() {
        "hosts" => {
            conn.execute(
                "INSERT INTO hosts (id,label,hostname,port,username,auth_method,grp,tags,color,os,keychain_id,jump_host_id,vault_id,startup_command,updated_at)
                 VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,?15)
                 ON CONFLICT(id) DO UPDATE SET label=excluded.label,hostname=excluded.hostname,port=excluded.port,username=excluded.username,auth_method=excluded.auth_method,grp=excluded.grp,tags=excluded.tags,color=excluded.color,os=excluded.os,keychain_id=excluded.keychain_id,jump_host_id=excluded.jump_host_id,vault_id=excluded.vault_id,startup_command=excluded.startup_command,updated_at=excluded.updated_at",
                rusqlite::params![
                    obj.get("id").and_then(|v|v.as_str()),
                    obj.get("label").and_then(|v|v.as_str()),
                    obj.get("hostname").and_then(|v|v.as_str()),
                    obj.get("port").and_then(|v|v.as_i64()).unwrap_or(22),
                    obj.get("username").and_then(|v|v.as_str()),
                    obj.get("auth_method").and_then(|v|v.as_str()),
                    obj.get("grp").and_then(|v|v.as_str()),
                    obj.get("tags").and_then(|v|v.as_str()).unwrap_or("[]"),
                    obj.get("color").and_then(|v|v.as_str()),
                    obj.get("os").and_then(|v|v.as_str()),
                    obj.get("keychain_id").and_then(|v|v.as_str()),
                    obj.get("jump_host_id").and_then(|v|v.as_str()),
                    obj.get("vault_id").and_then(|v|v.as_str()),
                    obj.get("startup_command").and_then(|v|v.as_str()),
                    obj.get("updated_at").and_then(|v|v.as_i64()).unwrap_or(chrono::Utc::now().timestamp()),
                ],
            )?;
        }
        "snippets" => {
            conn.execute(
                "INSERT INTO snippets (id,name,command,folder,tags,vault_id,updated_at) VALUES (?1,?2,?3,?4,?5,?6,?7)
                 ON CONFLICT(id) DO UPDATE SET name=excluded.name,command=excluded.command,folder=excluded.folder,tags=excluded.tags,vault_id=excluded.vault_id,updated_at=excluded.updated_at",
                rusqlite::params![
                    obj.get("id").and_then(|v|v.as_str()),
                    obj.get("name").and_then(|v|v.as_str()),
                    obj.get("command").and_then(|v|v.as_str()),
                    obj.get("folder").and_then(|v|v.as_str()),
                    obj.get("tags").and_then(|v|v.as_str()).unwrap_or("[]"),
                    obj.get("vault_id").and_then(|v|v.as_str()),
                    obj.get("updated_at").and_then(|v|v.as_i64()).unwrap_or(chrono::Utc::now().timestamp()),
                ],
            )?;
        }
        "keychain" => {
            conn.execute(
                "INSERT INTO keychain (id,label,username,auth_method,password,private_key,passphrase,vault_id,updated_at) VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9)
                 ON CONFLICT(id) DO UPDATE SET label=excluded.label,username=excluded.username,auth_method=excluded.auth_method,
                     password=COALESCE(excluded.password, keychain.password),
                     private_key=COALESCE(excluded.private_key, keychain.private_key),
                     passphrase=COALESCE(excluded.passphrase, keychain.passphrase),
                     vault_id=excluded.vault_id,updated_at=excluded.updated_at",
                rusqlite::params![
                    obj.get("id").and_then(|v|v.as_str()),
                    obj.get("label").and_then(|v|v.as_str()),
                    obj.get("username").and_then(|v|v.as_str()),
                    obj.get("auth_method").and_then(|v|v.as_str()),
                    obj.get("password").and_then(|v|v.as_str()),
                    obj.get("private_key").and_then(|v|v.as_str()),
                    obj.get("passphrase").and_then(|v|v.as_str()),
                    obj.get("vault_id").and_then(|v|v.as_str()),
                    obj.get("updated_at").and_then(|v|v.as_i64()).unwrap_or(chrono::Utc::now().timestamp()),
                ],
            )?;
        }
        "tunnels" => {
            conn.execute(
                "INSERT INTO tunnels (id,label,host_id,forward_type,local_host,local_port,remote_host,remote_port,vault_id,updated_at) VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10)
                 ON CONFLICT(id) DO UPDATE SET label=excluded.label,host_id=excluded.host_id,forward_type=excluded.forward_type,local_host=excluded.local_host,local_port=excluded.local_port,remote_host=excluded.remote_host,remote_port=excluded.remote_port,vault_id=excluded.vault_id,updated_at=excluded.updated_at",
                rusqlite::params![
                    obj.get("id").and_then(|v|v.as_str()),
                    obj.get("label").and_then(|v|v.as_str()),
                    obj.get("host_id").and_then(|v|v.as_str()),
                    obj.get("forward_type").and_then(|v|v.as_str()),
                    obj.get("local_host").and_then(|v|v.as_str()).unwrap_or("127.0.0.1"),
                    obj.get("local_port").and_then(|v|v.as_i64()).unwrap_or(0),
                    obj.get("remote_host").and_then(|v|v.as_str()).unwrap_or("127.0.0.1"),
                    obj.get("remote_port").and_then(|v|v.as_i64()).unwrap_or(0),
                    obj.get("vault_id").and_then(|v|v.as_str()),
                    obj.get("updated_at").and_then(|v|v.as_i64()).unwrap_or(chrono::Utc::now().timestamp()),
                ],
            )?;
        }
        "vaults" => {
            conn.execute(
                "INSERT OR IGNORE INTO vaults (id,name,kind,color,description,created_at) VALUES (?1,?2,?3,?4,?5,?6)",
                rusqlite::params![
                    obj.get("id").and_then(|v|v.as_str()),
                    obj.get("name").and_then(|v|v.as_str()),
                    obj.get("kind").and_then(|v|v.as_str()).unwrap_or("personal"),
                    obj.get("color").and_then(|v|v.as_str()),
                    obj.get("description").and_then(|v|v.as_str()),
                    obj.get("created_at").and_then(|v|v.as_i64()).unwrap_or(chrono::Utc::now().timestamp()),
                ],
            )?;
        }
        _ => {}
    }
    Ok(())
}

/// Parse HLC string "<ms>:<counter>:<device>" — returns (ms, counter, device).
fn parse_hlc(hlc: &str) -> (i64, u32, &str) {
    let mut parts = hlc.splitn(3, ':');
    let ms = parts.next().and_then(|s| s.parse::<i64>().ok()).unwrap_or(0);
    let ctr = parts.next().and_then(|s| s.parse::<u32>().ok()).unwrap_or(0);
    let dev = parts.next().unwrap_or("");
    (ms, ctr, dev)
}

/// Returns true iff `a` wins over `b` under HLC last-writer-wins.
fn hlc_wins(a: &str, b: &str) -> bool {
    let (a_ms, a_c, a_d) = parse_hlc(a);
    let (b_ms, b_c, b_d) = parse_hlc(b);
    (a_ms, a_c, a_d) > (b_ms, b_c, b_d)
}

/// End-to-end encrypted push/pull sync against the configured relay.
#[tauri::command]
pub async fn sync_now(engine: tauri::State<'_, SyncEngine>, vault: tauri::State<'_, Vault>) -> AppResult<SyncStatus> {
    let (mut relay_url, mut device_token) = {
        let s = engine.status.lock();
        (s.relay_url.clone(), s.device_token.clone())
    };
    if relay_url.is_none() {
        let _ = vault.with(|conn| {
            relay_url = conn
                .query_row("SELECT value FROM ai_settings WHERE key = 'sync_relay_url'", [], |r| r.get(0))
                .optional()?;
            device_token = conn
                .query_row("SELECT value FROM ai_settings WHERE key = 'sync_device_token'", [], |r| r.get(0))
                .optional()?;
            Ok(())
        });
        if let Some(ref url) = relay_url {
            let mut s = engine.status.lock();
            s.relay_url = Some(url.clone());
            s.enabled = true;
            s.device_token = device_token.clone();
            s.has_token = device_token.as_ref().map(|t| !t.is_empty()).unwrap_or(false);
        }
    }
    let relay_url = relay_url.ok_or_else(|| AppError::Network("no relay configured".into()))?;
    let token = device_token.unwrap_or_default();

    // Derive or load persistent device_id from the vault
    let device_id = vault.with(|conn| -> AppResult<String> {
        let existing: Option<String> = conn
            .query_row(
                "SELECT value FROM ai_settings WHERE key = 'sync_device_id'",
                [],
                |r| r.get(0),
            )
            .optional()
            .map_err(AppError::Db)?;
        if let Some(id) = existing {
            if !id.is_empty() {
                return Ok(id);
            }
        }
        let mut id_bytes = [0u8; 8];
        rand::thread_rng().fill_bytes(&mut id_bytes);
        let new_id = hex::encode(id_bytes);
        conn.execute(
            "INSERT INTO ai_settings(key, value) VALUES('sync_device_id', ?1)
             ON CONFLICT(key) DO UPDATE SET value=?1",
            [&new_id],
        )
        .map_err(AppError::Db)?;
        Ok(new_id)
    })?;

    {
        engine.status.lock().device_id = device_id.clone();
    }

    // Derive keys from vault master key.
    let root = vault.root_key()?;
    let keys = SyncKeys::derive(&root)?;

    let relay = HttpRelay::new(relay_url.clone(), token);

    // 1. Pull remote blobs first (decrypt & merge into local vault)
    let cursor = { engine.status.lock().cursor };
    let changes = relay.changes_since(cursor).await.unwrap_or_default();

    // To discover known record ids if /changes is not implemented by relay
    let initial_local_records = vault.with(|conn| collect_local_records(conn, &device_id))?;
    let mut ids_to_fetch: Vec<(String, u64)> = changes;
    if ids_to_fetch.is_empty() {
        for rec in &initial_local_records {
            ids_to_fetch.push((keys.blind_id(&rec.table, &rec.id), 0));
        }
    }

    let mut remote_blobs: HashMap<String, (SyncRecord, u64)> = HashMap::new();
    let mut remote_hlcs: HashMap<(String, String), String> = HashMap::new();
    let mut max_cursor: u64 = 0;
    for (blob_id, cur) in ids_to_fetch {
        max_cursor = max_cursor.max(cur);
        let bytes = match relay.get(&blob_id).await {
            Ok(Some(b)) => b,
            _ => continue,
        };
        if let Ok(rec) = keys.open(&blob_id, &bytes) {
            remote_hlcs.insert((rec.table.clone(), rec.id.clone()), rec.hlc.clone());
            remote_blobs.insert(blob_id, (rec, cur));
        }
    }

    let mut pulled = 0usize;
    vault.with(|conn| -> AppResult<()> {
        for (_blob_id, (remote, _cur)) in remote_blobs {
            let local_ts: Option<i64> = match remote.table.as_str() {
                "hosts" | "snippets" | "keychain" | "tunnels" => conn
                    .query_row(
                        &format!("SELECT updated_at FROM {} WHERE id=?1", remote.table),
                        [&remote.id],
                        |r| r.get(0),
                    )
                    .ok(),
                _ => None,
            };
            let local_hlc = match local_ts {
                Some(ts) if ts > 0 => format!("{}:0:{}", ts * 1000, device_id),
                _ => "0:0:".to_string(),
            };
            if hlc_wins(&remote.hlc, &local_hlc) {
                apply_remote_record(conn, &remote)?;
                pulled += 1;
            }
        }
        Ok(())
    })?;

    // 2. Collect local records AFTER merge and push ONLY records that are locally newer than the relay
    let post_merge_local_records = vault.with(|conn| collect_local_records(conn, &device_id))?;
    let mut pushed = 0usize;
    for rec in &post_merge_local_records {
        // If the relay already has this record with equal or newer HLC, skip pushing to avoid clobbering
        if let Some(r_hlc) = remote_hlcs.get(&(rec.table.clone(), rec.id.clone())) {
            if !hlc_wins(&rec.hlc, r_hlc) {
                continue;
            }
        }

        let blob_id = keys.blind_id(&rec.table, &rec.id);
        let blob = keys.seal(rec)?;
        match relay.put(&blob_id, blob).await {
            Ok(()) => pushed += 1,
            Err(e) => {
                let mut s = engine.status.lock();
                s.last_error = Some(format!("push failed for {}/{}: {e}", rec.table, rec.id));
                return Err(e);
            }
        }
    }

    let mut s = engine.status.lock();
    s.last_sync = Some(chrono::Utc::now().timestamp());
    s.cursor = max_cursor.max(s.cursor);
    s.last_error = None;
    let _ = pushed;
    let _ = pulled;
    Ok(s.clone())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn seal_open_roundtrip() {
        let keys = SyncKeys::derive(&[7u8; 32]).unwrap();
        let rec = SyncRecord {
            table: "hosts".into(),
            id: "abc".into(),
            hlc: "1:0:dev".into(),
            deleted: false,
            body: serde_json::json!({"hostname": "10.0.0.1"}),
        };
        let blob = keys.seal(&rec).unwrap();
        assert_eq!((blob.len() - 40) % PAD_BUCKET, 0);
        let back = keys.open(&keys.blind_id("hosts", "abc"), &blob).unwrap();
        assert_eq!(back.id, "abc");
        assert!(keys.open("tampered", &blob).is_err());
    }

    #[test]
    fn hlc_ordering() {
        assert!(hlc_wins("2000:0:b", "1000:0:a"));
        assert!(hlc_wins("1000:1:a", "1000:0:a"));
        assert!(hlc_wins("1000:0:b", "1000:0:a"));
        assert!(!hlc_wins("1000:0:a", "1000:0:b"));
    }
}
