use crate::error::{AppError, AppResult};
use crate::vault::{AuthMethod, HostInput, HostProfile, Vault};
use rusqlite::params;
use serde::{Deserialize, Serialize};
use std::time::Duration;
use tauri::State;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NetbirdDevice {
    pub id: String,
    pub name: String,
    pub hostname: String,
    pub ip: String,
    pub os: Option<String>,
    pub online: bool,
    pub last_seen: Option<String>,
    pub tags: Vec<String>,
    pub direct: bool,
    pub latency: Option<String>,
    pub is_self: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NetbirdImportPayload {
    pub hostname: String,
    pub ip: String,
    #[serde(default)]
    pub username: String,
    #[serde(default)]
    pub os: Option<String>,
    #[serde(default, alias = "vault_id")]
    pub vault_id: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NetbirdCredentials {
    pub token: Option<String>,
    pub management_url: Option<String>,
}

// ── CLI JSON Structs ─────────────────────────────────────────────────────────

#[derive(Deserialize)]
#[cfg_attr(target_os = "android", allow(dead_code))]
struct NetbirdCliStatus {
    #[serde(rename = "netbirdIp")]
    netbird_ip: Option<String>,
    fqdn: Option<String>,
    #[serde(default)]
    peers: Option<Vec<NetbirdCliPeer>>,
}

#[derive(Deserialize)]
#[cfg_attr(target_os = "android", allow(dead_code))]
struct NetbirdCliPeer {
    fqdn: Option<String>,
    #[serde(rename = "netbirdIp")]
    netbird_ip: Option<String>,
    ip: Option<String>,
    status: Option<String>,
    direct: Option<bool>,
    latency: Option<String>,
    #[serde(rename = "lastWireguardHandshake")]
    last_handshake: Option<String>,
}

fn clean_ip(raw: &str) -> String {
    let s = raw.trim();
    if let Some((addr, _)) = s.split_once('/') {
        addr.trim().to_string()
    } else {
        s.to_string()
    }
}

#[cfg_attr(target_os = "android", allow(dead_code))]
pub fn parse_netbird_cli_json(raw: &str) -> Option<Vec<NetbirdDevice>> {
    let parsed: NetbirdCliStatus = serde_json::from_str(raw).ok()?;
    let mut devices = Vec::new();

    // 1. Self device
    if let Some(self_ip_raw) = parsed.netbird_ip.filter(|s| !s.is_empty()) {
        let self_ip = clean_ip(&self_ip_raw);
        let self_fqdn = parsed.fqdn.unwrap_or_else(|| "localhost".to_string());
        let short_name = self_fqdn.split('.').next().unwrap_or(&self_fqdn).to_string();

        devices.push(NetbirdDevice {
            id: format!("self-{}", self_ip),
            name: format!("{} (This device)", short_name),
            hostname: self_fqdn,
            ip: self_ip,
            os: None,
            online: true,
            last_seen: Some("Connected".to_string()),
            tags: vec!["netbird".to_string(), "self".to_string()],
            direct: true,
            latency: None,
            is_self: true,
        });
    }

    // 2. Peers
    if let Some(peers) = parsed.peers {
        for peer in peers {
            let raw_ip = peer.netbird_ip.or(peer.ip).unwrap_or_default();
            let ip = clean_ip(&raw_ip);
            if ip.is_empty() {
                continue;
            }

            let fqdn = peer.fqdn.unwrap_or_else(|| ip.clone());
            let name = fqdn.split('.').next().unwrap_or(&fqdn).to_string();
            let is_online = peer
                .status
                .as_deref()
                .map(|s| s.eq_ignore_ascii_case("connected"))
                .unwrap_or(true);

            devices.push(NetbirdDevice {
                id: format!("nb-{}", ip),
                name,
                hostname: fqdn,
                ip,
                os: None,
                online: is_online,
                last_seen: peer.last_handshake,
                tags: vec!["netbird".to_string()],
                direct: peer.direct.unwrap_or(false),
                latency: peer.latency,
                is_self: false,
            });
        }
    }

    devices.sort_by(|a, b| {
        if a.is_self != b.is_self {
            b.is_self.cmp(&a.is_self)
        } else {
            a.name.to_lowercase().cmp(&b.name.to_lowercase())
        }
    });

    Some(devices)
}

// ── REST API JSON Structs ───────────────────────────────────────────────────

#[derive(Deserialize)]
struct NetbirdApiPeer {
    id: Option<String>,
    name: Option<String>,
    ip: Option<String>,
    connected: Option<bool>,
    last_seen: Option<String>,
    os: Option<String>,
    dns_label: Option<String>,
}

pub fn parse_netbird_api_json(raw: &str) -> AppResult<Vec<NetbirdDevice>> {
    let list: Vec<NetbirdApiPeer> = serde_json::from_str(raw)
        .map_err(|e| AppError::Other(format!("Failed to parse NetBird Management API response: {e}")))?;

    let mut devices = Vec::new();
    for p in list {
        let raw_ip = match p.ip {
            Some(i) if !i.trim().is_empty() => i,
            _ => continue,
        };
        let ip = clean_ip(&raw_ip);
        let name = p.name.unwrap_or_else(|| ip.clone());
        let hostname = p.dns_label.unwrap_or_else(|| name.clone());
        let id = p.id.unwrap_or_else(|| format!("nb-{}", ip));

        devices.push(NetbirdDevice {
            id,
            name,
            hostname,
            ip,
            os: p.os,
            online: p.connected.unwrap_or(false),
            last_seen: p.last_seen,
            tags: vec!["netbird".to_string()],
            direct: true,
            latency: None,
            is_self: false,
        });
    }

    devices.sort_by_key(|a| a.name.to_lowercase());
    Ok(devices)
}

// ── Tauri Commands ──────────────────────────────────────────────────────────

/// Detects if local NetBird CLI is available and returns peer/self devices.
#[tauri::command]
pub async fn netbird_detect_cli() -> AppResult<Option<Vec<NetbirdDevice>>> {
    #[cfg(target_os = "android")]
    {
        Ok(None)
    }

    #[cfg(not(target_os = "android"))]
    {
        use tokio::process::Command;

        let output = match tokio::time::timeout(
            Duration::from_secs(5),
            Command::new("netbird")
                .arg("status")
                .arg("--json")
                .output(),
        )
        .await
        {
            Ok(Ok(out)) if out.status.success() => out,
            _ => return Ok(None),
        };

        let raw = String::from_utf8_lossy(&output.stdout);
        Ok(parse_netbird_cli_json(&raw))
    }
}

/// Fetches peers from NetBird Management API (Cloud or Self-Hosted).
#[tauri::command]
pub async fn netbird_fetch_api(
    token: String,
    management_url: Option<String>,
) -> AppResult<Vec<NetbirdDevice>> {
    let trimmed_token = token.trim();
    if trimmed_token.is_empty() {
        return Err(AppError::Other("NetBird API token is required".into()));
    }

    let base = management_url
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .unwrap_or("https://api.netbird.io")
        .trim_end_matches('/');

    let url = format!("{base}/api/peers");

    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(12))
        .build()
        .map_err(|e| AppError::Other(format!("Failed to build HTTP client: {e}")))?;

    let res = client
        .get(&url)
        .header("Authorization", format!("Token {trimmed_token}"))
        .send()
        .await
        .map_err(|e| AppError::Other(format!("Failed to reach NetBird API: {e}")))?;

    if !res.status().is_success() {
        let status = res.status();
        let body = res.text().await.unwrap_or_default();
        return Err(AppError::Other(format!(
            "NetBird API error {status}: {body}"
        )));
    }

    let body = res
        .text()
        .await
        .map_err(|e| AppError::Other(format!("Failed to read response body: {e}")))?;

    parse_netbird_api_json(&body)
}

/// Imports selected NetBird devices into the specified vault under group "NetBird".
#[tauri::command]
pub fn netbird_import_devices(
    devices: Vec<NetbirdImportPayload>,
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

        let existing: Option<String> = vault.with(|c| {
            rusqlite::OptionalExtension::optional(c.query_row(
                "SELECT id FROM hosts WHERE vault_id = ?1 AND (label = ?2 OR hostname = ?3) LIMIT 1",
                params![v_id, dev.hostname, dev.ip],
                |r| r.get(0),
            ))
            .map_err(|e| AppError::Other(e.to_string()))
        })?;

        let id = existing.unwrap_or_else(|| uuid::Uuid::new_v4().to_string());

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
            auth_method: AuthMethod::Key,
            group: Some("NetBird".to_string()),
            tags: vec!["netbird".to_string()],
            color: Some("#f97316".to_string()), // NetBird vibrant orange
            has_secret: false,
            os: dev.os,
            keychain_id: None,
            jump_host_id: None,
            vault_id: Some(v_id),
            startup_command: None,
            proxy_command: None,
        };

        crate::vault::host_save(HostInput { profile, secret: None }, vault.clone())?;
        imported += 1;
    }

    Ok(imported)
}

/// Retrieves saved NetBird API credentials from the encrypted vault.
#[tauri::command]
pub fn netbird_get_credentials(vault: State<'_, Vault>) -> AppResult<NetbirdCredentials> {
    let creds = vault.with(|c| {
        let token: Option<String> = rusqlite::OptionalExtension::optional(c.query_row(
            "SELECT value FROM ai_settings WHERE key = 'netbird_token'",
            [],
            |r| r.get(0),
        ))?;
        let management_url: Option<String> = rusqlite::OptionalExtension::optional(c.query_row(
            "SELECT value FROM ai_settings WHERE key = 'netbird_management_url'",
            [],
            |r| r.get(0),
        ))?;
        Ok(NetbirdCredentials { token, management_url })
    })?;

    Ok(creds)
}

/// Saves NetBird API credentials into the encrypted vault.
#[tauri::command]
pub fn netbird_save_credentials(
    token: String,
    management_url: Option<String>,
    vault: State<'_, Vault>,
) -> AppResult<()> {
    vault.with(|c| {
        c.execute(
            "INSERT INTO ai_settings (key, value) VALUES ('netbird_token', ?1)
             ON CONFLICT(key) DO UPDATE SET value = excluded.value",
            params![token.trim()],
        )?;
        if let Some(url) = management_url {
            c.execute(
                "INSERT INTO ai_settings (key, value) VALUES ('netbird_management_url', ?1)
                 ON CONFLICT(key) DO UPDATE SET value = excluded.value",
                params![url.trim()],
            )?;
        }
        Ok(())
    })?;

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_netbird_cli_status_json() {
        let json = r#"{
            "netbirdIp": "100.90.10.1/16",
            "fqdn": "my-phone.netbird.cloud",
            "management": {
                "url": "https://api.netbird.io:443",
                "connected": true
            },
            "peers": [
                {
                    "fqdn": "internal-server.netbird.cloud",
                    "netbirdIp": "100.90.10.2",
                    "status": "Connected",
                    "direct": true,
                    "latency": "22ms",
                    "lastWireguardHandshake": "2026-10-19T22:00:00Z"
                },
                {
                    "fqdn": "backup-node.netbird.cloud",
                    "netbirdIp": "100.90.10.3",
                    "status": "Disconnected",
                    "direct": false,
                    "latency": "120ms"
                }
            ]
        }"#;

        let devs = parse_netbird_cli_json(json).expect("should parse CLI status");
        assert_eq!(devs.len(), 3);

        let me = &devs[0];
        assert!(me.is_self);
        assert_eq!(me.ip, "100.90.10.1");
        assert!(me.online);

        let p1 = &devs[1];
        assert!(!p1.is_self);
        assert_eq!(p1.ip, "100.90.10.3"); // alphabetical by name backup-node vs internal-server

        let p2 = &devs[2];
        assert_eq!(p2.ip, "100.90.10.2");
        assert_eq!(p2.latency, Some("22ms".into()));
        assert!(p2.direct);
        assert!(p2.online);
    }

    #[test]
    fn parses_netbird_api_peers_json() {
        let json = r#"[
            {
                "id": "peer-abc-123",
                "name": "devbox-ubuntu",
                "ip": "100.90.10.42",
                "connected": true,
                "os": "Linux ubuntu 24.04",
                "dns_label": "devbox",
                "last_seen": "2026-10-19T22:30:00Z"
            }
        ]"#;

        let list = parse_netbird_api_json(json).expect("should parse API peers");
        assert_eq!(list.len(), 1);
        let p = &list[0];
        assert_eq!(p.id, "peer-abc-123");
        assert_eq!(p.name, "devbox-ubuntu");
        assert_eq!(p.hostname, "devbox");
        assert_eq!(p.ip, "100.90.10.42");
        assert_eq!(p.os, Some("Linux ubuntu 24.04".into()));
        assert!(p.online);
    }
}
