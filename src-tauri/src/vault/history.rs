//! Connection logs, command & clipboard history (with secret-detection heuristics),
//! known hosts & TOFU trust pinning, tunnels, snippets, and multi-vault CRUD.

use super::{
    ensure_vault_writable, get_vault_relay_url, get_vault_role, log_sync_deletion,
    log_sync_mutation, now, ConnectionLog, KnownHost, Snippet, TunnelConfig, Vault, VaultRecord,
};
use crate::error::{AppError, AppResult};
use parking_lot::Mutex;
use rusqlite::{params, OptionalExtension};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use tauri::State;

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

#[allow(clippy::type_complexity)]
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
        ensure_vault_writable(c, tunnel.vault_id.as_deref())?;
        if let Some(vid) = c
            .query_row("SELECT vault_id FROM tunnels WHERE id=?1", [&tunnel.id], |r| r.get::<_, Option<String>>(0))
            .optional()?
            .flatten()
        {
            ensure_vault_writable(c, Some(&vid))?;
        }
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
        if let Some(vid) = c
            .query_row("SELECT vault_id FROM tunnels WHERE id=?1", [&id], |r| r.get::<_, Option<String>>(0))
            .optional()?
            .flatten()
        {
            ensure_vault_writable(c, Some(&vid))?;
        }
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
        ensure_vault_writable(c, snippet.vault_id.as_deref())?;
        if let Some(vid) = c
            .query_row("SELECT vault_id FROM snippets WHERE id=?1", [&snippet.id], |r| r.get::<_, Option<String>>(0))
            .optional()?
            .flatten()
        {
            ensure_vault_writable(c, Some(&vid))?;
        }
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
        if let Some(vid) = c
            .query_row("SELECT vault_id FROM snippets WHERE id=?1", [&id], |r| r.get::<_, Option<String>>(0))
            .optional()?
            .flatten()
        {
            ensure_vault_writable(c, Some(&vid))?;
        }
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
                role: None,
                relay_url: None,
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
                role: Some("owner".into()),
                relay_url: None,
            };
            let _ = c.execute("INSERT OR IGNORE INTO vaults (id, name, kind, color, description, created_at) VALUES ('personal', 'Personal Vault', 'personal', '#22d3ee', 'Your private hosts & credentials', ?1)", [personal.created_at]);
            res.push(personal);
        }
        for v in &mut res {
            v.role = Some(get_vault_role(c, &v.id));
            v.relay_url = get_vault_relay_url(c, &v.id);
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
        if let Some(ref role) = record.role {
            let _ = c.execute(
                "INSERT INTO ai_settings(key, value) VALUES(?1, ?2) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
                params![format!("team_vault_role:{}", record.id), role],
            );
        }
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
        for prefix in [
            "team_vault_role",
            "team_vault_relay_url",
            "team_vault_relay_token",
            "team_vault_relay_seed",
            "team_vault_relay_cursor",
        ] {
            let _ = c.execute("DELETE FROM ai_settings WHERE key=?1", [format!("{prefix}:{id}")]);
        }
        let _ = log_sync_deletion(c, "vaults", &id);
        Ok(())
    })
}
