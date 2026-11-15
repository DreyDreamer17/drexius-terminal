//! Vault KDF (Argon2id), emergency recovery envelope, crash-safe rekey journal,
//! and core vault lifecycle Tauri commands.

use super::{Vault, VaultStatus};
use crate::error::{AppError, AppResult};
use argon2::{Algorithm, Argon2, Params, Version};
use base64::{engine::general_purpose::STANDARD as B64, Engine};
use chacha20poly1305::{
    aead::{Aead, KeyInit},
    XChaCha20Poly1305, XNonce,
};
use rand::RngCore;
use rusqlite::{params, OptionalExtension};
use serde::{Deserialize, Serialize};
use std::path::PathBuf;
use tauri::{Manager, State};
use zeroize::Zeroizing;

/// Minimum length accepted when *unlocking* an existing vault.
///
/// This is deliberately permissive: it must stay low enough that a vault
/// created by an older build (which only required four characters) can never
/// be locked out of by an upgrade. It is a sanity floor, not a security
/// control.
pub(super) const MIN_UNLOCK_PASSWORD_CHARS: usize = 4;

/// Minimum length accepted when *choosing* a new master password — that is,
/// when creating a brand-new vault or when setting a new password through
/// recovery/rekey.
///
/// The lock screen already enforces this for new vaults ("Use at least 8
/// characters (12+ recommended)"); mirroring it here means the rule cannot
/// be bypassed by calling the IPC command directly. Argon2id makes each
/// guess expensive, but it does nothing for a four-character password.
pub(super) const MIN_NEW_PASSWORD_CHARS: usize = 8;

#[derive(Serialize, Deserialize)]
pub(super) struct RecoveryEnvelope {
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
pub(super) struct RekeyJournal {
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
pub(super) fn write_atomic(path: &std::path::Path, bytes: &[u8]) -> AppResult<()> {
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

pub(super) fn normalize_recovery_code(code: &str) -> String {
    let clean = code.trim().replace(['-', ' '], "").to_uppercase();
    if let Some(stripped) = clean.strip_prefix("DRX").or_else(|| clean.strip_prefix("NX")) {
        stripped.to_string()
    } else {
        clean
    }
}

pub(super) fn generate_recovery_code() -> (String, String) {
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
    /// Transient rekey-intent journal (see `RekeyJournal`).
    pub(super) fn rekey_journal_path(&self) -> PathBuf {
        self.path.with_extension("rekey")
    }

    /// Pre-rekey database snapshot taken before `PRAGMA rekey`, kept until the
    /// rekey is finalized. Restores the pre-rekey state if the DB itself is
    /// damaged mid-rekey.
    pub(super) fn pre_rekey_backup_path(&self) -> PathBuf {
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
                        if let Some(ref u) = *self.inner.lock() {
                            let _ = u.conn.execute(
                                "INSERT INTO vault_metadata(key, value) VALUES('recovery_code', ?1)
                                 ON CONFLICT(key) DO UPDATE SET value = excluded.value",
                                params![&code],
                            );
                        }
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
                    if let Some(ref u) = *self.inner.lock() {
                        let _ = u.conn.execute(
                            "INSERT INTO vault_metadata(key, value) VALUES('recovery_code', ?1)
                             ON CONFLICT(key) DO UPDATE SET value = excluded.value",
                            params![&code],
                        );
                    }
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
                if let Some(ref u) = *self.inner.lock() {
                    let _ = u.conn.execute(
                        "INSERT INTO vault_metadata(key, value) VALUES('recovery_code', ?1)
                         ON CONFLICT(key) DO UPDATE SET value = excluded.value",
                        params![&code],
                    );
                }
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

    /// Constant-time verification of the master password without altering the vault's active state.
    pub fn verify_password(&self, master_password: &str) -> AppResult<bool> {
        if !self.path.exists() {
            return Ok(false);
        }
        let salt = match std::fs::read(self.salt_path()) {
            Ok(s) if s.len() == 16 => s,
            _ => return Ok(false),
        };
        let key = match Self::derive_key(master_password, &salt) {
            Ok(k) => k,
            Err(_) => return Ok(false),
        };

        // If vault is currently unlocked in memory, compare the derived key with the root key in constant time
        if let Some(unlocked) = self.inner.lock().as_ref() {
            use subtle::ConstantTimeEq;
            return Ok(key.as_slice().ct_eq(unlocked.root_key.as_slice()).into());
        }

        // Vault is locked; test if the derived key unlocks the SQLCipher database
        let conn = match rusqlite::Connection::open(&self.path) {
            Ok(c) => c,
            Err(_) => return Ok(false),
        };
        let key_hex = Zeroizing::new(hex::encode(&key));
        if conn.execute_batch(&format!(
            "PRAGMA key = \"x'{}'\"; PRAGMA cipher_page_size = 4096; PRAGMA cipher_memory_security = ON;",
            key_hex.as_str()
        )).is_err() {
            return Ok(false);
        }
        let valid = conn.query_row("SELECT count(*) FROM sqlite_master", [], |r| r.get::<_, i64>(0)).is_ok();
        Ok(valid)
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
                    let _ = u.conn.execute(
                        "INSERT INTO vault_metadata(key, value) VALUES('recovery_code', ?1)
                         ON CONFLICT(key) DO UPDATE SET value = excluded.value",
                        params![&fresh_code],
                    );
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
            let _ = u.conn.execute(
                "INSERT INTO vault_metadata(key, value) VALUES('recovery_code', ?1)
                 ON CONFLICT(key) DO UPDATE SET value = excluded.value",
                params![&new_code],
            );
        }

        self.clear_saved_credentials();
        Ok(new_code)
    }

    pub fn regenerate_recovery_key(&self) -> AppResult<String> {
        let key = self.root_key()?;
        let (code, normalized) = generate_recovery_code();
        self.save_recovery_envelope(&key, &normalized)?;
        let g = self.inner.lock();
        let u = g.as_ref().ok_or(AppError::VaultLocked)?;
        u.conn.execute(
            "INSERT INTO vault_metadata(key, value) VALUES('recovery_code', ?1)
             ON CONFLICT(key) DO UPDATE SET value = excluded.value",
            params![&code],
        ).map_err(|e| AppError::Other(e.to_string()))?;
        Ok(code)
    }

    pub fn get_recovery_key(&self) -> AppResult<Option<String>> {
        let g = self.inner.lock();
        let u = g.as_ref().ok_or(AppError::VaultLocked)?;
        let code: Option<String> = u
            .conn
            .query_row(
                "SELECT value FROM vault_metadata WHERE key = 'recovery_code'",
                [],
                |r| r.get(0),
            )
            .optional()
            .map_err(|e| AppError::Other(e.to_string()))?;
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
}

// ─────────────────────────── Core Vault Commands ───────────────────────────

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
pub async fn vault_verify_password(password: String, app: tauri::AppHandle) -> AppResult<bool> {
    tauri::async_runtime::spawn_blocking(move || {
        let vault = app.state::<Vault>();
        vault.verify_password(&password)
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
pub fn vault_get_recovery_key(vault: State<'_, Vault>) -> AppResult<Option<String>> {
    vault.get_recovery_key()
}

#[tauri::command]
pub fn vault_regenerate_recovery_key(vault: State<'_, Vault>) -> AppResult<String> {
    vault.regenerate_recovery_key()
}

#[tauri::command]
pub fn vault_save_emergency_kit(content: String, filename: Option<String>) -> AppResult<String> {
    let fname = match filename {
        Some(f) => {
            let trimmed = f.trim();
            let p = std::path::Path::new(trimmed);
            let base = p
                .file_name()
                .and_then(|s| s.to_str())
                .filter(|s| {
                    !s.is_empty()
                        && *s == trimmed
                        && !s.contains('/')
                        && !s.contains('\\')
                        && *s != "."
                        && *s != ".."
                })
                .ok_or_else(|| {
                    AppError::Other(
                        "Invalid emergency kit filename: must be a plain filename without path components"
                            .to_string(),
                    )
                })?;
            base.to_string()
        }
        None => format!("drexius-emergency-kit-{}.txt", chrono::Utc::now().timestamp()),
    };

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
    crate::fs_guard::ensure_local_path_not_sensitive(&target.to_string_lossy())?;

    #[cfg(unix)]
    let write_with_mode = |p: &std::path::Path, data: &str| -> std::io::Result<()> {
        use std::io::Write;
        use std::os::unix::fs::OpenOptionsExt;
        let mut file = std::fs::OpenOptions::new()
            .write(true)
            .create(true)
            .truncate(true)
            .mode(0o600)
            .open(p)?;
        file.write_all(data.as_bytes())
    };

    #[cfg(not(unix))]
    let write_with_mode = |p: &std::path::Path, data: &str| -> std::io::Result<()> {
        std::fs::write(p, data)
    };

    if let Err(err) = write_with_mode(&target, &content) {
        #[cfg(target_os = "android")]
        {
            let fallback = std::path::PathBuf::from("/storage/emulated/0/Android/data/dev.drexius.terminal/files/Download");
            let _ = std::fs::create_dir_all(&fallback);
            let fallback_target = fallback.join(&fname);
            crate::fs_guard::ensure_local_path_not_sensitive(&fallback_target.to_string_lossy())?;
            if write_with_mode(&fallback_target, &content).is_ok() {
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
