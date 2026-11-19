//! Local-first encrypted vault — SQLCipher (AES-256, per-page HMAC-SHA512).
//!
//! Stores host profiles, secrets, reusable keychain identities,
//! connection logs, tunnels, snippets, and session snapshots.
//!
//! Organized into focused domain submodules under `src-tauri/src/vault/`:
//! - [`types`]: DTOs, enums, and serializable structures
//! - [`crypto`]: Argon2id KDF, emergency recovery envelope, rekey intent journal, core lifecycle commands
//! - [`keystore`]: OS Keychain, Android hardware Keystore JNI bridge, and device screen-lock credentials
//! - [`hosts`]: Host profile CRUD, Termux LAN translation, self-healing repair, and HLC sync logging
//! - [`keychain`]: Reusable identities, `~/.ssh` key detection/import, and `ssh-keygen` integration
//! - [`history`]: Connection logs, command & clipboard history, TOFU host-key pinning, tunnels, snippets, vaults
//! - [`team`]: Zero-knowledge `.drxvault` team export/import and AI provider configuration/key pools

pub mod crypto;
pub mod history;
pub mod hosts;
pub mod keychain;
pub mod keystore;
pub mod team;
pub mod types;

pub use crypto::*;
pub use history::*;
pub use hosts::*;
pub use keychain::*;
pub use keystore::*;
pub use team::*;
pub use types::*;

use crate::error::{AppError, AppResult};
use crate::snapshot::Snapshot;
use parking_lot::Mutex;
use rusqlite::{params, Connection, OptionalExtension};
use std::path::PathBuf;
use zeroize::Zeroizing;

pub(self) struct Unlocked {
    pub(self) conn: Connection,
    pub(self) root_key: Zeroizing<[u8; 32]>,
}

pub struct Vault {
    pub(self) path: PathBuf,
    pub(self) inner: Mutex<Option<Unlocked>>,
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
    cwd TEXT, executed_at INTEGER NOT NULL, starred INTEGER NOT NULL DEFAULT 0,
    run_count INTEGER NOT NULL DEFAULT 1
);
CREATE TABLE IF NOT EXISTS clipboard_history (
    id TEXT PRIMARY KEY, content TEXT NOT NULL, char_count INTEGER NOT NULL,
    line_count INTEGER NOT NULL, source TEXT, copied_at INTEGER NOT NULL, pinned INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS vault_metadata (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
);
"#;

pub(self) fn now() -> i64 {
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

impl Vault {
    pub fn new(path: PathBuf) -> Self {
        Self { path, inner: Mutex::new(None) }
    }

    pub(self) fn salt_path(&self) -> PathBuf {
        self.path.with_extension("salt")
    }

    pub fn recovery_path(&self) -> PathBuf {
        self.path.with_extension("recovery")
    }

    pub(self) fn unlock_with_key(&self, key: Zeroizing<[u8; 32]>) -> AppResult<()> {
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
        // v6: command_history gains run_count frequency tracking, deduplication, and lookup indexes
        let user_version: i64 = conn.query_row("PRAGMA user_version", [], |r| r.get(0)).unwrap_or(5);
        if user_version < 6 {
            let tx = conn.unchecked_transaction()?;
            add_column_if_missing(&tx, "command_history", "run_count", "INTEGER NOT NULL DEFAULT 1")?;
            // Collapse legacy duplicate (host_id, command) rows into the most recent entry,
            // preserving starred state and summing prior executions into run_count.
            tx.execute_batch(
                "CREATE TEMP TABLE _ch_agg AS
                 SELECT
                   COALESCE(host_id, '') AS host_key,
                   command,
                   MAX(executed_at) AS max_ts,
                   MAX(starred) AS any_starred,
                   SUM(CASE WHEN run_count > 0 THEN run_count ELSE 1 END) AS total_runs
                 FROM command_history
                 GROUP BY COALESCE(host_id, ''), command;
                 CREATE TEMP TABLE _ch_keep AS
                 SELECT a.host_key, a.command, a.any_starred, a.total_runs,
                   (SELECT ch.id FROM command_history ch
                    WHERE COALESCE(ch.host_id, '') = a.host_key AND ch.command = a.command
                    ORDER BY ch.executed_at DESC, ch.rowid DESC LIMIT 1) AS keep_id
                 FROM _ch_agg a;
                 UPDATE command_history
                 SET starred = (SELECT k.any_starred FROM _ch_keep k WHERE k.keep_id = command_history.id),
                     run_count = (SELECT k.total_runs FROM _ch_keep k WHERE k.keep_id = command_history.id)
                 WHERE id IN (SELECT keep_id FROM _ch_keep);
                 DELETE FROM command_history WHERE id NOT IN (SELECT keep_id FROM _ch_keep);
                 DROP TABLE _ch_keep;
                 DROP TABLE _ch_agg;
                 CREATE INDEX IF NOT EXISTS idx_command_history_host_cmd ON command_history (COALESCE(host_id, ''), command);
                 CREATE INDEX IF NOT EXISTS idx_command_history_executed_at ON command_history (executed_at DESC);"
            )?;
            tx.pragma_update(None, "user_version", 6)?;
            tx.commit()?;
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
            let changed = c.execute(
                "UPDATE hosts SET os=?1, updated_at=?2 WHERE id=?3 AND COALESCE(os, '') != ?1",
                params![os, now(), id],
            )?;
            if changed > 0 {
                let _ = log_sync_mutation(c, "hosts", id);
            }
            Ok(())
        })
    }

    pub fn host_with_secret(&self, id: &str) -> AppResult<(HostProfile, HostSecret)> {
        self.with(|c| {
            let _ = hosts::repair_corrupted_local_hosts(c);
            let android_ip = hosts::latest_paired_android_ip(c);
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
                        let mut profile = hosts::row_to_host(r)?;
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
                            let pw: Option<String> = r.get(15)?;
                            let pk: Option<String> = r.get(16)?;
                            let pass: Option<String> = r.get(17)?;
                            let has_pk = pk.as_deref().map(|s| !s.trim().is_empty()).unwrap_or(false);
                            let has_pw = pw.as_deref().map(|s| !s.trim().is_empty()).unwrap_or(false);
                            let resolved_auth = if has_pk && !has_pw {
                                AuthMethod::Key
                            } else if has_pw && !has_pk {
                                AuthMethod::Password
                            } else {
                                profile.auth_method
                            };
                            (
                                resolved_auth,
                                pw,
                                pk,
                                pass,
                                profile.username.clone(),
                            )
                        };

                        profile.auth_method = auth_method;
                        profile.username = username;
                        hosts::translate_termux_for_platform(&mut profile, android_ip.as_deref());

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

#[cfg(test)]
mod tests {
    use super::crypto::{generate_recovery_code, normalize_recovery_code};
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

    #[test]
    fn test_known_host_encrypted_db_roundtrip() {
        let unique = format!("test_known_host_{}.vault", rand::random::<u64>());
        let db_path = std::env::temp_dir().join(unique);
        let vault = Vault::new(db_path.clone());

        // 1. Initialize and unlock the encrypted SQLCipher vault
        vault.unlock("test-master-password-1234").expect("unlock vault");

        let host = "server.example.internal";
        let port = 2222;
        let fingerprint = "SHA256:7u1g0D1eP8wQz3V8/xK4m2N5p9T7r1S3v5X7z9B0=";

        // 2. Initial query should be None
        assert_eq!(vault.known_host(host, port).expect("query empty"), None);

        // 3. Record host key directly into encrypted DB
        vault.with(|c| {
            c.execute(
                "INSERT INTO known_hosts(host, port, fingerprint, added_at) VALUES(?1, ?2, ?3, ?4)",
                params![host, port, fingerprint, now()],
            )?;
            Ok(())
        }).expect("insert known host");

        // 4. Read back and verify exact fingerprint match
        let retrieved = vault.known_host(host, port).expect("query known host");
        assert_eq!(retrieved, Some(fingerprint.to_string()));

        // 5. Cleanup
        let _ = std::fs::remove_file(&db_path);
        let _ = std::fs::remove_file(vault.salt_path());
        let _ = std::fs::remove_file(db_path.with_extension("vault-wal"));
        let _ = std::fs::remove_file(db_path.with_extension("vault-shm"));
    }

    #[test]
    fn test_locked_vault_verify_password_and_recovery_metadata() {
        let unique = format!("test_verify_{}.vault", rand::random::<u64>());
        let db_path = std::env::temp_dir().join(unique);
        let vault = Vault::new(db_path.clone());
        let pw = "correct-master-password-1234";

        // Unlock creates the vault and generates initial recovery key in vault_metadata
        let rec = vault.unlock(pw).expect("initial unlock").expect("recovery code generated");
        assert!(rec.starts_with("DRX-"));

        // When unlocked, get_recovery_key returns the saved recovery code
        let fetched = vault.get_recovery_key().expect("fetch recovery key");
        assert_eq!(fetched, Some(rec.clone()));

        // Verification while unlocked
        assert!(vault.verify_password(pw).expect("verify unlocked correct"));
        assert!(!vault.verify_password("wrong-pw-1234").expect("verify unlocked wrong"));

        // Lock the vault
        vault.lock();
        assert!(!vault.is_unlocked());

        // Verification while LOCKED (uses raw hex key PRAGMA)
        assert!(vault.verify_password(pw).expect("verify locked correct"));
        assert!(!vault.verify_password("wrong-pw-1234").expect("verify locked wrong"));

        // Cleanup
        let _ = std::fs::remove_file(&db_path);
        let _ = std::fs::remove_file(vault.salt_path());
        let _ = std::fs::remove_file(vault.recovery_path());
        let _ = std::fs::remove_file(db_path.with_extension("vault-wal"));
        let _ = std::fs::remove_file(db_path.with_extension("vault-shm"));
    }

    #[test]
    fn test_vault_save_emergency_kit_rejects_traversal() {
        let bad_names = [
            "../escaped.txt",
            "../../.bashrc",
            "/etc/shadow",
            "subdir/file.txt",
            "..",
            ".",
            "foo\\bar.txt",
        ];
        for bad in bad_names {
            assert!(
                vault_save_emergency_kit("secret".to_string(), Some(bad.to_string())).is_err(),
                "expected rejection for filename: {bad}"
            );
        }
    }

    #[test]
    #[cfg(unix)]
    fn test_vault_save_emergency_kit_permissions_mode_0600() {
        use std::os::unix::fs::PermissionsExt;
        let fname = format!("test-kit-{}.txt", uuid::Uuid::new_v4());
        if let Ok(saved_path) = vault_save_emergency_kit("secret recovery key".to_string(), Some(fname)) {
            let meta = std::fs::metadata(&saved_path).expect("read metadata");
            let mode = meta.permissions().mode() & 0o777;
            let _ = std::fs::remove_file(&saved_path);
            assert_eq!(mode, 0o600, "emergency kit file must be mode 0600, got: {mode:o}");
        }
    }
}
