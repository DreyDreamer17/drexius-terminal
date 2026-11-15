//! Host profile CRUD, Termux LAN address translation, role/permission checks,
//! self-healing host repair, and HLC sync-log tracking.

use super::{now, AuthMethod, HostInput, HostProfile, KeychainInput, Vault};
use crate::error::{AppError, AppResult};
use rand::RngCore;
use rusqlite::{params, Connection, OptionalExtension};
use tauri::State;

pub(super) fn row_to_host(r: &rusqlite::Row) -> rusqlite::Result<HostProfile> {
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

#[cfg(not(target_os = "android"))]
pub(super) fn latest_paired_android_ip(conn: &Connection) -> Option<String> {
    conn.query_row(
        "SELECT ip_address FROM paired_devices
         WHERE revoked_at IS NULL
           AND ip_address IS NOT NULL
           AND ip_address != ''
           AND ip_address != '127.0.0.1'
           AND (LOWER(device_type) LIKE '%android%'
                OR LOWER(device_name) LIKE '%android%'
                OR LOWER(device_type) LIKE '%mobile%'
                OR LOWER(device_type) LIKE '%phone%')
         ORDER BY last_sync DESC LIMIT 1",
        [],
        |r| r.get::<_, String>(0),
    )
    .optional()
    .ok()
    .flatten()
}

#[cfg(target_os = "android")]
pub(super) fn latest_paired_android_ip(_conn: &Connection) -> Option<String> {
    None
}

pub(super) fn translate_termux_for_platform(profile: &mut HostProfile, android_lan_ip: Option<&str>) {
    #[cfg(not(target_os = "android"))]
    if profile.port == 8022
        && (profile.hostname.trim() == "127.0.0.1"
            || profile.hostname.trim().eq_ignore_ascii_case("localhost"))
    {
        if let Some(ip) = android_lan_ip {
            profile.hostname = ip.to_string();
            if profile.label.trim() == "Termux (Local)" {
                profile.label = "Termux (Phone LAN)".to_string();
            }
        }
    }
    #[cfg(target_os = "android")]
    let _ = (profile, android_lan_ip);
}

pub(super) fn normalize_termux_before_save(profile: &mut HostProfile, android_lan_ip: Option<&str>) {
    #[cfg(not(target_os = "android"))]
    if profile.port == 8022 {
        if let Some(ip) = android_lan_ip {
            if profile.hostname.trim() == ip {
                profile.hostname = "127.0.0.1".to_string();
                if profile.label.trim() == "Termux (Phone LAN)" {
                    profile.label = "Termux (Local)".to_string();
                }
            }
        }
    }
    #[cfg(target_os = "android")]
    let _ = (profile, android_lan_ip);
}

pub(crate) fn get_vault_role(conn: &Connection, vault_id: &str) -> String {
    if vault_id == "personal" || vault_id.is_empty() {
        return "owner".into();
    }
    conn.query_row(
        "SELECT value FROM ai_settings WHERE key = ?1",
        [format!("team_vault_role:{vault_id}")],
        |r| r.get::<_, String>(0),
    )
    .ok()
    .unwrap_or_else(|| "owner".into())
}

pub(crate) fn get_vault_relay_url(conn: &Connection, vault_id: &str) -> Option<String> {
    if vault_id == "personal" || vault_id.is_empty() {
        return None;
    }
    conn.query_row(
        "SELECT value FROM ai_settings WHERE key = ?1",
        [format!("team_vault_relay_url:{vault_id}")],
        |r| r.get::<_, String>(0),
    )
    .ok()
    .filter(|s| !s.trim().is_empty())
}

pub(crate) fn ensure_vault_writable(conn: &Connection, vault_id: Option<&str>) -> AppResult<()> {
    let vid = vault_id.unwrap_or("personal");
    if get_vault_role(conn, vid) == "readonly" {
        return Err(AppError::Other(
            "This Team Vault is Read-Only. You can connect to hosts and run snippets, but cannot modify or delete items.".into(),
        ));
    }
    Ok(())
}

/// Self-healing repair for any host row whose metadata was overwritten by the frontend
/// `LOCAL_HOST` placeholder (`hostname = 'localhost'`, `port = 0`, `username = 'local'`).
/// Recovers the original `hostname` and `username` from `connection_logs`, `port` from
/// `known_hosts`, and `auth_method` / `keychain_id` from `secrets` and `keychain`.
pub(super) fn repair_corrupted_local_hosts(conn: &Connection) -> AppResult<()> {
    let mut stmt = conn.prepare(
        "SELECT id, label FROM hosts WHERE port = 0 OR (hostname = 'localhost' AND username = 'local')",
    )?;
    let corrupted: Vec<(String, String)> = stmt
        .query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?)))?
        .filter_map(Result::ok)
        .collect();
    for (host_id, host_label) in corrupted {
        let log_match: Option<(String, String)> = conn
            .query_row(
                "SELECT username, hostname FROM connection_logs
                 WHERE (host_id = ?1 OR LOWER(host_label) = LOWER(?2))
                   AND hostname != 'localhost' AND hostname != ''
                   AND username != 'local'
                 ORDER BY started_at DESC LIMIT 1",
                params![host_id, host_label],
                |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?)),
            )
            .optional()?;
        let Some((restored_user, restored_host)) = log_match else {
            continue;
        };
        let restored_port: u16 = conn
            .query_row(
                "SELECT port FROM known_hosts WHERE host = ?1 AND port > 0 ORDER BY added_at DESC LIMIT 1",
                params![&restored_host],
                |r| r.get::<_, u16>(0),
            )
            .optional()?
            .unwrap_or(22);

        // Inspect secrets table first
        let secret_row: Option<(Option<String>, Option<String>)> = conn
            .query_row(
                "SELECT password, private_key FROM secrets WHERE host_id = ?1",
                params![&host_id],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .optional()?;

        let mut restored_auth = "password".to_string();
        let mut restored_kc_id: Option<String> = None;

        if let Some((pw, pk)) = secret_row {
            if pk.as_deref().map(|s| !s.trim().is_empty()).unwrap_or(false) {
                restored_auth = "key".to_string();
            } else if pw.as_deref().map(|s| !s.trim().is_empty()).unwrap_or(false) {
                restored_auth = "password".to_string();
            }
        } else {
            let kc_match: Option<(String, String)> = conn
                .query_row(
                    "SELECT id, auth_method FROM keychain
                     WHERE username = ?1
                     ORDER BY updated_at DESC LIMIT 1",
                    params![&restored_user],
                    |r| Ok((r.get(0)?, r.get(1)?)),
                )
                .optional()?
                .or_else(|| {
                    conn.query_row(
                        "SELECT id, auth_method FROM keychain ORDER BY updated_at DESC LIMIT 1",
                        [],
                        |r| Ok((r.get(0)?, r.get(1)?)),
                    )
                    .optional()
                    .ok()
                    .flatten()
                });
            if let Some((kc_id, kc_auth)) = kc_match {
                restored_kc_id = Some(kc_id);
                restored_auth = kc_auth;
            }
        }

        let _ = conn.execute(
            "UPDATE hosts
             SET hostname = ?1, port = ?2, username = ?3, auth_method = ?4, keychain_id = ?5, updated_at = ?6
             WHERE id = ?7",
            params![
                restored_host,
                restored_port,
                restored_user,
                restored_auth,
                restored_kc_id,
                now(),
                host_id
            ],
        );
    }
    Ok(())
}

#[tauri::command]
pub fn hosts_list(vault: State<'_, Vault>) -> AppResult<Vec<HostProfile>> {
    vault.with(|c| {
        let _ = repair_corrupted_local_hosts(c);
        let android_ip = latest_paired_android_ip(c);
        let mut st = c.prepare(
            "SELECT h.id, h.label, h.hostname, h.port, h.username, h.auth_method, h.grp, h.tags, h.color, h.os, h.keychain_id, h.jump_host_id, h.vault_id, h.startup_command, h.proxy_command,
                    (s.host_id IS NOT NULL OR h.keychain_id IS NOT NULL) FROM hosts h LEFT JOIN secrets s ON s.host_id=h.id ORDER BY h.grp, h.label",
        )?;
        let rows = st.query_map([], |r| {
            let mut h = row_to_host(r)?;
            h.has_secret = r.get(15)?;
            translate_termux_for_platform(&mut h, android_ip.as_deref());
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
        ensure_vault_writable(c, profile.vault_id.as_deref())?;
        if let Some(existing_vid) = c
            .query_row("SELECT vault_id FROM hosts WHERE id=?1", [&profile.id], |r| r.get::<_, Option<String>>(0))
            .optional()?
            .flatten()
        {
            ensure_vault_writable(c, Some(&existing_vid))?;
        }
        let android_ip = latest_paired_android_ip(c);
        let tx = c.unchecked_transaction()?;
        let mut profile = profile;
        normalize_termux_before_save(&mut profile, android_ip.as_deref());
        if profile.id.is_empty() {
            profile.id = uuid::Uuid::new_v4().to_string();
        }
        let host_vault = profile.vault_id.clone().unwrap_or_else(|| "personal".into());
        let kc_vault = keychain
            .vault_id
            .clone()
            .unwrap_or_else(|| host_vault.clone());
        ensure_vault_writable(&tx, Some(&host_vault))?;
        ensure_vault_writable(&tx, Some(&kc_vault))?;
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
        if profile.port == 0 || (profile.hostname == "localhost" && profile.username == "local") {
            if let Some(os_val) = profile.os.as_deref() {
                let _ = c.execute(
                    "UPDATE hosts SET os=?1, updated_at=?2 WHERE id=?3 AND COALESCE(os, '') != ?1",
                    params![os_val, now(), profile.id],
                );
            }
            return Ok(profile.id);
        }
        ensure_vault_writable(c, profile.vault_id.as_deref())?;
        if let Some(existing_vid) = c
            .query_row("SELECT vault_id FROM hosts WHERE id=?1", [&profile.id], |r| r.get::<_, Option<String>>(0))
            .optional()?
            .flatten()
        {
            ensure_vault_writable(c, Some(&existing_vid))?;
        }
        let android_ip = latest_paired_android_ip(c);
        normalize_termux_before_save(&mut profile, android_ip.as_deref());
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
        if let Some(vid) = c
            .query_row("SELECT vault_id FROM hosts WHERE id=?1", [&id], |r| r.get::<_, Option<String>>(0))
            .optional()?
            .flatten()
        {
            ensure_vault_writable(c, Some(&vid))?;
        }
        c.execute("DELETE FROM hosts WHERE id=?1", [&id])?;
        let _ = log_sync_deletion(c, "hosts", &id);
        Ok(())
    })
}
