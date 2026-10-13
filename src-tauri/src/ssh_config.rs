//! SSH config file parser and importer (~/.ssh/config).
//! Parses Host, HostName, User, Port, IdentityFile, ProxyJump, and imports profiles into SQLCipher.

use crate::error::{AppError, AppResult};
use crate::vault::{AuthMethod, HostInput, HostProfile, HostSecret, Vault};
use rusqlite::params;
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

/// Detect standard ~/.ssh/config path if it exists.
#[tauri::command]
pub fn ssh_config_detect() -> AppResult<Option<String>> {
    if let Some(home) = dirs::home_dir() {
        let p = home.join(".ssh").join("config");
        if p.is_file() {
            return Ok(Some(p.to_string_lossy().to_string()));
        }
    }
    Ok(None)
}

#[derive(Default)]
struct HostAcc {
    aliases: Vec<String>,
    hostname: Option<String>,
    user: Option<String>,
    port: Option<u16>,
    identity: Option<String>,
    jump: Option<String>,
}

#[derive(Default)]
struct Globals {
    user: Option<String>,
    port: Option<u16>,
    identity: Option<String>,
}

impl HostAcc {
    fn flush_into(&mut self, results: &mut Vec<ParsedSshHost>, g: &Globals) {
        if self.aliases.is_empty() {
            return;
        }

        for alias in self.aliases.drain(..) {
            // Skip wildcards
            if alias.contains('*') || alias.contains('?') || alias.starts_with('!') {
                continue;
            }

            let effective_host = self.hostname.clone().unwrap_or_else(|| alias.clone());
            let effective_user = self
                .user
                .clone()
                .or_else(|| g.user.clone())
                .unwrap_or_else(|| "root".to_string());
            let effective_port = self.port.or(g.port).unwrap_or(22);
            let effective_identity = self.identity.clone().or_else(|| g.identity.clone());

            results.push(ParsedSshHost {
                id: uuid::Uuid::new_v4().to_string(),
                label: alias,
                hostname: effective_host,
                port: effective_port,
                username: effective_user,
                identity_file: effective_identity,
                proxy_jump: self.jump.clone(),
                group: Some("SSH Config".to_string()),
            });
        }

        self.hostname = None;
        self.user = None;
        self.port = None;
        self.identity = None;
        self.jump = None;
    }
}

/// Parse SSH config text into a structured list of host entries.
pub fn parse_ssh_config_text(content: &str) -> Vec<ParsedSshHost> {
    let mut results: Vec<ParsedSshHost> = Vec::new();
    let mut globals = Globals::default();
    let mut current = HostAcc::default();

    for line in content.lines() {
        let trimmed = line.trim();
        if trimmed.is_empty() || trimmed.starts_with('#') {
            continue;
        }

        // Split key and value (supporting both whitespace and '=' delimiter)
        let (key, val) = if let Some(idx) = trimmed.find('=') {
            let k = trimmed[..idx].trim();
            let v = trimmed[idx + 1..].trim();
            (k, v)
        } else {
            let mut parts = trimmed.split_whitespace();
            let k = parts.next().unwrap_or("");
            let rest = trimmed[k.len()..].trim();
            (k, rest)
        };

        if key.is_empty() {
            continue;
        }

        let key_lower = key.to_lowercase();

        if key_lower == "host" {
            // New Host block
            current.flush_into(&mut results, &globals);

            let patterns: Vec<String> = val
                .split_whitespace()
                .map(|s| s.trim_matches('"').to_string())
                .filter(|s| !s.is_empty())
                .collect();

            // If pattern is just `*`, it's a global config section
            if patterns.len() == 1 && patterns[0] == "*" {
                // Future directives update globals
                current.aliases = Vec::new();
            } else {
                current.aliases = patterns;
            }
        } else if current.aliases.is_empty() {
            // Directives outside or under Host * apply globally
            match key_lower.as_str() {
                "user" => globals.user = Some(val.to_string()),
                "port" => globals.port = val.parse::<u16>().ok(),
                "identityfile" => globals.identity = Some(val.to_string()),
                _ => {}
            }
        } else {
            // Inside a specific Host block
            match key_lower.as_str() {
                "hostname" => current.hostname = Some(val.to_string()),
                "user" => current.user = Some(val.to_string()),
                "port" => current.port = val.parse::<u16>().ok(),
                "identityfile" => current.identity = Some(val.to_string()),
                "proxyjump" => current.jump = Some(val.to_string()),
                _ => {}
            }
        }
    }

    // Flush last block
    current.flush_into(&mut results, &globals);

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

/// Import selected parsed SSH hosts into the vault.
#[tauri::command]
pub fn ssh_config_import(
    hosts: Vec<ParsedSshHost>,
    vault_id: String,
    vault: State<'_, Vault>,
) -> AppResult<usize> {
    if hosts.is_empty() {
        return Ok(0);
    }

    // Track alias -> host_id mapping so jump hosts can be linked
    let mut alias_to_id: HashMap<String, String> = HashMap::new();
    for h in &hosts {
        alias_to_id.insert(h.label.clone(), h.id.clone());
    }

    let mut imported = 0;

    for parsed in hosts {
        let mut keychain_id: Option<String> = None;
        let mut host_secret: Option<HostSecret> = None;
        let mut auth_method = AuthMethod::Agent;

        if let Some(id_path) = &parsed.identity_file {
            let expanded = expand_path(id_path);
            if expanded.is_file() {
                auth_method = AuthMethod::Key;
                if let Ok(key_content) = std::fs::read_to_string(&expanded) {
                    if key_content.contains("PRIVATE KEY") {
                        // Store in keychain as a reusable identity
                        let key_filename = expanded
                            .file_name()
                            .and_then(|n| n.to_str())
                            .unwrap_or("id_key");
                        let kc_label = format!("{} ({})", parsed.label, key_filename);

                        let kid = uuid::Uuid::new_v4().to_string();
                        let kc_res = vault.with(|c| {
                            c.execute(
                                "INSERT INTO keychain(id, label, username, auth_method, password, private_key, passphrase, vault_id, updated_at)
                                 VALUES(?1, ?2, ?3, 'key', NULL, ?4, NULL, ?5, unixepoch())",
                                params![kid, kc_label, parsed.username, key_content, vault_id],
                            )?;
                            Ok(())
                        });
                        if kc_res.is_ok() {
                            keychain_id = Some(kid);
                            host_secret = None;
                        } else {
                            host_secret = Some(HostSecret {
                                password: None,
                                private_key: Some(key_content),
                                passphrase: None,
                            });
                        }
                    }
                }
            }
        }

        // Link Jump Host if proxy_jump matches an alias
        let jump_host_id = parsed.proxy_jump.as_ref().and_then(|j| {
            let primary_jump = j.split(',').next().unwrap_or(j).trim();
            alias_to_id.get(primary_jump).cloned()
        });

        let profile = HostProfile {
            id: parsed.id.clone(),
            label: parsed.label.clone(),
            hostname: parsed.hostname,
            port: parsed.port,
            username: parsed.username,
            auth_method,
            group: parsed.group.or_else(|| Some("SSH Config".to_string())),
            tags: vec!["ssh-config".to_string()],
            color: Some("#22d3ee".to_string()),
            has_secret: host_secret.is_some(),
            os: None,
            keychain_id,
            jump_host_id,
            vault_id: Some(vault_id.clone()),
            startup_command: None,
        };

        let res = crate::vault::host_save(
            HostInput {
                profile,
                secret: host_secret,
            },
            vault.clone(),
        );

        if res.is_ok() {
            imported += 1;
        }
    }

    Ok(imported)
}
