//! SSH config file parser and importer (~/.ssh/config).
//!
//! Follows OpenSSH's own matching rules: directives are evaluated top to
//! bottom and **the first obtained value for each parameter wins**, `Host`
//! patterns support `*` / `?` wildcards and `!` negation (case-insensitive),
//! and `Match host`/`Match originalhost`/`Match all` blocks participate.
//! Other `Match` variants (user/exec/final/…) cannot be evaluated offline
//! and their bodies are skipped. Includes and multi-valued directives (such
//! as multiple IdentityFile entries) are not expanded by this preview.
//! Re-importing skips existing profiles instead of duplicating them.

use crate::error::{AppError, AppResult};
use crate::vault::{AuthMethod, HostInput, HostProfile, Vault};
use rusqlite::{params, OptionalExtension};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::path::PathBuf;
use tauri::State;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ParsedSshHost {
    pub id: String,
    pub label: String,
    pub hostname: String,
    pub port: u16,
    pub username: String,
    pub identity_file: Option<String>,
    pub proxy_jump: Option<String>,
    pub proxy_command: Option<String>,
    pub group: Option<String>,
}

fn expand_path(p: &str) -> PathBuf {
    let trimmed = p.trim().trim_matches('"').trim_matches('\'');
    if trimmed.starts_with("~/") || trimmed == "~" {
        if let Some(home) = dirs::home_dir() {
            if trimmed == "~" {
                return home;
            }
            return home.join(&trimmed[2..]);
        }
    }
    PathBuf::from(trimmed)
}

/// The username OpenSSH would fall back to when no `User` is configured:
/// the local account name (never a hard-coded "root").
fn local_username() -> String {
    std::env::var("USER")
        .or_else(|_| std::env::var("LOGNAME"))
        .or_else(|_| std::env::var("USERNAME"))
        .unwrap_or_default()
}

/// Detect standard ~/.ssh/config path or Android external candidate paths if it exists.
#[tauri::command]
pub fn ssh_config_detect() -> AppResult<Option<String>> {
    #[cfg(target_os = "android")]
    {
        let candidates = [
            "/data/data/com.termux/files/home/.ssh/config",
            "/storage/emulated/0/Download/config",
            "/storage/emulated/0/Download/ssh_config",
            "/storage/emulated/0/Documents/config",
            "/storage/emulated/0/Documents/ssh_config",
            "/sdcard/Download/config",
            "/sdcard/Download/ssh_config",
        ];
        for c in &candidates {
            if std::path::Path::new(c).is_file() {
                return Ok(Some(c.to_string()));
            }
        }
    }
    if let Some(home) = dirs::home_dir() {
        let p = home.join(".ssh").join("config");
        if p.is_file() {
            return Ok(Some(p.to_string_lossy().to_string()));
        }
    }
    let fallback_candidates = [
        "/storage/emulated/0/Download/config",
        "/storage/emulated/0/Download/ssh_config",
        "/storage/emulated/0/Documents/config",
        "/storage/emulated/0/Documents/ssh_config",
    ];
    for c in &fallback_candidates {
        if std::path::Path::new(c).is_file() {
            return Ok(Some(c.to_string()));
        }
    }
    Ok(None)
}

// ── Pattern matching (OpenSSH rules) ──────────────────────────────────────────

/// Case-insensitive wildcard match: `*` = any sequence, `?` = one char.
fn pattern_matches(name: &str, pattern: &str) -> bool {
    fn rec(n: &[u8], p: &[u8]) -> bool {
        match p.first() {
            None => n.is_empty(),
            Some(b'*') => {
                let rest = &p[1..];
                (0..=n.len()).any(|i| rec(&n[i..], rest))
            }
            Some(b'?') => !n.is_empty() && rec(&n[1..], &p[1..]),
            Some(c) => !n.is_empty() && n[0].eq_ignore_ascii_case(c) && rec(&n[1..], &p[1..]),
        }
    }
    rec(name.as_bytes(), pattern.as_bytes())
}

/// A pattern list matches when at least one positive pattern matches and no
/// negated (`!`) pattern matches. A list of only negations matches nothing.
fn pattern_list_matches(name: &str, patterns: &[String]) -> bool {
    let mut matched = false;
    for p in patterns {
        if let Some(neg) = p.strip_prefix('!') {
            if pattern_matches(name, neg) {
                return false;
            }
        } else if pattern_matches(name, p) {
            matched = true;
        }
    }
    matched
}

// ── Config blocks ─────────────────────────────────────────────────────────────

enum BlockKind {
    /// Applies to every host: directives outside any Host/Match, or `Match all`.
    Global,
    /// `Host` pattern list.
    Host(Vec<String>),
    /// `Match host` uses the hostname resolved by earlier directives;
    /// `Match originalhost` uses the requested alias. Both conditions AND.
    MatchHost {
        resolved: Vec<String>,
        original: Vec<String>,
    },
    /// Any other `Match` variant — cannot be evaluated offline; body ignored.
    Ignored,
}

struct ConfigBlock {
    kind: BlockKind,
    /// (lowercase key, value) in file order — first value wins per host.
    params: Vec<(String, String)>,
}

fn is_match_condition_kw(tok: &str) -> bool {
    matches!(
        tok.to_ascii_lowercase().as_str(),
        "all" | "final" | "canonical" | "localnetwork" | "exec" | "host" | "originalhost" | "user"
            | "tagged"
    )
}

/// Classify a `Match` line's conditions. Only `all` and host-pattern
/// conditions can be resolved without a live connection; anything else makes
/// the whole block unresolvable and it is ignored (never merged into another
/// host's block).
fn parse_match_kind(val: &str) -> BlockKind {
    let mut tokens = val.split_whitespace().peekable();
    let mut resolved: Vec<String> = Vec::new();
    let mut original: Vec<String> = Vec::new();
    let mut host_like = true;
    let mut saw_condition = false;

    while let Some(tok) = tokens.next() {
        saw_condition = true;
        match tok.to_ascii_lowercase().as_str() {
            // `all` is unconditionally true — contributes no restriction.
            "all" => {}
            "final" | "canonical" | "localnetwork" => host_like = false,
            // `exec` takes the rest of the line as its command.
            "exec" => {
                host_like = false;
                break;
            }
            "host" | "originalhost" => {
                let target = if tok.eq_ignore_ascii_case("host") {
                    &mut resolved
                } else {
                    &mut original
                };
                while let Some(p) = tokens.peek() {
                    if is_match_condition_kw(p) {
                        break;
                    }
                    target.push(tokens.next().unwrap_or_default().to_string());
                }
                if target.is_empty() {
                    host_like = false;
                }
            }
            "user" | "tagged" => {
                host_like = false;
                while let Some(p) = tokens.peek() {
                    if is_match_condition_kw(p) {
                        break;
                    }
                    let _ = tokens.next();
                }
            }
            // Unknown token — be conservative.
            _ => host_like = false,
        }
    }

    if !host_like {
        BlockKind::Ignored
    } else if !resolved.is_empty() || !original.is_empty() {
        BlockKind::MatchHost { resolved, original }
    } else if saw_condition {
        // `Match all` (or only unrestrictive conditions).
        BlockKind::Global
    } else {
        // `Match` with no criteria is invalid in OpenSSH; ignore defensively.
        BlockKind::Ignored
    }
}

fn block_applies(kind: &BlockKind, name: &str, resolved_hostname: &str) -> bool {
    match kind {
        BlockKind::Global => true,
        BlockKind::Ignored => false,
        BlockKind::Host(patterns) => pattern_list_matches(name, patterns),
        BlockKind::MatchHost { resolved, original } => {
            (resolved.is_empty() || pattern_list_matches(resolved_hostname, resolved))
                && (original.is_empty() || pattern_list_matches(name, original))
        }
    }
}

/// Split `key value`, `key=value` or `key = value`. An `=` inside the value is
/// only a separator when it appears before any whitespace.
fn split_key_value(trimmed: &str) -> (&str, &str) {
    let eq = trimmed.find('=');
    let ws = trimmed.find(char::is_whitespace);
    let use_eq = match (eq, ws) {
        (Some(e), None) => Some(e),
        (Some(e), Some(w)) if e < w => Some(e),
        _ => None,
    };
    if let Some(idx) = use_eq {
        let k = trimmed[..idx].trim();
        let v = trimmed[idx + 1..].trim();
        (k, v)
    } else {
        let mut parts = trimmed.split_whitespace();
        let k = parts.next().unwrap_or("");
        let mut rest = trimmed[k.len()..].trim();
        if let Some(after_eq) = rest.strip_prefix('=') {
            rest = after_eq.trim();
        }
        (k, rest)
    }
}

/// Parse SSH config text into concrete host entries.
pub fn parse_ssh_config_text(content: &str) -> Vec<ParsedSshHost> {
    // Phase 1: collect ordered blocks.
    let mut blocks: Vec<ConfigBlock> = Vec::new();
    for line in content.lines() {
        let trimmed = line.trim();
        if trimmed.is_empty() || trimmed.starts_with('#') {
            continue;
        }
        let (key, val) = split_key_value(trimmed);
        if key.is_empty() {
            continue;
        }
        let key_lower = key.to_ascii_lowercase();

        match key_lower.as_str() {
            "host" => {
                let patterns: Vec<String> = val
                    .split_whitespace()
                    .map(|s| s.trim_matches('"').to_string())
                    .filter(|s| !s.is_empty())
                    .collect();
                blocks.push(ConfigBlock {
                    kind: BlockKind::Host(patterns),
                    params: Vec::new(),
                });
            }
            "match" => {
                blocks.push(ConfigBlock {
                    kind: parse_match_kind(val),
                    params: Vec::new(),
                });
            }
            _ => {
                // Directives outside any block go into a Global block.
                if blocks.is_empty() {
                    blocks.push(ConfigBlock {
                        kind: BlockKind::Global,
                        params: Vec::new(),
                    });
                }
                if let Some(last) = blocks.last_mut() {
                    last.params.push((key_lower, val.to_string()));
                }
            }
        }
    }

    // Phase 2: candidate aliases are concrete Host entries only. `Match`
    // conditions filter hosts; they do not declare new hosts.
    let mut names: Vec<String> = Vec::new();
    for b in &blocks {
        let patterns = match &b.kind {
            BlockKind::Host(p) => p,
            _ => continue,
        };
        for p in patterns {
            if p.starts_with('!') || p.contains('*') || p.contains('?')
                || !pattern_list_matches(p, patterns)
            {
                continue;
            }
            if !names.iter().any(|n| n.eq_ignore_ascii_case(p)) {
                names.push(p.clone());
            }
        }
    }

    // Phase 3: per host, first matching block wins for each parameter
    // (OpenSSH semantics).
    let mut results: Vec<ParsedSshHost> = Vec::new();
    for name in names {
        let mut hostname: Option<String> = None;
        let mut user: Option<String> = None;
        let mut port: Option<u16> = None;
        let mut identity: Option<String> = None;
        let mut jump: Option<String> = None;
        let mut proxy_cmd: Option<String> = None;

        for b in &blocks {
            if !block_applies(&b.kind, &name, hostname.as_deref().unwrap_or(&name)) {
                continue;
            }
            for (k, v) in &b.params {
                match k.as_str() {
                    "hostname" if hostname.is_none() => hostname = Some(v.clone()),
                    "user" if user.is_none() => user = Some(v.clone()),
                    "port" if port.is_none() => port = v.parse::<u16>().ok(),
                    "identityfile" if identity.is_none() => {
                        identity = Some(v.clone())
                    }
                    "proxyjump" if jump.is_none() => jump = Some(v.clone()),
                    "proxycommand" if proxy_cmd.is_none() => proxy_cmd = Some(v.clone()),
                    _ => {}
                }
            }
        }

        results.push(ParsedSshHost {
            id: uuid::Uuid::new_v4().to_string(),
            label: name.clone(),
            hostname: hostname.unwrap_or(name),
            port: port.unwrap_or(22),
            username: user.unwrap_or_else(local_username),
            identity_file: identity,
            proxy_jump: jump,
            proxy_command: proxy_cmd,
            group: Some("SSH Config".to_string()),
        });
    }

    results
}

/// Read and preview SSH config entries from a file path or raw string.
#[tauri::command]
pub fn ssh_config_preview(
    path: Option<String>,
    content: Option<String>,
) -> AppResult<Vec<ParsedSshHost>> {
    let text = if let Some(raw) = content {
        raw
    } else {
        let p = if let Some(custom) = path {
            PathBuf::from(custom)
        } else if let Ok(Some(detected)) = ssh_config_detect() {
            PathBuf::from(detected)
        } else if let Some(home) = dirs::home_dir() {
            home.join(".ssh").join("config")
        } else {
            return Err(AppError::Other("Could not resolve home directory".into()));
        };

        if !p.is_file() {
            return Err(AppError::Other(format!(
                "SSH config file not found: {}",
                p.display()
            )));
        }

        std::fs::read_to_string(&p)
            .map_err(|e| AppError::Other(format!("Failed to read SSH config {}: {e}", p.display())))?
    };

    Ok(parse_ssh_config_text(&text))
}

/// Import selected parsed SSH hosts into the vault. An already imported
/// alias in the same vault is skipped so a second import never duplicates it
/// or overwrites the user's subsequent edits to that profile.
#[tauri::command]
pub fn ssh_config_import(
    hosts: Vec<ParsedSshHost>,
    vault_id: String,
    vault: State<'_, Vault>,
) -> AppResult<usize> {
    if hosts.is_empty() {
        return Ok(0);
    }

    // Resolve IDs before saving so ProxyJump can point to a host that was
    // imported earlier or is later in this batch. Only reuse profiles known
    // to have been imported (tagged ssh-config), or an exact manual match.
    let mut alias_to_id: HashMap<String, String> = HashMap::new();
    let mut existing_aliases = std::collections::HashSet::new();
    for h in &hosts {
        let existing: Option<String> = vault.with(|c| {
            Ok(c.query_row(
                "SELECT id FROM hosts WHERE label=?1 AND vault_id=?2 AND \
                 (tags LIKE '%ssh-config%' OR hostname=?3) LIMIT 1",
                params![h.label, vault_id, h.hostname],
                |r| r.get(0),
            ).optional()?)
        })?;
        if existing.is_some() {
            existing_aliases.insert(h.label.to_ascii_lowercase());
        }
        alias_to_id.insert(
            h.label.to_ascii_lowercase(),
            existing.unwrap_or_else(|| h.id.clone()),
        );
    }

    let mut imported = 0;
    let mut seen = std::collections::HashSet::new();
    for parsed in hosts {
        let label_key = parsed.label.to_ascii_lowercase();
        if !seen.insert(label_key.clone()) || existing_aliases.contains(&label_key) {
            continue;
        }

        let mut keychain_id: Option<String> = None;
        let mut auth_method = AuthMethod::Agent;

        if let Some(id_path) = &parsed.identity_file {
            let expanded = expand_path(id_path);
            if expanded.is_file() {
                auth_method = AuthMethod::Key;
                if let Ok(key_content) = std::fs::read_to_string(&expanded) {
                    if key_content.contains("PRIVATE KEY") {
                        let key_filename = expanded
                            .file_name()
                            .and_then(|n| n.to_str())
                            .unwrap_or("id_key");
                        let kc_label = format!("{} ({})", parsed.label, key_filename);
                        let kid = uuid::Uuid::new_v4().to_string();
                        vault.with(|c| {
                            c.execute(
                                "INSERT INTO keychain(id, label, username, auth_method, password, private_key, passphrase, vault_id, updated_at)
                                 VALUES(?1, ?2, ?3, 'key', NULL, ?4, NULL, ?5, unixepoch())",
                                params![kid, kc_label, parsed.username, key_content, vault_id],
                            )?;
                            Ok(())
                        })?;
                        keychain_id = Some(kid);
                    }
                }
            }
        }

        // ProxyJump may reference an alias in this batch, or an older vault
        // host. The latter lookup is scoped to the target vault.
        let jump_host_id = if let Some(j) = &parsed.proxy_jump {
            let primary = j.split(',').next().unwrap_or(j).trim();
            if let Some(id) = alias_to_id.get(&primary.to_ascii_lowercase()) {
                Some(id.clone())
            } else {
                vault.with(|c| {
                    Ok(c.query_row(
                        "SELECT id FROM hosts WHERE label=?1 AND vault_id=?2 LIMIT 1",
                        params![primary, vault_id],
                        |r| r.get(0),
                    ).optional()?)
                })?
            }
        } else {
            None
        };

        let profile = HostProfile {
            id: parsed.id,
            label: parsed.label,
            hostname: parsed.hostname,
            port: parsed.port,
            username: parsed.username,
            auth_method,
            group: parsed.group.or_else(|| Some("SSH Config".to_string())),
            tags: vec!["ssh-config".to_string()],
            color: Some("#22d3ee".to_string()),
            has_secret: false,
            os: None,
            keychain_id: keychain_id.clone(),
            jump_host_id,
            vault_id: Some(vault_id.clone()),
            startup_command: None,
            proxy_command: parsed.proxy_command,
        };

        if let Err(e) = crate::vault::host_save(
            HostInput { profile, secret: None },
            vault.clone(),
        ) {
            // No orphan keychain entry if saving the host failed.
            if let Some(kid) = keychain_id {
                let _ = vault.with(|c| {
                    c.execute("DELETE FROM keychain WHERE id=?1", [&kid])?;
                    Ok(())
                });
            }
            return Err(e);
        }
        imported += 1;
    }

    Ok(imported)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn host_star_is_a_fallback_only_when_it_comes_later() {
        let entries = parse_ssh_config_text("\
Host prod\n  User deploy\n  HostName prod.example.org\n\
Host *\n  User fallback\n  Port 2200\n");
        assert_eq!(entries.len(), 1);
        assert_eq!(entries[0].username, "deploy");
        assert_eq!(entries[0].port, 2200);
        assert_eq!(entries[0].hostname, "prod.example.org");

        let early = parse_ssh_config_text("\
Host *\n  User fallback\n\
Host prod\n  User deploy\n");
        assert_eq!(early[0].username, "fallback");
    }

    #[test]
    fn patterns_negation_and_first_value() {
        let entries = parse_ssh_config_text("\
Host app1 app2\n  Port 2222\n\
Host app* !app2\n  User service\n  Port 9000\n\
Host !app1\n  User nobody\n");
        assert_eq!(entries.len(), 2);
        assert_eq!(entries[0].label, "app1");
        assert_eq!(entries[0].username, "service");
        assert_eq!(entries[0].port, 2222);
        assert_eq!(entries[1].label, "app2");
        assert_ne!(entries[1].username, "service");
        assert_ne!(entries[1].username, "nobody");
    }

    #[test]
    fn match_host_and_originalhost_are_distinct_and_unknown_is_skipped() {
        let entries = parse_ssh_config_text("\
Host prod\n  HostName prod.internal\n\
Match host prod.internal originalhost prod\n  User deploy\n\
Match exec false\n  User forbidden\n\
Match host prod\n  Port 2200\n\
Match all\n  Port 2022\n");
        assert_eq!(entries.len(), 1);
        assert_eq!(entries[0].username, "deploy");
        assert_eq!(entries[0].port, 2022);
    }

    #[test]
    fn match_does_not_create_host_and_does_not_leak_into_next_host() {
        let entries = parse_ssh_config_text("\
Match host phantom\n  User phantom_user\n\
Host server\n  HostName server.local\n\
Match user different\n  Port 9999\n");
        assert_eq!(entries.len(), 1);
        assert_eq!(entries[0].label, "server");
        assert_eq!(entries[0].port, 22);
        assert_ne!(entries[0].username, "phantom_user");
    }

    #[test]
    fn key_value_separators() {
        let entries = parse_ssh_config_text("\
Host box\n  Port = 2201\n  User=admin\n  ProxyJump hop=1\n");
        assert_eq!(entries[0].port, 2201);
        assert_eq!(entries[0].username, "admin");
        assert_eq!(entries[0].proxy_jump.as_deref(), Some("hop=1"));
    }
}
