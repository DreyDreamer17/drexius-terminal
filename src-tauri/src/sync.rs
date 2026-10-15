//! Encrypted v2 relay sync (self-hosted).
//!
//!   seed    ── random group secret in SQLCipher, shared by encrypted LAN pairing
//!   K_sync  = HKDF-SHA256(seed, info="nexus/sync/v2")   → XChaCha20-Poly1305 key
//!   K_index = HKDF-SHA256(seed, info="nexus/index/v2")  → HMAC key for blinded record ids
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
const MAX_RELAY_RESPONSE: usize = 8 * 1024 * 1024;
const SYNC_TABLES: &[&str] = &["hosts", "snippets", "keychain", "tunnels", "vaults"];

/// Stable per-sync-group secret. Unlike the local SQLCipher key, this survives
/// master-password changes and is transferred only inside an authenticated
/// encrypted pairing archive. Stored inside SQLCipher, never in localStorage.
pub(crate) fn get_or_create_sync_seed(conn: &rusqlite::Connection) -> AppResult<Zeroizing<[u8; 32]>> {
    let stored: Option<String> = conn.query_row(
        "SELECT value FROM ai_settings WHERE key='sync_seed_v2'", [], |r| r.get(0),
    ).optional()?;
    if let Some(value) = stored {
        let bytes = hex::decode(value).map_err(|_| AppError::Crypto("Invalid sync seed".into()))?;
        let seed: [u8; 32] = bytes.try_into()
            .map_err(|_| AppError::Crypto("Invalid sync seed length".into()))?;
        return Ok(Zeroizing::new(seed));
    }
    let mut seed = Zeroizing::new([0u8; 32]);
    rand::thread_rng().fill_bytes(seed.as_mut());
    let encoded = Zeroizing::new(hex::encode(seed.as_ref()));
    conn.execute("INSERT INTO ai_settings(key,value) VALUES('sync_seed_v2',?1)", [encoded.as_str()])?;
    Ok(seed)
}

pub(crate) fn sync_seed_if_configured(conn: &rusqlite::Connection) -> AppResult<Option<String>> {
    let configured: Option<String> = conn.query_row(
        "SELECT value FROM ai_settings WHERE key='sync_relay_url'", [], |r| r.get(0),
    ).optional()?;
    if configured.as_deref().is_some_and(|url| !url.trim().is_empty()) {
        let seed = get_or_create_sync_seed(conn)?;
        return Ok(Some(hex::encode(seed.as_ref())));
    }
    Ok(None)
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SyncRecord {
    pub table: String,
    pub id: String,
    /// Hybrid logical clock: "<unix_ms>:<counter>:<device_id>"
    pub hlc: String,
    pub deleted: bool,
    pub body: serde_json::Value,
}

#[derive(Clone)]
pub struct SyncKeys {
    enc: Zeroizing<[u8; 32]>,
    index: Zeroizing<[u8; 32]>,
}

impl SyncKeys {
    pub fn derive(seed: &[u8; 32]) -> AppResult<Self> {
        let hk = Hkdf::<Sha256>::new(Some(b"nexus-terminal-sync-v2"), seed);
        let mut enc = Zeroizing::new([0u8; 32]);
        let mut index = Zeroizing::new([0u8; 32]);
        hk.expand(b"nexus/sync/v2", enc.as_mut()).map_err(|e| AppError::Crypto(e.to_string()))?;
        hk.expand(b"nexus/index/v2", index.as_mut()).map_err(|e| AppError::Crypto(e.to_string()))?;
        Ok(Self { enc, index })
    }

    /// Opaque, deterministic blob name — the relay can't link it to a host/record.
    pub fn blind_id(&self, table: &str, id: &str) -> String {
        let mut mac = <Hmac<Sha256> as Mac>::new_from_slice(self.index.as_ref()).expect("hmac key");
        mac.update(table.as_bytes());
        mac.update(b":");
        mac.update(id.as_bytes());
        format!("v2-{}", hex::encode(mac.finalize().into_bytes()))
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
        if padded.len() < 4 {
            return Err(AppError::Crypto("blob length prefix missing".into()));
        }
        let len = u32::from_be_bytes(padded[..4].try_into().unwrap()) as usize;
        if len > padded.len() - 4 {
            return Err(AppError::Crypto("blob length mismatch".into()));
        }
        let rec: SyncRecord = ciborium::from_reader(&padded[4..4 + len])
            .map_err(|e| AppError::Crypto(e.to_string()))?;
        if self.blind_id(&rec.table, &rec.id) != blob_id {
            return Err(AppError::Crypto("Sync record ID mismatch".into()));
        }
        Ok(rec)
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
#[derive(Clone)]
pub struct HttpRelay {
    pub base_url: String,
    pub client: reqwest::Client,
    pub device_token: String,
}

/// Read untrusted relay responses with a hard cap; avoid unbounded allocation.
async fn bounded_response(mut r: reqwest::Response) -> AppResult<Vec<u8>> {
    let mut out = Vec::new();
    while let Some(chunk) = r.chunk().await.map_err(|e| AppError::Network(e.to_string()))? {
        if chunk.len() > MAX_RELAY_RESPONSE - out.len() {
            return Err(AppError::Network("Relay response exceeds 8 MiB limit".into()));
        }
        out.extend_from_slice(&chunk);
    }
    Ok(out)
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
        Ok(Some(bounded_response(r).await?))
    }
    async fn changes_since(&self, cursor: u64) -> AppResult<Vec<(String, u64)>> {
        const PAGE: usize = 1000;
        const MAX_PER_RUN: usize = 100_000;
        let mut after = cursor;
        let mut all = Vec::new();
        loop {
            let r = self
                .client
                .get(format!("{}/changes", self.base_url))
                .bearer_auth(&self.device_token)
                .query(&[("since", after.to_string()), ("limit", PAGE.to_string())])
                .send()
                .await
                .map_err(|e| AppError::Network(e.to_string()))?;
            if r.status() == reqwest::StatusCode::NOT_FOUND || r.status() == reqwest::StatusCode::NOT_IMPLEMENTED {
                return Err(AppError::Network("Relay must implement paginated GET /changes?since=&limit=".into()));
            }
            if !r.status().is_success() {
                return Err(AppError::Network(format!("relay changes {}", r.status())));
            }
            let body = bounded_response(r).await?;
            let parsed: ChangesResponse = serde_json::from_slice(&body)
                .map_err(|e| AppError::Network(e.to_string()))?;
            if parsed.changes.len() > PAGE || all.len() + parsed.changes.len() > MAX_PER_RUN {
                return Err(AppError::Network("Relay change batch exceeds limits".into()));
            }
            let count = parsed.changes.len();
            for change in parsed.changes {
                if change.cursor <= after {
                    return Err(AppError::Network("Relay returned non-increasing cursor".into()));
                }
                after = change.cursor;
                all.push((change.id, change.cursor));
            }
            if count < PAGE { break; }
        }
        Ok(all)
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
    /// Blobs the relay served that this device could not read (another sync
    /// group, a corrupt record, or an id the relay no longer stores). They are
    /// skipped, not fatal; this counts the last attempt.
    pub skipped_blobs: u64,
    #[serde(skip)]
    pub device_token: Option<String>,
}

pub struct SyncEngine {
    status: Mutex<SyncStatus>,
    run_lock: tokio::sync::Mutex<()>,
}

impl Default for SyncEngine {
    fn default() -> Self {
        let mut id_bytes = [0u8; 8];
        rand::thread_rng().fill_bytes(&mut id_bytes);
        let device_id = hex::encode(id_bytes);
        Self {
            status: Mutex::new(SyncStatus { device_id, ..Default::default() }),
            run_lock: tokio::sync::Mutex::new(()),
        }
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
        let saved_cursor: Option<String> = conn
            .query_row("SELECT value FROM ai_settings WHERE key='sync_cursor_v2'", [], |r| r.get(0))
            .optional()?;
        let last_success: Option<String> = conn
            .query_row("SELECT value FROM ai_settings WHERE key='sync_last_success_v2'", [], |r| r.get(0))
            .optional()?;

        let mut s = engine.status.lock();
        if let Some(ts) = last_success.and_then(|v| v.parse::<i64>().ok()) {
            s.last_sync = Some(s.last_sync.unwrap_or(0).max(ts));
        }
        if let Some(cur) = saved_cursor.and_then(|v| v.parse::<u64>().ok()) {
            s.cursor = s.cursor.max(cur);
        }
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

/// M5: the device token is sent as a bearer credential, so relays must use https.
/// Plain http is accepted only for loopback (local development relays).
pub fn relay_url_is_allowed(url: &str) -> bool {
    match reqwest::Url::parse(url.trim()) {
        Ok(u) => match u.scheme() {
            "https" => true,
            "http" => matches!(u.host_str(), Some("localhost") | Some("127.0.0.1") | Some("[::1]")),
            _ => false,
        },
        Err(_) => false,
    }
}

#[tauri::command]
pub fn sync_configure(
    relay_url: Option<String>,
    device_token: Option<String>,
    engine: tauri::State<'_, SyncEngine>,
    vault: tauri::State<'_, Vault>,
) -> AppResult<()> {
    let relay_url = relay_url.map(|u| u.trim().trim_end_matches('/').to_string())
        .filter(|u| !u.is_empty());
    if let Some(ref url) = relay_url {
        if !relay_url_is_allowed(url) {
            let msg = "Sync relay must use https:// (http:// is allowed only for localhost).";
            engine.status.lock().last_error = Some(msg.into());
            return Err(AppError::Network(msg.into()));
        }
    }
    // Persist atomically before reporting success or changing the in-memory
    // status. A locked vault or disk failure must not silently drop settings.
    let persisted_token: Option<String> = vault.with(|conn| {
        let tx = conn.unchecked_transaction()?;
        if let Some(ref url) = relay_url {
            tx.execute(
                "INSERT INTO ai_settings(key,value) VALUES('sync_relay_url',?1)
                 ON CONFLICT(key) DO UPDATE SET value=?1", [url.as_str()],
            )?;
        } else {
            tx.execute("DELETE FROM ai_settings WHERE key='sync_relay_url'", [])?;
        }
        if let Some(ref token) = device_token {
            if token.is_empty() {
                tx.execute("DELETE FROM ai_settings WHERE key='sync_device_token'", [])?;
            } else {
                tx.execute(
                    "INSERT INTO ai_settings(key,value) VALUES('sync_device_token',?1)
                     ON CONFLICT(key) DO UPDATE SET value=?1", [token.as_str()],
                )?;
            }
        }
        let stored: Option<String> = tx.query_row(
            "SELECT value FROM ai_settings WHERE key='sync_device_token'", [], |r| r.get(0),
        ).optional()?;
        tx.commit()?;
        Ok(stored)
    })?;
    let mut status = engine.status.lock();
    status.enabled = relay_url.is_some();
    status.relay_url = relay_url;
    status.device_token = persisted_token;
    status.has_token = status.device_token.as_ref().is_some_and(|t| !t.is_empty());
    status.last_error = None;
    Ok(())
}

/// Extract every syncable record from a SQLite connection as a SyncRecord
/// using `updated_at` as a coarse cursor (HLC will be "<updated_at_ms>:0:<device>").
fn collect_local_records(conn: &rusqlite::Connection, device_id: &str) -> AppResult<Vec<SyncRecord>> {
    let mut logged_hlcs: HashMap<String, String> = HashMap::new();
    if let Ok(mut stmt) = conn.prepare("SELECT record_id, hlc FROM sync_log WHERE deleted = 0") {
        if let Ok(rows) = stmt.query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?))) {
            for row in rows.flatten() {
                logged_hlcs.insert(row.0, row.1);
            }
        }
    }
    let mut out = Vec::new();
    for &tbl in SYNC_TABLES {
        let (id_col, body_cols): (&str, &[&str]) = match tbl {
            "hosts" => ("id", &["id","label","hostname","port","username","auth_method","grp","tags","color","os","keychain_id","jump_host_id","vault_id","startup_command","updated_at","secret_password","secret_private_key","secret_passphrase"]),
            "snippets" => ("id", &["id","name","command","folder","tags","vault_id","updated_at"]),
            "keychain" => ("id", &["id","label","username","auth_method","password","private_key","passphrase","vault_id","updated_at"]),
            "tunnels" => ("id", &["id","label","host_id","forward_type","local_host","local_port","remote_host","remote_port","vault_id","updated_at"]),
            "vaults" => ("id", &["id","name","kind","color","description","created_at"]),
            _ => continue,
        };
        let cols = body_cols.iter().map(|col| match *col {
            "secret_password" => "(SELECT password FROM secrets WHERE host_id=hosts.id) AS secret_password",
            "secret_private_key" => "(SELECT private_key FROM secrets WHERE host_id=hosts.id) AS secret_private_key",
            "secret_passphrase" => "(SELECT passphrase FROM secrets WHERE host_id=hosts.id) AS secret_passphrase",
            _ => *col,
        }).collect::<Vec<_>>().join(",");
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
                let hlc = logged_hlcs
                    .get(&id_val)
                    .cloned()
                    .unwrap_or_else(|| format!("{ts}:0:{device_id}"));
                Ok(SyncRecord {
                    table: tbl.to_string(),
                    id: id_val,
                    hlc,
                    deleted: false,
                    body: serde_json::Value::Object(obj),
                })
            })
            .map_err(AppError::Db)?;
        for r in rows {
            out.push(r.map_err(AppError::Db)?);
        }
    }

    // Also include deletion tombstones from sync_log so peer devices receive deletions
    if let Ok(mut del_stmt) = conn.prepare("SELECT record_id, tbl, hlc FROM sync_log WHERE deleted = 1") {
        if let Ok(del_rows) = del_stmt.query_map([], |row| {
            Ok(SyncRecord {
                table: row.get(1)?,
                id: row.get(0)?,
                hlc: row.get(2)?,
                deleted: true,
                body: serde_json::Value::Null,
            })
        }) {
            for r in del_rows.flatten() {
                out.push(r);
            }
        }
    }

    Ok(out)
}

/// Apply a remote SyncRecord to the local database using HLC last-writer-wins.
fn apply_remote_record(conn: &rusqlite::Connection, rec: &SyncRecord) -> AppResult<()> {
    let tx = conn.unchecked_transaction()?;

    if rec.deleted {
        match rec.table.as_str() {
            "hosts" => {
                tx.execute("DELETE FROM hosts WHERE id=?1", [&rec.id])?;
                tx.execute("DELETE FROM secrets WHERE host_id=?1", [&rec.id])?;
            }
            "snippets" => {
                tx.execute("DELETE FROM snippets WHERE id=?1", [&rec.id])?;
            }
            "keychain" => {
                tx.execute("DELETE FROM keychain WHERE id=?1", [&rec.id])?;
                tx.execute("UPDATE hosts SET keychain_id=NULL WHERE keychain_id=?1", [&rec.id])?;
            }
            "tunnels" => {
                tx.execute("DELETE FROM tunnels WHERE id=?1", [&rec.id])?;
            }
            "vaults" => {
                if rec.id != "personal" {
                    tx.execute("UPDATE hosts SET vault_id='personal' WHERE vault_id=?1", [&rec.id])?;
                    tx.execute("UPDATE snippets SET vault_id='personal' WHERE vault_id=?1", [&rec.id])?;
                    tx.execute("UPDATE tunnels SET vault_id='personal' WHERE vault_id=?1", [&rec.id])?;
                    tx.execute("UPDATE keychain SET vault_id='personal' WHERE vault_id=?1", [&rec.id])?;
                    tx.execute("DELETE FROM vaults WHERE id=?1", [&rec.id])?;
                }
            }
            _ => {}
        }
        tx.execute(
            "INSERT INTO sync_log (record_id, tbl, hlc, deleted) VALUES (?1, ?2, ?3, 1)
             ON CONFLICT(record_id) DO UPDATE SET tbl=excluded.tbl, hlc=excluded.hlc, deleted=1",
            rusqlite::params![rec.id, rec.table, rec.hlc],
        )?;
        tx.commit()?;
        return Ok(());
    }

    let obj = match &rec.body {
        serde_json::Value::Object(o) => o,
        _ => return Ok(()),
    };

    match rec.table.as_str() {
        "hosts" => {
            tx.execute(
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
            let has_keychain = if let Some(kid) = obj.get("keychain_id").and_then(|v| v.as_str()).filter(|s| !s.is_empty()) {
                tx.query_row("SELECT 1 FROM keychain WHERE id=?1", [kid], |_| Ok(true))
                    .optional()?.unwrap_or(false)
            } else { false };
            let password = obj.get("secret_password").and_then(|v| v.as_str());
            let private_key = obj.get("secret_private_key").and_then(|v| v.as_str());
            let passphrase = obj.get("secret_passphrase").and_then(|v| v.as_str());
            if has_keychain || (password.is_none() && private_key.is_none() && passphrase.is_none()) {
                tx.execute("DELETE FROM secrets WHERE host_id=?1", [&rec.id])?;
            } else {
                tx.execute(
                    "INSERT INTO secrets(host_id,password,private_key,passphrase) VALUES(?1,?2,?3,?4)
                     ON CONFLICT(host_id) DO UPDATE SET password=?2, private_key=?3, passphrase=?4",
                    rusqlite::params![rec.id, password, private_key, passphrase],
                )?;
            }
        }
        "snippets" => {
            tx.execute(
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
            tx.execute(
                "INSERT INTO keychain (id,label,username,auth_method,password,private_key,passphrase,vault_id,updated_at) VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9)
                 ON CONFLICT(id) DO UPDATE SET label=excluded.label,username=excluded.username,auth_method=excluded.auth_method,
                     password=excluded.password,
                     private_key=excluded.private_key,
                     passphrase=excluded.passphrase,
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
            // Reconcile single-source invariant: drop fallback secrets for any hosts referencing this keychain
            tx.execute(
                "DELETE FROM secrets WHERE host_id IN (SELECT id FROM hosts WHERE keychain_id = ?1)",
                [&rec.id],
            )?;
        }
        "tunnels" => {
            tx.execute(
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
            tx.execute(
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
        _ => return Ok(()),
    }

    tx.execute(
        "INSERT INTO sync_log (record_id, tbl, hlc, deleted) VALUES (?1, ?2, ?3, 0)
         ON CONFLICT(record_id) DO UPDATE SET tbl=excluded.tbl, hlc=excluded.hlc, deleted=0",
        rusqlite::params![rec.id, rec.table, rec.hlc],
    )?;

    tx.commit()?;
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

/// Result of fetching + opening one remote blob.
#[derive(Debug)]
enum BlobOutcome {
    Applied,
    /// A blob this device will *never* be able to read, with the reason.
    Skipped(String),
}

/// Count and log a skip. Kept as a function so both fetch loops report
/// identically (the pull loop drains in two places).
fn record_skipped_blob(reason: String, skipped: &mut u64) {
    *skipped += 1;
    log::warn!("Skipping unreadable sync blob — {reason}");
}

/// Fetch/open classification for one relay blob.
///
/// Failures are split by whether waiting can help. A transport error stays
/// fatal, so the cursor is not persisted and the next run retries. A blob that
/// is undecryptable or missing is *never* going to become readable — another
/// sync group sharing the relay, a truncated record, a relay database restored
/// from an older backup — so it is skipped and the cursor still advances.
///
/// Without that split one foreign blob wedged sync permanently: the cursor is
/// written only after a fully successful pass, so every later attempt died on
/// the same record and nothing synced again. Skipping is safe: the record is
/// keyed by `HMAC(K_index, table:id)` under *their* key and sealed under *their*
/// `K_sync`, so there is nothing here to lose by ignoring it.
fn open_remote_blob(
    blob_id: &str,
    cur: u64,
    result: AppResult<Option<Vec<u8>>>,
    keys: &SyncKeys,
    blobs: &mut HashMap<String, (SyncRecord, u64)>,
    hlcs: &mut HashMap<(String, String), String>,
) -> AppResult<BlobOutcome> {
    let bytes = match result {
        Ok(Some(bytes)) => bytes,
        // The relay's change log lists an id it no longer serves.
        Ok(None) => {
            return Ok(BlobOutcome::Skipped(format!(
                "{blob_id}: listed in the change log but not served"
            )))
        }
        // Transient (timeout, DNS, TLS, 5xx): abort, keep the cursor, retry next run.
        Err(AppError::Network(e)) => return Err(AppError::Network(e)),
        Err(e) => return Ok(BlobOutcome::Skipped(format!("{blob_id}: {e}"))),
    };
    let rec = match keys.open(blob_id, &bytes) {
        Ok(rec) => rec,
        // AEAD failure (wrong group key / tampered) or an unparsable record.
        Err(AppError::Crypto(e)) => {
            return Ok(BlobOutcome::Skipped(format!("{blob_id}: {e}")))
        }
        Err(e) => return Err(e),
    };
    if !SYNC_TABLES.contains(&rec.table.as_str()) {
        return Ok(BlobOutcome::Skipped(format!(
            "{blob_id}: unsupported sync table '{}'",
            rec.table
        )));
    }
    hlcs.insert((rec.table.clone(), rec.id.clone()), rec.hlc.clone());
    blobs.insert(blob_id.to_string(), (rec, cur));
    Ok(BlobOutcome::Applied)
}

fn accept_remote_blob(
    fetched: Result<(String, u64, AppResult<Option<Vec<u8>>>), tokio::task::JoinError>,
    keys: &SyncKeys,
    blobs: &mut HashMap<String, (SyncRecord, u64)>,
    hlcs: &mut HashMap<(String, String), String>,
) -> AppResult<BlobOutcome> {
    match fetched {
        Ok((blob_id, cur, result)) => open_remote_blob(&blob_id, cur, result, keys, blobs, hlcs),
        // A panicked fetch task poisons only its own blob.
        Err(e) => Ok(BlobOutcome::Skipped(format!("fetch task failed: {e}"))),
    }
}

fn accept_pushed_blob(
    result: Result<(String, String, String, AppResult<()>), tokio::task::JoinError>,
) -> AppResult<(String, String)> {
    match result {
        Ok((_table, id, hlc, Ok(()))) => Ok((id, hlc)),
        Ok((table, id, _hlc, Err(e))) => Err(AppError::Network(format!("Push failed for {table}/{id}: {e}"))),
        Err(e) => Err(AppError::Other(format!("Push task failed: {e}"))),
    }
}

/// End-to-end encrypted push/pull sync against the configured relay.
#[tauri::command]
pub async fn sync_now(engine: tauri::State<'_, SyncEngine>, vault: tauri::State<'_, Vault>) -> AppResult<SyncStatus> {
    let result = sync_now_inner(&engine, &vault).await;
    if let Err(ref e) = result {
        engine.status.lock().last_error = Some(e.to_string());
    }
    result
}

async fn sync_now_inner(engine: &SyncEngine, vault: &Vault) -> AppResult<SyncStatus> {
    // Manual and background syncs cannot race each other's cursor or writes.
    let _run = engine.run_lock.lock().await;
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

    // Derive v2 keys from the group's stable seed, not this device's
    // master-password-derived SQLCipher key. First sync creates the seed;
    // pairing carries it to newly enrolled devices.
    let seed = vault.with(get_or_create_sync_seed)?;
    let keys = SyncKeys::derive(&seed)?;

    let relay = HttpRelay::new(relay_url.clone(), token);

    // 1. Pull remote blobs first (decrypt & merge into local vault)
    let saved_cursor = vault.with(|conn| {
        let value: Option<String> = conn.query_row(
            "SELECT value FROM ai_settings WHERE key='sync_cursor_v2'", [], |r| r.get(0),
        ).optional()?;
        match value {
            Some(v) => v.parse::<u64>().map_err(|_| AppError::Crypto("Invalid sync cursor".into())),
            None => Ok(0),
        }
    })?;
    let cursor = saved_cursor.max(engine.status.lock().cursor);
    let changes = match relay.changes_since(cursor).await {
        Ok(c) => c,
        Err(e) => {
            let mut s = engine.status.lock();
            s.last_error = Some(format!("failed to fetch sync changes: {e}"));
            return Err(e);
        }
    };

    // Ignore legacy v1 blobs: they were keyed by per-device vault keys and
    // cannot be decrypted using the shared v2 group key.
    let ids_to_fetch: Vec<(String, u64)> = changes.iter()
        .filter(|(id, _)| id.starts_with("v2-"))
        .cloned()
        .collect();

    let mut remote_blobs: HashMap<String, (SyncRecord, u64)> = HashMap::new();
    let mut remote_hlcs: HashMap<(String, String), String> = HashMap::new();
    let mut skipped_blobs: u64 = 0;
    let max_cursor: u64 = changes.iter().map(|(_, cur)| *cur).max().unwrap_or(0);

    let mut fetch_set = tokio::task::JoinSet::new();
    for (blob_id, cur) in ids_to_fetch {
        let relay = relay.clone();
        fetch_set.spawn(async move {
            let res = relay.get(&blob_id).await;
            (blob_id, cur, res)
        });
        if fetch_set.len() >= 16 {
            let result = fetch_set.join_next().await.expect("nonempty fetch set");
            let outcome = accept_remote_blob(result, &keys, &mut remote_blobs, &mut remote_hlcs)?;
            if let BlobOutcome::Skipped(reason) = outcome {
                record_skipped_blob(reason, &mut skipped_blobs);
            }
        }
    }

    while let Some(res) = fetch_set.join_next().await {
        let outcome = accept_remote_blob(res, &keys, &mut remote_blobs, &mut remote_hlcs)?;
        if let BlobOutcome::Skipped(reason) = outcome {
            record_skipped_blob(reason, &mut skipped_blobs);
        }
    }

    let mut pulled = 0usize;
    vault.with(|conn| -> AppResult<()> {
        let mut sorted_remotes: Vec<(SyncRecord, u64)> = remote_blobs.into_values().collect();
        let table_rank = |tbl: &str| match tbl {
            "vaults" => 0,
            "keychain" => 1,
            "hosts" => 2,
            "tunnels" => 3,
            "snippets" => 4,
            _ => 5,
        };
        sorted_remotes.sort_by_key(|(r, _)| table_rank(&r.table));

        for (remote, _cur) in sorted_remotes {
            let local_logged_hlc: Option<String> = conn
                .query_row("SELECT hlc FROM sync_log WHERE record_id=?1", [&remote.id], |r| r.get(0))
                .ok();
            let local_hlc = if let Some(thlc) = local_logged_hlc {
                thlc
            } else {
                let local_ts: Option<i64> = match remote.table.as_str() {
                    "hosts" | "snippets" | "keychain" | "tunnels" => conn
                        .query_row(
                            &format!("SELECT updated_at FROM {} WHERE id=?1", remote.table),
                            [&remote.id],
                            |r| r.get(0),
                        )
                        .ok(),
                    "vaults" => conn
                        .query_row("SELECT created_at FROM vaults WHERE id=?1", [&remote.id], |r| r.get(0))
                        .ok(),
                    _ => None,
                };
                match local_ts {
                    Some(ts) if ts > 0 => format!("{}:0:{}", ts * 1000, device_id),
                    _ => "0:0:".to_string(),
                }
            };
            if hlc_wins(&remote.hlc, &local_hlc) {
                apply_remote_record(conn, &remote)?;
                pulled += 1;
            }
        }
        Ok(())
    })?;

    // 2. Push only changed records. Persist acknowledgements inside SQLCipher
    // so a restart (or a quiet 60-second background poll) does not re-upload
    // every record and flood the relay change log.
    let (post_merge_local_records, pushed_hlcs) = vault.with(|conn| {
        conn.execute_batch("CREATE TABLE IF NOT EXISTS sync_pushed(record_id TEXT PRIMARY KEY, hlc TEXT NOT NULL)")?;
        let records = collect_local_records(conn, &device_id)?;
        let mut known = HashMap::new();
        let mut stmt = conn.prepare("SELECT record_id,hlc FROM sync_pushed")?;
        for row in stmt.query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?)))? {
            let (id, hlc) = row?;
            known.insert(id, hlc);
        }
        Ok((records, known))
    })?;
    let mut acknowledged: Vec<(String, String)> = Vec::new();
    let mut pushed = 0usize;
    let mut push_set = tokio::task::JoinSet::new();
    for rec in post_merge_local_records {
        if pushed_hlcs.get(&rec.id) == Some(&rec.hlc) {
            continue;
        }
        // If the relay already has this record with equal or newer HLC, skip pushing to avoid clobbering
        if let Some(r_hlc) = remote_hlcs.get(&(rec.table.clone(), rec.id.clone())) {
            if !hlc_wins(&rec.hlc, r_hlc) {
                if rec.hlc == *r_hlc {
                    acknowledged.push((rec.id.clone(), rec.hlc.clone()));
                }
                continue;
            }
        }

        let blob_id = keys.blind_id(&rec.table, &rec.id);
        let blob = keys.seal(&rec)?;
        let relay = relay.clone();
        let table = rec.table.clone();
        let id = rec.id.clone();
        let hlc = rec.hlc.clone();
        push_set.spawn(async move {
            let res = relay.put(&blob_id, blob).await;
            (table, id, hlc, res)
        });
        if push_set.len() >= 16 {
            let result = push_set.join_next().await.expect("nonempty push set");
            acknowledged.push(accept_pushed_blob(result)?);
            pushed += 1;
        }
    }

    while let Some(res) = push_set.join_next().await {
        acknowledged.push(accept_pushed_blob(res)?);
        pushed += 1;
    }

    let next_cursor = cursor.max(max_cursor);
    let completed_at = chrono::Utc::now().timestamp();
    vault.with(|conn| {
        let tx = conn.unchecked_transaction()?;
        for (id, hlc) in &acknowledged {
            tx.execute(
                "INSERT INTO sync_pushed(record_id,hlc) VALUES(?1,?2)
                 ON CONFLICT(record_id) DO UPDATE SET hlc=excluded.hlc",
                rusqlite::params![id, hlc],
            )?;
        }
        tx.execute(
            "INSERT INTO ai_settings(key,value) VALUES('sync_cursor_v2',?1)
             ON CONFLICT(key) DO UPDATE SET value=?1",
            [next_cursor.to_string()],
        )?;
        tx.execute(
            "INSERT INTO ai_settings(key,value) VALUES('sync_last_success_v2',?1)
             ON CONFLICT(key) DO UPDATE SET value=?1",
            [completed_at.to_string()],
        )?;
        tx.commit()?;
        Ok(())
    })?;

    let mut s = engine.status.lock();
    s.last_sync = Some(completed_at);
    s.cursor = next_cursor;
    s.last_error = None;
    // Surfaces permanent per-blob problems without failing the run: a non-zero
    // count means the relay is holding records this device can't read (most
    // often a second sync group sharing one relay/token).
    s.skipped_blobs = skipped_blobs;
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
    fn stable_seed_survives_reopen_and_rejects_corruption() {
        let conn = rusqlite::Connection::open_in_memory().unwrap();
        conn.execute("CREATE TABLE ai_settings(key TEXT PRIMARY KEY, value TEXT NOT NULL)", []).unwrap();
        let a = get_or_create_sync_seed(&conn).unwrap();
        let b = get_or_create_sync_seed(&conn).unwrap();
        assert_eq!(*a, *b);
        assert_eq!(SyncKeys::derive(&a).unwrap().blind_id("hosts", "one"),
                   SyncKeys::derive(&b).unwrap().blind_id("hosts", "one"));
        conn.execute("UPDATE ai_settings SET value='bad' WHERE key='sync_seed_v2'", []).unwrap();
        assert!(get_or_create_sync_seed(&conn).is_err());
    }

    #[test]
    fn inline_host_secrets_roundtrip_and_removal() {
        fn db() -> rusqlite::Connection {
            let c = rusqlite::Connection::open_in_memory().unwrap();
            c.execute_batch("\
                CREATE TABLE hosts(id TEXT PRIMARY KEY,label TEXT,hostname TEXT,port INTEGER,username TEXT,
                  auth_method TEXT,grp TEXT,tags TEXT,color TEXT,os TEXT,keychain_id TEXT,
                  jump_host_id TEXT,vault_id TEXT,startup_command TEXT,updated_at INTEGER);
                CREATE TABLE secrets(host_id TEXT PRIMARY KEY,password TEXT,private_key TEXT,passphrase TEXT);
                CREATE TABLE keychain(id TEXT PRIMARY KEY,label TEXT,username TEXT,auth_method TEXT,
                  password TEXT,private_key TEXT,passphrase TEXT,vault_id TEXT,updated_at INTEGER);
                CREATE TABLE snippets(id TEXT PRIMARY KEY,name TEXT,command TEXT,folder TEXT,tags TEXT,
                  vault_id TEXT,updated_at INTEGER);
                CREATE TABLE tunnels(id TEXT PRIMARY KEY,label TEXT,host_id TEXT,forward_type TEXT,
                  local_host TEXT,local_port INTEGER,remote_host TEXT,remote_port INTEGER,vault_id TEXT,updated_at INTEGER);
                CREATE TABLE vaults(id TEXT PRIMARY KEY,name TEXT,kind TEXT,color TEXT,description TEXT,created_at INTEGER);
                CREATE TABLE sync_log(record_id TEXT PRIMARY KEY,tbl TEXT,hlc TEXT,deleted INTEGER);
            ").unwrap();
            c
        }
        let a = db();
        let b = db();
        a.execute("INSERT INTO hosts(id,label,hostname,port,username,auth_method,tags,updated_at)
                   VALUES('h','Test','example.org',22,'alice','password','[]',1)", []).unwrap();
        a.execute("INSERT INTO secrets(host_id,password) VALUES('h','hidden')", []).unwrap();
        let rec = collect_local_records(&a, "a").unwrap().into_iter()
            .find(|r| r.table == "hosts").unwrap();
        assert_eq!(rec.body["secret_password"], "hidden");
        apply_remote_record(&b, &rec).unwrap();
        let password: String = b.query_row("SELECT password FROM secrets WHERE host_id='h'", [], |r| r.get(0)).unwrap();
        assert_eq!(password, "hidden");
        let mut removed = rec.clone();
        removed.hlc = "9999999999999:0:a".into();
        removed.body["secret_password"] = serde_json::Value::Null;
        apply_remote_record(&b, &removed).unwrap();
        let count: i64 = b.query_row("SELECT count(*) FROM secrets", [], |r| r.get(0)).unwrap();
        assert_eq!(count, 0);
    }

    #[test]
    fn groups_are_isolated_and_ids_are_versioned() {
        let a = SyncKeys::derive(&[7u8; 32]).unwrap();
        let b = SyncKeys::derive(&[8u8; 32]).unwrap();
        let a_id = a.blind_id("hosts", "abc");
        assert!(a_id.starts_with("v2-"));
        assert_ne!(a_id, b.blind_id("hosts", "abc"));
        assert_ne!(a_id, a.blind_id("keychain", "abc"));
        let rec = SyncRecord { table: "hosts".into(), id: "abc".into(),
            hlc: "1:0:a".into(), deleted: false, body: serde_json::json!({}) };
        let blob = a.seal(&rec).unwrap();
        assert!(b.open(&a_id, &blob).is_err());
        assert!(a.open(&a.blind_id("hosts", "different"), &blob).is_err());
    }

    #[test]
    fn hlc_ordering() {
        assert!(hlc_wins("2000:0:b", "1000:0:a"));
        assert!(hlc_wins("1000:1:a", "1000:0:a"));
        assert!(hlc_wins("1000:0:b", "1000:0:a"));
        assert!(!hlc_wins("1000:0:a", "1000:0:b"));
    }

    fn host_record(id: &str, hlc: &str) -> SyncRecord {
        SyncRecord {
            table: "hosts".into(),
            id: id.into(),
            hlc: hlc.into(),
            deleted: false,
            body: serde_json::json!({ "hostname": "10.0.0.1" }),
        }
    }

    /// A blob we can never read is skipped so the cursor advances; a transport
    /// error stays fatal so the cursor is held and the record is retried.
    #[test]
    fn unreadable_blobs_are_skipped_but_transport_errors_are_not() {
        let ours = SyncKeys::derive(&[7u8; 32]).unwrap();
        let theirs = SyncKeys::derive(&[8u8; 32]).unwrap();
        let mut blobs: HashMap<String, (SyncRecord, u64)> = HashMap::new();
        let mut hlcs: HashMap<(String, String), String> = HashMap::new();
        let rec = host_record("abc", "1:0:a");

        // Another sync group sharing this relay: skipped, and nothing applied.
        let their_id = theirs.blind_id("hosts", "abc");
        let their_blob = theirs.seal(&rec).unwrap();
        let out = open_remote_blob(&their_id, 5, Ok(Some(their_blob)), &ours, &mut blobs, &mut hlcs);
        assert!(matches!(out, Ok(BlobOutcome::Skipped(_))));
        assert!(blobs.is_empty() && hlcs.is_empty());

        // Listed in the change log but not served: waiting will not help.
        let out = open_remote_blob("v2-abc", 6, Ok(None), &ours, &mut blobs, &mut hlcs);
        assert!(matches!(out, Ok(BlobOutcome::Skipped(_))));

        // Truncated ciphertext: skipped as well.
        let out = open_remote_blob("v2-abc", 7, Ok(Some(vec![9u8; 40])), &ours, &mut blobs, &mut hlcs);
        assert!(matches!(out, Ok(BlobOutcome::Skipped(_))));

        // Transient failures must abort the run so no change is marked applied.
        let err = open_remote_blob(
            "v2-abc",
            8,
            Err(AppError::Network("connection reset".into())),
            &ours,
            &mut blobs,
            &mut hlcs,
        )
        .unwrap_err();
        assert!(matches!(err, AppError::Network(_)));

        // Our own blob applies and its HLC is recorded for push de-duplication.
        let our_id = ours.blind_id("hosts", "abc");
        let our_blob = ours.seal(&rec).unwrap();
        let out = open_remote_blob(&our_id, 9, Ok(Some(our_blob)), &ours, &mut blobs, &mut hlcs);
        assert!(matches!(out, Ok(BlobOutcome::Applied)));
        assert_eq!(blobs.len(), 1);
        assert_eq!(
            hlcs.get(&("hosts".to_string(), "abc".to_string())).map(String::as_str),
            Some("1:0:a")
        );
    }

    #[test]
    fn skipped_blobs_are_counted() {
        let mut skipped = 0u64;
        record_skipped_blob("v2-aa: authentication tag mismatch".into(), &mut skipped);
        record_skipped_blob("v2-bb: listed in the change log but not served".into(), &mut skipped);
        assert_eq!(skipped, 2);
    }
}
