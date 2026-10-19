//! Local-first encrypted vault — SQLCipher (AES-256, per-page HMAC-SHA512).
//!
//! Stores host profiles, secrets, reusable keychain identities,
//! connection logs, tunnels, snippets, and session snapshots.

use crate::error::{AppError, AppResult};
use crate::snapshot::Snapshot;
use argon2::{Algorithm, Argon2, Params, Version};
use parking_lot::Mutex;
use base64::{engine::general_purpose::STANDARD as B64, Engine};
use chacha20poly1305::{
    aead::{Aead, KeyInit},
    XChaCha20Poly1305, XNonce,
};
use rand::RngCore;
use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::path::PathBuf;
use zeroize::{Zeroize, ZeroizeOnDrop, Zeroizing};

/// Service name used when talking to the OS keychain (macOS Keychain, Windows
/// Credential Manager, Linux Secret Service via dbus). Grouped under the
/// DrexiusTerminal app identifier so entries are easy to audit/clean up.
const KEYCHAIN_SERVICE: &str = "dev.drexius.terminal";
/// Username under which the master password is stored. We use a fixed,
/// well-known entry so we can query "is there a stored password?" quickly.
const KEYCHAIN_USER: &str = "vault-master-password";

/// Minimum length accepted when *unlocking* an existing vault.
///
/// This is deliberately permissive: it must stay low enough that a vault
/// created by an older build (which only required four characters) can never
/// be locked out of by an upgrade. It is a sanity floor, not a security
/// control.
const MIN_UNLOCK_PASSWORD_CHARS: usize = 4;

/// Minimum length accepted when *choosing* a new master password — that is,
/// when creating a brand-new vault or when setting a new password through
/// recovery/rekey.
///
/// The lock screen already enforces this for new vaults ("Use at least 8
/// characters (12+ recommended)"); mirroring it here means the rule cannot
/// be bypassed by calling the IPC command directly. Argon2id makes each
/// guess expensive, but it does nothing for a four-character password.
const MIN_NEW_PASSWORD_CHARS: usize = 8;

fn keychain_entry() -> AppResult<keyring::Entry> {
    keyring::Entry::new(KEYCHAIN_SERVICE, KEYCHAIN_USER)
        .map_err(|e| AppError::Other(format!("OS keychain unavailable: {e}")))
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct VaultRecord {
    pub id: String,
    pub name: String,
    pub kind: String, // "personal" | "team"
    pub color: Option<String>,
    pub description: Option<String>,
    pub created_at: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SerialPortInfo {
    pub port_name: String,
    pub description: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AiProviderConfig {
    pub provider_id: String,
    pub name: String,
    pub base_url: String,
    pub api_keys: Vec<String>,
    pub selected_model: String,
    pub models_cache: Vec<String>,
    pub balance_strategy: String, // "round_robin" | "p2c" | "random"
    pub enabled: bool,
    pub updated_at: i64,
    #[serde(default)]
    pub use_proxies: bool,
    #[serde(default)]
    pub proxy_urls: Vec<String>,
    #[serde(default = "default_proxy_strategy")]
    pub proxy_strategy: String,
    #[serde(default)]
    pub auto_ssh_proxy: bool,
    #[serde(default)]
    pub auto_ssh_host_id: Option<String>,
}

fn default_proxy_strategy() -> String {
    "p2c".into()
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TeamVaultPayload {
    pub vault: VaultRecord,
    pub hosts: Vec<HostProfile>,
    pub keychain: Vec<KeychainItem>,
    pub tunnels: Vec<TunnelConfig>,
    pub snippets: Vec<Snippet>,
    #[serde(default)]
    pub ai_configs: Vec<AiProviderConfig>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EncryptedTeamVaultBundle {
    pub version: u32,
    pub format: String,
    pub vault_name: String,
    pub salt: String,
    pub nonce: String,
    pub ciphertext: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PairedDevice {
    pub id: String,
    pub device_name: String,
    pub device_type: String,
    pub ip_address: Option<String>,
    pub public_key: Option<String>,
    pub paired_at: i64,
    pub last_sync: i64,
    /// Stable peer device identity (`sync_device_id`) reported at pairing.
    /// Legacy peers that predate the field send an empty string.
    #[serde(default)]
    pub device_id: String,
    /// When set, this peer is revoked: it is refused at future pairings.
    pub revoked_at: Option<i64>,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum AuthMethod {
    Password,
    Key,
    Agent,
}

impl AuthMethod {
    pub fn as_str(&self) -> &'static str {
        match self {
            AuthMethod::Password => "password",
            AuthMethod::Key => "key",
            AuthMethod::Agent => "agent",
        }
    }
    pub fn parse(s: &str) -> Self {
        match s {
            "key" => AuthMethod::Key,
            "agent" => AuthMethod::Agent,
            _ => AuthMethod::Password,
        }
    }
}

/// Non-secret host metadata — safe to send to the WebView.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HostProfile {
    pub id: String,
    pub label: String,
    pub hostname: String,
    pub port: u16,
    pub username: String,
    pub auth_method: AuthMethod,
    pub group: Option<String>,
    pub tags: Vec<String>,
    pub color: Option<String>,
    pub has_secret: bool,
    #[serde(default)]
    pub os: Option<String>,
    #[serde(default)]
    pub keychain_id: Option<String>,
    #[serde(default)]
    pub jump_host_id: Option<String>,
    #[serde(default)]
    pub vault_id: Option<String>,
    #[serde(default)]
    pub startup_command: Option<String>,
    #[serde(default)]
    pub proxy_command: Option<String>,
}

/// Credentials — never serialized back to the frontend. Wiped on drop.
#[derive(Default, Clone, Deserialize, Zeroize, ZeroizeOnDrop)]
#[serde(rename_all = "camelCase")]
pub struct HostSecret {
    pub password: Option<String>,
    pub private_key: Option<String>,
    pub passphrase: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HostInput {
    #[serde(flatten)]
    pub profile: HostProfile,
    /// `None` = keep existing secret.
    pub secret: Option<HostSecret>,
}

/// Reusable Identity in Keychain (stored encrypted in the vault)
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct KeychainItem {
    pub id: String,
    pub label: String,
    pub username: Option<String>,
    pub auth_method: AuthMethod,
    pub has_secret: bool,
    pub updated_at: i64,
    #[serde(default)]
    pub vault_id: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct KeychainInput {
    pub id: String,
    pub label: String,
    pub username: Option<String>,
    pub auth_method: AuthMethod,
    pub password: Option<String>,
    pub private_key: Option<String>,
    pub passphrase: Option<String>,
    pub vault_id: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConnectionLog {
    pub id: String,
    pub host_id: Option<String>,
    pub host_label: String,
    pub username: String,
    pub hostname: String,
    pub started_at: i64,
    pub ended_at: Option<i64>,
    pub duration: Option<i64>,
    pub status: String,
    pub saved: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct KnownHost {
    pub host: String,
    pub port: u16,
    pub fingerprint: String,
    pub added_at: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TunnelConfig {
    pub id: String,
    pub label: String,
    pub host_id: String,
    pub forward_type: String, // "local", "remote", "dynamic"
    pub local_host: String,
    pub local_port: u16,
    pub remote_host: String,
    pub remote_port: u16,
    #[serde(default)]
    pub updated_at: i64,
    #[serde(default)]
    pub vault_id: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Snippet {
    pub id: String,
    pub name: String,
    pub command: String,
    pub folder: Option<String>,
    pub tags: Vec<String>,
    #[serde(default)]
    pub vault_id: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VaultStatus {
    pub initialized: bool,
    pub unlocked: bool,
}

struct Unlocked {
    conn: Connection,
    root_key: Zeroizing<[u8; 32]>,
}

pub struct Vault {
    path: PathBuf,
    inner: Mutex<Option<Unlocked>>,
}

const SCHEMA: &str = r#"
CREATE TABLE IF NOT EXISTS hosts (
    id TEXT PRIMARY KEY, label TEXT NOT NULL, hostname TEXT NOT NULL, port INTEGER NOT NULL,
    username TEXT NOT NULL, auth_method TEXT NOT NULL, grp TEXT, tags TEXT NOT NULL DEFAULT '[]',
    color TEXT, os TEXT, keychain_id TEXT, jump_host_id TEXT, vault_id TEXT, startup_command TEXT, proxy_command TEXT, updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS secrets (
    host_id TEXT PRIMARY KEY REFERENCES hosts(id) ON DELETE CASCADE,
    password TEXT, private_key TEXT, passphrase TEXT
);
CREATE TABLE IF NOT EXISTS keychain (
    id TEXT PRIMARY KEY, label TEXT NOT NULL, username TEXT, auth_method TEXT NOT NULL,
    password TEXT, private_key TEXT, passphrase TEXT, updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS known_hosts (
    host TEXT NOT NULL, port INTEGER NOT NULL, fingerprint TEXT NOT NULL, added_at INTEGER NOT NULL,
    PRIMARY KEY (host, port)
);
CREATE TABLE IF NOT EXISTS snippets (
    id TEXT PRIMARY KEY, name TEXT NOT NULL, command TEXT NOT NULL, folder TEXT,
    tags TEXT NOT NULL DEFAULT '[]', updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS snapshots (
    host_id TEXT PRIMARY KEY, session_id TEXT, cwd TEXT NOT NULL, last_command TEXT, updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS connection_logs (
    id TEXT PRIMARY KEY, host_id TEXT, host_label TEXT NOT NULL, username TEXT NOT NULL,
    hostname TEXT NOT NULL, started_at INTEGER NOT NULL, ended_at INTEGER, duration INTEGER,
    status TEXT NOT NULL, saved INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS tunnels (
    id TEXT PRIMARY KEY, label TEXT NOT NULL, host_id TEXT NOT NULL, forward_type TEXT NOT NULL,
    local_host TEXT NOT NULL, local_port INTEGER NOT NULL, remote_host TEXT NOT NULL, remote_port INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS vaults (
    id TEXT PRIMARY KEY, name TEXT NOT NULL, kind TEXT NOT NULL DEFAULT 'personal',
    color TEXT, description TEXT, created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS sync_log (
    record_id TEXT PRIMARY KEY, tbl TEXT NOT NULL, hlc TEXT NOT NULL, deleted INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS paired_devices (
    id TEXT PRIMARY KEY, device_name TEXT NOT NULL, device_type TEXT NOT NULL,
    ip_address TEXT, public_key TEXT, paired_at INTEGER NOT NULL, last_sync INTEGER NOT NULL,
    device_id TEXT NOT NULL DEFAULT '', revoked_at INTEGER
);
CREATE TABLE IF NOT EXISTS command_history (
    id TEXT PRIMARY KEY, host_id TEXT, host_label TEXT NOT NULL, command TEXT NOT NULL,
    cwd TEXT, executed_at INTEGER NOT NULL, starred INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS clipboard_history (
    id TEXT PRIMARY KEY, content TEXT NOT NULL, char_count INTEGER NOT NULL,
    line_count INTEGER NOT NULL, source TEXT, copied_at INTEGER NOT NULL, pinned INTEGER NOT NULL DEFAULT 0
);
"#;

fn now() -> i64 {
    chrono::Utc::now().timestamp()
}

fn add_column_if_missing(conn: &Connection, table: &str, col: &str, col_type: &str) -> rusqlite::Result<()> {
    let pragma_sql = format!("PRAGMA table_info({table})");
    let mut stmt = conn.prepare(&pragma_sql)?;
    let col_exists: bool = stmt
        .query_map([], |row| row.get::<_, String>(1))?
        .filter_map(Result::ok)
        .any(|name| name.eq_ignore_ascii_case(col));
    if !col_exists {
        conn.execute(&format!("ALTER TABLE {table} ADD COLUMN {col} {col_type}"), [])?;
    }
    Ok(())
}

#[derive(Serialize, Deserialize)]
struct RecoveryEnvelope {
    version: u32,
    recovery_salt: String,
    nonce: String,
    ciphertext: String,
}

/// Rekey intent journal. Written (atomically) *before* `PRAGMA rekey` runs and
/// deleted only after the new salt + recovery envelope are safely on disk. If
/// the process dies mid-rekey, the next unlock/recover finds this file and can
/// either roll back (the DB still opens with the old key) or finish the rekey
/// (the DB already opens with the new key) — never both credentials broken.
#[derive(Serialize, Deserialize)]
struct RekeyJournal {
    version: u32,
    /// hex-encoded 16-byte salt for the NEW master key.
    new_salt: String,
    /// new_key (32 bytes) sealed with the OLD db key:
    /// base64(nonce24 || ciphertext48).
    new_key_sealed: String,
}

/// Write a file as atomically as the OS allows: same-directory temp file,
/// fsync, then rename over the target. A crash can leave a stray `.tmp-*`
/// file but never a half-written salt/envelope/journal.
fn write_atomic(path: &std::path::Path, bytes: &[u8]) -> AppResult<()> {
    use std::io::Write;
    let dir = match path.parent() {
        Some(p) if !p.as_os_str().is_empty() => p.to_path_buf(),
        _ => std::path::PathBuf::from("."),
    };
    let fname = path
        .file_name()
        .ok_or_else(|| AppError::Other("Invalid target file name".into()))?;
    let mut tmp_name = fname.to_os_string();
    tmp_name.push(format!(".tmp-{}", std::process::id()));
    let tmp_path = dir.join(tmp_name);
    let result = (|| -> AppResult<()> {
        let mut f = std::fs::File::create(&tmp_path)?;
        f.write_all(bytes)?;
        f.sync_all()?;
        std::fs::rename(&tmp_path, path)?;
        Ok(())
    })();
    if result.is_err() {
        let _ = std::fs::remove_file(&tmp_path);
    }
    result
}

fn normalize_recovery_code(code: &str) -> String {
    let clean = code.trim().replace('-', "").replace(' ', "").to_uppercase();
    if let Some(stripped) = clean.strip_prefix("DRX").or_else(|| clean.strip_prefix("NX")) {
        stripped.to_string()
    } else {
        clean
    }
}

fn generate_recovery_code() -> (String, String) {
    let mut raw = [0u8; 16];
    rand::thread_rng().fill_bytes(&mut raw);
    let hex_raw = hex::encode(raw).to_uppercase();
    let formatted = format!(
        "DRX-{}-{}-{}-{}-{}-{}-{}-{}",
        &hex_raw[0..4],
        &hex_raw[4..8],
        &hex_raw[8..12],
        &hex_raw[12..16],
        &hex_raw[16..20],
        &hex_raw[20..24],
        &hex_raw[24..28],
        &hex_raw[28..32]
    );
    let normalized = hex_raw;
    (formatted, normalized)
}

impl Vault {
    pub fn new(path: PathBuf) -> Self {
        Self { path, inner: Mutex::new(None) }
    }

    fn salt_path(&self) -> PathBuf {
        self.path.with_extension("salt")
    }

    pub fn recovery_path(&self) -> PathBuf {
        self.path.with_extension("recovery")
    }

    /// Machine-isolated credential path for device screen lock & biometrics fallback.
    pub fn device_lock_path(&self) -> PathBuf {
        self.path.with_extension("device_lock")
    }

    fn device_lock_key(&self) -> AppResult<[u8; 32]> {
        let salt = std::fs::read(self.salt_path()).unwrap_or_else(|_| b"drexius-terminal-default-salt".to_vec());
        let mut ikm = Vec::new();
        ikm.extend_from_slice(b"drexius-device-lock-master-v1-");
        ikm.extend_from_slice(&salt);
        #[cfg(target_os = "android")]
        ikm.extend_from_slice(b"-android-sandbox-uid");
        #[cfg(not(target_os = "android"))]
        ikm.extend_from_slice(b"-desktop-local-fallback");

        let hk = hkdf::Hkdf::<sha2::Sha256>::new(Some(b"drx-device-lock-salt-2025"), &ikm);
        let mut okm = [0u8; 32];
        hk.expand(b"drx-device-lock-encryption-key", &mut okm)
            .map_err(|e| AppError::Crypto(e.to_string()))?;
        Ok(okm)
    }

    pub fn save_device_lock(&self, master_password: &str) -> AppResult<()> {
        let key_bytes = self.device_lock_key()?;
        let cipher = XChaCha20Poly1305::new((&key_bytes).into());
        let mut nonce_bytes = [0u8; 24];
        rand::thread_rng().fill_bytes(&mut nonce_bytes);
        let nonce = XNonce::from_slice(&nonce_bytes);
        let ciphertext = cipher
            .encrypt(nonce, master_password.as_bytes())
            .map_err(|e| AppError::Crypto(format!("Failed to encrypt device lock credential: {e}")))?;

        let mut payload = nonce_bytes.to_vec();
        payload.extend_from_slice(&ciphertext);
        let path = self.device_lock_path();
        write_atomic(&path, &payload)?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let _ = std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o600));
        }
        Ok(())
    }

    pub fn load_device_lock(&self) -> AppResult<Zeroizing<String>> {
        let path = self.device_lock_path();
        if !path.exists() {
            return Err(AppError::Other("No device lock credential found on this device".into()));
        }
        let payload = std::fs::read(&path)?;
        if payload.len() <= 24 {
            return Err(AppError::Other("Corrupt device credential payload".into()));
        }
        let (nonce_bytes, ciphertext) = payload.split_at(24);
        let nonce = XNonce::from_slice(nonce_bytes);
        let key_bytes = self.device_lock_key()?;
        let cipher = XChaCha20Poly1305::new((&key_bytes).into());
        let plaintext = cipher
            .decrypt(nonce, ciphertext)
            .map_err(|e| AppError::Crypto(format!("Failed to decrypt device credential: {e}")))?;
        let pw_str = String::from_utf8(plaintext)
            .map_err(|_| AppError::Other("Invalid device credential encoding".into()))?;
        Ok(Zeroizing::new(pw_str))
    }

    pub fn delete_device_lock(&self) -> AppResult<()> {
        let path = self.device_lock_path();
        if path.exists() {
            let _ = std::fs::remove_file(path);
        }
        Ok(())
    }

    pub fn clear_saved_credentials(&self) {
        if let Ok(entry) = keychain_entry() {
            let _ = entry.delete_credential();
        }
        let _ = self.delete_device_lock();
    }

    /// Transient rekey-intent journal (see `RekeyJournal`).
    fn rekey_journal_path(&self) -> PathBuf {
        self.path.with_extension("rekey")
    }

    /// Pre-rekey database snapshot taken before `PRAGMA rekey`, kept until the
    /// rekey is finalized. Restores the pre-rekey state if the DB itself is
    /// damaged mid-rekey.
    fn pre_rekey_backup_path(&self) -> PathBuf {
        self.path.with_extension("pre-rekey")
    }

    pub fn derive_key(password: &str, salt: &[u8]) -> AppResult<Zeroizing<[u8; 32]>> {
        let params = Params::new(64 * 1024, 3, 1, Some(32)).map_err(|e| AppError::Crypto(e.to_string()))?;
        let argon = Argon2::new(Algorithm::Argon2id, Version::V0x13, params);
        let mut key = Zeroizing::new([0u8; 32]);
        argon
            .hash_password_into(password.as_bytes(), salt, key.as_mut())
            .map_err(|e| AppError::Crypto(e.to_string()))?;
        Ok(key)
    }

    pub fn save_recovery_envelope(&self, db_key: &[u8; 32], normalized_code: &str) -> AppResult<()> {
        let mut salt = [0u8; 16];
        rand::thread_rng().fill_bytes(&mut salt);
        let kek = Self::derive_key(normalized_code, &salt)?;

        let mut nonce_bytes = [0u8; 24];
        rand::thread_rng().fill_bytes(&mut nonce_bytes);
        let nonce = XNonce::from_slice(&nonce_bytes);

        let cipher = XChaCha20Poly1305::new((kek.as_ref()).into());
        let ciphertext = cipher
            .encrypt(nonce, db_key.as_slice())
            .map_err(|e| AppError::Crypto(format!("Failed to encrypt recovery envelope: {e}")))?;

        let env = RecoveryEnvelope {
            version: 1,
            recovery_salt: hex::encode(salt),
            nonce: hex::encode(nonce_bytes),
            ciphertext: B64.encode(ciphertext),
        };
        let json = serde_json::to_string_pretty(&env)
            .map_err(|e| AppError::Other(e.to_string()))?;
        write_atomic(&self.recovery_path(), json.as_bytes())?;
        Ok(())
    }

    /// Seal the new db key under the old db key for the rekey journal.
    fn seal_new_key(old_key: &[u8; 32], new_key: &[u8; 32]) -> AppResult<String> {
        let cipher = XChaCha20Poly1305::new(old_key.into());
        let mut nonce_bytes = [0u8; 24];
        rand::thread_rng().fill_bytes(&mut nonce_bytes);
        let nonce = XNonce::from_slice(&nonce_bytes);
        let ct = cipher
            .encrypt(nonce, new_key.as_slice())
            .map_err(|e| AppError::Crypto(format!("Failed to seal rekey journal: {e}")))?;
        let mut blob = nonce_bytes.to_vec();
        blob.extend_from_slice(&ct);
        Ok(B64.encode(blob))
    }

    fn unseal_new_key(old_key: &[u8; 32], sealed: &str) -> AppResult<Zeroizing<[u8; 32]>> {
        let blob = B64
            .decode(sealed)
            .map_err(|_| AppError::Crypto("Invalid rekey journal payload".into()))?;
        if blob.len() != 24 + 32 + 16 {
            return Err(AppError::Crypto("Invalid rekey journal payload length".into()));
        }
        let nonce = XNonce::from_slice(&blob[..24]);
        let cipher = XChaCha20Poly1305::new(old_key.into());
        let pt = cipher
            .decrypt(nonce, &blob[24..])
            .map_err(|_| AppError::Crypto("Rekey journal did not match the vault key".into()))?;
        if pt.len() != 32 {
            return Err(AppError::Crypto("Corrupted key in rekey journal".into()));
        }
        let mut key = Zeroizing::new([0u8; 32]);
        key.copy_from_slice(&pt);
        Ok(key)
    }

    pub fn decrypt_recovery_envelope(&self, code: &str) -> AppResult<Zeroizing<[u8; 32]>> {
        let normalized = normalize_recovery_code(code);
        if normalized.len() < 16 {
            return Err(AppError::Other("Invalid recovery key format".into()));
        }
        let env_bytes = std::fs::read(self.recovery_path())
            .map_err(|_| AppError::Other("No emergency recovery key found on this system".into()))?;
        let env: RecoveryEnvelope = serde_json::from_slice(&env_bytes)
            .map_err(|e| AppError::Other(format!("Corrupt recovery envelope: {e}")))?;

        let salt = hex::decode(&env.recovery_salt)
            .map_err(|_| AppError::Crypto("Invalid salt in recovery envelope".into()))?;
        let kek = Self::derive_key(&normalized, &salt)?;

        let nonce_bytes = hex::decode(&env.nonce)
            .map_err(|_| AppError::Crypto("Invalid nonce in recovery envelope".into()))?;
        if nonce_bytes.len() != 24 {
            return Err(AppError::Crypto("Invalid nonce length".into()));
        }
        let nonce = XNonce::from_slice(&nonce_bytes);

        let ciphertext = B64.decode(&env.ciphertext)
            .map_err(|_| AppError::Crypto("Invalid ciphertext in recovery envelope".into()))?;

        let cipher = XChaCha20Poly1305::new((kek.as_ref()).into());
        let db_key = cipher
            .decrypt(nonce, ciphertext.as_slice())
            .map_err(|_| AppError::Crypto("Invalid recovery key. Decryption failed.".into()))?;

        if db_key.len() != 32 {
            return Err(AppError::Crypto("Corrupted database key in envelope".into()));
        }
        let mut key = Zeroizing::new([0u8; 32]);
        key.copy_from_slice(&db_key);
        Ok(key)
    }

    fn unlock_with_key(&self, key: Zeroizing<[u8; 32]>) -> AppResult<()> {
        let conn = Connection::open(&self.path)?;
        let hex_key = Zeroizing::new(hex::encode(key.as_ref()));
        conn.execute_batch(&format!(
            "PRAGMA key = \"x'{}'\"; PRAGMA cipher_page_size = 4096; PRAGMA cipher_memory_security = ON;",
            hex_key.as_str()
        ))?;
        // Wrong key → "file is not a database".
        conn.query_row("SELECT count(*) FROM sqlite_master", [], |r| r.get::<_, i64>(0))
            .map_err(|_| AppError::BadMasterPassword)?;
        conn.execute_batch("PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL;")?;
        conn.execute_batch(SCHEMA)?;

        // Migrations: gated by SQLite user_version so ALTER TABLE statements only run once
        let user_version: i64 = conn.query_row("PRAGMA user_version", [], |r| r.get(0)).unwrap_or(0);
        if user_version < 2 {
            let tx = conn.unchecked_transaction()?;
            tx.execute("CREATE TABLE IF NOT EXISTS vaults (id TEXT PRIMARY KEY, name TEXT NOT NULL, kind TEXT NOT NULL DEFAULT 'personal', color TEXT, description TEXT, created_at INTEGER NOT NULL)", [])?;
            tx.execute("INSERT OR IGNORE INTO vaults (id, name, kind, color, description, created_at) VALUES ('personal', 'Personal Vault', 'personal', '#22d3ee', 'Your private hosts & secrets', unixepoch())", [])?;
            add_column_if_missing(&tx, "hosts", "os", "TEXT")?;
            add_column_if_missing(&tx, "hosts", "keychain_id", "TEXT")?;
            add_column_if_missing(&tx, "hosts", "jump_host_id", "TEXT")?;
            add_column_if_missing(&tx, "hosts", "vault_id", "TEXT DEFAULT 'personal'")?;
            add_column_if_missing(&tx, "hosts", "startup_command", "TEXT")?;
            add_column_if_missing(&tx, "keychain", "vault_id", "TEXT DEFAULT 'personal'")?;
            add_column_if_missing(&tx, "tunnels", "vault_id", "TEXT DEFAULT 'personal'")?;
            add_column_if_missing(&tx, "snippets", "vault_id", "TEXT DEFAULT 'personal'")?;
            tx.execute("CREATE TABLE IF NOT EXISTS paired_devices (id TEXT PRIMARY KEY, device_name TEXT NOT NULL, device_type TEXT NOT NULL, ip_address TEXT, public_key TEXT, paired_at INTEGER NOT NULL, last_sync INTEGER NOT NULL, device_id TEXT NOT NULL DEFAULT '', revoked_at INTEGER)", [])?;
            tx.execute("CREATE TABLE IF NOT EXISTS ai_configs (provider_id TEXT PRIMARY KEY, name TEXT NOT NULL, base_url TEXT NOT NULL, api_keys TEXT NOT NULL DEFAULT '[]', selected_model TEXT NOT NULL DEFAULT '', models_cache TEXT NOT NULL DEFAULT '[]', balance_strategy TEXT NOT NULL DEFAULT 'round_robin', enabled INTEGER NOT NULL DEFAULT 1, updated_at INTEGER NOT NULL)", [])?;
            add_column_if_missing(&tx, "ai_configs", "use_proxies", "INTEGER NOT NULL DEFAULT 0")?;
            add_column_if_missing(&tx, "ai_configs", "proxy_urls", "TEXT NOT NULL DEFAULT '[]'")?;
            add_column_if_missing(&tx, "ai_configs", "proxy_strategy", "TEXT NOT NULL DEFAULT 'p2c'")?;
            add_column_if_missing(&tx, "ai_configs", "auto_ssh_proxy", "INTEGER NOT NULL DEFAULT 0")?;
            add_column_if_missing(&tx, "ai_configs", "auto_ssh_host_id", "TEXT")?;
            tx.execute("CREATE TABLE IF NOT EXISTS ai_settings (key TEXT PRIMARY KEY, value TEXT NOT NULL)", [])?;
            tx.execute("CREATE TABLE IF NOT EXISTS command_history (id TEXT PRIMARY KEY, host_id TEXT, host_label TEXT NOT NULL, command TEXT NOT NULL, cwd TEXT, executed_at INTEGER NOT NULL, starred INTEGER NOT NULL DEFAULT 0)", [])?;
            tx.execute("CREATE TABLE IF NOT EXISTS clipboard_history (id TEXT PRIMARY KEY, content TEXT NOT NULL, char_count INTEGER NOT NULL, line_count INTEGER NOT NULL, source TEXT, copied_at INTEGER NOT NULL, pinned INTEGER NOT NULL DEFAULT 0)", [])?;
            // Auto-detect and import keys from existing hosts into keychain (idempotent, only imports unlinked)
            let _ = import_hosts_keys_internal(&tx);
            tx.pragma_update(None, "user_version", 2)?;
            tx.commit()?;
        } else {
            let _ = conn.execute("INSERT OR IGNORE INTO vaults (id, name, kind, color, description, created_at) VALUES ('personal', 'Personal Vault', 'personal', '#22d3ee', 'Your private hosts & secrets', unixepoch())", []);
        }
        // v3: single-source credentials backfill for vaults already at v2.
        let user_version: i64 = conn.query_row("PRAGMA user_version", [], |r| r.get(0)).unwrap_or(2);
        if user_version < 3 {
            let tx = conn.unchecked_transaction()?;
            tx.execute(
                "DELETE FROM secrets WHERE host_id IN (
                    SELECT h.id FROM hosts h
                    JOIN keychain k ON k.id = h.keychain_id
                    WHERE h.keychain_id IS NOT NULL AND h.keychain_id != ''
                )",
                [],
            )?;
            tx.execute(
                "UPDATE hosts SET keychain_id = NULL
                 WHERE keychain_id IS NOT NULL AND keychain_id != ''
                   AND keychain_id NOT IN (SELECT id FROM keychain)",
                [],
            )?;
            tx.execute(
                "UPDATE keychain SET vault_id = 'personal' WHERE vault_id IS NULL OR vault_id = ''",
                [],
            )?;
            let _ = import_hosts_keys_internal(&tx);
            tx.pragma_update(None, "user_version", 3)?;
            tx.commit()?;
        }
        // v4: paired_devices gains a stable peer identity and a revocation marker so
        // `pairing_revoke_device` can actually refuse the peer at future pairings.
        let user_version: i64 = conn.query_row("PRAGMA user_version", [], |r| r.get(0)).unwrap_or(3);
        if user_version < 4 {
            let tx = conn.unchecked_transaction()?;
            add_column_if_missing(&tx, "paired_devices", "device_id", "TEXT NOT NULL DEFAULT ''")?;
            add_column_if_missing(&tx, "paired_devices", "revoked_at", "INTEGER")?;
            tx.pragma_update(None, "user_version", 4)?;
            tx.commit()?;
        }
        // v5: hosts gains proxy_command for Zero-Trust tunnels (Cloudflare Access, AWS SSM, custom ProxyCommand)
        let user_version: i64 = conn.query_row("PRAGMA user_version", [], |r| r.get(0)).unwrap_or(4);
        if user_version < 5 {
            let tx = conn.unchecked_transaction()?;
            add_column_if_missing(&tx, "hosts", "proxy_command", "TEXT")?;
            tx.pragma_update(None, "user_version", 5)?;
            tx.commit()?;
        }
        *self.inner.lock() = Some(Unlocked { conn, root_key: key });
        Ok(())
    }

    pub fn unlock(&self, master_password: &str) -> AppResult<Option<String>> {
        // Choosing the master password for a *new* vault is a different act
        // from unlocking an existing one, and only the former gets the strong
        // length policy. The vault database not existing is exactly the
        // distinction the lock screen draws (`initialized === false`), so an
        // existing vault can never be locked out by this check.
        if !self.path.exists() && master_password.chars().count() < MIN_NEW_PASSWORD_CHARS {
            return Err(AppError::Other(format!(
                "Master password must be at least {MIN_NEW_PASSWORD_CHARS} characters"
            )));
        }
        let salt = match std::fs::read(self.salt_path()) {
            Ok(s) if s.len() == 16 => s,
            Ok(s) => return Err(AppError::Crypto(format!("vault salt file is corrupt ({} bytes, expected 16)", s.len()))),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
                if self.path.exists() {
                    return Err(AppError::Crypto(
                        "Vault database exists but its salt file (drexius.salt) is missing. \
                         Refusing to generate a new salt to prevent permanent data loss. \
                         Please restore drexius.salt or delete the vault database to reset.".into()
                    ));
                }
                let mut s = vec![0u8; 16];
                rand::thread_rng().fill_bytes(&mut s);
                write_atomic(&self.salt_path(), &s)?;
                s
            }
            Err(e) => return Err(AppError::Io(e)),
        };
        let key = Self::derive_key(master_password, &salt)?;

        // A crash mid-rekey leaves an intent journal behind. Resolve it before
        // anything else: either the rekey never committed (roll it back) or it
        // did (finish it and hand the user a fresh recovery key).
        let journal = self.read_rekey_journal();
        match self.unlock_with_key(key.clone()) {
            Ok(()) => {
                if let Some(j) = &journal {
                    let journal_salt = hex::decode(&j.new_salt).unwrap_or_default();
                    if journal_salt.as_slice() == salt.as_slice() {
                        // DB + salt already on the new key; the envelope may
                        // predate the crash. Regenerate it and show the code.
                        let (code, normalized) = generate_recovery_code();
                        self.save_recovery_envelope(&key, &normalized)?;
                        self.clear_rekey_artifacts();
                        self.clear_saved_credentials();
                        return Ok(Some(code));
                    }
                    // Rekey never committed: old key still opens the DB.
                    self.clear_rekey_artifacts();
                }
                // No recovery envelope yet (new vault, or a vault upgraded
                // from a version without recovery keys): create one and give
                // the user the code — it is the only copy they will get.
                if !self.recovery_path().exists() {
                    let (code, normalized) = generate_recovery_code();
                    self.save_recovery_envelope(&key, &normalized)?;
                    return Ok(Some(code));
                }
                // No pending rekey: a leftover snapshot is stale.
                let _ = std::fs::remove_file(self.pre_rekey_backup_path());
                Ok(None)
            }
            Err(AppError::BadMasterPassword) if journal.is_some() => {
                // The password does not match the salt on file, but a rekey
                // journal exists: the crash likely hit after `PRAGMA rekey`
                // but before the new salt was written. Try the journal's salt.
                let j = journal.expect("checked is_some");
                let new_salt: [u8; 16] = hex::decode(&j.new_salt)
                    .ok()
                    .and_then(|v| v.try_into().ok())
                    .ok_or(AppError::BadMasterPassword)?;
                let key2 = Self::derive_key(master_password, &new_salt)?;
                self.unlock_with_key(key2.clone())?;
                // Post-rekey state confirmed: finish the rekey.
                write_atomic(&self.salt_path(), &new_salt)?;
                let (code, normalized) = generate_recovery_code();
                self.save_recovery_envelope(&key2, &normalized)?;
                self.clear_rekey_artifacts();
                if let Some(ref mut u) = *self.inner.lock() {
                    u.root_key = key2;
                }
                self.clear_saved_credentials();
                Ok(Some(code))
            }
            Err(e) => Err(e),
        }
    }

    fn read_rekey_journal(&self) -> Option<RekeyJournal> {
        let bytes = std::fs::read(self.rekey_journal_path()).ok()?;
        serde_json::from_slice(&bytes).ok()
    }

    /// Remove the rekey journal and the pre-rekey snapshot. Called only once
    /// the vault is known to be in a consistent state again.
    fn clear_rekey_artifacts(&self) {
        let _ = std::fs::remove_file(self.rekey_journal_path());
        let _ = std::fs::remove_file(self.pre_rekey_backup_path());
    }

    pub fn recover_and_rekey(&self, recovery_code: &str, new_password: &str) -> AppResult<String> {
        // Defense in depth: the `vault_recover` command checks this too, but
        // the method is the real gate — it is where the new password is
        // actually turned into a key.
        if new_password.chars().count() < MIN_NEW_PASSWORD_CHARS {
            return Err(AppError::Other(format!(
                "New master password must be at least {MIN_NEW_PASSWORD_CHARS} characters"
            )));
        }
        let db_key = self.decrypt_recovery_envelope(recovery_code)?;
        let journal = self.read_rekey_journal();

        match self.unlock_with_key(db_key.clone()) {
            Ok(()) => {
                // Old key still opens the DB. If a journal exists the previous
                // rekey never committed — roll it back before starting anew.
                if journal.is_some() {
                    self.clear_rekey_artifacts();
                }
            }
            Err(AppError::BadMasterPassword) if journal.is_some() => {
                // A crashed rekey already committed (`PRAGMA rekey` ran): the
                // old recovery code still unseals the new key from the journal.
                let j = journal.expect("checked is_some");
                let new_key = Self::unseal_new_key(&db_key, &j.new_key_sealed)?;
                self.unlock_with_key(new_key.clone())?;
                let new_salt: [u8; 16] = hex::decode(&j.new_salt)
                    .ok()
                    .and_then(|v| v.try_into().ok())
                    .ok_or(AppError::Crypto("Corrupt rekey journal salt".into()))?;
                write_atomic(&self.salt_path(), &new_salt)?;
                let (fresh_code, normalized) = generate_recovery_code();
                self.save_recovery_envelope(&new_key, &normalized)?;
                self.clear_rekey_artifacts();
                if let Some(ref mut u) = *self.inner.lock() {
                    u.root_key = new_key;
                }
                self.clear_saved_credentials();
                return Ok(fresh_code);
            }
            Err(e) => return Err(e),
        }

        let mut new_salt = [0u8; 16];
        rand::thread_rng().fill_bytes(&mut new_salt);
        let new_key = Self::derive_key(new_password, &new_salt)?;

        // Snapshot the (still old-keyed) database before the point of no
        // return. A byte copy stays encrypted; the WAL is folded in first so
        // the copy is consistent.
        {
            let g = self.inner.lock();
            let u = g.as_ref().ok_or(AppError::VaultLocked)?;
            u.conn.query_row("PRAGMA wal_checkpoint(TRUNCATE)", [], |_| Ok(()))?;
        }
        let backup_path = self.pre_rekey_backup_path();
        let _ = std::fs::remove_file(&backup_path);
        std::fs::copy(self.path.clone(), &backup_path)?;

        // Journal the intent (new salt + new key sealed under the old key)
        // BEFORE rekeying, so any crash from here on is recoverable.
        let journal = RekeyJournal {
            version: 1,
            new_salt: hex::encode(new_salt),
            new_key_sealed: Self::seal_new_key(&db_key, &new_key)?,
        };
        let journal_json = serde_json::to_string(&journal)
            .map_err(|e| AppError::Other(e.to_string()))?;
        write_atomic(&self.rekey_journal_path(), journal_json.as_bytes())?;

        // Point of no return.
        let hex_new_key = Zeroizing::new(hex::encode(new_key.as_ref()));
        {
            let g = self.inner.lock();
            let u = g.as_ref().ok_or(AppError::VaultLocked)?;
            u.conn.execute_batch(&format!("PRAGMA rekey = \"x'{}'\";", hex_new_key.as_str()))?;
        }

        // Finalize: new salt, then a fresh recovery envelope, then retire the
        // journal + snapshot. If we crash between these steps, the next
        // unlock/recover finds the journal and finishes the job.
        write_atomic(&self.salt_path(), &new_salt)?;
        let (new_code, normalized) = generate_recovery_code();
        self.save_recovery_envelope(&new_key, &normalized)?;
        self.clear_rekey_artifacts();

        if let Some(ref mut u) = *self.inner.lock() {
            u.root_key = new_key;
        }

        self.clear_saved_credentials();
        Ok(new_code)
    }

    pub fn regenerate_recovery_key(&self) -> AppResult<String> {
        let key = self.root_key()?;
        let (code, normalized) = generate_recovery_code();
        self.save_recovery_envelope(&key, &normalized)?;
        Ok(code)
    }

    pub fn reset(&self) -> AppResult<()> {
        *self.inner.lock() = None;
        let _ = std::fs::remove_file(&self.path);
        let _ = std::fs::remove_file(self.path.with_extension("vault-wal"));
        let _ = std::fs::remove_file(self.path.with_extension("vault-shm"));
        let _ = std::fs::remove_file(self.salt_path());
        let _ = std::fs::remove_file(self.recovery_path());
        let _ = std::fs::remove_file(self.rekey_journal_path());
        let _ = std::fs::remove_file(self.pre_rekey_backup_path());
        self.clear_saved_credentials();
        Ok(())
    }

    pub fn lock(&self) {
        *self.inner.lock() = None;
    }

    pub fn is_unlocked(&self) -> bool {
        self.inner.lock().is_some()
    }

    pub fn with<T>(&self, f: impl FnOnce(&Connection) -> AppResult<T>) -> AppResult<T> {
        let g = self.inner.lock();
        let u = g.as_ref().ok_or(AppError::VaultLocked)?;
        f(&u.conn)
    }

    pub fn root_key(&self) -> AppResult<Zeroizing<[u8; 32]>> {
        let g = self.inner.lock();
        let u = g.as_ref().ok_or(AppError::VaultLocked)?;
        Ok(Zeroizing::new(*u.root_key))
    }

    pub fn known_host(&self, host: &str, port: u16) -> AppResult<Option<String>> {
        self.with(|c| {
            Ok(c.query_row(
                "SELECT fingerprint FROM known_hosts WHERE host=?1 AND port=?2",
                params![host, port],
                |r| r.get(0),
            )
            .optional()?)
        })
    }

    pub fn set_host_os(&self, id: &str, os: &str) -> AppResult<()> {
        self.with(|c| {
            c.execute("UPDATE hosts SET os=?1, updated_at=?2 WHERE id=?3", params![os, now(), id])?;
            let _ = log_sync_mutation(c, "hosts", id);
            Ok(())
        })
    }

    pub fn host_with_secret(&self, id: &str) -> AppResult<(HostProfile, HostSecret)> {
        self.with(|c| {
            let host_res = c
                .query_row(
                    "SELECT h.id, h.label, h.hostname, h.port, h.username, h.auth_method, h.grp, h.tags, h.color, h.os, h.keychain_id, h.jump_host_id, h.vault_id, h.startup_command, h.proxy_command,
                            s.password, s.private_key, s.passphrase,
                            k.auth_method, k.password, k.private_key, k.passphrase, k.username
                     FROM hosts h
                     LEFT JOIN secrets s ON s.host_id=h.id
                     LEFT JOIN keychain k ON k.id=h.keychain_id
                     WHERE h.id=?1",
                    [id],
                    |r| {
                        let mut profile = row_to_host(r)?;
                        let k_auth: Option<String> = r.get(18)?;
                        let (auth_method, password, private_key, passphrase, username) = if let Some(ka) = k_auth {
                            // Sourced from Keychain
                            let k_user: Option<String> = r.get(22)?;
                            (
                                AuthMethod::parse(&ka),
                                r.get(19)?,
                                r.get(20)?,
                                r.get(21)?,
                                k_user.unwrap_or(profile.username.clone()),
                            )
                        } else {
                            // Sourced from Host Secret
                            (
                                profile.auth_method,
                                r.get(15)?,
                                r.get(16)?,
                                r.get(17)?,
                                profile.username.clone(),
                            )
                        };

                        profile.auth_method = auth_method;
                        profile.username = username;

                        Ok((
                            profile,
                            HostSecret {
                                password,
                                private_key,
                                passphrase,
                            },
                        ))
                    },
                )
                .optional()?;
            host_res.ok_or_else(|| AppError::HostNotFound(id.into()))
        })
    }

    pub fn save_snapshot(&self, s: &Snapshot) -> AppResult<()> {
        self.with(|c| {
            c.execute(
                "INSERT INTO snapshots(host_id,session_id,cwd,last_command,updated_at) VALUES(?1,?2,?3,?4,?5)
                 ON CONFLICT(host_id) DO UPDATE SET session_id=?2,cwd=?3,last_command=?4,updated_at=?5",
                params![s.host_id, s.session_id, s.cwd, s.last_command, s.updated_at],
            )?;
            Ok(())
        })
    }

    pub fn load_snapshot(&self, host_id: &str) -> AppResult<Option<Snapshot>> {
        self.with(|c| {
            Ok(c.query_row(
                "SELECT host_id,session_id,cwd,last_command,updated_at FROM snapshots WHERE host_id=?1",
                [host_id],
                |r| {
                    Ok(Snapshot {
                        host_id: r.get(0)?,
                        session_id: r.get(1)?,
                        cwd: r.get(2)?,
                        last_command: r.get(3)?,
                        updated_at: r.get(4)?,
                    })
                },
            )
            .optional()?)
        })
    }

    pub fn log_start(&self, id: &str, host_id: Option<&str>, host_label: &str, username: &str, hostname: &str) -> AppResult<()> {
        self.with(|c| {
            c.execute(
                "INSERT INTO connection_logs(id, host_id, host_label, username, hostname, started_at, status, saved)
                 VALUES(?1, ?2, ?3, ?4, ?5, ?6, 'connected', 0)",
                params![id, host_id, host_label, username, hostname, now()],
            )?;
            Ok(())
        })
    }

    pub fn log_end(&self, id: &str, status: &str) -> AppResult<()> {
        self.with(|c| {
            let ended = now();
            let started: Option<i64> = c.query_row(
                "SELECT started_at FROM connection_logs WHERE id=?1",
                [id],
                |r| r.get(0),
            ).optional()?;
            let duration = started.map(|s| ended - s);
            c.execute(
                "UPDATE connection_logs SET ended_at=?1, duration=?2, status=?3 WHERE id=?4",
                params![ended, duration, status, id],
            )?;
            Ok(())
        })
    }

    pub fn tunnel_get(&self, id: &str) -> AppResult<TunnelConfig> {
        self.with(|c| {
            c.query_row(
                "SELECT id, label, host_id, forward_type, local_host, local_port, remote_host, remote_port, updated_at, vault_id
                 FROM tunnels WHERE id=?1",
                [id],
                |r| {
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
                },
            )
            .map_err(|_| AppError::Other(format!("Tunnel not found: {id}")))
        })
    }
}

fn row_to_host(r: &rusqlite::Row) -> rusqlite::Result<HostProfile> {
    let tags: String = r.get(7)?;
    let auth: String = r.get(5)?;
    Ok(HostProfile {
        id: r.get(0)?,
        label: r.get(1)?,
        hostname: r.get(2)?,
        port: r.get(3)?,
        username: r.get(4)?,
        auth_method: AuthMethod::parse(&auth),
        group: r.get(6)?,
        tags: serde_json::from_str(&tags).unwrap_or_default(),
        color: r.get(8)?,
        os: r.get::<_, Option<String>>(9).unwrap_or(None),
        keychain_id: r.get::<_, Option<String>>(10).unwrap_or(None),
        jump_host_id: r.get::<_, Option<String>>(11).unwrap_or(None),
        vault_id: r.get::<_, Option<String>>(12).unwrap_or(None),
        startup_command: r.get::<_, Option<String>>(13).unwrap_or(None),
        proxy_command: r.get::<_, Option<String>>(14).unwrap_or(None),
        has_secret: false,
    })
}

// ─────────────────────────── Commands ───────────────────────────

use tauri::{Manager, State};

#[tauri::command]
pub fn vault_status(vault: State<'_, Vault>) -> VaultStatus {
    VaultStatus { initialized: vault.path.exists(), unlocked: vault.inner.lock().is_some() }
}

#[tauri::command]
pub async fn vault_unlock(master_password: String, app: tauri::AppHandle) -> AppResult<Option<String>> {
    // Unlocking an existing vault keeps the permissive floor so an older
    // four-character vault can never be bricked. The stronger policy for
    // *choosing* a password lives in `Vault::unlock`, which knows whether
    // this call creates the vault or opens it.
    if master_password.chars().count() < MIN_UNLOCK_PASSWORD_CHARS {
        return Err(AppError::Other(format!(
            "Master password must be at least {MIN_UNLOCK_PASSWORD_CHARS} characters"
        )));
    }
    let pw = Zeroizing::new(master_password);
    tauri::async_runtime::spawn_blocking(move || {
        let vault = app.state::<Vault>();
        vault.unlock(&pw)
    })
    .await
    .map_err(|e| AppError::Other(e.to_string()))?
}

#[tauri::command]
pub async fn vault_recover(
    recovery_code: String,
    new_password: String,
    app: tauri::AppHandle,
) -> AppResult<String> {
    if new_password.chars().count() < MIN_NEW_PASSWORD_CHARS {
        return Err(AppError::Other(format!(
            "New master password must be at least {MIN_NEW_PASSWORD_CHARS} characters"
        )));
    }
    tauri::async_runtime::spawn_blocking(move || {
        let vault = app.state::<Vault>();
        vault.recover_and_rekey(&recovery_code, &new_password)
    })
    .await
    .map_err(|e| AppError::Other(e.to_string()))?
}

#[tauri::command]
pub async fn vault_reset(app: tauri::AppHandle, vault: State<'_, Vault>) -> AppResult<()> {
    use tauri_plugin_dialog::{DialogExt, MessageDialogButtons, MessageDialogKind};

    // Native confirmation so a rogue frontend (XSS) cannot silently wipe the
    // vault. Intentionally password-less (documented escape hatch) — a lost
    // master password must never make the data unrecoverable-stuck. The dialog
    // runs off the main thread (blocking_show panics there).
    let confirmed = tauri::async_runtime::spawn_blocking(move || {
        app.dialog()
            .message(
                "This erases the encrypted vault, saved hosts, keychain identities, \
                 snippets and tunnels on this device. It cannot be undone. \
                 No password is required — that is the documented escape hatch.",
            )
            .title("Reset DrexiusTerminal vault?")
            .kind(MessageDialogKind::Warning)
            .buttons(MessageDialogButtons::OkCancelCustom(
                "Erase everything".into(),
                "Cancel".into(),
            ))
            .blocking_show()
    })
    .await
    .map_err(|e| AppError::Other(format!("Failed to show confirmation dialog: {e}")))?;

    if !confirmed {
        return Err(AppError::Other("Reset cancelled".into()));
    }
    vault.reset()
}

#[tauri::command]
pub fn vault_get_recovery_key(vault: State<'_, Vault>) -> AppResult<String> {
    vault.regenerate_recovery_key()
}

#[tauri::command]
pub fn vault_save_emergency_kit(content: String, filename: Option<String>) -> AppResult<String> {
    let fname = filename.unwrap_or_else(|| {
        format!("drexius-emergency-kit-{}.txt", chrono::Utc::now().timestamp())
    });

    #[cfg(target_os = "android")]
    let download_dir = {
        let candidates = [
            std::path::PathBuf::from("/storage/emulated/0/Download"),
            std::path::PathBuf::from("/storage/emulated/0/Documents"),
            std::path::PathBuf::from("/sdcard/Download"),
            std::path::PathBuf::from("/storage/emulated/0"),
        ];
        candidates
            .into_iter()
            .find(|p| p.is_dir())
            .unwrap_or_else(|| std::path::PathBuf::from("/storage/emulated/0/Download"))
    };

    #[cfg(not(target_os = "android"))]
    let download_dir = {
        if std::path::Path::new("/storage/emulated/0").is_dir() {
            std::path::PathBuf::from("/storage/emulated/0/Download")
        } else {
            dirs::download_dir()
                .or_else(dirs::document_dir)
                .or_else(dirs::home_dir)
                .unwrap_or_else(|| std::path::PathBuf::from("."))
        }
    };

    let _ = std::fs::create_dir_all(&download_dir);
    let target = download_dir.join(&fname);
    if let Err(err) = std::fs::write(&target, &content) {
        #[cfg(target_os = "android")]
        {
            let fallback = std::path::PathBuf::from("/storage/emulated/0/Android/data/dev.drexius.terminal/files/Download");
            let _ = std::fs::create_dir_all(&fallback);
            let fallback_target = fallback.join(&fname);
            if std::fs::write(&fallback_target, &content).is_ok() {
                return Ok(fallback_target.to_string_lossy().to_string());
            }
        }
        return Err(AppError::Other(format!("Failed to save emergency kit: {err}")));
    }
    Ok(target.to_string_lossy().to_string())
}

#[tauri::command]
pub fn vault_lock(vault: State<'_, Vault>) {
    vault.lock()
}

// ── OS Keychain & Device Screen Lock integration ──
//
// Stores the master password in the user's OS-provided credential store
// (macOS Keychain, Windows Credential Manager, Linux Secret Service) or,
// on Android and headless systems, in an AES/ChaCha encrypted file bound to the
// app's private sandbox UID so that subsequent unlocks can happen via biometrics
// (Fingerprint, Touch ID, Face ID, Android screen lock) without retyping.

#[tauri::command]
pub async fn os_keychain_unlock(app: tauri::AppHandle) -> AppResult<Option<String>> {
    tauri::async_runtime::spawn_blocking(move || {
        let vault = app.state::<Vault>();

        #[cfg(target_os = "android")]
        {
            let pw = vault.load_device_lock().map_err(|e| {
                AppError::Other(format!("No master password stored for quick unlock: {e}"))
            })?;
            return vault.unlock(&pw);
        }

        #[cfg(not(target_os = "android"))]
        {
            // 1. Try OS keyring first (Desktop: macOS Keychain, Windows Credential Manager, Linux Secret Service)
            let pw = match keychain_entry().and_then(|entry| {
                entry.get_password().map_err(|e| match e {
                    keyring::Error::NoEntry => AppError::Other("No master password stored in OS keychain".into()),
                    keyring::Error::NoStorageAccess(msg) => AppError::Other(format!("OS keychain unavailable: {msg}")),
                    keyring::Error::PlatformFailure(msg) => AppError::Other(format!("Biometric prompt failed: {msg}")),
                    other => AppError::Other(format!("OS keychain denied access: {other}")),
                })
            }) {
                Ok(p) => Zeroizing::new(p),
                Err(keyring_err) => {
                    // Keyring is unavailable or failed (e.g. headless desktop).
                    // Check if a secure device lock credential exists in the app's isolated sandbox.
                    match vault.load_device_lock() {
                        Ok(p) => p,
                        Err(_) => return Err(keyring_err),
                    }
                }
            };

            vault.unlock(&pw)
        }
    })
    .await
    .map_err(|e| AppError::Other(e.to_string()))?
}

#[tauri::command]
pub fn os_keychain_store(master_password: String, vault: State<'_, Vault>) -> AppResult<()> {
    if !vault.is_unlocked() {
        return Err(AppError::VaultLocked);
    }
    // This stores a password that already exists (it is the one that unlocked
    // the vault), so the permissive floor applies — not the new-password policy.
    if master_password.chars().count() < MIN_UNLOCK_PASSWORD_CHARS {
        return Err(AppError::Other(format!(
            "Master password must be at least {MIN_UNLOCK_PASSWORD_CHARS} characters"
        )));
    }
    let pw = Zeroizing::new(master_password);

    #[cfg(target_os = "android")]
    {
        vault.save_device_lock(&pw)?;
        return Ok(());
    }

    #[cfg(not(target_os = "android"))]
    {
        // 1. Try OS keyring first
        let keyring_result = keychain_entry().and_then(|entry| {
            entry
                .set_password(&pw)
                .map_err(|e| AppError::Other(format!("Failed to store in OS keychain: {e}")))
        });

        // 2. If OS keyring fails, fallback to device-bound secure file
        if keyring_result.is_err() {
            vault.save_device_lock(&pw)?;
        }
        Ok(())
    }
}

/// "Is there a stored quick-unlock credential on this device?"
///
/// The device-lock file is a plain `stat()` and always checked. Reading the OS
/// keyring is *not* free: on macOS an access can raise a Touch ID / keychain
/// dialog and on Linux a Secret Service prompt. The app mounts a lock screen
/// before the user has touched anything, so the keyring is only consulted when
/// a view the user deliberately opened asks for it (`probeKeyring: true`) —
/// see `bridge.osKeychainStatus` and the Quick Unlock settings sheet.
#[tauri::command]
pub fn os_keychain_status(vault: State<'_, Vault>, probe_keyring: Option<bool>) -> bool {
    if vault.device_lock_path().exists() {
        return true;
    }
    #[cfg(not(target_os = "android"))]
    {
        probe_keyring.unwrap_or(false)
            && keychain_entry()
                .and_then(|e| e.get_password().map_err(|e| AppError::Other(e.to_string())))
                .is_ok()
    }
    #[cfg(target_os = "android")]
    {
        // Android has no OS-keyring entry: the sandboxed device-lock file above
        // is the only store, so there is nothing to probe.
        let _ = probe_keyring;
        false
    }
}

#[tauri::command]
pub fn os_keychain_delete(vault: State<'_, Vault>) -> AppResult<()> {
    #[cfg(not(target_os = "android"))]
    if let Ok(entry) = keychain_entry() {
        let _ = entry.delete_credential();
    }
    let _ = vault.delete_device_lock();
    Ok(())
}

#[tauri::command]
pub fn check_storage_permission() -> AppResult<bool> {
    #[cfg(target_os = "android")]
    {
        let ctx = ndk_context::android_context();
        if !ctx.vm().is_null() && !ctx.context().is_null() {
            if let Ok(vm) = unsafe { jni::JavaVM::from_raw(ctx.vm() as *mut jni::sys::JavaVM) } {
                if let Ok(mut env) = vm.attach_current_thread() {
                    let app_ctx = std::mem::ManuallyDrop::new(unsafe {
                        jni::objects::JObject::from_raw(ctx.context() as jni::sys::jobject)
                    });
                    if let Some(cls) = crate::ssh::load_android_app_class(
                        &mut env,
                        &*app_ctx,
                        "dev.drexius.terminal.MainActivity",
                    ) {
                        if let Ok(val) = env.call_static_method(
                            &cls,
                            "isStoragePermissionGranted",
                            "()Z",
                            &[],
                        ) {
                            if let Ok(b) = val.z() {
                                return Ok(b);
                            }
                        }
                    }
                    if env.exception_check().unwrap_or(false) {
                        let _ = env.exception_clear();
                    }
                }
            }
        }
        return Ok(false);
    }
    #[cfg(not(target_os = "android"))]
    {
        Ok(true)
    }
}

#[tauri::command]
pub fn request_storage_permission() -> AppResult<bool> {
    #[cfg(target_os = "android")]
    {
        let ctx = ndk_context::android_context();
        if !ctx.vm().is_null() && !ctx.context().is_null() {
            if let Ok(vm) = unsafe { jni::JavaVM::from_raw(ctx.vm() as *mut jni::sys::JavaVM) } {
                if let Ok(mut env) = vm.attach_current_thread() {
                    let app_ctx = std::mem::ManuallyDrop::new(unsafe {
                        jni::objects::JObject::from_raw(ctx.context() as jni::sys::jobject)
                    });
                    if let Some(cls) = crate::ssh::load_android_app_class(
                        &mut env,
                        &*app_ctx,
                        "dev.drexius.terminal.MainActivity",
                    ) {
                        let _ = env.call_static_method(
                            &cls,
                            "requestStoragePermissionsStatic",
                            "()V",
                            &[],
                        );
                    }
                    if env.exception_check().unwrap_or(false) {
                        let _ = env.exception_clear();
                    }
                    return Ok(true);
                }
            }
        }
    }
    Ok(true)
}

// ── Hosts ──

#[tauri::command]
pub fn hosts_list(vault: State<'_, Vault>) -> AppResult<Vec<HostProfile>> {
    vault.with(|c| {
        let mut st = c.prepare(
            "SELECT h.id, h.label, h.hostname, h.port, h.username, h.auth_method, h.grp, h.tags, h.color, h.os, h.keychain_id, h.jump_host_id, h.vault_id, h.startup_command, h.proxy_command,
                    (s.host_id IS NOT NULL OR h.keychain_id IS NOT NULL) FROM hosts h LEFT JOIN secrets s ON s.host_id=h.id ORDER BY h.grp, h.label",
        )?;
        let rows = st.query_map([], |r| {
            let mut h = row_to_host(r)?;
            h.has_secret = r.get(15)?;
            Ok(h)
        })?;
        Ok(rows.collect::<Result<Vec<_>, _>>()?)
    })
}

#[tauri::command]
pub fn host_save_with_new_keychain(
    profile: HostProfile,
    keychain: KeychainInput,
    vault: State<'_, Vault>,
) -> AppResult<String> {
    vault.with(|c| {
        let tx = c.unchecked_transaction()?;
        let mut profile = profile;
        if profile.id.is_empty() {
            profile.id = uuid::Uuid::new_v4().to_string();
        }
        let host_vault = profile.vault_id.clone().unwrap_or_else(|| "personal".into());
        let kc_vault = keychain
            .vault_id
            .clone()
            .unwrap_or_else(|| host_vault.clone());
        let mut kc_id = keychain.id.clone();
        if kc_id.is_empty() {
            kc_id = uuid::Uuid::new_v4().to_string();
        }
        tx.execute(
            "INSERT INTO keychain(id, label, username, auth_method, password, private_key, passphrase, vault_id, updated_at)
             VALUES(?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)
             ON CONFLICT(id) DO UPDATE SET label=?2, username=?3, auth_method=?4,
                 password=COALESCE(?5, password), private_key=COALESCE(?6, private_key), passphrase=COALESCE(?7, passphrase), vault_id=?8, updated_at=?9",
            params![
                kc_id, keychain.label, keychain.username, keychain.auth_method.as_str(),
                keychain.password, keychain.private_key, keychain.passphrase, kc_vault, now()
            ],
        )?;
        profile.keychain_id = Some(kc_id.clone());
        tx.execute(
            "INSERT INTO hosts(id, label, hostname, port, username, auth_method, grp, tags, color, os, keychain_id, jump_host_id, vault_id, startup_command, proxy_command, updated_at)
             VALUES(?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16)
             ON CONFLICT(id) DO UPDATE SET label=?2, hostname=?3, port=?4, username=?5, auth_method=?6,
                 grp=?7, tags=?8, color=?9, os=?10, keychain_id=?11, jump_host_id=?12, vault_id=?13, startup_command=?14, proxy_command=?15, updated_at=?16",
            params![
                profile.id, profile.label, profile.hostname, profile.port, profile.username,
                profile.auth_method.as_str(), profile.group,
                serde_json::to_string(&profile.tags).unwrap_or_else(|_| "[]".into()),
                profile.color, profile.os, profile.keychain_id, profile.jump_host_id,
                profile.vault_id.clone().unwrap_or_else(|| "personal".into()),
                profile.startup_command,
                profile.proxy_command,
                now()
            ],
        )?;
        // Single-source: linked host must not retain a host-level secret.
        tx.execute("DELETE FROM secrets WHERE host_id=?1", [&profile.id])?;
        log_sync_mutation(&tx, "keychain", &kc_id)?;
        log_sync_mutation(&tx, "hosts", &profile.id)?;
        tx.commit()?;
        Ok(profile.id)
    })
}

#[tauri::command]
pub fn host_save(input: HostInput, vault: State<'_, Vault>) -> AppResult<String> {
    let HostInput { mut profile, secret } = input;
    if profile.id.is_empty() {
        profile.id = uuid::Uuid::new_v4().to_string();
    }
    vault.with(|c| {
        c.execute(
            "INSERT INTO hosts(id, label, hostname, port, username, auth_method, grp, tags, color, os, keychain_id, jump_host_id, vault_id, startup_command, proxy_command, updated_at)
             VALUES(?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16)
             ON CONFLICT(id) DO UPDATE SET label=?2, hostname=?3, port=?4, username=?5, auth_method=?6,
                 grp=?7, tags=?8, color=?9, os=?10, keychain_id=?11, jump_host_id=?12, vault_id=?13, startup_command=?14, proxy_command=?15, updated_at=?16",
            params![
                profile.id, profile.label, profile.hostname, profile.port, profile.username,
                profile.auth_method.as_str(), profile.group,
                serde_json::to_string(&profile.tags).unwrap_or_else(|_| "[]".into()),
                profile.color, profile.os, profile.keychain_id, profile.jump_host_id,
                profile.vault_id.unwrap_or_else(|| "personal".into()),
                profile.startup_command,
                profile.proxy_command,
                now()
            ],
        )?;
        let mut has_valid_keychain = false;
        if let Some(ref kid) = profile.keychain_id {
            if !kid.is_empty() {
                let kc_exists: bool = c
                    .query_row("SELECT 1 FROM keychain WHERE id=?1", [kid], |_| Ok(true))
                    .optional()?
                    .unwrap_or(false);
                if kc_exists {
                    has_valid_keychain = true;
                    // Host now resolves credentials from Keychain (see host_with_secret):
                    // drop any stale host-specific secret so deleting the Keychain
                    // identity later cannot silently fall back to an old password/key.
                    c.execute("DELETE FROM secrets WHERE host_id=?1", [&profile.id])?;
                } else {
                    profile.keychain_id = None;
                    c.execute("UPDATE hosts SET keychain_id=NULL WHERE id=?1", [&profile.id])?;
                }
            }
        }
        if !has_valid_keychain {
            if let Some(s) = &secret {
                c.execute(
                    "INSERT INTO secrets(host_id, password, private_key, passphrase) VALUES(?1, ?2, ?3, ?4)
                     ON CONFLICT(host_id) DO UPDATE SET password=?2, private_key=?3, passphrase=?4",
                    params![profile.id, s.password, s.private_key, s.passphrase],
                )?;
            }
        }
        let _ = log_sync_mutation(c, "hosts", &profile.id);
        Ok(profile.id.clone())
    })
}

pub fn get_or_create_device_id(conn: &Connection) -> String {
    let existing: Option<String> = conn
        .query_row(
            "SELECT value FROM ai_settings WHERE key = 'sync_device_id'",
            [],
            |r| r.get(0),
        )
        .optional()
        .ok()
        .flatten();
    if let Some(id) = existing {
        if !id.is_empty() {
            return id;
        }
    }
    let mut id_bytes = [0u8; 8];
    rand::thread_rng().fill_bytes(&mut id_bytes);
    let new_id = hex::encode(id_bytes);
    let _ = conn.execute(
        "INSERT INTO ai_settings(key, value) VALUES('sync_device_id', ?1)
         ON CONFLICT(key) DO UPDATE SET value=?1",
        [&new_id],
    );
    new_id
}

/// Advances HLC monotonically and logs a mutation in `sync_log`.
pub fn log_sync_mutation(conn: &Connection, tbl: &str, record_id: &str) -> rusqlite::Result<()> {
    let prev_hlc: Option<String> = conn
        .query_row("SELECT hlc FROM sync_log WHERE record_id=?1", [record_id], |r| r.get(0))
        .ok();
    let (prev_ms, prev_ctr) = if let Some(ref h) = prev_hlc {
        let mut p = h.splitn(3, ':');
        let ms = p.next().and_then(|s| s.parse::<i64>().ok()).unwrap_or(0);
        let ctr = p.next().and_then(|s| s.parse::<u32>().ok()).unwrap_or(0);
        (ms, ctr)
    } else {
        (0, 0)
    };
    let now_ms = chrono::Utc::now().timestamp_millis();
    let (next_ms, next_ctr) = if now_ms > prev_ms {
        (now_ms, 0)
    } else if now_ms == prev_ms {
        (now_ms, prev_ctr + 1)
    } else {
        (prev_ms, prev_ctr + 1)
    };
    let device_id = get_or_create_device_id(conn);
    let next_hlc = format!("{next_ms}:{next_ctr}:{device_id}");
    conn.execute(
        "INSERT INTO sync_log (record_id, tbl, hlc, deleted) VALUES (?1, ?2, ?3, 0)
         ON CONFLICT(record_id) DO UPDATE SET tbl=excluded.tbl, hlc=excluded.hlc, deleted=0",
        params![record_id, tbl, next_hlc],
    )?;
    Ok(())
}

/// Records a deletion tombstone in `sync_log` so sync engines propagate the removal to peers.
pub fn log_sync_deletion(conn: &Connection, tbl: &str, record_id: &str) -> rusqlite::Result<()> {
    let prev_hlc: Option<String> = conn
        .query_row("SELECT hlc FROM sync_log WHERE record_id=?1", [record_id], |r| r.get(0))
        .ok();
    let (prev_ms, prev_ctr) = if let Some(ref h) = prev_hlc {
        let mut p = h.splitn(3, ':');
        let ms = p.next().and_then(|s| s.parse::<i64>().ok()).unwrap_or(0);
        let ctr = p.next().and_then(|s| s.parse::<u32>().ok()).unwrap_or(0);
        (ms, ctr)
    } else {
        (0, 0)
    };
    let now_ms = chrono::Utc::now().timestamp_millis();
    let (next_ms, next_ctr) = if now_ms > prev_ms {
        (now_ms, 0)
    } else if now_ms == prev_ms {
        (now_ms, prev_ctr + 1)
    } else {
        (prev_ms, prev_ctr + 1)
    };
    let device_id = get_or_create_device_id(conn);
    let next_hlc = format!("{next_ms}:{next_ctr}:{device_id}");
    conn.execute(
        "INSERT INTO sync_log (record_id, tbl, hlc, deleted) VALUES (?1, ?2, ?3, 1)
         ON CONFLICT(record_id) DO UPDATE SET tbl=excluded.tbl, hlc=excluded.hlc, deleted=1",
        params![record_id, tbl, next_hlc],
    )?;
    Ok(())
}

#[tauri::command]
pub fn host_delete(id: String, vault: State<'_, Vault>) -> AppResult<()> {
    vault.with(|c| {
        c.execute("DELETE FROM hosts WHERE id=?1", [&id])?;
        let _ = log_sync_deletion(c, "hosts", &id);
        Ok(())
    })
}

// ── Keychain / Reusable Identities ──

#[tauri::command]
pub fn keychain_list(vault: State<'_, Vault>) -> AppResult<Vec<KeychainItem>> {
    vault.with(|c| {
        let mut st = c.prepare(
            "SELECT id, label, username, auth_method, (password IS NOT NULL OR private_key IS NOT NULL), updated_at, vault_id
             FROM keychain ORDER BY label",
        )?;
        let rows = st.query_map([], |r| {
            let auth: String = r.get(3)?;
            Ok(KeychainItem {
                id: r.get(0)?,
                label: r.get(1)?,
                username: r.get(2)?,
                auth_method: AuthMethod::parse(&auth),
                has_secret: r.get(4)?,
                updated_at: r.get(5)?,
                vault_id: r.get(6)?,
            })
        })?;
        Ok(rows.collect::<Result<Vec<_>, _>>()?)
    })
}

/// Insert or update one keychain identity and log the mutation for sync. Shared
/// by `keychain_save` and the generate-and-save path so both keep the same
/// `COALESCE` semantics: an omitted secret leaves the stored one alone.
fn upsert_keychain_identity(c: &Connection, input: &KeychainInput) -> rusqlite::Result<String> {
    let mut id = input.id.clone();
    if id.is_empty() {
        id = uuid::Uuid::new_v4().to_string();
    }
    c.execute(
        "INSERT INTO keychain(id, label, username, auth_method, password, private_key, passphrase, vault_id, updated_at)
         VALUES(?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)
         ON CONFLICT(id) DO UPDATE SET label=?2, username=?3, auth_method=?4,
             password=COALESCE(?5, password), private_key=COALESCE(?6, private_key), passphrase=COALESCE(?7, passphrase), vault_id=?8, updated_at=?9",
        params![
            id,
            input.label.clone(),
            input.username.clone(),
            input.auth_method.as_str(),
            input.password.clone(),
            input.private_key.clone(),
            input.passphrase.clone(),
            input.vault_id.clone().unwrap_or_else(|| "personal".into()),
            now()
        ],
    )?;
    let _ = log_sync_mutation(c, "keychain", &id);
    Ok(id)
}

#[tauri::command]
pub fn keychain_save(input: KeychainInput, vault: State<'_, Vault>) -> AppResult<String> {
    vault.with(|c| Ok(upsert_keychain_identity(c, &input)?))
}

#[tauri::command]
pub fn keychain_delete(id: String, vault: State<'_, Vault>) -> AppResult<()> {
    vault.with(|c| {
        c.execute("DELETE FROM keychain WHERE id=?1", [&id])?;
        c.execute("UPDATE hosts SET keychain_id=NULL WHERE keychain_id=?1", [&id])?;
        let _ = log_sync_deletion(c, "keychain", &id);
        Ok(())
    })
}

pub fn import_hosts_keys_internal(c: &Connection) -> AppResult<usize> {
    let mut st = c.prepare(
        "SELECT h.id, h.label, h.username, h.auth_method, s.password, s.private_key, s.passphrase, h.vault_id
         FROM hosts h
         JOIN secrets s ON s.host_id = h.id
         WHERE (h.keychain_id IS NULL OR h.keychain_id = '')
           AND ((s.private_key IS NOT NULL AND s.private_key != '') OR (s.password IS NOT NULL AND s.password != ''))",
    )?;

    struct HostSecretRow {
        host_id: String,
        label: String,
        username: String,
        auth_method: String,
        password: Option<String>,
        private_key: Option<String>,
        passphrase: Option<String>,
        vault_id: Option<String>,
    }

    let rows = st
        .query_map([], |r| {
            Ok(HostSecretRow {
                host_id: r.get(0)?,
                label: r.get(1)?,
                username: r.get(2)?,
                auth_method: r.get(3)?,
                password: r.get(4)?,
                private_key: r.get(5)?,
                passphrase: r.get(6)?,
                vault_id: r.get(7)?,
            })
        })?
        .collect::<Result<Vec<_>, _>>()?;

    let mut imported = 0;
    for r in rows {
        let host_vault = r.vault_id.clone().unwrap_or_else(|| "personal".into());
        // Scope dedup strictly to the host's own vault so team hosts never
        // attach to an identity in another vault (including legacy unscoped
        // rows, which the v3 migration scopes to personal).
        let existing_id: Option<String> = if let Some(ref pk) = r.private_key {
            c.query_row(
                "SELECT id FROM keychain WHERE private_key = ?1 AND vault_id = ?2 LIMIT 1",
                params![pk, host_vault],
                |row| row.get(0),
            )
            .optional()?
        } else {
            None
        };

        let kc_id = if let Some(eid) = existing_id {
            eid
        } else {
            let new_id = uuid::Uuid::new_v4().to_string();
            let kc_label = if !r.username.is_empty() && !r.label.to_lowercase().contains(&r.username.to_lowercase()) {
                format!("{} ({})", r.label, r.username)
            } else {
                r.label.clone()
            };
            c.execute(
                "INSERT INTO keychain(id, label, username, auth_method, password, private_key, passphrase, vault_id, updated_at)
                 VALUES(?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)",
                params![
                    new_id,
                    kc_label,
                    r.username,
                    r.auth_method,
                    r.password,
                    r.private_key,
                    r.passphrase,
                    host_vault,
                    now()
                ],
            )?;
            imported += 1;
            let _ = log_sync_mutation(c, "keychain", &new_id);
            new_id
        };

        c.execute(
            "UPDATE hosts SET keychain_id = ?1, updated_at = ?2 WHERE id = ?3",
            params![kc_id, now(), r.host_id],
        )?;
        let _ = log_sync_mutation(c, "hosts", &r.host_id);
        // Host now resolves from Keychain: drop the original row so a later
        // Keychain delete cannot silently fall back to stale credentials.
        c.execute("DELETE FROM secrets WHERE host_id = ?1", [&r.host_id])?;
    }
    // Backfill: hosts already linked by earlier runs still carry their old
    // secrets row. Remove any fallback where a valid Keychain link exists.
    c.execute(
        "DELETE FROM secrets WHERE host_id IN (
            SELECT h.id FROM hosts h
            JOIN keychain k ON k.id = h.keychain_id
            WHERE h.keychain_id IS NOT NULL AND h.keychain_id != ''
        )",
        [],
    )?;
    Ok(imported)
}

#[tauri::command]
pub fn keychain_import_from_hosts(vault: State<'_, Vault>) -> AppResult<usize> {
    vault.with(|c| import_hosts_keys_internal(c))
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DetectedLocalKey {
    pub path: String,
    pub filename: String,
    pub key_type: String,
    pub has_public: bool,
    pub comment: Option<String>,
}

#[tauri::command]
pub fn keychain_detect_local_keys() -> AppResult<Vec<DetectedLocalKey>> {
    let mut detected = Vec::new();
    let ssh_dir = match dirs::home_dir() {
        Some(h) => h.join(".ssh"),
        None => return Ok(detected),
    };

    if !ssh_dir.exists() || !ssh_dir.is_dir() {
        return Ok(detected);
    }

    let entries = match std::fs::read_dir(&ssh_dir) {
        Ok(e) => e,
        Err(_) => return Ok(detected),
    };

    for entry in entries.flatten() {
        let path = entry.path();
        if !path.is_file() {
            continue;
        }

        let filename = match path.file_name().and_then(|n| n.to_str()) {
            Some(n) => n.to_string(),
            None => continue,
        };

        if filename.ends_with(".pub")
            || filename.starts_with("known_hosts")
            || filename == "config"
            || filename.starts_with("authorized_keys")
            || filename == "environment"
            || filename.ends_with(".old")
            || filename.ends_with(".bak")
        {
            continue;
        }

        let metadata = match entry.metadata() {
            Ok(m) => m,
            Err(_) => continue,
        };
        if metadata.len() > 65536 {
            continue;
        }

        let content = match std::fs::read_to_string(&path) {
            Ok(c) => c,
            Err(_) => continue,
        };

        let key_type = if content.contains("BEGIN OPENSSH PRIVATE KEY") {
            if filename.contains("ed25519") {
                "OpenSSH ED25519"
            } else if filename.contains("rsa") {
                "OpenSSH RSA"
            } else if filename.contains("ecdsa") {
                "OpenSSH ECDSA"
            } else {
                "OpenSSH Private Key"
            }
        } else if content.contains("BEGIN RSA PRIVATE KEY") {
            "RSA Private Key (PEM)"
        } else if content.contains("BEGIN EC PRIVATE KEY") {
            "ECDSA Private Key (PEM)"
        } else if content.contains("BEGIN DSA PRIVATE KEY") {
            "DSA Private Key (PEM)"
        } else if content.contains("BEGIN ENCRYPTED PRIVATE KEY") {
            "Encrypted PKCS#8 Key"
        } else if content.contains("BEGIN PRIVATE KEY") {
            "PKCS#8 Private Key"
        } else if content.contains("PuTTY-User-Key-File-") {
            "PuTTY Private Key"
        } else {
            continue;
        };

        let pub_path = ssh_dir.join(format!("{}.pub", filename));
        let has_public = pub_path.exists();
        let comment = if has_public {
            if let Ok(pub_content) = std::fs::read_to_string(&pub_path) {
                let parts: Vec<&str> = pub_content.trim().split_whitespace().collect();
                if parts.len() >= 3 {
                    Some(parts[2..].join(" "))
                } else {
                    None
                }
            } else {
                None
            }
        } else {
            None
        };

        detected.push(DetectedLocalKey {
            path: path.to_string_lossy().to_string(),
            filename,
            key_type: key_type.to_string(),
            has_public,
            comment,
        });
    }

    detected.sort_by(|a, b| a.filename.cmp(&b.filename));
    Ok(detected)
}

#[tauri::command]
pub fn keychain_import_local_key(
    path: String,
    label: Option<String>,
    passphrase: Option<String>,
    vault_id: Option<String>,
    vault: State<'_, Vault>,
) -> AppResult<String> {
    // Importing a chosen key file is a feature, but a scripted call must not be
    // able to read arbitrary files off the disk through this command. Roots
    // restrict where, and the PEM check below restricts *what* can be taken in.
    let key_path = crate::fs_guard::ensure_local_path_in_roots(&path)?;
    if !key_path.exists() {
        return Err(AppError::Other(format!("Key file does not exist: {}", path)));
    }
    let content = std::fs::read_to_string(&key_path)
        .map_err(|e| AppError::Other(format!("Failed to read key file: {}", e)))?;
    // Must actually look like a PEM private key before anything else happens.
    if !content.contains("PRIVATE KEY") {
        return Err(AppError::Other(format!(
            "{} does not look like a PEM private key file",
            path
        )));
    }

    let filename = key_path
        .file_name()
        .and_then(|n| n.to_str())
        .unwrap_or("ssh_key");

    let final_label = match label {
        Some(l) if !l.trim().is_empty() => l.trim().to_string(),
        _ => {
            let pub_path = key_path.with_extension("pub");
            let comment = if pub_path.exists() {
                std::fs::read_to_string(pub_path).ok().and_then(|p| {
                    let parts: Vec<&str> = p.trim().split_whitespace().collect();
                    if parts.len() >= 3 {
                        Some(parts[2..].join(" "))
                    } else {
                        None
                    }
                })
            } else {
                None
            };
            if let Some(c) = comment {
                format!("{} ({})", filename, c)
            } else {
                filename.to_string()
            }
        }
    };

    vault.with(|c| {
        let scope = vault_id.unwrap_or_else(|| "personal".into());
        let existing: Option<String> = c
            .query_row(
                "SELECT id FROM keychain WHERE private_key = ?1 AND vault_id = ?2 LIMIT 1",
                params![content, scope],
                |r| r.get(0),
            )
            .optional()?;

        if let Some(id) = existing {
            return Ok(id);
        }

        let id = uuid::Uuid::new_v4().to_string();
        c.execute(
            "INSERT INTO keychain(id, label, username, auth_method, password, private_key, passphrase, vault_id, updated_at)
             VALUES(?1, ?2, NULL, 'key', NULL, ?3, ?4, ?5, ?6)",
            params![id, final_label, content, passphrase, scope, now()],
        )?;
        let _ = log_sync_mutation(c, "keychain", &id);
        Ok(id)
    })
}

/// Output of `ssh-keygen`, consumed inside Rust only.
///
/// Deliberately **not** `Serialize`: a generated private key cannot be returned
/// by a command, so it never reaches the WebView. `ZeroizeOnDrop` wipes this
/// in-memory copy once it has been written into the (SQLCipher-backed) vault;
/// the vault itself is the only place the key material persists.
#[derive(Debug, Clone, Zeroize, ZeroizeOnDrop)]
pub struct GeneratedKeyPair {
    pub algorithm: String,
    pub private_key: String,
    pub public_key: String,
    pub fingerprint: String,
}

fn keychain_generate_key_sync(
    algorithm: String,
    bits: Option<u32>,
    comment: Option<String>,
    passphrase: Option<String>,
) -> AppResult<GeneratedKeyPair> {
    let algo = match algorithm.to_lowercase().as_str() {
        "rsa" => "rsa",
        "ecdsa" => "ecdsa",
        _ => "ed25519",
    };

    let temp_dir = std::env::temp_dir();
    let unique_id = uuid::Uuid::new_v4().to_string();
    let key_dir = temp_dir.join(format!("nx_keygen_{}", unique_id));

    #[cfg(unix)]
    {
        use std::os::unix::fs::DirBuilderExt;
        let mut builder = std::fs::DirBuilder::new();
        builder.mode(0o700);
        builder.create(&key_dir).map_err(|e| AppError::Other(format!("Failed to create secure key dir: {e}")))?;
    }
    #[cfg(not(unix))]
    {
        std::fs::create_dir_all(&key_dir).map_err(|e| AppError::Other(format!("Failed to create key dir: {e}")))?;
    }

    let key_path = key_dir.join("id_key");
    let pub_path = key_dir.join("id_key.pub");

    let pass = passphrase.unwrap_or_default();
    let cmt = comment.unwrap_or_else(|| "drexius-generated-key".into());

    let mut cmd = std::process::Command::new("ssh-keygen");
    cmd.arg("-t").arg(algo);
    cmd.arg("-N").arg(&pass);
    cmd.arg("-C").arg(&cmt);
    cmd.arg("-f").arg(&key_path);
    cmd.arg("-q");

    if algo == "rsa" {
        let b = bits.unwrap_or(4096);
        cmd.arg("-b").arg(b.to_string());
    }

    let status = cmd
        .status()
        .map_err(|e| {
            let _ = std::fs::remove_dir_all(&key_dir);
            AppError::Other(format!("Failed to execute ssh-keygen: {e}"))
        })?;

    if !status.success() {
        let _ = std::fs::remove_dir_all(&key_dir);
        return Err(AppError::Other("ssh-keygen execution failed".into()));
    }

    let private_key = std::fs::read_to_string(&key_path)
        .map_err(|e| {
            let _ = std::fs::remove_dir_all(&key_dir);
            AppError::Other(format!("Failed to read generated private key: {e}"))
        })?;
    let public_key = std::fs::read_to_string(&pub_path)
        .map_err(|e| {
            let _ = std::fs::remove_dir_all(&key_dir);
            AppError::Other(format!("Failed to read generated public key: {e}"))
        })?;

    // Compute fingerprint via ssh-keygen -lf
    let mut fp_cmd = std::process::Command::new("ssh-keygen");
    fp_cmd.arg("-lf").arg(&pub_path);
    let fingerprint = if let Ok(output) = fp_cmd.output() {
        let s = String::from_utf8_lossy(&output.stdout).trim().to_string();
        let parts: Vec<&str> = s.split_whitespace().collect();
        if parts.len() >= 2 {
            parts[1].to_string()
        } else {
            s
        }
    } else {
        "SHA256:unknown".to_string()
    };

    let _ = std::fs::remove_dir_all(&key_dir);

    Ok(GeneratedKeyPair {
        algorithm: algo.to_uppercase(),
        private_key,
        public_key: public_key.trim().to_string(),
        fingerprint,
    })
}

/// What the UI sends to create a key. There is intentionally no `privateKey`
/// field: generation and storage happen in one Rust call.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct KeygenRequest {
    #[serde(default)]
    pub label: String,
    #[serde(default)]
    pub username: Option<String>,
    pub algorithm: String,
    #[serde(default)]
    pub bits: Option<u32>,
    #[serde(default)]
    pub comment: Option<String>,
    /// Encrypts the new private key at rest; stored only on the keychain row.
    #[serde(default)]
    pub passphrase: Option<String>,
    #[serde(default)]
    pub vault_id: Option<String>,
}

/// Everything the UI may learn about a freshly generated key — metadata only.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GeneratedKeySaved {
    pub item: KeychainItem,
    pub public_key: String,
    pub fingerprint: String,
    pub algorithm: String,
}

/// Generate an SSH key pair and save it to the vault in a single call.
///
/// The old flow returned the private key to JavaScript, which posted it straight
/// back to `keychain_save` — putting raw key material in the WebView, its
/// devtools and any XSS foothold in the shell, only so it could be sent back to
/// Rust. `KeychainPanel` never displays the private key (only the public half),
/// so nothing is lost by keeping the secret on this side of the boundary.
#[tauri::command]
pub async fn keychain_generate_and_save(
    req: KeygenRequest,
    app: tauri::AppHandle,
) -> AppResult<GeneratedKeySaved> {
    tauri::async_runtime::spawn_blocking(move || {
        let pair = keychain_generate_key_sync(
            req.algorithm.clone(),
            req.bits,
            req.comment,
            req.passphrase.clone(),
        )?;
        let algorithm = pair.algorithm.clone();

        let label = {
            let requested = req.label.trim();
            if requested.is_empty() {
                format!("Generated {algorithm} Key")
            } else {
                requested.to_string()
            }
        };
        let username = req.username.unwrap_or_default();
        let vault_id = req.vault_id.unwrap_or_else(|| "personal".into());
        let passphrase = req.passphrase.filter(|p| !p.is_empty());

        let item = app.state::<Vault>().with(|c| -> AppResult<KeychainItem> {
            let id = upsert_keychain_identity(
                c,
                &KeychainInput {
                    id: String::new(),
                    label: label.clone(),
                    username: if username.is_empty() {
                        None
                    } else {
                        Some(username.clone())
                    },
                    auth_method: AuthMethod::Key,
                    password: None,
                    private_key: Some(pair.private_key.clone()),
                    passphrase: passphrase.clone(),
                    vault_id: Some(vault_id.clone()),
                },
            )?;
            Ok(KeychainItem {
                id,
                label,
                username: if username.is_empty() {
                    None
                } else {
                    Some(username)
                },
                auth_method: AuthMethod::Key,
                has_secret: true,
                updated_at: now(),
                vault_id: Some(vault_id),
            })
        })?;

        Ok(GeneratedKeySaved {
            item,
            public_key: pair.public_key.clone(),
            fingerprint: pair.fingerprint.clone(),
            algorithm,
        })
    })
    .await
    .map_err(|e| AppError::Other(e.to_string()))?
}

// ── Connection Logs ──

#[tauri::command]
pub fn logs_list(limit: Option<usize>, vault: State<'_, Vault>) -> AppResult<Vec<ConnectionLog>> {
    let lim = limit.unwrap_or(100).min(1000);
    vault.with(|c| {
        let sql = format!(
            "SELECT id, host_id, host_label, username, hostname, started_at, ended_at, duration, status, saved
             FROM connection_logs ORDER BY started_at DESC LIMIT {lim}"
        );
        let mut st = c.prepare(&sql)?;
        let rows = st.query_map([], |r| {
            let saved_int: i64 = r.get(9)?;
            Ok(ConnectionLog {
                id: r.get(0)?,
                host_id: r.get(1)?,
                host_label: r.get(2)?,
                username: r.get(3)?,
                hostname: r.get(4)?,
                started_at: r.get(5)?,
                ended_at: r.get(6)?,
                duration: r.get(7)?,
                status: r.get(8)?,
                saved: saved_int != 0,
            })
        })?;
        Ok(rows.collect::<Result<Vec<_>, _>>()?)
    })
}

#[tauri::command]
pub fn log_toggle_saved(id: String, vault: State<'_, Vault>) -> AppResult<bool> {
    vault.with(|c| {
        c.execute("UPDATE connection_logs SET saved = CASE WHEN saved=1 THEN 0 ELSE 1 END WHERE id=?1", [&id])?;
        let saved: i64 = c.query_row("SELECT saved FROM connection_logs WHERE id=?1", [&id], |r| r.get(0))?;
        Ok(saved != 0)
    })
}

#[tauri::command]
pub fn logs_clear(vault: State<'_, Vault>) -> AppResult<()> {
    vault.with(|c| {
        c.execute("DELETE FROM connection_logs WHERE saved = 0", [])?;
        Ok(())
    })
}

// ── Command History ──

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CommandHistoryItem {
    pub id: String,
    pub host_id: Option<String>,
    pub host_label: String,
    pub command: String,
    pub cwd: Option<String>,
    pub executed_at: i64,
    pub starred: bool,
}

/// Heuristic for commands that probably carry a credential. Shared by command history and the snapshot path,
/// so no recording path can disagree about what is secret.
pub fn looks_sensitive_command(cmd: &str) -> bool {
    const KEYWORDS: &[&str] = &[
        "password", "passwd", "passphrase", "passcode", "token", "secret", "api_key", "apikey", "api-key",
        "private_key", "credential", "bearer ", "authorization:",
    ];
    let lower = cmd.to_lowercase();
    KEYWORDS.iter().any(|k| lower.contains(k))
}

/// Heuristic for clipboard content or raw text that probably carries a credential or private key.
pub fn looks_sensitive_text(text: &str) -> bool {
    let lower = text.to_lowercase();
    if (lower.contains("-----begin") && lower.contains("private key"))
        || lower.contains("-----begin openssh private key-----")
        || lower.contains("-----begin rsa private key-----")
        || lower.contains("-----begin dsa private key-----")
        || lower.contains("-----begin ec private key-----")
    {
        return true;
    }
    const TEXT_KEYWORDS: &[&str] = &[
        "password", "passwd", "passphrase", "passcode", "api_key", "apikey", "api-key",
        "private_key", "bearer ", "authorization:", "secret_key", "client_secret",
        "aws_secret_access_key", "ghp_", "github_pat_", "xoxb-", "xoxp-",
    ];
    if TEXT_KEYWORDS.iter().any(|k| lower.contains(k)) {
        return true;
    }
    looks_sensitive_command(text)
}

#[tauri::command]
pub fn command_history_add(
    host_id: Option<String>,
    host_label: String,
    command: String,
    cwd: Option<String>,
    vault: State<'_, Vault>,
) -> AppResult<CommandHistoryItem> {
    let trimmed = command.trim();
    if trimmed.is_empty() {
        return Err(AppError::Other("Empty command".into()));
    }
    if looks_sensitive_command(trimmed) {
        return Err(AppError::Other("Not recorded: the command looks like it contains a credential.".into()));
    }
    let item = CommandHistoryItem {
        id: uuid::Uuid::new_v4().to_string(),
        host_id,
        host_label,
        command: trimmed.to_string(),
        cwd,
        executed_at: now(),
        starred: false,
    };
    vault.with(|c| {
        c.execute(
            "INSERT INTO command_history (id, host_id, host_label, command, cwd, executed_at, starred)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
            params![
                item.id,
                item.host_id,
                item.host_label,
                item.command,
                item.cwd,
                item.executed_at,
                if item.starred { 1 } else { 0 }
            ],
        )?;
        Ok(())
    })?;
    Ok(item)
}

#[tauri::command]
pub fn command_history_list(
    limit: Option<usize>,
    search: Option<String>,
    vault: State<'_, Vault>,
) -> AppResult<Vec<CommandHistoryItem>> {
    vault.with(|c| {
        let max_rows = limit.unwrap_or(200);
        if let Some(ref q) = search {
            let pattern = format!("%{}%", q);
            let mut st = c.prepare(
                "SELECT id, host_id, host_label, command, cwd, executed_at, starred
                 FROM command_history
                 WHERE command LIKE ?1 OR host_label LIKE ?1
                 ORDER BY executed_at DESC LIMIT ?2",
            )?;
            let mapped = st.query_map(params![pattern, max_rows], |r| {
                let starred_int: i64 = r.get(6)?;
                Ok(CommandHistoryItem {
                    id: r.get(0)?,
                    host_id: r.get(1)?,
                    host_label: r.get(2)?,
                    command: r.get(3)?,
                    cwd: r.get(4)?,
                    executed_at: r.get(5)?,
                    starred: starred_int != 0,
                })
            })?.collect::<Result<Vec<_>, _>>()?;
            Ok(mapped)
        } else {
            let mut st = c.prepare(
                "SELECT id, host_id, host_label, command, cwd, executed_at, starred
                 FROM command_history
                 ORDER BY executed_at DESC LIMIT ?1",
            )?;
            let mapped = st.query_map(params![max_rows], |r| {
                let starred_int: i64 = r.get(6)?;
                Ok(CommandHistoryItem {
                    id: r.get(0)?,
                    host_id: r.get(1)?,
                    host_label: r.get(2)?,
                    command: r.get(3)?,
                    cwd: r.get(4)?,
                    executed_at: r.get(5)?,
                    starred: starred_int != 0,
                })
            })?.collect::<Result<Vec<_>, _>>()?;
            Ok(mapped)
        }
    })
}

#[tauri::command]
pub fn command_history_toggle_star(id: String, vault: State<'_, Vault>) -> AppResult<bool> {
    vault.with(|c| {
        c.execute(
            "UPDATE command_history SET starred = CASE WHEN starred=1 THEN 0 ELSE 1 END WHERE id=?1",
            [&id],
        )?;
        let starred: i64 = c.query_row("SELECT starred FROM command_history WHERE id=?1", [&id], |r| r.get(0))?;
        Ok(starred != 0)
    })
}

#[tauri::command]
pub fn command_history_delete(id: String, vault: State<'_, Vault>) -> AppResult<()> {
    vault.with(|c| {
        c.execute("DELETE FROM command_history WHERE id=?1", [&id])?;
        Ok(())
    })
}

#[tauri::command]
pub fn command_history_clear(vault: State<'_, Vault>) -> AppResult<()> {
    vault.with(|c| {
        c.execute("DELETE FROM command_history WHERE starred = 0", [])?;
        Ok(())
    })
}

// ── Clipboard History ──

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ClipboardItem {
    pub id: String,
    pub content: String,
    pub char_count: usize,
    pub line_count: usize,
    pub source: Option<String>,
    pub copied_at: i64,
    pub pinned: bool,
}

#[tauri::command]
pub fn clipboard_history_add(
    content: String,
    source: Option<String>,
    vault: State<'_, Vault>,
) -> AppResult<ClipboardItem> {
    // Store and compare the trimmed text: copying the same command again with a
    // trailing newline should bump the existing entry, not duplicate it.
    let trimmed = content.trim().to_string();
    if trimmed.is_empty() {
        return Err(AppError::Other("Empty clipboard content".into()));
    }
    if looks_sensitive_text(&trimmed) {
        return Err(AppError::Other("Not recorded: clipboard content appears to contain sensitive information or credentials.".into()));
    }
    let char_count = trimmed.chars().count();
    let line_count = trimmed.lines().count().max(1);

    vault.with(|c| {
        // Read `pinned` back with the row: bumping an entry must not report an
        // unpinned item for a pinned row (the UI keeps a pin it just refreshed).
        let existing: Option<(String, bool)> = c
            .query_row(
                "SELECT id, pinned FROM clipboard_history WHERE content=?1",
                [&trimmed],
                |r| Ok((r.get(0)?, r.get::<_, i64>(1)? != 0)),
            )
            .optional()?;

        if let Some((eid, pinned)) = existing {
            c.execute(
                "UPDATE clipboard_history SET copied_at=?1, source=?2 WHERE id=?3",
                params![now(), source, eid],
            )?;
            return Ok(ClipboardItem {
                id: eid,
                content: trimmed,
                char_count,
                line_count,
                source,
                copied_at: now(),
                pinned,
            });
        }

        let item = ClipboardItem {
            id: uuid::Uuid::new_v4().to_string(),
            content: trimmed.clone(),
            char_count,
            line_count,
            source: source.clone(),
            copied_at: now(),
            pinned: false,
        };

        c.execute(
            "INSERT INTO clipboard_history (id, content, char_count, line_count, source, copied_at, pinned)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, 0)",
            params![
                item.id,
                item.content,
                item.char_count as i64,
                item.line_count as i64,
                item.source,
                item.copied_at
            ],
        )?;

        let _ = c.execute(
            "DELETE FROM clipboard_history WHERE pinned = 0 AND id NOT IN (
                SELECT id FROM clipboard_history ORDER BY copied_at DESC LIMIT 100
             )",
            [],
        );

        Ok(item)
    })
}

#[tauri::command]
pub fn clipboard_history_list(
    limit: Option<usize>,
    search: Option<String>,
    vault: State<'_, Vault>,
) -> AppResult<Vec<ClipboardItem>> {
    vault.with(|c| {
        let max_rows = limit.unwrap_or(100);
        if let Some(ref q) = search {
            let pattern = format!("%{}%", q);
            let mut st = c.prepare(
                "SELECT id, content, char_count, line_count, source, copied_at, pinned
                 FROM clipboard_history
                 WHERE content LIKE ?1
                 ORDER BY pinned DESC, copied_at DESC LIMIT ?2",
            )?;
            let mapped = st.query_map(params![pattern, max_rows], |r| {
                let pinned_int: i64 = r.get(6)?;
                Ok(ClipboardItem {
                    id: r.get(0)?,
                    content: r.get(1)?,
                    char_count: r.get::<_, i64>(2)? as usize,
                    line_count: r.get::<_, i64>(3)? as usize,
                    source: r.get(4)?,
                    copied_at: r.get(5)?,
                    pinned: pinned_int != 0,
                })
            })?.collect::<Result<Vec<_>, _>>()?;
            Ok(mapped)
        } else {
            let mut st = c.prepare(
                "SELECT id, content, char_count, line_count, source, copied_at, pinned
                 FROM clipboard_history
                 ORDER BY pinned DESC, copied_at DESC LIMIT ?1",
            )?;
            let mapped = st.query_map(params![max_rows], |r| {
                let pinned_int: i64 = r.get(6)?;
                Ok(ClipboardItem {
                    id: r.get(0)?,
                    content: r.get(1)?,
                    char_count: r.get::<_, i64>(2)? as usize,
                    line_count: r.get::<_, i64>(3)? as usize,
                    source: r.get(4)?,
                    copied_at: r.get(5)?,
                    pinned: pinned_int != 0,
                })
            })?.collect::<Result<Vec<_>, _>>()?;
            Ok(mapped)
        }
    })
}

#[tauri::command]
pub fn clipboard_history_toggle_pin(id: String, vault: State<'_, Vault>) -> AppResult<bool> {
    vault.with(|c| {
        c.execute(
            "UPDATE clipboard_history SET pinned = CASE WHEN pinned=1 THEN 0 ELSE 1 END WHERE id=?1",
            [&id],
        )?;
        let pinned: i64 = c.query_row("SELECT pinned FROM clipboard_history WHERE id=?1", [&id], |r| r.get(0))?;
        Ok(pinned != 0)
    })
}

#[tauri::command]
pub fn clipboard_history_delete(id: String, vault: State<'_, Vault>) -> AppResult<()> {
    vault.with(|c| {
        c.execute("DELETE FROM clipboard_history WHERE id=?1", [&id])?;
        Ok(())
    })
}

#[tauri::command]
pub fn clipboard_history_clear(vault: State<'_, Vault>) -> AppResult<()> {
    vault.with(|c| {
        c.execute("DELETE FROM clipboard_history WHERE pinned = 0", [])?;
        Ok(())
    })
}

// ── Known Hosts ──

#[tauri::command]
pub fn known_hosts_list(vault: State<'_, Vault>) -> AppResult<Vec<KnownHost>> {
    vault.with(|c| {
        let mut st = c.prepare("SELECT host, port, fingerprint, added_at FROM known_hosts ORDER BY host, port")?;
        let rows = st.query_map([], |r| {
            Ok(KnownHost {
                host: r.get(0)?,
                port: r.get(1)?,
                fingerprint: r.get(2)?,
                added_at: r.get(3)?,
            })
        })?;
        Ok(rows.collect::<Result<Vec<_>, _>>()?)
    })
}

#[tauri::command]
pub fn known_host_delete(host: String, port: u16, vault: State<'_, Vault>) -> AppResult<()> {
    vault.with(|c| {
        c.execute("DELETE FROM known_hosts WHERE host=?1 AND port=?2", params![host, port])?;
        Ok(())
    })
}

// ── Host-key trust pinning ────────────────────────────────────────────────────
// `host_trust_key` may only pin a fingerprint this installation actually saw on
// a recent connect attempt. The WebView can ask to trust "the key that was just
// offered", but it can never mint trust for an arbitrary attacker key.

fn pending_trust() -> &'static Mutex<HashMap<(String, u16), (String, std::time::Instant)>> {
    static PENDING: std::sync::OnceLock<Mutex<HashMap<(String, u16), (String, std::time::Instant)>>> =
        std::sync::OnceLock::new();
    PENDING.get_or_init(|| Mutex::new(HashMap::new()))
}

const PENDING_TRUST_TTL: std::time::Duration = std::time::Duration::from_secs(600);

/// Called from the SSH layer when a server offers an unknown host key.
pub fn record_pending_trust(host: &str, port: u16, fingerprint: &str) {
    let mut g = pending_trust().lock();
    g.retain(|_, (_, t)| t.elapsed() < PENDING_TRUST_TTL);
    g.insert((host.to_string(), port), (fingerprint.to_string(), std::time::Instant::now()));
}

#[tauri::command]
pub fn host_trust_key(host: String, port: u16, fingerprint: String, vault: State<'_, Vault>) -> AppResult<()> {
    // Only a fingerprint offered by a recent connection can be pinned.
    let observed: Option<(String, u16)> = {
        let mut g = pending_trust().lock();
        g.retain(|_, (_, t)| t.elapsed() < PENDING_TRUST_TTL);
        let key = (host.clone(), port);
        if g.get(&key).map(|(f, _)| f == &fingerprint).unwrap_or(false) {
            g.remove(&key);
            Some(key)
        } else {
            // A jump-host key arrives under the hop's (hostname, port) even
            // though the UI names the final target — match by fingerprint and
            // pin under the host that actually offered it.
            let hit = g
                .iter()
                .find(|(_, (f, _))| f == &fingerprint)
                .map(|((h, p), _)| (h.clone(), *p));
            if let Some(ref hp) = hit {
                g.remove(hp);
            }
            hit
        }
    };
    let (pin_host, pin_port) = observed.ok_or_else(|| {
        AppError::Other(
            "Refused to trust: this fingerprint was not offered by any recent connection. \
             Reconnect and approve the key shown in the terminal."
                .into(),
        )
    })?;
    vault.with(|c| {
        c.execute(
            "INSERT OR REPLACE INTO known_hosts(host, port, fingerprint, added_at) VALUES(?1, ?2, ?3, ?4)",
            params![pin_host, pin_port, fingerprint, now()],
        )?;
        Ok(())
    })
}

// ── Tunnels / Port Forwarding ──

#[tauri::command]
pub fn tunnels_list(vault: State<'_, Vault>) -> AppResult<Vec<TunnelConfig>> {
    vault.with(|c| {
        let mut st = c.prepare(
            "SELECT id, label, host_id, forward_type, local_host, local_port, remote_host, remote_port, updated_at, vault_id
             FROM tunnels ORDER BY label",
        )?;
        let rows = st.query_map([], |r| {
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
        })?;
        Ok(rows.collect::<Result<Vec<_>, _>>()?)
    })
}

#[tauri::command]
pub fn tunnel_save(mut tunnel: TunnelConfig, vault: State<'_, Vault>) -> AppResult<String> {
    crate::tunnel::validate_tunnel(&tunnel)?;
    if tunnel.id.is_empty() {
        tunnel.id = uuid::Uuid::new_v4().to_string();
    }
    vault.with(|c| {
        c.execute(
            "INSERT INTO tunnels(id, label, host_id, forward_type, local_host, local_port, remote_host, remote_port, vault_id, updated_at)
             VALUES(?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)
             ON CONFLICT(id) DO UPDATE SET label=?2, host_id=?3, forward_type=?4, local_host=?5, local_port=?6,
                 remote_host=?7, remote_port=?8, vault_id=?9, updated_at=?10",
            params![
                tunnel.id, tunnel.label, tunnel.host_id, tunnel.forward_type,
                tunnel.local_host, tunnel.local_port, tunnel.remote_host, tunnel.remote_port,
                tunnel.vault_id.unwrap_or_else(|| "personal".into()), now()
            ],
        )?;
        let _ = log_sync_mutation(c, "tunnels", &tunnel.id);
        Ok(tunnel.id.clone())
    })
}

#[tauri::command]
pub fn tunnel_delete(id: String, vault: State<'_, Vault>) -> AppResult<()> {
    vault.with(|c| {
        c.execute("DELETE FROM tunnels WHERE id=?1", [&id])?;
        let _ = log_sync_deletion(c, "tunnels", &id);
        Ok(())
    })
}

// ── Snippets ──

#[tauri::command]
pub fn snippets_list(vault: State<'_, Vault>) -> AppResult<Vec<Snippet>> {
    vault.with(|c| {
        let mut st = c.prepare("SELECT id, name, command, folder, tags, vault_id FROM snippets ORDER BY folder, name")?;
        let rows = st.query_map([], |r| {
            let tags: String = r.get(4)?;
            Ok(Snippet {
                id: r.get(0)?,
                name: r.get(1)?,
                command: r.get(2)?,
                folder: r.get(3)?,
                tags: serde_json::from_str(&tags).unwrap_or_default(),
                vault_id: r.get(5)?,
            })
        })?;
        Ok(rows.collect::<Result<Vec<_>, _>>()?)
    })
}

#[tauri::command]
pub fn snippet_save(mut snippet: Snippet, vault: State<'_, Vault>) -> AppResult<String> {
    if snippet.id.is_empty() {
        snippet.id = uuid::Uuid::new_v4().to_string();
    }
    vault.with(|c| {
        c.execute(
            "INSERT OR REPLACE INTO snippets(id, name, command, folder, tags, vault_id, updated_at) VALUES(?1, ?2, ?3, ?4, ?5, ?6, ?7)",
            params![
                snippet.id, snippet.name, snippet.command, snippet.folder,
                serde_json::to_string(&snippet.tags).unwrap_or_else(|_| "[]".into()),
                snippet.vault_id.unwrap_or_else(|| "personal".into()), now()
            ],
        )?;
        let _ = log_sync_mutation(c, "snippets", &snippet.id);
        Ok(snippet.id.clone())
    })
}

#[tauri::command]
pub fn snippet_delete(id: String, vault: State<'_, Vault>) -> AppResult<()> {
    vault.with(|c| {
        c.execute("DELETE FROM snippets WHERE id=?1", [&id])?;
        let _ = log_sync_deletion(c, "snippets", &id);
        Ok(())
    })
}

// ── Multi-Vault Management ──

#[tauri::command]
pub fn vault_list(vault: State<'_, Vault>) -> AppResult<Vec<VaultRecord>> {
    vault.with(|c| {
        let mut st = c.prepare("SELECT id, name, kind, color, description, created_at FROM vaults ORDER BY created_at ASC")?;
        let rows = st.query_map([], |r| {
            Ok(VaultRecord {
                id: r.get(0)?,
                name: r.get(1)?,
                kind: r.get(2)?,
                color: r.get(3)?,
                description: r.get(4)?,
                created_at: r.get(5)?,
            })
        })?;
        let mut res = rows.collect::<Result<Vec<_>, _>>()?;
        if res.is_empty() {
            let personal = VaultRecord {
                id: "personal".into(),
                name: "Personal Vault".into(),
                kind: "personal".into(),
                color: Some("#22d3ee".into()),
                description: Some("Your private hosts & credentials".into()),
                created_at: now(),
            };
            let _ = c.execute("INSERT OR IGNORE INTO vaults (id, name, kind, color, description, created_at) VALUES ('personal', 'Personal Vault', 'personal', '#22d3ee', 'Your private hosts & credentials', ?1)", [personal.created_at]);
            res.push(personal);
        }
        Ok(res)
    })
}

#[tauri::command]
pub fn vault_save(mut record: VaultRecord, vault: State<'_, Vault>) -> AppResult<String> {
    if record.id.is_empty() {
        record.id = uuid::Uuid::new_v4().to_string();
    }
    vault.with(|c| {
        c.execute(
            "INSERT INTO vaults(id, name, kind, color, description, created_at)
             VALUES(?1, ?2, ?3, ?4, ?5, ?6)
             ON CONFLICT(id) DO UPDATE SET name=?2, kind=?3, color=?4, description=?5",
            params![record.id, record.name, record.kind, record.color, record.description, record.created_at],
        )?;
        let _ = log_sync_mutation(c, "vaults", &record.id);
        Ok(record.id)
    })
}

#[tauri::command]
pub fn vault_delete(id: String, vault: State<'_, Vault>) -> AppResult<()> {
    if id == "personal" {
        return Err(AppError::Other("Cannot delete the default Personal Vault".into()));
    }
    vault.with(|c| {
        c.execute("UPDATE hosts SET vault_id='personal' WHERE vault_id=?1", [&id])?;
        c.execute("UPDATE snippets SET vault_id='personal' WHERE vault_id=?1", [&id])?;
        c.execute("UPDATE tunnels SET vault_id='personal' WHERE vault_id=?1", [&id])?;
        c.execute("UPDATE keychain SET vault_id='personal' WHERE vault_id=?1", [&id])?;
        c.execute("DELETE FROM vaults WHERE id=?1", [&id])?;
        let _ = log_sync_deletion(c, "vaults", &id);
        Ok(())
    })
}

// ── Zero-Knowledge Team Sharing (Encrypted .drxvault Bundles) ──

#[tauri::command]
pub async fn team_vault_export(
    vault_id: String,
    passphrase: String,
    app: tauri::AppHandle,
) -> AppResult<EncryptedTeamVaultBundle> {
    if passphrase.trim().is_empty() {
        return Err(AppError::Other("Passphrase cannot be empty".into()));
    }

    tauri::async_runtime::spawn_blocking(move || {
        let vault = app.state::<Vault>();
        let payload = vault.with(|c| {
            let v_record: VaultRecord = c.query_row(
                "SELECT id, name, kind, color, description, created_at FROM vaults WHERE id=?1",
                [&vault_id],
                |r| {
                    Ok(VaultRecord {
                        id: r.get(0)?,
                        name: r.get(1)?,
                        kind: r.get(2)?,
                        color: r.get(3)?,
                        description: r.get(4)?,
                        created_at: r.get(5)?,
                    })
                },
            ).unwrap_or_else(|_| VaultRecord {
                id: vault_id.clone(),
                name: "Team Vault".into(),
                kind: "team".into(),
                color: Some("#10b981".into()),
                description: Some("Shared Team Vault".into()),
                created_at: now(),
            });

            let mut st_hosts = c.prepare(
                "SELECT h.id, h.label, h.hostname, h.port, h.username, h.auth_method, h.grp, h.tags, h.color, h.os, h.keychain_id, h.jump_host_id, h.vault_id, h.startup_command, h.proxy_command,
                        (s.host_id IS NOT NULL OR h.keychain_id IS NOT NULL)
                 FROM hosts h LEFT JOIN secrets s ON s.host_id=h.id
                 WHERE h.vault_id = ?1",
            )?;
            let hosts = st_hosts.query_map([&vault_id], |r| {
                let mut h = row_to_host(r)?;
                h.has_secret = r.get(15)?;
                Ok(h)
            })?.collect::<Result<Vec<_>, _>>()?;

            let mut st_snips = c.prepare("SELECT id, name, command, folder, tags, vault_id FROM snippets WHERE vault_id = ?1")?;
            let snippets = st_snips.query_map([&vault_id], |r| {
                let tags: String = r.get(4)?;
                Ok(Snippet {
                    id: r.get(0)?,
                    name: r.get(1)?,
                    command: r.get(2)?,
                    folder: r.get(3)?,
                    tags: serde_json::from_str(&tags).unwrap_or_default(),
                    vault_id: r.get(5)?,
                })
            })?.collect::<Result<Vec<_>, _>>()?;

            let mut st_tun = c.prepare("SELECT id, label, host_id, forward_type, local_host, local_port, remote_host, remote_port, updated_at, vault_id FROM tunnels WHERE vault_id = ?1")?;
            let tunnels = st_tun.query_map([&vault_id], |r| {
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
            })?.collect::<Result<Vec<_>, _>>()?;

            let mut st_kc = c.prepare("SELECT id, label, username, auth_method, (password IS NOT NULL OR private_key IS NOT NULL), updated_at, vault_id FROM keychain WHERE vault_id = ?1")?;
            let keychain = st_kc.query_map([&vault_id], |r| {
                let auth: String = r.get(3)?;
                Ok(KeychainItem {
                    id: r.get(0)?,
                    label: r.get(1)?,
                    username: r.get(2)?,
                    auth_method: AuthMethod::parse(&auth),
                    has_secret: r.get(4)?,
                    updated_at: r.get(5)?,
                    vault_id: r.get(6)?,
                })
            })?.collect::<Result<Vec<_>, _>>()?;

            // Personal AI provider keys / proxy credentials are never shared with a team.
            let ai_configs: Vec<AiProviderConfig> = Vec::new();

            Ok(TeamVaultPayload {
                vault: v_record,
                hosts,
                keychain,
                tunnels,
                snippets,
                ai_configs,
            })
        })?;

        let json_bytes = serde_json::to_vec(&payload)
            .map_err(|e| AppError::Other(format!("Failed to serialize vault payload: {e}")))?;

        let mut salt = [0u8; 16];
        rand::thread_rng().fill_bytes(&mut salt);
        let key = Vault::derive_key(&passphrase, &salt)?;

        let mut nonce_bytes = [0u8; 24];
        rand::thread_rng().fill_bytes(&mut nonce_bytes);
        let nonce = XNonce::from_slice(&nonce_bytes);

        let cipher = XChaCha20Poly1305::new((key.as_ref()).into());
        let ciphertext = cipher
            .encrypt(nonce, json_bytes.as_ref())
            .map_err(|e| AppError::Crypto(format!("Encryption failed: {e}")))?;

        Ok(EncryptedTeamVaultBundle {
            version: 1,
            format: "drexius-team-vault".into(),
            vault_name: payload.vault.name,
            salt: hex::encode(salt),
            nonce: hex::encode(nonce_bytes),
            ciphertext: B64.encode(ciphertext),
        })
    })
    .await
    .map_err(|e| AppError::Other(e.to_string()))?
}

#[tauri::command]
pub async fn team_vault_import(
    bundle: EncryptedTeamVaultBundle,
    passphrase: String,
    app: tauri::AppHandle,
) -> AppResult<String> {
    tauri::async_runtime::spawn_blocking(move || {
        let salt = hex::decode(&bundle.salt)
            .map_err(|_| AppError::Crypto("Invalid salt format".into()))?;
        let key = Vault::derive_key(&passphrase, &salt)?;

        let nonce_bytes = hex::decode(&bundle.nonce)
            .map_err(|_| AppError::Crypto("Invalid nonce format".into()))?;
        if nonce_bytes.len() != 24 {
            return Err(AppError::Crypto("Invalid nonce length".into()));
        }
        let nonce = XNonce::from_slice(&nonce_bytes);

        let ciphertext = B64
            .decode(&bundle.ciphertext)
            .map_err(|_| AppError::Crypto("Invalid ciphertext format".into()))?;

        let cipher = XChaCha20Poly1305::new((key.as_ref()).into());
        let plaintext = cipher
            .decrypt(nonce, ciphertext.as_ref())
            .map_err(|_| AppError::Crypto("Invalid passphrase or corrupted vault bundle".into()))?;

        let payload: TeamVaultPayload = serde_json::from_slice(&plaintext)
            .map_err(|e| AppError::Other(format!("Failed to parse decrypted bundle: {e}")))?;

        // M4: a bundle must never write into the user's personal vault. Hosts with matching IDs would be overwritten.
        if payload.vault.id == "personal" {
            return Err(AppError::Other(
                "This bundle targets the personal vault and was rejected. Team bundles must use a team vault id.".into(),
            ));
        }

        let vault = app.state::<Vault>();
        vault.with(|c| {
            let tx = c.unchecked_transaction()?;

            tx.execute(
                "INSERT INTO vaults(id, name, kind, color, description, created_at)
                 VALUES(?1, ?2, 'team', ?3, ?4, ?5)
                 ON CONFLICT(id) DO UPDATE SET name=?2, color=?3, description=?4",
                params![payload.vault.id, payload.vault.name, payload.vault.color, payload.vault.description, payload.vault.created_at],
            )?;
            log_sync_mutation(&tx, "vaults", &payload.vault.id)?;

            // Pass 1: determine mapped IDs for ALL incoming hosts before writing any records
            // to ensure forward references in jump_host_id can never resolve to unrelated local hosts.
            let mut host_id_map: HashMap<String, String> = HashMap::new();
            for h in &payload.hosts {
                let is_collision = tx.query_row(
                    "SELECT vault_id FROM hosts WHERE id = ?1",
                    [&h.id],
                    |r| r.get::<_, String>(0),
                ).optional()?;

                let has_secret: bool = tx.query_row(
                    "SELECT 1 FROM secrets WHERE host_id = ?1",
                    [&h.id],
                    |_| Ok(true),
                ).optional()?.unwrap_or(false);

                let host_id = if has_secret || (is_collision.is_some() && is_collision.as_deref() != Some(&payload.vault.id)) {
                    uuid::Uuid::new_v4().to_string()
                } else {
                    h.id.clone()
                };
                host_id_map.insert(h.id.clone(), host_id);
            }

            // Pass 2: write host records with internal references fully mapped
            for h in &payload.hosts {
                let host_id = host_id_map.get(&h.id).cloned().unwrap_or_else(|| h.id.clone());

                // Imported hosts should only bind to keychains that exist within this team vault
                let safe_keychain_id = if let Some(ref kid) = h.keychain_id {
                    let exists: bool = tx.query_row(
                        "SELECT 1 FROM keychain WHERE id = ?1 AND vault_id = ?2",
                        params![kid, payload.vault.id],
                        |_| Ok(true),
                    ).optional()?.unwrap_or(false);
                    if exists { Some(kid.clone()) } else { None }
                } else {
                    None
                };

                let jump_id = h.jump_host_id.as_ref().and_then(|jid| {
                    host_id_map.get(jid).cloned()
                });

                tx.execute(
                    "INSERT INTO hosts(id, label, hostname, port, username, auth_method, grp, tags, color, os, keychain_id, jump_host_id, vault_id, startup_command, proxy_command, updated_at)
                     VALUES(?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16)
                     ON CONFLICT(id) DO UPDATE SET label=?2, hostname=?3, port=?4, username=?5, auth_method=?6,
                         grp=?7, tags=?8, color=?9, os=?10, keychain_id=?11, jump_host_id=?12, vault_id=?13, updated_at=?16",
                    params![
                        host_id, h.label, h.hostname, h.port, h.username, h.auth_method.as_str(),
                        h.group, serde_json::to_string(&h.tags).unwrap_or_else(|_| "[]".into()),
                        h.color, h.os, safe_keychain_id, jump_id, payload.vault.id,
                        // M1: startup commands & proxy commands are never imported from a bundle. Untrusted code execution protection.
                        Option::<String>::None,
                        Option::<String>::None,
                        now()
                    ],
                )?;
                log_sync_mutation(&tx, "hosts", &host_id)?;
            }

            for s in &payload.snippets {
                let snip_collision = tx.query_row(
                    "SELECT vault_id FROM snippets WHERE id = ?1",
                    [&s.id],
                    |r| r.get::<_, String>(0),
                ).optional()?;
                let snip_id = if snip_collision.is_some() && snip_collision.as_deref() != Some(&payload.vault.id) {
                    uuid::Uuid::new_v4().to_string()
                } else {
                    s.id.clone()
                };

                tx.execute(
                    "INSERT OR REPLACE INTO snippets(id, name, command, folder, tags, vault_id, updated_at)
                     VALUES(?1, ?2, ?3, ?4, ?5, ?6, ?7)",
                    params![snip_id, s.name, s.command, s.folder, serde_json::to_string(&s.tags).unwrap_or_else(|_| "[]".into()), payload.vault.id, now()],
                )?;
                log_sync_mutation(&tx, "snippets", &snip_id)?;
            }

            for t in &payload.tunnels {
                let tun_collision = tx.query_row(
                    "SELECT vault_id FROM tunnels WHERE id = ?1",
                    [&t.id],
                    |r| r.get::<_, String>(0),
                ).optional()?;
                let tun_id = if tun_collision.is_some() && tun_collision.as_deref() != Some(&payload.vault.id) {
                    uuid::Uuid::new_v4().to_string()
                } else {
                    t.id.clone()
                };
                let mapped_host_id = host_id_map.get(&t.host_id).cloned().unwrap_or_else(|| t.host_id.clone());

                tx.execute(
                    "INSERT INTO tunnels(id, label, host_id, forward_type, local_host, local_port, remote_host, remote_port, vault_id, updated_at)
                     VALUES(?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)
                     ON CONFLICT(id) DO UPDATE SET label=?2, host_id=?3, forward_type=?4, local_host=?5, local_port=?6,
                         remote_host=?7, remote_port=?8, vault_id=?9, updated_at=?10",
                    params![
                        tun_id, t.label, mapped_host_id, t.forward_type, t.local_host, t.local_port,
                        t.remote_host, t.remote_port, payload.vault.id, now()
                    ],
                )?;
                log_sync_mutation(&tx, "tunnels", &tun_id)?;
            }

            // `payload.ai_configs` is intentionally ignored: older bundles may carry someone else's
            // API keys, and importing must never overwrite this user's own AI settings.

            tx.commit()?;
            Ok(payload.vault.id)
        })
    })
    .await
    .map_err(|e| AppError::Other(e.to_string()))?
}

// ── AI Provider Configuration & Key Pooling ──

pub(crate) fn query_all_ai_configs(c: &rusqlite::Connection) -> AppResult<Vec<AiProviderConfig>> {
    let mut st = c.prepare(
        "SELECT provider_id, name, base_url, api_keys, selected_model, models_cache, balance_strategy, enabled, updated_at, use_proxies, proxy_urls, proxy_strategy, auto_ssh_proxy, auto_ssh_host_id FROM ai_configs ORDER BY updated_at DESC"
    )?;
    let items = st.query_map([], |r| {
        let keys_str: String = r.get::<_, Option<String>>(3)?.unwrap_or_else(|| "[]".into());
        let cache_str: String = r.get::<_, Option<String>>(5)?.unwrap_or_else(|| "[]".into());
        let proxies_str: String = r.get::<_, Option<String>>(10)?.unwrap_or_else(|| "[]".into());
        Ok(AiProviderConfig {
            provider_id: r.get(0)?,
            name: r.get(1)?,
            base_url: r.get(2)?,
            api_keys: serde_json::from_str(&keys_str).unwrap_or_default(),
            selected_model: r.get::<_, Option<String>>(4)?.unwrap_or_default(),
            models_cache: serde_json::from_str(&cache_str).unwrap_or_default(),
            balance_strategy: r.get::<_, Option<String>>(6)?.unwrap_or_else(|| "round_robin".into()),
            enabled: r.get::<_, Option<i64>>(7)?.unwrap_or(1) != 0,
            updated_at: r.get::<_, Option<i64>>(8)?.unwrap_or(0),
            use_proxies: r.get::<_, Option<i64>>(9)?.unwrap_or(0) != 0,
            proxy_urls: serde_json::from_str(&proxies_str).unwrap_or_default(),
            proxy_strategy: r.get::<_, Option<String>>(11)?.unwrap_or_else(|| "p2c".into()),
            auto_ssh_proxy: r.get::<_, Option<i64>>(12)?.unwrap_or(0) != 0,
            auto_ssh_host_id: r.get::<_, Option<String>>(13)?,
        })
    })?.collect::<Result<Vec<_>, _>>()?;
    Ok(items)
}

#[tauri::command]
pub fn ai_configs_list(vault: tauri::State<'_, Vault>) -> AppResult<Vec<AiProviderConfig>> {
    // Secrets never leave the backend: the UI only receives masked keys / proxy URLs.
    vault.with(|c| Ok(query_all_ai_configs(c)?.into_iter().map(mask_ai_config).collect()))
}

/// Replaces API keys and proxy URLs with masked display strings (same length/order, so the UI
/// can still show counts and remove by index).
pub(crate) fn mask_ai_config(mut cfg: AiProviderConfig) -> AiProviderConfig {
    cfg.api_keys = cfg.api_keys.iter().map(|k| crate::ai_client::mask_secret(k)).collect();
    cfg.proxy_urls = cfg.proxy_urls.iter().map(|p| crate::ai_client::mask_proxy(p)).collect();
    cfg
}

/// Saves non-secret provider settings. API keys and proxy URLs are deliberately NOT written here
/// (the UI only holds masked copies); use the `ai_keys_*` / `ai_proxies_*` commands instead.
#[tauri::command]
pub fn ai_config_save(config: AiProviderConfig, vault: tauri::State<'_, Vault>) -> AppResult<()> {
    vault.with(|c| {
        upsert_ai_config_without_secrets(c, &config)?;
        Ok(())
    })
}

fn upsert_ai_config_without_secrets(c: &Connection, config: &AiProviderConfig) -> AppResult<()> {
    // Keys are bound to the endpoint they were added for. If the provider is repointed at a
    // different origin, drop its keys so they can never be sent to a new host unnoticed.
    let old_base: Option<String> = c
        .query_row(
            "SELECT base_url FROM ai_configs WHERE provider_id = ?1",
            [&config.provider_id],
            |r| r.get::<_, Option<String>>(0),
        )
        .optional()?
        .flatten();
    if let Some(old) = old_base {
        let origin = |s: &str| {
            reqwest::Url::parse(s.trim())
                .ok()
                .map(|u| (u.scheme().to_string(), u.host_str().map(str::to_ascii_lowercase), u.port_or_known_default()))
        };
        if origin(&old) != origin(&config.base_url) {
            c.execute("UPDATE ai_configs SET api_keys = '[]' WHERE provider_id = ?1", [&config.provider_id])?;
        }
    }

    let cache_json = serde_json::to_string(&config.models_cache).unwrap_or_else(|_| "[]".into());
    c.execute(
        "INSERT INTO ai_configs(provider_id, name, base_url, api_keys, selected_model, models_cache, balance_strategy, enabled, updated_at, use_proxies, proxy_urls, proxy_strategy, auto_ssh_proxy, auto_ssh_host_id)
         VALUES(?1, ?2, ?3, '[]', ?4, ?5, ?6, ?7, ?8, ?9, '[]', ?10, ?11, ?12)
         ON CONFLICT(provider_id) DO UPDATE SET name=?2, base_url=?3, selected_model=?4, models_cache=?5, balance_strategy=?6, enabled=?7, updated_at=?8, use_proxies=?9, proxy_strategy=?10, auto_ssh_proxy=?11, auto_ssh_host_id=?12",
        params![
            config.provider_id, config.name, config.base_url,
            config.selected_model, cache_json, config.balance_strategy,
            if config.enabled { 1 } else { 0 }, now(),
            if config.use_proxies { 1 } else { 0 }, config.proxy_strategy,
            if config.auto_ssh_proxy { 1 } else { 0 }, config.auto_ssh_host_id
        ],
    )?;
    Ok(())
}

/// Edits one secret list column (`api_keys` or `proxy_urls`) in place and returns the updated,
/// masked config. `col` is only ever one of two internal constants.
fn edit_ai_secret_list(
    c: &Connection,
    provider_id: &str,
    col: &'static str,
    f: impl FnOnce(&mut Vec<String>),
) -> AppResult<AiProviderConfig> {
    debug_assert!(col == "api_keys" || col == "proxy_urls");
    let raw: Option<String> = c
        .query_row(
            &format!("SELECT {col} FROM ai_configs WHERE provider_id = ?1"),
            [provider_id],
            |r| r.get::<_, Option<String>>(0),
        )
        .optional()?
        .flatten();
    let mut list: Vec<String> = raw
        .as_deref()
        .and_then(|j| serde_json::from_str(j).ok())
        .unwrap_or_default();
    f(&mut list);
    let json = serde_json::to_string(&list).unwrap_or_else(|_| "[]".into());
    c.execute(
        &format!("UPDATE ai_configs SET {col} = ?1, updated_at = ?2 WHERE provider_id = ?3"),
        params![json, now(), provider_id],
    )?;
    query_all_ai_configs(c)?
        .into_iter()
        .find(|x| x.provider_id == provider_id)
        .map(mask_ai_config)
        .ok_or_else(|| AppError::Other(format!("AI provider '{provider_id}' not found")))
}

fn add_unique(list: &mut Vec<String>, items: Vec<String>) {
    for it in items {
        let it = it.trim().to_string();
        if !it.is_empty() && !list.contains(&it) {
            list.push(it);
        }
    }
}

#[tauri::command]
pub fn ai_keys_add(
    config: AiProviderConfig,
    keys: Vec<String>,
    vault: tauri::State<'_, Vault>,
) -> AppResult<AiProviderConfig> {
    vault.with(|c| {
        upsert_ai_config_without_secrets(c, &config)?;
        edit_ai_secret_list(c, &config.provider_id, "api_keys", |l| add_unique(l, keys))
    })
}

#[tauri::command]
pub fn ai_key_remove(provider_id: String, index: usize, vault: tauri::State<'_, Vault>) -> AppResult<AiProviderConfig> {
    vault.with(|c| {
        edit_ai_secret_list(c, &provider_id, "api_keys", |l| {
            if index < l.len() {
                l.remove(index);
            }
        })
    })
}

#[tauri::command]
pub fn ai_keys_clear(provider_id: String, vault: tauri::State<'_, Vault>) -> AppResult<AiProviderConfig> {
    vault.with(|c| edit_ai_secret_list(c, &provider_id, "api_keys", |l| l.clear()))
}

#[tauri::command]
pub fn ai_proxies_add(
    config: AiProviderConfig,
    proxies: Vec<String>,
    vault: tauri::State<'_, Vault>,
) -> AppResult<AiProviderConfig> {
    vault.with(|c| {
        upsert_ai_config_without_secrets(c, &config)?;
        edit_ai_secret_list(c, &config.provider_id, "proxy_urls", |l| add_unique(l, proxies))
    })
}

#[tauri::command]
pub fn ai_proxy_remove(provider_id: String, index: usize, vault: tauri::State<'_, Vault>) -> AppResult<AiProviderConfig> {
    vault.with(|c| {
        edit_ai_secret_list(c, &provider_id, "proxy_urls", |l| {
            if index < l.len() {
                l.remove(index);
            }
        })
    })
}

#[tauri::command]
pub fn ai_proxies_clear(provider_id: String, vault: tauri::State<'_, Vault>) -> AppResult<AiProviderConfig> {
    vault.with(|c| edit_ai_secret_list(c, &provider_id, "proxy_urls", |l| l.clear()))
}

#[tauri::command]
pub fn ai_active_provider_get(vault: tauri::State<'_, Vault>) -> AppResult<Option<String>> {
    vault.with(|c| {
        Ok(c.query_row(
            "SELECT value FROM ai_settings WHERE key = 'active_provider'",
            [],
            |r| r.get(0),
        ).optional()?)
    })
}

#[tauri::command]
pub fn ai_active_provider_set(provider_id: String, vault: tauri::State<'_, Vault>) -> AppResult<()> {
    vault.with(|c| {
        c.execute(
            "INSERT INTO ai_settings(key, value) VALUES('active_provider', ?1)
             ON CONFLICT(key) DO UPDATE SET value=?1",
            [provider_id],
        )?;
        Ok(())
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    #[test]
    fn test_recovery_code_generation_and_normalization() {
        let (formatted, normalized) = generate_recovery_code();
        assert!(formatted.starts_with("DRX-"));
        assert_eq!(normalized.len(), 32);
        assert_eq!(normalize_recovery_code(&formatted), normalized);
        assert_eq!(normalize_recovery_code("drx-1234-abcd-5678-ef01"), "1234ABCD5678EF01");
        assert_eq!(normalize_recovery_code("  drx 1234 abcd "), "1234ABCD");
        assert_eq!(normalize_recovery_code("nx-1234-abcd-5678-ef01"), "1234ABCD5678EF01");
        assert_eq!(normalize_recovery_code("1234ABCD5678EF01"), "1234ABCD5678EF01");
    }

    /// Guards the invariant behind `keychain_generate_and_save`: whatever the
    /// WebView learns about a generated key must never include the secret half.
    /// If a private key or passphrase field is ever added to this response, this
    /// test fails instead of the boundary silently widening again.
    #[test]
    fn generated_key_response_carries_no_private_key() {
        let saved = GeneratedKeySaved {
            item: KeychainItem {
                id: "key-1".into(),
                label: "Generated ED25519 Key".into(),
                username: None,
                auth_method: AuthMethod::Key,
                has_secret: true,
                updated_at: 0,
                vault_id: Some("personal".into()),
            },
            public_key: "ssh-ed25519 AAAAC3Nza public-only".into(),
            fingerprint: "SHA256:test".into(),
            algorithm: "ED25519".into(),
        };
        let json = serde_json::to_string(&saved).expect("serialize response");
        assert!(json.contains("publicKey"), "public half must still reach the UI");
        assert!(!json.contains("privateKey"), "private key must not be serializable out");
        assert!(!json.contains("PRIVATE KEY"), "no PEM material in the response");
        assert!(!json.contains("passphrase"), "passphrase stays in Rust too");
    }

    #[test]
    fn test_recovery_envelope_roundtrip() {
        let unique = format!("test_vault_{}.db", rand::random::<u64>());
        let db_path = std::env::temp_dir().join(unique);
        let vault = Vault::new(db_path.clone());

        let (code, normalized) = generate_recovery_code();
        let db_key = [42u8; 32];

        vault.save_recovery_envelope(&db_key, &normalized).expect("Save envelope");
        assert!(vault.recovery_path().exists());

        let decrypted = vault.decrypt_recovery_envelope(&code).expect("Decrypt envelope");
        assert_eq!(*decrypted, db_key);

        // Wrong code fails
        assert!(vault.decrypt_recovery_envelope("DRX-0000-0000-0000-0000-0000-0000-0000-0000").is_err());

        // Cleanup
        let _ = std::fs::remove_file(vault.recovery_path());
    }

    /// The master-password policy must distinguish *choosing* a password from
    /// *unlocking* with one.
    ///
    /// A brand-new vault demands a real password, but an existing vault has to
    /// keep accepting whatever it was created with — otherwise upgrading the
    /// app could permanently lock a user out of a vault that was created under
    /// an older, weaker policy. The lock screen draws exactly this line
    /// (`initialized === false`); the backend has to draw it too.
    #[test]
    fn new_vaults_demand_a_longer_password_than_existing_ones() {
        let unique = format!("test_policy_{}.vault", rand::random::<u64>());
        let db_path = std::env::temp_dir().join(unique);
        let vault = Vault::new(db_path.clone());

        // Not initialized yet: choosing the password requires the strong policy.
        let err = vault.unlock("short").expect_err("a new vault must reject a short password");
        assert!(
            err.to_string().contains("at least 8 characters"),
            "expected the new-password policy error, got: {err}"
        );

        // Now pretend an existing vault is there: a database file plus a
        // 16-byte salt, so the only thing that can fail from here on is the
        // password itself. The permissive floor must apply, so the failure has
        // to be "wrong password", not "too short".
        std::fs::write(&db_path, b"not-a-real-vault").expect("seed vault file");
        std::fs::write(vault.salt_path(), [7u8; 16]).expect("seed salt file");
        let err = vault
            .unlock("four")
            .expect_err("a wrong password must not unlock the vault");
        assert!(
            !err.to_string().contains("at least 8 characters"),
            "an existing vault must not be judged by the new-password policy, got: {err}"
        );

        let _ = std::fs::remove_file(&db_path);
        let _ = std::fs::remove_file(vault.salt_path());
        let _ = std::fs::remove_file(db_path.with_extension("vault-wal"));
        let _ = std::fs::remove_file(db_path.with_extension("vault-shm"));
    }

    /// Every file the vault writes must be refused by the filesystem policy.
    ///
    /// The vault database, its salt, recovery envelope, device-lock credential,
    /// rekey journal and pre-rekey snapshot all live under the app data
    /// directory, which sits inside the user's home directory — an *approved*
    /// root for the generic `local_fs_*` commands. The sensitive-name denylist
    /// in `fs_guard` is therefore the only thing standing between a
    /// compromised WebView and the vault's own state files.
    ///
    /// This test derives the paths from the vault's own helpers, so a sidecar
    /// added later cannot be forgotten here without failing CI.
    #[test]
    fn every_vault_sidecar_is_blocked_by_the_filesystem_policy() {
        let vault = Vault::new(PathBuf::from("/tmp/drexius.vault"));
        let sidecars = vec![
            ("vault database", vault.path.clone()),
            ("salt", vault.salt_path()),
            ("recovery envelope", vault.recovery_path()),
            ("device lock", vault.device_lock_path()),
            ("rekey journal", vault.rekey_journal_path()),
            ("pre-rekey snapshot", vault.pre_rekey_backup_path()),
            ("wal", vault.path.with_extension("vault-wal")),
            ("shm", vault.path.with_extension("vault-shm")),
        ];
        for (label, path) in sidecars {
            assert!(
                crate::fs_guard::is_sensitive_path(&path),
                "the {label} ({}) must not be reachable through the local-FS commands",
                path.display()
            );
        }
    }
}

