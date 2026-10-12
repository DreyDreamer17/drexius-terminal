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
/// NexusTerminal app identifier so entries are easy to audit/clean up.
const KEYCHAIN_SERVICE: &str = "dev.nexusterminal.app";
/// Username under which the master password is stored. We use a fixed,
/// well-known entry so we can query "is there a stored password?" quickly.
const KEYCHAIN_USER: &str = "vault-master-password";

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
    color TEXT, os TEXT, keychain_id TEXT, jump_host_id TEXT, vault_id TEXT, startup_command TEXT, updated_at INTEGER NOT NULL
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
    ip_address TEXT, public_key TEXT, paired_at INTEGER NOT NULL, last_sync INTEGER NOT NULL
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

impl Vault {
    pub fn new(path: PathBuf) -> Self {
        Self { path, inner: Mutex::new(None) }
    }

    fn salt_path(&self) -> PathBuf {
        self.path.with_extension("salt")
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

    pub fn unlock(&self, master_password: &str) -> AppResult<()> {
        let salt = match std::fs::read(self.salt_path()) {
            Ok(s) if s.len() == 16 => s,
            Ok(s) => return Err(AppError::Crypto(format!("vault salt file is corrupt ({} bytes, expected 16)", s.len()))),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
                if self.path.exists() {
                    return Err(AppError::Crypto(
                        "Vault database exists but its salt file (nexus.vault.salt) is missing. \
                         Refusing to generate a new salt to prevent permanent data loss. \
                         Please restore nexus.vault.salt or delete the vault database to reset.".into()
                    ));
                }
                let mut s = vec![0u8; 16];
                rand::thread_rng().fill_bytes(&mut s);
                std::fs::write(self.salt_path(), &s)?;
                s
            }
            Err(e) => return Err(AppError::Io(e)),
        };
        let key = Self::derive_key(master_password, &salt)?;
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
            let _ = conn.execute("CREATE TABLE IF NOT EXISTS vaults (id TEXT PRIMARY KEY, name TEXT NOT NULL, kind TEXT NOT NULL DEFAULT 'personal', color TEXT, description TEXT, created_at INTEGER NOT NULL)", []);
            let _ = conn.execute("INSERT OR IGNORE INTO vaults (id, name, kind, color, description, created_at) VALUES ('personal', 'Personal Vault', 'personal', '#22d3ee', 'Your private hosts & secrets', unixepoch())", []);
            let _ = conn.execute("ALTER TABLE hosts ADD COLUMN os TEXT", []);
            let _ = conn.execute("ALTER TABLE hosts ADD COLUMN keychain_id TEXT", []);
            let _ = conn.execute("ALTER TABLE hosts ADD COLUMN jump_host_id TEXT", []);
            let _ = conn.execute("ALTER TABLE hosts ADD COLUMN vault_id TEXT DEFAULT 'personal'", []);
            let _ = conn.execute("ALTER TABLE hosts ADD COLUMN startup_command TEXT", []);
            let _ = conn.execute("ALTER TABLE keychain ADD COLUMN vault_id TEXT DEFAULT 'personal'", []);
            let _ = conn.execute("ALTER TABLE tunnels ADD COLUMN vault_id TEXT DEFAULT 'personal'", []);
            let _ = conn.execute("ALTER TABLE snippets ADD COLUMN vault_id TEXT DEFAULT 'personal'", []);
            let _ = conn.execute("CREATE TABLE IF NOT EXISTS paired_devices (id TEXT PRIMARY KEY, device_name TEXT NOT NULL, device_type TEXT NOT NULL, ip_address TEXT, public_key TEXT, paired_at INTEGER NOT NULL, last_sync INTEGER NOT NULL)", []);
            let _ = conn.execute("CREATE TABLE IF NOT EXISTS ai_configs (provider_id TEXT PRIMARY KEY, name TEXT NOT NULL, base_url TEXT NOT NULL, api_keys TEXT NOT NULL DEFAULT '[]', selected_model TEXT NOT NULL DEFAULT '', models_cache TEXT NOT NULL DEFAULT '[]', balance_strategy TEXT NOT NULL DEFAULT 'round_robin', enabled INTEGER NOT NULL DEFAULT 1, updated_at INTEGER NOT NULL)", []);
            let _ = conn.execute("ALTER TABLE ai_configs ADD COLUMN use_proxies INTEGER NOT NULL DEFAULT 0", []);
            let _ = conn.execute("ALTER TABLE ai_configs ADD COLUMN proxy_urls TEXT NOT NULL DEFAULT '[]'", []);
            let _ = conn.execute("ALTER TABLE ai_configs ADD COLUMN proxy_strategy TEXT NOT NULL DEFAULT 'p2c'", []);
            let _ = conn.execute("ALTER TABLE ai_configs ADD COLUMN auto_ssh_proxy INTEGER NOT NULL DEFAULT 0", []);
            let _ = conn.execute("ALTER TABLE ai_configs ADD COLUMN auto_ssh_host_id TEXT", []);
            let _ = conn.execute("CREATE TABLE IF NOT EXISTS ai_settings (key TEXT PRIMARY KEY, value TEXT NOT NULL)", []);
            let _ = conn.execute("CREATE TABLE IF NOT EXISTS command_history (id TEXT PRIMARY KEY, host_id TEXT, host_label TEXT NOT NULL, command TEXT NOT NULL, cwd TEXT, executed_at INTEGER NOT NULL, starred INTEGER NOT NULL DEFAULT 0)", []);
            let _ = conn.execute("CREATE TABLE IF NOT EXISTS clipboard_history (id TEXT PRIMARY KEY, content TEXT NOT NULL, char_count INTEGER NOT NULL, line_count INTEGER NOT NULL, source TEXT, copied_at INTEGER NOT NULL, pinned INTEGER NOT NULL DEFAULT 0)", []);
            // Auto-detect and import keys from existing hosts into keychain (idempotent, only imports unlinked)
            let _ = import_hosts_keys_internal(&conn);
            let _ = conn.execute("PRAGMA user_version = 2", []);
        } else {
            let _ = conn.execute("INSERT OR IGNORE INTO vaults (id, name, kind, color, description, created_at) VALUES ('personal', 'Personal Vault', 'personal', '#22d3ee', 'Your private hosts & secrets', unixepoch())", []);
        }
        *self.inner.lock() = Some(Unlocked { conn, root_key: key });
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
            Ok(())
        })
    }

    pub fn host_with_secret(&self, id: &str) -> AppResult<(HostProfile, HostSecret)> {
        self.with(|c| {
            let host_res = c
                .query_row(
                    "SELECT h.id, h.label, h.hostname, h.port, h.username, h.auth_method, h.grp, h.tags, h.color, h.os, h.keychain_id, h.jump_host_id, h.vault_id, h.startup_command,
                            s.password, s.private_key, s.passphrase,
                            k.auth_method, k.password, k.private_key, k.passphrase, k.username
                     FROM hosts h
                     LEFT JOIN secrets s ON s.host_id=h.id
                     LEFT JOIN keychain k ON k.id=h.keychain_id
                     WHERE h.id=?1",
                    [id],
                    |r| {
                        let mut profile = row_to_host(r)?;
                        let k_auth: Option<String> = r.get(17)?;
                        let (auth_method, password, private_key, passphrase, username) = if let Some(ka) = k_auth {
                            // Sourced from Keychain
                            let k_user: Option<String> = r.get(21)?;
                            (
                                AuthMethod::parse(&ka),
                                r.get(18)?,
                                r.get(19)?,
                                r.get(20)?,
                                k_user.unwrap_or(profile.username.clone()),
                            )
                        } else {
                            // Sourced from Host Secret
                            (
                                profile.auth_method,
                                r.get(14)?,
                                r.get(15)?,
                                r.get(16)?,
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
pub async fn vault_unlock(master_password: String, app: tauri::AppHandle) -> AppResult<()> {
    if master_password.len() < 4 {
        return Err(AppError::Other("Master password must be at least 4 characters".into()));
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
pub fn vault_lock(vault: State<'_, Vault>) {
    vault.lock()
}

// ── OS Keychain (biometric / Touch ID / Windows Hello integration) ──
//
// Stores the master password in the user's OS-provided credential store so
// that subsequent unlocks can happen via OS biometrics (Touch ID, Face ID,
// Windows Hello) without retyping. We deliberately treat the OS keychain as
// an *optional convenience*, never a requirement: if it's unavailable (e.g.
// headless Linux without a Secret Service daemon), commands return a
// structured error and the UI falls back to the password field. Storing,
// retrieving and deleting are all explicit user-initiated actions — we
// never silently read from the keychain without the user clicking a
// "Biometric unlock" button, because on macOS any read triggers a Touch ID
// prompt. The frontend tracks opt-in state itself (a simple localStorage
// flag); we don't provide a "probe" backend command because probing would
// itself trigger a biometric prompt on some platforms.

#[tauri::command]
pub async fn os_keychain_unlock(app: tauri::AppHandle) -> AppResult<()> {
    tauri::async_runtime::spawn_blocking(move || {
        // Read the master password from the OS keychain and unlock the vault.
        // On macOS this triggers a Touch ID / Apple Watch prompt via the
        // Security framework; on Windows it opens a Windows Hello consent
        // dialog if the credential is protected. The user has explicitly
        // tapped the biometric-unlock button before this is called.
        let pw = match keychain_entry()?.get_password() {
            Ok(p) => Zeroizing::new(p),
            Err(keyring::Error::NoEntry) => {
                return Err(AppError::Other(
                    "No master password stored in OS keychain".into(),
                ))
            }
            Err(keyring::Error::NoStorageAccess(e)) => {
                return Err(AppError::Other(format!(
                    "OS keychain unavailable: {e}"
                )))
            }
            Err(keyring::Error::PlatformFailure(e)) => {
                return Err(AppError::Other(format!(
                    "Biometric prompt failed: {e}"
                )))
            }
            Err(e) => {
                return Err(AppError::Other(format!(
                    "OS keychain denied access: {e}"
                )))
            }
        };
        let vault = app.state::<Vault>();
        vault.unlock(&pw)
    })
    .await
    .map_err(|e| AppError::Other(e.to_string()))?
}

#[tauri::command]
pub fn os_keychain_store(master_password: String, vault: State<'_, Vault>) -> AppResult<()> {
    // Persist the master password in the OS keychain only if vault is unlocked and password valid.
    if !vault.is_unlocked() {
        return Err(AppError::VaultLocked);
    }
    if master_password.len() < 4 {
        return Err(AppError::Other("Master password must be at least 4 characters".into()));
    }
    let pw = Zeroizing::new(master_password);
    keychain_entry()?
        .set_password(&pw)
        .map_err(|e| AppError::Other(format!("Failed to store in OS keychain: {e}")))
}

#[tauri::command]
pub fn os_keychain_delete() -> AppResult<()> {
    // Remove any stored master password from the OS keychain. Called when
    // the user turns off the "Remember me" toggle or explicitly wants to
    // clear the credential. Succeeds silently if no entry exists.
    match keychain_entry()?.delete_credential() {
        Ok(()) => Ok(()),
        Err(keyring::Error::NoEntry) => Ok(()),
        Err(e) => Err(AppError::Other(format!(
            "Failed to delete from OS keychain: {e}"
        ))),
    }
}

// ── Hosts ──

#[tauri::command]
pub fn hosts_list(vault: State<'_, Vault>) -> AppResult<Vec<HostProfile>> {
    vault.with(|c| {
        let mut st = c.prepare(
            "SELECT h.id, h.label, h.hostname, h.port, h.username, h.auth_method, h.grp, h.tags, h.color, h.os, h.keychain_id, h.jump_host_id, h.vault_id, h.startup_command,
                    (s.host_id IS NOT NULL OR h.keychain_id IS NOT NULL) FROM hosts h LEFT JOIN secrets s ON s.host_id=h.id ORDER BY h.grp, h.label",
        )?;
        let rows = st.query_map([], |r| {
            let mut h = row_to_host(r)?;
            h.has_secret = r.get(14)?;
            Ok(h)
        })?;
        Ok(rows.collect::<Result<Vec<_>, _>>()?)
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
            "INSERT INTO hosts(id, label, hostname, port, username, auth_method, grp, tags, color, os, keychain_id, jump_host_id, vault_id, startup_command, updated_at)
             VALUES(?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15)
             ON CONFLICT(id) DO UPDATE SET label=?2, hostname=?3, port=?4, username=?5, auth_method=?6,
                 grp=?7, tags=?8, color=?9, os=?10, keychain_id=?11, jump_host_id=?12, vault_id=?13, startup_command=?14, updated_at=?15",
            params![
                profile.id, profile.label, profile.hostname, profile.port, profile.username,
                profile.auth_method.as_str(), profile.group,
                serde_json::to_string(&profile.tags).unwrap_or_else(|_| "[]".into()),
                profile.color, profile.os, profile.keychain_id, profile.jump_host_id,
                profile.vault_id.unwrap_or_else(|| "personal".into()),
                profile.startup_command,
                now()
            ],
        )?;
        if let Some(s) = &secret {
            c.execute(
                "INSERT INTO secrets(host_id, password, private_key, passphrase) VALUES(?1, ?2, ?3, ?4)
                 ON CONFLICT(host_id) DO UPDATE SET password=?2, private_key=?3, passphrase=?4",
                params![profile.id, s.password, s.private_key, s.passphrase],
            )?;
        }
        let _ = c.execute("DELETE FROM sync_log WHERE record_id=?1", [&profile.id]);
        Ok(profile.id.clone())
    })
}

/// Records a deletion tombstone in `sync_log` so sync engines propagate the removal to peers.
pub fn log_sync_deletion(conn: &Connection, tbl: &str, record_id: &str) -> rusqlite::Result<()> {
    let now_ms = chrono::Utc::now().timestamp_millis();
    let hlc = format!("{now_ms}:0:local");
    conn.execute(
        "INSERT INTO sync_log (record_id, tbl, hlc, deleted) VALUES (?1, ?2, ?3, 1)
         ON CONFLICT(record_id) DO UPDATE SET tbl=excluded.tbl, hlc=excluded.hlc, deleted=1",
        params![record_id, tbl, hlc],
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

#[tauri::command]
pub fn keychain_save(input: KeychainInput, vault: State<'_, Vault>) -> AppResult<String> {
    let mut id = input.id;
    if id.is_empty() {
        id = uuid::Uuid::new_v4().to_string();
    }
    vault.with(|c| {
        c.execute(
            "INSERT INTO keychain(id, label, username, auth_method, password, private_key, passphrase, vault_id, updated_at)
             VALUES(?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)
             ON CONFLICT(id) DO UPDATE SET label=?2, username=?3, auth_method=?4,
                 password=COALESCE(?5, password), private_key=COALESCE(?6, private_key), passphrase=COALESCE(?7, passphrase), vault_id=?8, updated_at=?9",
            params![
                id, input.label, input.username, input.auth_method.as_str(),
                input.password, input.private_key, input.passphrase, input.vault_id.unwrap_or_else(|| "personal".into()), now()
            ],
        )?;
        let _ = c.execute("DELETE FROM sync_log WHERE record_id=?1", [&id]);
        Ok(id)
    })
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
        "SELECT h.id, h.label, h.username, h.auth_method, s.password, s.private_key, s.passphrase
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
            })
        })?
        .collect::<Result<Vec<_>, _>>()?;

    let mut imported = 0;
    for r in rows {
        // If private_key exists, check if that exact private key is already in keychain
        let existing_id: Option<String> = if let Some(ref pk) = r.private_key {
            c.query_row(
                "SELECT id FROM keychain WHERE private_key = ?1 LIMIT 1",
                [pk],
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
                "INSERT INTO keychain(id, label, username, auth_method, password, private_key, passphrase, updated_at)
                 VALUES(?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
                params![
                    new_id,
                    kc_label,
                    r.username,
                    r.auth_method,
                    r.password,
                    r.private_key,
                    r.passphrase,
                    now()
                ],
            )?;
            imported += 1;
            new_id
        };

        c.execute(
            "UPDATE hosts SET keychain_id = ?1 WHERE id = ?2",
            params![kc_id, r.host_id],
        )?;
    }
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
    vault: State<'_, Vault>,
) -> AppResult<String> {
    let key_path = PathBuf::from(&path);
    if !key_path.exists() {
        return Err(AppError::Other(format!("Key file does not exist: {}", path)));
    }
    let content = std::fs::read_to_string(&key_path)
        .map_err(|e| AppError::Other(format!("Failed to read key file: {}", e)))?;

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
        let existing: Option<String> = c
            .query_row(
                "SELECT id FROM keychain WHERE private_key = ?1 LIMIT 1",
                [&content],
                |r| r.get(0),
            )
            .optional()?;

        if let Some(id) = existing {
            return Ok(id);
        }

        let id = uuid::Uuid::new_v4().to_string();
        c.execute(
            "INSERT INTO keychain(id, label, username, auth_method, password, private_key, passphrase, updated_at)
             VALUES(?1, ?2, NULL, 'key', NULL, ?3, ?4, ?5)",
            params![id, final_label, content, passphrase, now()],
        )?;
        Ok(id)
    })
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
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
    let cmt = comment.unwrap_or_else(|| "nexus-generated-key".into());

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

#[tauri::command]
pub async fn keychain_generate_key(
    algorithm: String,
    bits: Option<u32>,
    comment: Option<String>,
    passphrase: Option<String>,
) -> AppResult<GeneratedKeyPair> {
    tauri::async_runtime::spawn_blocking(move || {
        keychain_generate_key_sync(algorithm, bits, comment, passphrase)
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
    let trimmed = content.trim();
    if trimmed.is_empty() {
        return Err(AppError::Other("Empty clipboard content".into()));
    }
    if looks_sensitive_text(trimmed) {
        return Err(AppError::Other("Not recorded: clipboard content appears to contain sensitive information or credentials.".into()));
    }
    let char_count = content.chars().count();
    let line_count = content.lines().count().max(1);

    vault.with(|c| {
        let existing_id: Option<String> = c
            .query_row("SELECT id FROM clipboard_history WHERE content=?1", [&content], |r| r.get(0))
            .optional()?;

        if let Some(eid) = existing_id {
            c.execute(
                "UPDATE clipboard_history SET copied_at=?1, source=?2 WHERE id=?3",
                params![now(), source, eid],
            )?;
            return Ok(ClipboardItem {
                id: eid,
                content,
                char_count,
                line_count,
                source,
                copied_at: now(),
                pinned: false,
            });
        }

        let item = ClipboardItem {
            id: uuid::Uuid::new_v4().to_string(),
            content: content.clone(),
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

#[tauri::command]
pub fn host_trust_key(host: String, port: u16, fingerprint: String, vault: State<'_, Vault>) -> AppResult<()> {
    vault.with(|c| {
        c.execute(
            "INSERT OR REPLACE INTO known_hosts(host, port, fingerprint, added_at) VALUES(?1, ?2, ?3, ?4)",
            params![host, port, fingerprint, now()],
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
        let _ = c.execute("DELETE FROM sync_log WHERE record_id=?1", [&tunnel.id]);
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
        let _ = c.execute("DELETE FROM sync_log WHERE record_id=?1", [&snippet.id]);
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
        let _ = c.execute("DELETE FROM sync_log WHERE record_id=?1", [&record.id]);
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

// ── Zero-Knowledge Team Sharing (Encrypted .nxvault Bundles) ──

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
                "SELECT h.id, h.label, h.hostname, h.port, h.username, h.auth_method, h.grp, h.tags, h.color, h.os, h.keychain_id, h.jump_host_id, h.vault_id, h.startup_command,
                        (s.host_id IS NOT NULL OR h.keychain_id IS NOT NULL)
                 FROM hosts h LEFT JOIN secrets s ON s.host_id=h.id
                 WHERE h.vault_id = ?1",
            )?;
            let hosts = st_hosts.query_map([&vault_id], |r| {
                let mut h = row_to_host(r)?;
                h.has_secret = r.get(14)?;
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
            format: "nexus-team-vault".into(),
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
            c.execute(
                "INSERT INTO vaults(id, name, kind, color, description, created_at)
                 VALUES(?1, ?2, 'team', ?3, ?4, ?5)
                 ON CONFLICT(id) DO UPDATE SET name=?2, color=?3, description=?4",
                params![payload.vault.id, payload.vault.name, payload.vault.color, payload.vault.description, payload.vault.created_at],
            )?;

            let mut host_id_map: HashMap<String, String> = HashMap::new();

            for h in &payload.hosts {
                // Check if this host id already exists in a different vault or has an attached secret
                let is_collision = c.query_row(
                    "SELECT vault_id FROM hosts WHERE id = ?1",
                    [&h.id],
                    |r| r.get::<_, String>(0),
                ).optional()?;

                let has_secret: bool = c.query_row(
                    "SELECT 1 FROM secrets WHERE host_id = ?1",
                    [&h.id],
                    |_| Ok(true),
                ).optional()?.unwrap_or(false);

                let host_id = if has_secret || (is_collision.is_some() && is_collision.as_deref() != Some(&payload.vault.id)) {
                    let new_id = uuid::Uuid::new_v4().to_string();
                    host_id_map.insert(h.id.clone(), new_id.clone());
                    new_id
                } else {
                    h.id.clone()
                };

                // Imported hosts should only bind to keychains that exist within this team vault
                let safe_keychain_id = if let Some(ref kid) = h.keychain_id {
                    let exists: bool = c.query_row(
                        "SELECT 1 FROM keychain WHERE id = ?1 AND vault_id = ?2",
                        params![kid, payload.vault.id],
                        |_| Ok(true),
                    ).optional()?.unwrap_or(false);
                    if exists { Some(kid.clone()) } else { None }
                } else {
                    None
                };

                let jump_id = h.jump_host_id.as_ref().map(|jid| {
                    host_id_map.get(jid).cloned().unwrap_or_else(|| jid.clone())
                });

                c.execute(
                    "INSERT INTO hosts(id, label, hostname, port, username, auth_method, grp, tags, color, os, keychain_id, jump_host_id, vault_id, startup_command, updated_at)
                     VALUES(?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15)
                     ON CONFLICT(id) DO UPDATE SET label=?2, hostname=?3, port=?4, username=?5, auth_method=?6,
                         grp=?7, tags=?8, color=?9, os=?10, keychain_id=?11, jump_host_id=?12, vault_id=?13, updated_at=?15",
                    params![
                        host_id, h.label, h.hostname, h.port, h.username, h.auth_method.as_str(),
                        h.group, serde_json::to_string(&h.tags).unwrap_or_else(|_| "[]".into()),
                        h.color, h.os, safe_keychain_id, jump_id, payload.vault.id,
                        // M1: startup commands are never imported from a bundle. Auto-run on connect is code execution.
                        Option::<String>::None,
                        now()
                    ],
                )?;
            }

            for s in &payload.snippets {
                let snip_collision = c.query_row(
                    "SELECT vault_id FROM snippets WHERE id = ?1",
                    [&s.id],
                    |r| r.get::<_, String>(0),
                ).optional()?;
                let snip_id = if snip_collision.is_some() && snip_collision.as_deref() != Some(&payload.vault.id) {
                    uuid::Uuid::new_v4().to_string()
                } else {
                    s.id.clone()
                };

                c.execute(
                    "INSERT OR REPLACE INTO snippets(id, name, command, folder, tags, vault_id, updated_at)
                     VALUES(?1, ?2, ?3, ?4, ?5, ?6, ?7)",
                    params![snip_id, s.name, s.command, s.folder, serde_json::to_string(&s.tags).unwrap_or_else(|_| "[]".into()), payload.vault.id, now()],
                )?;
            }

            for t in &payload.tunnels {
                let tun_collision = c.query_row(
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

                c.execute(
                    "INSERT INTO tunnels(id, label, host_id, forward_type, local_host, local_port, remote_host, remote_port, vault_id, updated_at)
                     VALUES(?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)
                     ON CONFLICT(id) DO UPDATE SET label=?2, host_id=?3, forward_type=?4, local_host=?5, local_port=?6,
                         remote_host=?7, remote_port=?8, vault_id=?9, updated_at=?10",
                    params![
                        tun_id, t.label, mapped_host_id, t.forward_type, t.local_host, t.local_port,
                        t.remote_host, t.remote_port, payload.vault.id, now()
                    ],
                )?;
            }

            // `payload.ai_configs` is intentionally ignored: older bundles may carry someone else's
            // API keys, and importing must never overwrite this user's own AI settings.

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
