//! Keychain reusable identities, local `~/.ssh` key detection/import, and SSH keypair generation.

use super::{
    ensure_vault_writable, log_sync_deletion, log_sync_mutation, now, AuthMethod, KeychainInput,
    KeychainItem, Vault,
};
use crate::error::{AppError, AppResult};
use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use tauri::{Manager, State};
use zeroize::{Zeroize, ZeroizeOnDrop};

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
    vault.with(|c| {
        ensure_vault_writable(c, input.vault_id.as_deref())?;
        if !input.id.is_empty() {
            if let Some(vid) = c
                .query_row("SELECT vault_id FROM keychain WHERE id=?1", [&input.id], |r| r.get::<_, Option<String>>(0))
                .optional()?
                .flatten()
            {
                ensure_vault_writable(c, Some(&vid))?;
            }
        }
        Ok(upsert_keychain_identity(c, &input)?)
    })
}

#[tauri::command]
pub fn keychain_delete(id: String, vault: State<'_, Vault>) -> AppResult<()> {
    vault.with(|c| {
        if let Some(vid) = c
            .query_row("SELECT vault_id FROM keychain WHERE id=?1", [&id], |r| r.get::<_, Option<String>>(0))
            .optional()?
            .flatten()
        {
            ensure_vault_writable(c, Some(&vid))?;
        }
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
    vault.with(import_hosts_keys_internal)
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
                let parts: Vec<&str> = pub_content.split_whitespace().collect();
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
                    let parts: Vec<&str> = p.split_whitespace().collect();
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
