//! Zero-knowledge, end-to-end encrypted sync (blueprint + working crypto core).
//!
//!   K_root  ── vault master key (Argon2id)
//!   K_sync  = HKDF-SHA256(K_root, info="nexus/sync/v1")   → XChaCha20-Poly1305 key
//!   K_index = HKDF-SHA256(K_root, info="nexus/index/v1")  → HMAC key for blinded record ids
//!
//! The relay (WebDAV / S3 / Git / self-hosted) stores only:
//!   PUT /blobs/{hex(HMAC(K_index, table:id))}  body = nonce(24) || ciphertext || tag(16)
//! Payloads are padded to 256-byte buckets to hide record sizes.
//! Conflict resolution: Hybrid Logical Clock, last-writer-wins per record.

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
use serde::{Deserialize, Serialize};
use sha2::Sha256;
use zeroize::Zeroizing;

const PAD_BUCKET: usize = 256;

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

    /// Opaque, deterministic blob name — the relay can't link it to a host.
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

/// Reference HTTP relay transport (stub). Works against any server exposing
/// `PUT/GET /blobs/:id` and `GET /changes?since=`.
pub struct HttpRelay {
    pub base_url: String,
    pub client: reqwest::Client,
    pub device_token: String,
}

impl SyncTransport for HttpRelay {
    async fn put(&self, blob_id: &str, data: Vec<u8>) -> AppResult<()> {
        self.client
            .put(format!("{}/blobs/{blob_id}", self.base_url))
            .bearer_auth(&self.device_token)
            .body(data)
            .send()
            .await
            .and_then(|r| r.error_for_status())
            .map_err(|e| AppError::Network(e.to_string()))?;
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
        Ok(Some(r.bytes().await.map_err(|e| AppError::Network(e.to_string()))?.to_vec()))
    }
    async fn changes_since(&self, _cursor: u64) -> AppResult<Vec<(String, u64)>> {
        // TODO: GET /changes?since={cursor}
        Ok(vec![])
    }
}

#[derive(Default, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct SyncStatus {
    pub enabled: bool,
    pub relay_url: Option<String>,
    pub last_sync: Option<i64>,
    pub cursor: u64,
}

#[derive(Default)]
pub struct SyncEngine {
    status: Mutex<SyncStatus>,
}

#[tauri::command]
pub fn sync_status(engine: tauri::State<'_, SyncEngine>) -> SyncStatus {
    engine.status.lock().clone()
}

#[tauri::command]
pub fn sync_configure(relay_url: Option<String>, engine: tauri::State<'_, SyncEngine>) {
    let mut s = engine.status.lock();
    s.enabled = relay_url.is_some();
    s.relay_url = relay_url;
}

/// Stub: derives keys, seals every local record, pushes to relay, pulls & merges.
#[tauri::command]
pub async fn sync_now(engine: tauri::State<'_, SyncEngine>, vault: tauri::State<'_, Vault>) -> AppResult<SyncStatus> {
    let root = vault.root_key()?;
    let _keys = SyncKeys::derive(&root)?;
    // 1. SELECT changed rows from sync_log where hlc > last_pushed
    // 2. keys.seal(record) → transport.put(keys.blind_id(..), blob)
    // 3. transport.changes_since(cursor) → keys.open → HLC merge into vault
    let mut s = engine.status.lock();
    s.last_sync = Some(chrono::Utc::now().timestamp());
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
}
