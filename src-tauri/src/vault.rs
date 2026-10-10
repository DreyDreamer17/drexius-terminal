//! Local-first encrypted vault — SQLCipher (AES-256, per-page HMAC-SHA512).
//!
//! Stores host profiles, secrets, reusable keychain identities,
//! connection logs, tunnels, snippets, and session snapshots.

use crate::error::{AppError, AppResult};
use crate::snapshot::Snapshot;
use argon2::{Algorithm, Argon2, Params, Version};
use parking_lot::Mutex;
use rand::RngCore;
use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use std::path::PathBuf;
use zeroize::{Zeroize, ZeroizeOnDrop, Zeroizing};

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
}

/// Credentials — never serialized back to the frontend. Wiped on drop.
#[derive(Default, Deserialize, Zeroize, ZeroizeOnDrop)]
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
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Snippet {
    pub id: String,
    pub name: String,
    pub command: String,
    pub folder: Option<String>,
    pub tags: Vec<String>,
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
    color TEXT, os TEXT, keychain_id TEXT, updated_at INTEGER NOT NULL
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
CREATE TABLE IF NOT EXISTS sync_log (
    record_id TEXT PRIMARY KEY, tbl TEXT NOT NULL, hlc TEXT NOT NULL, deleted INTEGER NOT NULL DEFAULT 0
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

    fn derive_key(password: &str, salt: &[u8]) -> AppResult<Zeroizing<[u8; 32]>> {
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
            _ => {
                let mut s = vec![0u8; 16];
                rand::thread_rng().fill_bytes(&mut s);
                std::fs::write(self.salt_path(), &s)?;
                s
            }
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
        // Migrations
        let _ = conn.execute("ALTER TABLE hosts ADD COLUMN os TEXT", []);
        let _ = conn.execute("ALTER TABLE hosts ADD COLUMN keychain_id TEXT", []);
        // Auto-detect and import keys from existing hosts into keychain (idempotent, only imports unlinked)
        let _ = import_hosts_keys_internal(&conn);
        *self.inner.lock() = Some(Unlocked { conn, root_key: key });
        Ok(())
    }

    pub fn lock(&self) {
        *self.inner.lock() = None;
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
                    "SELECT h.id, h.label, h.hostname, h.port, h.username, h.auth_method, h.grp, h.tags, h.color, h.os, h.keychain_id,
                            s.password, s.private_key, s.passphrase,
                            k.auth_method, k.password, k.private_key, k.passphrase, k.username
                     FROM hosts h
                     LEFT JOIN secrets s ON s.host_id=h.id
                     LEFT JOIN keychain k ON k.id=h.keychain_id
                     WHERE h.id=?1",
                    [id],
                    |r| {
                        let mut profile = row_to_host(r)?;
                        let k_auth: Option<String> = r.get(14)?;
                        let (auth_method, password, private_key, passphrase, username) = if let Some(ka) = k_auth {
                            // Sourced from Keychain
                            let k_user: Option<String> = r.get(18)?;
                            (
                                AuthMethod::parse(&ka),
                                r.get(15)?,
                                r.get(16)?,
                                r.get(17)?,
                                k_user.unwrap_or(profile.username.clone()),
                            )
                        } else {
                            // Sourced from Host Secret
                            (
                                profile.auth_method,
                                r.get(11)?,
                                r.get(12)?,
                                r.get(13)?,
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
                "SELECT id, label, host_id, forward_type, local_host, local_port, remote_host, remote_port, updated_at
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
        has_secret: false,
    })
}

// ─────────────────────────── Commands ───────────────────────────

use tauri::State;

#[tauri::command]
pub fn vault_status(vault: State<'_, Vault>) -> VaultStatus {
    VaultStatus { initialized: vault.path.exists(), unlocked: vault.inner.lock().is_some() }
}

#[tauri::command(async)]
pub fn vault_unlock(master_password: String, vault: State<'_, Vault>) -> AppResult<()> {
    let pw = Zeroizing::new(master_password);
    vault.unlock(&pw)
}

#[tauri::command]
pub fn vault_lock(vault: State<'_, Vault>) {
    vault.lock()
}

// ── Hosts ──

#[tauri::command]
pub fn hosts_list(vault: State<'_, Vault>) -> AppResult<Vec<HostProfile>> {
    vault.with(|c| {
        let mut st = c.prepare(
            "SELECT h.id, h.label, h.hostname, h.port, h.username, h.auth_method, h.grp, h.tags, h.color, h.os, h.keychain_id,
                    (s.host_id IS NOT NULL OR h.keychain_id IS NOT NULL) FROM hosts h LEFT JOIN secrets s ON s.host_id=h.id ORDER BY h.grp, h.label",
        )?;
        let rows = st.query_map([], |r| {
            let mut h = row_to_host(r)?;
            h.has_secret = r.get(11)?;
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
            "INSERT INTO hosts(id, label, hostname, port, username, auth_method, grp, tags, color, os, keychain_id, updated_at)
             VALUES(?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12)
             ON CONFLICT(id) DO UPDATE SET label=?2, hostname=?3, port=?4, username=?5, auth_method=?6,
                 grp=?7, tags=?8, color=?9, os=?10, keychain_id=?11, updated_at=?12",
            params![
                profile.id, profile.label, profile.hostname, profile.port, profile.username,
                profile.auth_method.as_str(), profile.group,
                serde_json::to_string(&profile.tags).unwrap_or_else(|_| "[]".into()),
                profile.color, profile.os, profile.keychain_id, now()
            ],
        )?;
        if let Some(s) = &secret {
            c.execute(
                "INSERT INTO secrets(host_id, password, private_key, passphrase) VALUES(?1, ?2, ?3, ?4)
                 ON CONFLICT(host_id) DO UPDATE SET password=?2, private_key=?3, passphrase=?4",
                params![profile.id, s.password, s.private_key, s.passphrase],
            )?;
        }
        Ok(profile.id.clone())
    })
}

#[tauri::command]
pub fn host_delete(id: String, vault: State<'_, Vault>) -> AppResult<()> {
    vault.with(|c| {
        c.execute("DELETE FROM hosts WHERE id=?1", [id])?;
        Ok(())
    })
}

// ── Keychain / Reusable Identities ──

#[tauri::command]
pub fn keychain_list(vault: State<'_, Vault>) -> AppResult<Vec<KeychainItem>> {
    vault.with(|c| {
        let mut st = c.prepare(
            "SELECT id, label, username, auth_method, (password IS NOT NULL OR private_key IS NOT NULL), updated_at
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
            "INSERT INTO keychain(id, label, username, auth_method, password, private_key, passphrase, updated_at)
             VALUES(?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)
             ON CONFLICT(id) DO UPDATE SET label=?2, username=?3, auth_method=?4,
                 password=COALESCE(?5, password), private_key=COALESCE(?6, private_key), passphrase=COALESCE(?7, passphrase), updated_at=?8",
            params![
                id, input.label, input.username, input.auth_method.as_str(),
                input.password, input.private_key, input.passphrase, now()
            ],
        )?;
        Ok(id)
    })
}

#[tauri::command]
pub fn keychain_delete(id: String, vault: State<'_, Vault>) -> AppResult<()> {
    vault.with(|c| {
        c.execute("DELETE FROM keychain WHERE id=?1", [&id])?;
        c.execute("UPDATE hosts SET keychain_id=NULL WHERE keychain_id=?1", [&id])?;
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

// ── Connection Logs ──

#[tauri::command]
pub fn logs_list(vault: State<'_, Vault>) -> AppResult<Vec<ConnectionLog>> {
    vault.with(|c| {
        let mut st = c.prepare(
            "SELECT id, host_id, host_label, username, hostname, started_at, ended_at, duration, status, saved
             FROM connection_logs ORDER BY started_at DESC LIMIT 100",
        )?;
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
            "SELECT id, label, host_id, forward_type, local_host, local_port, remote_host, remote_port, updated_at
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
            })
        })?;
        Ok(rows.collect::<Result<Vec<_>, _>>()?)
    })
}

#[tauri::command]
pub fn tunnel_save(mut tunnel: TunnelConfig, vault: State<'_, Vault>) -> AppResult<String> {
    if tunnel.id.is_empty() {
        tunnel.id = uuid::Uuid::new_v4().to_string();
    }
    vault.with(|c| {
        c.execute(
            "INSERT INTO tunnels(id, label, host_id, forward_type, local_host, local_port, remote_host, remote_port, updated_at)
             VALUES(?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)
             ON CONFLICT(id) DO UPDATE SET label=?2, host_id=?3, forward_type=?4, local_host=?5, local_port=?6,
                 remote_host=?7, remote_port=?8, updated_at=?9",
            params![
                tunnel.id, tunnel.label, tunnel.host_id, tunnel.forward_type,
                tunnel.local_host, tunnel.local_port, tunnel.remote_host, tunnel.remote_port, now()
            ],
        )?;
        Ok(tunnel.id.clone())
    })
}

#[tauri::command]
pub fn tunnel_delete(id: String, vault: State<'_, Vault>) -> AppResult<()> {
    vault.with(|c| {
        c.execute("DELETE FROM tunnels WHERE id=?1", [id])?;
        Ok(())
    })
}

// ── Snippets ──

#[tauri::command]
pub fn snippets_list(vault: State<'_, Vault>) -> AppResult<Vec<Snippet>> {
    vault.with(|c| {
        let mut st = c.prepare("SELECT id, name, command, folder, tags FROM snippets ORDER BY folder, name")?;
        let rows = st.query_map([], |r| {
            let tags: String = r.get(4)?;
            Ok(Snippet {
                id: r.get(0)?,
                name: r.get(1)?,
                command: r.get(2)?,
                folder: r.get(3)?,
                tags: serde_json::from_str(&tags).unwrap_or_default(),
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
            "INSERT OR REPLACE INTO snippets(id, name, command, folder, tags, updated_at) VALUES(?1, ?2, ?3, ?4, ?5, ?6)",
            params![
                snippet.id, snippet.name, snippet.command, snippet.folder,
                serde_json::to_string(&snippet.tags).unwrap_or_else(|_| "[]".into()), now()
            ],
        )?;
        Ok(snippet.id.clone())
    })
}

#[tauri::command]
pub fn snippet_delete(id: String, vault: State<'_, Vault>) -> AppResult<()> {
    vault.with(|c| {
        c.execute("DELETE FROM snippets WHERE id=?1", [id])?;
        Ok(())
    })
}
