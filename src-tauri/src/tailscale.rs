use crate::error::{AppError, AppResult};
use crate::vault::{AuthMethod, HostInput, HostProfile, Vault};
use rusqlite::params;
use serde::{Deserialize, Serialize};
#[cfg(not(target_os = "android"))]
use std::collections::HashMap;
use std::time::Duration;
use tauri::State;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TailscaleDevice {
    pub id: String,
    pub name: String,
    pub hostname: String,
    pub ip: String,
    pub ipv6: Option<String>,
    pub os: Option<String>,
    pub online: bool,
    pub last_seen: Option<String>,
    pub tags: Vec<String>,
    #[serde(default, alias = "tailscale_ssh")]
    pub tailscale_ssh: bool,
    #[serde(default, alias = "is_self")]
    pub is_self: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TailscaleImportPayload {
    pub hostname: String,
    pub ip: String,
    #[serde(default)]
    pub username: String,
    #[serde(default)]
    pub os: Option<String>,
    #[serde(default, alias = "tailscale_ssh")]
    pub tailscale_ssh: bool,
    #[serde(default, alias = "vault_id")]
    pub vault_id: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TailscaleCredentials {
    #[serde(alias = "api_key")]
    pub api_key: Option<String>,
    pub tailnet: Option<String>,
}

// ── CLI JSON Structs ─────────────────────────────────────────────────────────

#[cfg(not(target_os = "android"))]
#[derive(Deserialize)]
struct CliStatus {
    #[serde(rename = "BackendState")]
    _backend_state: Option<String>,
    #[serde(rename = "Self")]
    self_node: Option<CliNode>,
    #[serde(rename = "Peer")]
    peer: Option<HashMap<String, CliNode>>,
}

#[cfg(not(target_os = "android"))]
#[derive(Deserialize)]
struct CliNode {
    #[serde(rename = "ID")]
    id: Option<String>,
    #[serde(rename = "HostName")]
    hostname: Option<String>,
    #[serde(rename = "DNSName")]
    dns_name: Option<String>,
    #[serde(rename = "OS")]
    os: Option<String>,
    #[serde(rename = "TailscaleIPs")]
    tailscale_ips: Option<Vec<String>>,
    #[serde(rename = "Online")]
    online: Option<bool>,
    #[serde(rename = "LastSeen")]
    last_seen: Option<String>,
    #[serde(rename = "TailscaleSSHEnabled")]
    tailscale_ssh_enabled: Option<bool>,
    #[serde(rename = "Tags")]
    tags: Option<Vec<String>>,
}

#[cfg(not(target_os = "android"))]
fn parse_cli_node(node: CliNode, is_self: bool) -> Option<TailscaleDevice> {
    let hostname = node.hostname.filter(|h| !h.is_empty())?;
    let ips = node.tailscale_ips.unwrap_or_default();
    let ipv4 = ips.iter().find(|ip| ip.contains('.')).cloned()?;
    let ipv6 = ips.iter().find(|ip| ip.contains(':')).cloned();
    let name = node.dns_name.unwrap_or_else(|| hostname.clone());
    let id = node.id.unwrap_or_else(|| hostname.clone());

    Some(TailscaleDevice {
        id,
        name: name.trim_end_matches('.').to_string(),
        hostname,
        ip: ipv4,
        ipv6,
        os: node.os,
        online: node.online.unwrap_or(true),
        last_seen: node.last_seen,
        tags: node.tags.unwrap_or_default(),
        tailscale_ssh: node.tailscale_ssh_enabled.unwrap_or(false),
        is_self,
    })
}

// ── REST API JSON Structs ───────────────────────────────────────────────────

#[derive(Deserialize)]
struct ApiDevicesResponse {
    devices: Option<Vec<ApiDevice>>,
}

#[derive(Deserialize)]
struct ApiDevice {
    id: Option<String>,
    name: Option<String>,
    hostname: Option<String>,
    addresses: Option<Vec<String>>,
    os: Option<String>,
    #[serde(rename = "connectedToControl")]
    connected_to_control: Option<bool>,
    #[serde(rename = "lastSeen")]
    last_seen: Option<String>,
    tags: Option<Vec<String>>,
    #[serde(rename = "tailscaleSSHEnabled")]
    tailscale_ssh_enabled: Option<bool>,
}

// ── Tauri Commands ──────────────────────────────────────────────────────────

/// Detects if local Tailscale CLI is available and returns peer/self devices.
#[tauri::command]
pub async fn tailscale_detect_cli() -> AppResult<Option<Vec<TailscaleDevice>>> {
    #[cfg(target_os = "android")]
    {
        // Android does not have the tailscale CLI executable in PATH
        Ok(None)
    }

    #[cfg(not(target_os = "android"))]
    {
        use tokio::process::Command;

        let output = match tokio::time::timeout(
            Duration::from_secs(5),
            Command::new("tailscale")
                .arg("status")
                .arg("--json")
                .output(),
        )
        .await
        {
            Ok(Ok(out)) => out,
            _ => return Ok(None),
        };

        if !output.status.success() {
            return Ok(None);
        }

        let parsed: CliStatus = match serde_json::from_slice(&output.stdout) {
            Ok(p) => p,
            Err(_) => return Ok(None),
        };

        let mut devices = Vec::new();

        if let Some(self_node) = parsed.self_node {
            if let Some(dev) = parse_cli_node(self_node, true) {
                devices.push(dev);
            }
        }

        if let Some(peers) = parsed.peer {
            for (_, peer_node) in peers {
                if let Some(dev) = parse_cli_node(peer_node, false) {
                    devices.push(dev);
                }
            }
        }

        devices.sort_by(|a, b| {
            if a.is_self != b.is_self {
                return b.is_self.cmp(&a.is_self);
            }
            a.hostname.to_lowercase().cmp(&b.hostname.to_lowercase())
        });

        Ok(Some(devices))
    }
}

/// Fetches devices from the Tailscale REST API using an API Access Token.
#[tauri::command]
pub async fn tailscale_fetch_api(
    api_key: String,
    tailnet: Option<String>,
) -> AppResult<Vec<TailscaleDevice>> {
    let key = api_key.trim();
    if key.is_empty() {
        return Err(AppError::Other("Tailscale API key cannot be empty".into()));
    }

    let tailnet_slug = match tailnet {
        Some(ref t) if !t.trim().is_empty() => t.trim(),
        _ => "-",
    };

    let url = format!("https://api.tailscale.com/api/v2/tailnet/{tailnet_slug}/devices");

    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(12))
        .build()
        .map_err(|e| AppError::Other(format!("Failed to create HTTP client: {e}")))?;

    let resp = client
        .get(&url)
        .bearer_auth(key)
        .send()
        .await
        .map_err(|e| AppError::Other(format!("Tailscale API request failed: {e}")))?;

    if !resp.status().is_success() {
        let status = resp.status();
        let body = resp.text().await.unwrap_or_default();
        return Err(AppError::Other(format!(
            "Tailscale API error ({status}): {body}"
        )));
    }

    let data: ApiDevicesResponse = resp
        .json()
        .await
        .map_err(|e| AppError::Other(format!("Failed to parse Tailscale API response: {e}")))?;

    let mut devices = Vec::new();
    let api_devices = data.devices.unwrap_or_default();

    for d in api_devices {
        let hostname = match d.hostname.filter(|h| !h.is_empty()) {
            Some(h) => h,
            None => continue,
        };
        let addrs = d.addresses.unwrap_or_default();
        let ipv4 = match addrs.iter().find(|ip| ip.contains('.')).cloned() {
            Some(ip) => ip,
            None => continue,
        };
        let ipv6 = addrs.iter().find(|ip| ip.contains(':')).cloned();
        let name = d.name.unwrap_or_else(|| hostname.clone());
        let id = d.id.unwrap_or_else(|| hostname.clone());

        devices.push(TailscaleDevice {
            id,
            name: name.trim_end_matches('.').to_string(),
            hostname,
            ip: ipv4,
            ipv6,
            os: d.os,
            online: d.connected_to_control.unwrap_or(true),
            last_seen: d.last_seen,
            tags: d.tags.unwrap_or_default(),
            tailscale_ssh: d.tailscale_ssh_enabled.unwrap_or(false),
            is_self: false,
        });
    }

    devices.sort_by(|a, b| a.hostname.to_lowercase().cmp(&b.hostname.to_lowercase()));
    Ok(devices)
}

/// Imports selected Tailscale devices as host profiles into the specified vault.
#[tauri::command]
pub fn tailscale_import(
    devices: Vec<TailscaleImportPayload>,
    vault: State<'_, Vault>,
) -> AppResult<usize> {
    if devices.is_empty() {
        return Ok(0);
    }

    let mut imported = 0;
    for dev in devices {
        let vault_id = dev.vault_id.trim();
        let v_id = if vault_id.is_empty() {
            "personal".to_string()
        } else {
            vault_id.to_string()
        };

        // Check if a host with this hostname or label already exists in this vault
        let existing: Option<String> = vault.with(|c| {
            rusqlite::OptionalExtension::optional(c.query_row(
                "SELECT id FROM hosts WHERE vault_id = ?1 AND (label = ?2 OR hostname = ?3) LIMIT 1",
                params![v_id, dev.hostname, dev.ip],
                |r| r.get(0),
            ))
            .map_err(|e| AppError::Other(e.to_string()))
        })?;

        let id = existing.unwrap_or_else(|| uuid::Uuid::new_v4().to_string());
        let auth_method = if dev.tailscale_ssh {
            AuthMethod::Agent
        } else {
            AuthMethod::Key
        };

        let profile = HostProfile {
            id,
            label: dev.hostname,
            hostname: dev.ip,
            port: 22,
            username: if dev.username.trim().is_empty() {
                "root".to_string()
            } else {
                dev.username.trim().to_string()
            },
            auth_method,
            group: Some("Tailscale".to_string()),
            tags: vec!["tailscale".to_string()],
            color: Some("#6366f1".to_string()), // Tailscale indigo
            has_secret: false,
            os: dev.os,
            keychain_id: None,
            jump_host_id: None,
            vault_id: Some(v_id),
            startup_command: None,
        };

        crate::vault::host_save(HostInput { profile, secret: None }, vault.clone())?;
        imported += 1;
    }

    Ok(imported)
}

/// Retrieves saved Tailscale API credentials from the encrypted vault.
#[tauri::command]
pub fn tailscale_get_credentials(vault: State<'_, Vault>) -> AppResult<TailscaleCredentials> {
    let creds = vault.with(|c| {
        let api_key: Option<String> = rusqlite::OptionalExtension::optional(c.query_row(
            "SELECT value FROM ai_settings WHERE key = 'tailscale_api_key'",
            [],
            |r| r.get(0),
        ))?;
        let tailnet: Option<String> = rusqlite::OptionalExtension::optional(c.query_row(
            "SELECT value FROM ai_settings WHERE key = 'tailscale_tailnet'",
            [],
            |r| r.get(0),
        ))?;
        Ok(TailscaleCredentials { api_key, tailnet })
    })?;

    Ok(creds)
}

/// Saves Tailscale API credentials into the encrypted vault.
#[tauri::command]
pub fn tailscale_save_credentials(
    api_key: String,
    tailnet: Option<String>,
    vault: State<'_, Vault>,
) -> AppResult<()> {
    vault.with(|c| {
        c.execute(
            "INSERT INTO ai_settings (key, value) VALUES ('tailscale_api_key', ?1)
             ON CONFLICT(key) DO UPDATE SET value = excluded.value",
            params![api_key.trim()],
        )?;
        if let Some(t) = tailnet {
            c.execute(
                "INSERT INTO ai_settings (key, value) VALUES ('tailscale_tailnet', ?1)
                 ON CONFLICT(key) DO UPDATE SET value = excluded.value",
                params![t.trim()],
            )?;
        }
        Ok(())
    })?;

    Ok(())
}
