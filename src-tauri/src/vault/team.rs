//! Zero-Knowledge Team Vault `.drxvault` export/import and AI Provider Config & Secret Pool commands.

use super::{
    get_vault_relay_url, hosts::row_to_host, log_sync_mutation, now, AiProviderConfig, AuthMethod,
    EncryptedTeamVaultBundle, KeychainItem, SharedSecret, Snippet, TeamRelayBundleConfig,
    TeamVaultPayload, TunnelConfig, Vault, VaultRecord,
};
use crate::error::{AppError, AppResult};
use base64::{engine::general_purpose::STANDARD as B64, Engine};
use chacha20poly1305::{
    aead::{Aead, KeyInit},
    XChaCha20Poly1305, XNonce,
};
use rand::RngCore;
use rusqlite::{params, Connection, OptionalExtension};
use std::collections::HashMap;
use tauri::Manager;

// ── Zero-Knowledge Team Sharing (Encrypted .drxvault Bundles) ──

#[tauri::command]
pub async fn team_vault_export(
    vault_id: String,
    passphrase: String,
    include_secrets: Option<bool>,
    role: Option<String>,
    app: tauri::AppHandle,
) -> AppResult<EncryptedTeamVaultBundle> {
    if passphrase.trim().is_empty() {
        return Err(AppError::Other("Passphrase cannot be empty".into()));
    }
    let with_secrets = include_secrets.unwrap_or(true);
    let member_role = match role.as_deref() {
        Some("readonly") => "readonly".to_string(),
        _ => "editor".to_string(),
    };

    tauri::async_runtime::spawn_blocking(move || {
        let vault = app.state::<Vault>();
        let payload = vault.with(|c| {
            let mut v_record: VaultRecord = c.query_row(
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
                        role: Some(member_role.clone()),
                        relay_url: get_vault_relay_url(c, &vault_id),
                    })
                },
            ).unwrap_or_else(|_| VaultRecord {
                id: vault_id.clone(),
                name: "Team Vault".into(),
                kind: "team".into(),
                color: Some("#10b981".into()),
                description: Some("Shared Team Vault".into()),
                created_at: now(),
                role: Some(member_role.clone()),
                relay_url: get_vault_relay_url(c, &vault_id),
            });

            if v_record.id == "personal" {
                v_record.id = "shared-personal-vault".into();
                if v_record.name == "Personal Vault" {
                    v_record.name = "Shared Vault".into();
                }
                v_record.kind = "team".into();
            }

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

            let mut host_secrets: HashMap<String, SharedSecret> = HashMap::new();
            if with_secrets {
                let mut st_sec = c.prepare(
                    "SELECT s.host_id, s.password, s.private_key, s.passphrase
                     FROM secrets s
                     JOIN hosts h ON h.id = s.host_id
                     WHERE h.vault_id = ?1",
                )?;
                let sec_rows = st_sec.query_map([&vault_id], |r| {
                    Ok((
                        r.get::<_, String>(0)?,
                        SharedSecret {
                            password: r.get(1)?,
                            private_key: r.get(2)?,
                            passphrase: r.get(3)?,
                        },
                    ))
                })?;
                for row in sec_rows.flatten() {
                    if row.1.password.is_some() || row.1.private_key.is_some() || row.1.passphrase.is_some() {
                        host_secrets.insert(row.0, row.1);
                    }
                }
            }

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

            let mut st_kc = c.prepare(
                "SELECT id, label, username, auth_method, (password IS NOT NULL OR private_key IS NOT NULL), updated_at, vault_id,
                        password, private_key, passphrase
                 FROM keychain
                 WHERE vault_id = ?1
                    OR id IN (SELECT keychain_id FROM hosts WHERE vault_id = ?1 AND keychain_id IS NOT NULL)",
            )?;
            let mut keychain = Vec::new();
            let mut keychain_secrets: HashMap<String, SharedSecret> = HashMap::new();
            let kc_rows = st_kc.query_map([&vault_id], |r| {
                let auth: String = r.get(3)?;
                let item = KeychainItem {
                    id: r.get(0)?,
                    label: r.get(1)?,
                    username: r.get(2)?,
                    auth_method: AuthMethod::parse(&auth),
                    has_secret: r.get(4)?,
                    updated_at: r.get(5)?,
                    vault_id: r.get(6)?,
                };
                let sec = SharedSecret {
                    password: r.get(7)?,
                    private_key: r.get(8)?,
                    passphrase: r.get(9)?,
                };
                Ok((item, sec))
            })?;
            for row in kc_rows {
                let (item, sec) = row?;
                if with_secrets && (sec.password.is_some() || sec.private_key.is_some() || sec.passphrase.is_some()) {
                    keychain_secrets.insert(item.id.clone(), sec);
                }
                keychain.push(item);
            }

            let relay_url = get_vault_relay_url(c, &vault_id);
            let relay_token: Option<String> = c
                .query_row(
                    "SELECT value FROM ai_settings WHERE key = ?1",
                    [format!("team_vault_relay_token:{vault_id}")],
                    |r| r.get(0),
                )
                .ok()
                .filter(|s: &String| !s.trim().is_empty());
            let relay_seed: Option<String> = c
                .query_row(
                    "SELECT value FROM ai_settings WHERE key = ?1",
                    [format!("team_vault_relay_seed:{vault_id}")],
                    |r| r.get(0),
                )
                .ok()
                .filter(|s: &String| !s.trim().is_empty());

            let team_relay = match (relay_url, relay_token, relay_seed) {
                (Some(relay_url), Some(relay_token), Some(relay_seed)) => Some(TeamRelayBundleConfig {
                    relay_url,
                    relay_token,
                    relay_seed,
                }),
                _ => None,
            };

            // Personal AI provider keys / proxy credentials are never shared with a team.
            let ai_configs: Vec<AiProviderConfig> = Vec::new();

            Ok(TeamVaultPayload {
                vault: v_record,
                hosts,
                keychain,
                tunnels,
                snippets,
                ai_configs,
                include_secrets: with_secrets,
                host_secrets,
                keychain_secrets,
                team_relay,
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
            let imported_role = match payload.vault.role.as_deref() {
                Some("readonly") => "readonly",
                _ => "editor",
            };
            tx.execute(
                "INSERT INTO ai_settings(key, value) VALUES(?1, ?2)
                 ON CONFLICT(key) DO UPDATE SET value=excluded.value",
                params![format!("team_vault_role:{}", payload.vault.id), imported_role],
            )?;
            if let Some(ref tr) = payload.team_relay {
                if crate::sync::relay_url_is_allowed(&tr.relay_url) {
                    tx.execute(
                        "INSERT INTO ai_settings(key, value) VALUES(?1, ?2) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
                        params![format!("team_vault_relay_url:{}", payload.vault.id), tr.relay_url],
                    )?;
                    tx.execute(
                        "INSERT INTO ai_settings(key, value) VALUES(?1, ?2) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
                        params![format!("team_vault_relay_token:{}", payload.vault.id), tr.relay_token],
                    )?;
                    tx.execute(
                        "INSERT INTO ai_settings(key, value) VALUES(?1, ?2) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
                        params![format!("team_vault_relay_seed:{}", payload.vault.id), tr.relay_seed],
                    )?;
                }
            }
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

                let collides_with_other_vault = is_collision.is_some() && is_collision.as_deref() != Some(&payload.vault.id);
                let host_id = if collides_with_other_vault || (!payload.include_secrets && has_secret && is_collision.is_none()) {
                    uuid::Uuid::new_v4().to_string()
                } else {
                    h.id.clone()
                };
                host_id_map.insert(h.id.clone(), host_id);
            }

            // Pass 1.5: import keychain entries belonging to this team bundle
            let mut keychain_id_map: HashMap<String, String> = HashMap::new();
            for kc in &payload.keychain {
                let is_collision = tx.query_row(
                    "SELECT vault_id FROM keychain WHERE id = ?1",
                    [&kc.id],
                    |r| r.get::<_, String>(0),
                ).optional()?;

                let collides_with_other_vault = is_collision.is_some() && is_collision.as_deref() != Some(&payload.vault.id);
                let kc_id = if collides_with_other_vault {
                    uuid::Uuid::new_v4().to_string()
                } else {
                    kc.id.clone()
                };
                keychain_id_map.insert(kc.id.clone(), kc_id.clone());

                let shared_sec = payload.keychain_secrets.get(&kc.id);
                tx.execute(
                    "INSERT INTO keychain(id, label, username, auth_method, password, private_key, passphrase, vault_id, updated_at)
                     VALUES(?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)
                     ON CONFLICT(id) DO UPDATE SET label=?2, username=?3, auth_method=?4,
                         password=COALESCE(?5, password), private_key=COALESCE(?6, private_key), passphrase=COALESCE(?7, passphrase),
                         vault_id=?8, updated_at=?9",
                    params![
                        kc_id,
                        kc.label,
                        kc.username,
                        kc.auth_method.as_str(),
                        shared_sec.and_then(|s| s.password.clone()),
                        shared_sec.and_then(|s| s.private_key.clone()),
                        shared_sec.and_then(|s| s.passphrase.clone()),
                        payload.vault.id,
                        kc.updated_at
                    ],
                )?;
                log_sync_mutation(&tx, "keychain", &kc_id)?;
            }

            // Pass 2: write host records with internal references fully mapped
            for h in &payload.hosts {
                let host_id = host_id_map.get(&h.id).cloned().unwrap_or_else(|| h.id.clone());

                // Imported hosts should only bind to keychains that exist within this team vault
                let safe_keychain_id = if let Some(ref kid) = h.keychain_id {
                    let mapped_kid = keychain_id_map.get(kid).unwrap_or(kid);
                    let exists: bool = tx.query_row(
                        "SELECT 1 FROM keychain WHERE id = ?1 AND vault_id = ?2",
                        params![mapped_kid, payload.vault.id],
                        |_| Ok(true),
                    ).optional()?.unwrap_or(false);
                    if exists { Some(mapped_kid.clone()) } else { None }
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
                if safe_keychain_id.is_none() {
                    if let Some(sec) = payload.host_secrets.get(&h.id) {
                        if sec.password.is_some() || sec.private_key.is_some() || sec.passphrase.is_some() {
                            tx.execute(
                                "INSERT INTO secrets(host_id, password, private_key, passphrase)
                                 VALUES(?1, ?2, ?3, ?4)
                                 ON CONFLICT(host_id) DO UPDATE SET password=?2, private_key=?3, passphrase=?4",
                                params![host_id, sec.password, sec.private_key, sec.passphrase],
                            )?;
                        }
                    }
                }
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
