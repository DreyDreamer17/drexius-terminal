//! Cloud Provider Fleet Sync (Hetzner Cloud, DigitalOcean, Proxmox VE).
//!
//! Fetches live virtual machines and LXC containers using read-only API tokens
//! stored inside the encrypted SQLCipher vault, reports real-time server power
//! states, and syncs/imports them into provider host groups.

use crate::error::{AppError, AppResult};
use crate::vault::{AuthMethod, HostInput, HostProfile, Vault};
use rusqlite::params;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::time::Duration;
use tauri::State;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CloudInstance {
    pub id: String,
    pub provider: String, // "hetzner" | "digitalocean" | "proxmox"
    pub name: String,
    pub ip: String,
    pub ipv6: Option<String>,
    pub status: String, // "running" | "active" | "off" | "stopped" | "starting"
    pub online: bool,
    pub region: Option<String>,
    pub instance_type: Option<String>,
    pub os: Option<String>,
    pub tags: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CloudImportPayload {
    pub id: String,
    pub provider: String,
    pub name: String,
    pub ip: String,
    #[serde(default)]
    pub username: String,
    #[serde(default)]
    pub port: Option<u16>,
    #[serde(default)]
    pub os: Option<String>,
    #[serde(default)]
    pub region: Option<String>,
    #[serde(default)]
    pub tags: Vec<String>,
    #[serde(default)]
    pub vault_id: String,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CloudCredentials {
    pub hetzner_token: Option<String>,
    pub digitalocean_token: Option<String>,
    pub proxmox_url: Option<String>,
    pub proxmox_token: Option<String>,
    #[serde(default = "default_true")]
    pub proxmox_insecure: bool,
}

fn default_true() -> bool {
    true
}

pub fn normalize_cloud_os(raw: Option<&str>) -> Option<String> {
    let s = raw?.trim().to_lowercase();
    if s.is_empty() {
        return None;
    }
    if s.contains("ubuntu") {
        Some("ubuntu".into())
    } else if s.contains("debian") {
        Some("debian".into())
    } else if s.contains("arch") {
        Some("arch".into())
    } else if s.contains("fedora") {
        Some("fedora".into())
    } else if s.contains("rocky") || s.contains("alma") {
        Some("rocky".into())
    } else if s.contains("centos") {
        Some("centos".into())
    } else if s.contains("alpine") {
        Some("alpine".into())
    } else if s.contains("suse") {
        Some("suse".into())
    } else if s.contains("amazon") || s.contains("amzn") {
        Some("amazon".into())
    } else if s.contains("windows") {
        Some("windows".into())
    } else if s.contains("freebsd") || s.contains("linux") {
        Some("linux".into())
    } else {
        None
    }
}

// ── Hetzner Cloud API Structs ────────────────────────────────────────────────

#[derive(Deserialize)]
struct HetznerServersResponse {
    servers: Option<Vec<HetznerServer>>,
}

#[derive(Deserialize)]
struct HetznerServer {
    id: u64,
    name: String,
    status: Option<String>,
    public_net: Option<HetznerPublicNet>,
    private_net: Option<Vec<HetznerPrivateNet>>,
    server_type: Option<HetznerServerType>,
    datacenter: Option<HetznerDatacenter>,
    image: Option<HetznerImage>,
    labels: Option<HashMap<String, String>>,
}

#[derive(Deserialize)]
struct HetznerPublicNet {
    ipv4: Option<HetznerIpEntry>,
    ipv6: Option<HetznerIpEntry>,
}

#[derive(Deserialize)]
struct HetznerIpEntry {
    ip: Option<String>,
}

#[derive(Deserialize)]
struct HetznerPrivateNet {
    ip: Option<String>,
}

#[derive(Deserialize)]
struct HetznerServerType {
    name: Option<String>,
}

#[derive(Deserialize)]
struct HetznerDatacenter {
    name: Option<String>,
}

#[derive(Deserialize)]
struct HetznerImage {
    os_flavor: Option<String>,
    name: Option<String>,
}

pub fn parse_hetzner_response(body: &str) -> AppResult<Vec<CloudInstance>> {
    let parsed: HetznerServersResponse = serde_json::from_str(body)
        .map_err(|e| AppError::Other(format!("Failed to parse Hetzner response: {e}")))?;

    let mut out = Vec::new();
    for srv in parsed.servers.unwrap_or_default() {
        let pub_ipv4 = srv
            .public_net
            .as_ref()
            .and_then(|n| n.ipv4.as_ref())
            .and_then(|ip| ip.ip.clone())
            .filter(|s| !s.is_empty());
        let priv_ipv4 = srv
            .private_net
            .as_ref()
            .and_then(|list| list.first())
            .and_then(|n| n.ip.clone())
            .filter(|s| !s.is_empty());
        let pub_ipv6 = srv
            .public_net
            .as_ref()
            .and_then(|n| n.ipv6.as_ref())
            .and_then(|ip| ip.ip.clone())
            .filter(|s| !s.is_empty())
            .map(|ip| ip.split('/').next().unwrap_or(&ip).to_string());

        let ip = match pub_ipv4.or(priv_ipv4).or_else(|| pub_ipv6.clone()) {
            Some(addr) => addr,
            None => continue,
        };

        let status = srv.status.unwrap_or_else(|| "unknown".into()).to_lowercase();
        let online = status == "running";
        let region = srv.datacenter.and_then(|d| d.name);
        let instance_type = srv.server_type.and_then(|t| t.name);
        let os_raw = srv
            .image
            .as_ref()
            .and_then(|img| img.os_flavor.as_deref().or(img.name.as_deref()));
        let os = normalize_cloud_os(os_raw).or_else(|| Some("linux".into()));

        let mut tags = vec!["hetzner".to_string()];
        if let Some(ref r) = region {
            tags.push(r.clone());
        }
        if let Some(labels) = srv.labels {
            for (k, v) in labels {
                if v.is_empty() {
                    tags.push(k);
                } else {
                    tags.push(format!("{k}:{v}"));
                }
            }
        }

        out.push(CloudInstance {
            id: srv.id.to_string(),
            provider: "hetzner".into(),
            name: srv.name,
            ip,
            ipv6: pub_ipv6,
            status,
            online,
            region,
            instance_type,
            os,
            tags,
        });
    }

    out.sort_by(|a, b| a.name.to_lowercase().cmp(&b.name.to_lowercase()));
    Ok(out)
}

// ── DigitalOcean API Structs ─────────────────────────────────────────────────

#[derive(Deserialize)]
struct DoDropletsResponse {
    droplets: Option<Vec<DoDroplet>>,
}

#[derive(Deserialize)]
struct DoDroplet {
    id: u64,
    name: String,
    status: Option<String>,
    size_slug: Option<String>,
    networks: Option<DoNetworks>,
    region: Option<DoRegion>,
    image: Option<DoImage>,
    tags: Option<Vec<String>>,
}

#[derive(Deserialize)]
struct DoNetworks {
    v4: Option<Vec<DoNetEntry>>,
    v6: Option<Vec<DoNetEntry>>,
}

#[derive(Deserialize, Clone)]
struct DoNetEntry {
    ip_address: Option<String>,
    #[serde(rename = "type")]
    net_type: Option<String>,
}

#[derive(Deserialize)]
struct DoRegion {
    slug: Option<String>,
}

#[derive(Deserialize)]
struct DoImage {
    distribution: Option<String>,
    name: Option<String>,
}

pub fn parse_digitalocean_response(body: &str) -> AppResult<Vec<CloudInstance>> {
    let parsed: DoDropletsResponse = serde_json::from_str(body)
        .map_err(|e| AppError::Other(format!("Failed to parse DigitalOcean response: {e}")))?;

    let mut out = Vec::new();
    for d in parsed.droplets.unwrap_or_default() {
        let v4_list = d
            .networks
            .as_ref()
            .and_then(|n| n.v4.as_ref())
            .cloned()
            .unwrap_or_default();
        let pub_v4 = v4_list
            .iter()
            .find(|n| n.net_type.as_deref() == Some("public"))
            .and_then(|n| n.ip_address.clone());
        let priv_v4 = v4_list
            .iter()
            .find(|n| n.net_type.as_deref() == Some("private"))
            .and_then(|n| n.ip_address.clone());
        let ipv6 = d
            .networks
            .as_ref()
            .and_then(|n| n.v6.as_ref())
            .and_then(|list| list.first())
            .and_then(|n| n.ip_address.clone());

        let ip = match pub_v4.or(priv_v4).or_else(|| ipv6.clone()) {
            Some(addr) if !addr.is_empty() => addr,
            _ => continue,
        };

        let raw_status = d.status.unwrap_or_else(|| "unknown".into()).to_lowercase();
        let online = raw_status == "active" || raw_status == "running";
        let status = if raw_status == "active" {
            "running".into()
        } else {
            raw_status
        };
        let region = d.region.and_then(|r| r.slug);
        let os_raw = d
            .image
            .as_ref()
            .and_then(|img| img.distribution.as_deref().or(img.name.as_deref()));
        let os = normalize_cloud_os(os_raw).or_else(|| Some("linux".into()));

        let mut tags = vec!["digitalocean".to_string()];
        if let Some(ref r) = region {
            tags.push(r.clone());
        }
        if let Some(extra) = d.tags {
            for t in extra {
                if !tags.contains(&t) {
                    tags.push(t);
                }
            }
        }

        out.push(CloudInstance {
            id: d.id.to_string(),
            provider: "digitalocean".into(),
            name: d.name,
            ip,
            ipv6,
            status,
            online,
            region,
            instance_type: d.size_slug,
            os,
            tags,
        });
    }

    out.sort_by(|a, b| a.name.to_lowercase().cmp(&b.name.to_lowercase()));
    Ok(out)
}

// ── Proxmox VE API Structs ───────────────────────────────────────────────────

#[derive(Deserialize)]
struct ProxmoxResourcesResponse {
    data: Option<Vec<ProxmoxResource>>,
}

#[derive(Deserialize)]
struct ProxmoxResource {
    vmid: Option<u64>,
    name: Option<String>,
    node: Option<String>,
    #[serde(rename = "type")]
    vm_type: Option<String>, // "qemu" | "lxc"
    status: Option<String>,  // "running" | "stopped" | "paused"
    tags: Option<String>,    // semicolon/comma separated in PVE
    template: Option<u8>,
}

#[derive(Deserialize)]
struct ProxmoxLxcIfacesResponse {
    data: Option<Vec<ProxmoxLxcIface>>,
}

#[derive(Deserialize)]
struct ProxmoxLxcIface {
    name: Option<String>,
    inet: Option<String>, // e.g. "192.168.1.150/24"
}

#[derive(Deserialize)]
struct ProxmoxQemuIfacesResponse {
    data: Option<ProxmoxQemuResult>,
}

#[derive(Deserialize)]
struct ProxmoxQemuResult {
    result: Option<Vec<ProxmoxQemuIface>>,
}

#[derive(Deserialize)]
struct ProxmoxQemuIface {
    name: Option<String>,
    #[serde(rename = "ip-addresses")]
    ip_addresses: Option<Vec<ProxmoxQemuIp>>,
}

#[derive(Deserialize)]
struct ProxmoxQemuIp {
    #[serde(rename = "ip-address")]
    ip_address: Option<String>,
    #[serde(rename = "ip-address-type")]
    ip_type: Option<String>,
}

pub fn parse_proxmox_resources(
    body: &str,
    fallback_host: &str,
) -> AppResult<Vec<(u64, String, String, CloudInstance)>> {
    let parsed: ProxmoxResourcesResponse = serde_json::from_str(body)
        .map_err(|e| AppError::Other(format!("Failed to parse Proxmox VE response: {e}")))?;

    let mut out = Vec::new();
    for res in parsed.data.unwrap_or_default() {
        if res.template == Some(1) {
            continue; // skip VM templates
        }
        let vmid = match res.vmid {
            Some(id) => id,
            None => continue,
        };
        let node = res.node.unwrap_or_else(|| "pve".into());
        let vm_type = res.vm_type.unwrap_or_else(|| "qemu".into());
        let name = res
            .name
            .filter(|n| !n.trim().is_empty())
            .unwrap_or_else(|| format!("{vm_type}-{vmid}"));
        let status = res.status.unwrap_or_else(|| "stopped".into()).to_lowercase();
        let online = status == "running";

        let mut tags = vec!["proxmox".to_string(), vm_type.clone(), node.clone()];
        if let Some(raw_tags) = res.tags {
            for t in raw_tags.split(|c| c == ';' || c == ',' || c == ' ') {
                let trimmed = t.trim();
                if !trimmed.is_empty() && !tags.iter().any(|x| x == trimmed) {
                    tags.push(trimmed.to_string());
                }
            }
        }

        let default_ip = if !fallback_host.is_empty() {
            fallback_host.to_string()
        } else {
            name.clone()
        };

        out.push((
            vmid,
            node.clone(),
            vm_type.clone(),
            CloudInstance {
                id: vmid.to_string(),
                provider: "proxmox".into(),
                name,
                ip: default_ip,
                ipv6: None,
                status,
                online,
                region: Some(node),
                instance_type: Some(format!("{vm_type} #{vmid}")),
                os: Some("linux".into()),
                tags,
            },
        ));
    }

    out.sort_by(|a, b| a.0.cmp(&b.0));
    Ok(out)
}

// ── Tauri Commands ──────────────────────────────────────────────────────────

#[tauri::command]
pub async fn cloud_fetch_instances(
    provider: String,
    api_token: String,
    api_url: Option<String>,
    allow_insecure: Option<bool>,
) -> AppResult<Vec<CloudInstance>> {
    let prov = provider.trim().to_lowercase();
    let token = api_token.trim();
    if token.is_empty() {
        return Err(AppError::Other("API token cannot be empty".into()));
    }

    let is_proxmox = prov == "proxmox";
    // Only Proxmox on-premise clusters may opt in to self-signed TLS.
    // Public cloud providers (Hetzner, DigitalOcean) always enforce valid TLS certificates.
    let accept_invalid_certs = is_proxmox && allow_insecure.unwrap_or(false);

    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(12))
        .danger_accept_invalid_certs(accept_invalid_certs)
        .build()
        .map_err(|e| AppError::Other(format!("Failed to build HTTP client: {e}")))?;

    match prov.as_str() {
        "hetzner" => {
            let resp = client
                .get("https://api.hetzner.cloud/v1/servers?per_page=50")
                .bearer_auth(token)
                .send()
                .await
                .map_err(|e| AppError::Other(format!("Hetzner API request failed: {e}")))?;

            if !resp.status().is_success() {
                let status = resp.status();
                let body = resp.text().await.unwrap_or_default();
                return Err(AppError::Other(format!(
                    "Hetzner Cloud API error ({status}): {body}"
                )));
            }

            let body = resp
                .text()
                .await
                .map_err(|e| AppError::Other(format!("Failed reading Hetzner response: {e}")))?;
            parse_hetzner_response(&body)
        }
        "digitalocean" => {
            let resp = client
                .get("https://api.digitalocean.com/v2/droplets?per_page=200")
                .bearer_auth(token)
                .send()
                .await
                .map_err(|e| AppError::Other(format!("DigitalOcean API request failed: {e}")))?;

            if !resp.status().is_success() {
                let status = resp.status();
                let body = resp.text().await.unwrap_or_default();
                return Err(AppError::Other(format!(
                    "DigitalOcean API error ({status}): {body}"
                )));
            }

            let body = resp
                .text()
                .await
                .map_err(|e| AppError::Other(format!("Failed reading DigitalOcean response: {e}")))?;
            parse_digitalocean_response(&body)
        }
        "proxmox" => {
            let raw_url = api_url
                .as_deref()
                .map(str::trim)
                .filter(|s| !s.is_empty())
                .ok_or_else(|| {
                    AppError::Other(
                        "Proxmox VE URL is required (e.g. https://192.168.1.100:8006)".into(),
                    )
                })?;

            let base_url = if raw_url.starts_with("http://") || raw_url.starts_with("https://") {
                raw_url.trim_end_matches('/').to_string()
            } else {
                format!("https://{}", raw_url.trim_end_matches('/'))
            };

            let auth_header = if token.starts_with("PVEAPIToken=") || token.starts_with("PVEAPIToken ") {
                token.to_string()
            } else {
                format!("PVEAPIToken={token}")
            };

            let res_url = format!("{base_url}/api2/json/cluster/resources?type=vm");
            let resp = client
                .get(&res_url)
                .header("Authorization", &auth_header)
                .send()
                .await
                .map_err(|e| AppError::Other(format!("Proxmox API request failed: {e}")))?;

            if !resp.status().is_success() {
                let status = resp.status();
                let body = resp.text().await.unwrap_or_default();
                return Err(AppError::Other(format!(
                    "Proxmox VE API error ({status}): {body}"
                )));
            }

            let body = resp
                .text()
                .await
                .map_err(|e| AppError::Other(format!("Failed reading Proxmox response: {e}")))?;

            let entries = parse_proxmox_resources(&body, "")?;
            let mut instances = Vec::with_capacity(entries.len());

            // Best-effort guest IP resolution for running LXC/QEMU instances
            let ip_client = reqwest::Client::builder()
                .timeout(Duration::from_millis(2200))
                .danger_accept_invalid_certs(accept_invalid_certs)
                .build()
                .unwrap_or(client);

            for (vmid, node, vm_type, mut inst) in entries {
                if inst.online {
                    if vm_type == "lxc" {
                        let iface_url =
                            format!("{base_url}/api2/json/nodes/{node}/lxc/{vmid}/interfaces");
                        if let Ok(r) = ip_client
                            .get(&iface_url)
                            .header("Authorization", &auth_header)
                            .send()
                            .await
                        {
                            if let Ok(parsed) = r.json::<ProxmoxLxcIfacesResponse>().await {
                                if let Some(ip) = parsed
                                    .data
                                    .unwrap_or_default()
                                    .into_iter()
                                    .filter(|i| i.name.as_deref() != Some("lo"))
                                    .filter_map(|i| i.inet)
                                    .map(|cidr| cidr.split('/').next().unwrap_or(&cidr).to_string())
                                    .find(|ip| !ip.is_empty() && !ip.starts_with("127."))
                                {
                                    inst.ip = ip;
                                }
                            }
                        }
                    } else if vm_type == "qemu" {
                        let agent_url = format!(
                            "{base_url}/api2/json/nodes/{node}/qemu/{vmid}/agent/network-interfaces"
                        );
                        if let Ok(r) = ip_client
                            .get(&agent_url)
                            .header("Authorization", &auth_header)
                            .send()
                            .await
                        {
                            if let Ok(parsed) = r.json::<ProxmoxQemuIfacesResponse>().await {
                                let ifaces = parsed
                                    .data
                                    .and_then(|d| d.result)
                                    .unwrap_or_default();
                                for iface in ifaces {
                                    if iface.name.as_deref() == Some("lo") {
                                        continue;
                                    }
                                    if let Some(found_ip) = iface
                                        .ip_addresses
                                        .unwrap_or_default()
                                        .into_iter()
                                        .filter(|a| a.ip_type.as_deref() == Some("ipv4"))
                                        .filter_map(|a| a.ip_address)
                                        .find(|ip| !ip.is_empty() && !ip.starts_with("127."))
                                    {
                                        inst.ip = found_ip;
                                        break;
                                    }
                                }
                            }
                        }
                    }
                }
                instances.push(inst);
            }

            Ok(instances)
        }
        other => Err(AppError::Other(format!(
            "Unsupported cloud provider: {other}"
        ))),
    }
}

/// Imports or updates cloud instances as host profiles in the specified vault.
#[tauri::command]
pub fn cloud_import_instances(
    instances: Vec<CloudImportPayload>,
    vault: State<'_, Vault>,
) -> AppResult<usize> {
    if instances.is_empty() {
        return Ok(0);
    }

    let existing_hosts = crate::vault::hosts_list(vault.clone())?;
    let mut imported = 0;

    for item in instances {
        let vault_id = item.vault_id.trim();
        let v_id = if vault_id.is_empty() {
            "personal".to_string()
        } else {
            vault_id.to_string()
        };

        let prov = item.provider.trim().to_lowercase();
        let cloud_tag = format!("cloud:{prov}:{}", item.id);

        // Match existing host in this vault by cloud tag, label, or IP
        let existing_profile = existing_hosts.iter().find(|h| {
            let same_vault = h.vault_id.as_deref().unwrap_or("personal") == v_id;
            same_vault
                && (h.tags.iter().any(|t| t == &cloud_tag)
                    || h.label.eq_ignore_ascii_case(&item.name)
                    || h.hostname == item.ip)
        });

        let (group_name, group_color) = match prov.as_str() {
            "hetzner" => ("Hetzner Cloud", "#ef4444"),
            "digitalocean" => ("DigitalOcean", "#0080ff"),
            "proxmox" => ("Proxmox VE", "#f97316"),
            _ => ("Cloud Fleet", "#38bdf8"),
        };

        let mut tags = item.tags.clone();
        if !tags.iter().any(|t| t == &prov) {
            tags.push(prov.clone());
        }
        if !tags.iter().any(|t| t == &cloud_tag) {
            tags.push(cloud_tag);
        }

        let profile = if let Some(prev) = existing_profile {
            HostProfile {
                id: prev.id.clone(),
                label: item.name,
                hostname: item.ip,
                port: item.port.unwrap_or(prev.port),
                username: if item.username.trim().is_empty() {
                    prev.username.clone()
                } else {
                    item.username.trim().to_string()
                },
                auth_method: prev.auth_method.clone(),
                group: prev.group.clone().or_else(|| Some(group_name.to_string())),
                tags,
                color: prev.color.clone().or_else(|| Some(group_color.to_string())),
                has_secret: prev.has_secret,
                os: item.os.or_else(|| prev.os.clone()),
                keychain_id: prev.keychain_id.clone(),
                jump_host_id: prev.jump_host_id.clone(),
                vault_id: Some(v_id),
                startup_command: prev.startup_command.clone(),
                proxy_command: prev.proxy_command.clone(),
            }
        } else {
            HostProfile {
                id: uuid::Uuid::new_v4().to_string(),
                label: item.name,
                hostname: item.ip,
                port: item.port.unwrap_or(22),
                username: if item.username.trim().is_empty() {
                    "root".to_string()
                } else {
                    item.username.trim().to_string()
                },
                auth_method: AuthMethod::Key,
                group: Some(group_name.to_string()),
                tags,
                color: Some(group_color.to_string()),
                has_secret: false,
                os: item.os,
                keychain_id: None,
                jump_host_id: None,
                vault_id: Some(v_id),
                startup_command: None,
                proxy_command: None,
            }
        };

        crate::vault::host_save(HostInput { profile, secret: None }, vault.clone())?;
        imported += 1;
    }

    Ok(imported)
}

#[tauri::command]
pub fn cloud_get_credentials(vault: State<'_, Vault>) -> AppResult<CloudCredentials> {
    vault.with(|c| {
        let get_key = |k: &str| -> rusqlite::Result<Option<String>> {
            rusqlite::OptionalExtension::optional(c.query_row(
                "SELECT value FROM ai_settings WHERE key = ?1",
                params![k],
                |r| r.get(0),
            ))
        };
        let hetzner_token = get_key("cloud_hetzner_token")?;
        let digitalocean_token = get_key("cloud_do_token")?;
        let proxmox_url = get_key("cloud_proxmox_url")?;
        let proxmox_token = get_key("cloud_proxmox_token")?;
        let proxmox_insecure = get_key("cloud_proxmox_insecure")?
            .map(|v| v != "0" && v != "false")
            .unwrap_or(false);

        Ok(CloudCredentials {
            hetzner_token,
            digitalocean_token,
            proxmox_url,
            proxmox_token,
            proxmox_insecure,
        })
    })
}

#[tauri::command]
pub fn cloud_save_credentials(
    creds: CloudCredentials,
    vault: State<'_, Vault>,
) -> AppResult<()> {
    vault.with(|c| {
        let set_key = |k: &str, v: Option<&str>| -> rusqlite::Result<()> {
            if let Some(val) = v {
                c.execute(
                    "INSERT INTO ai_settings (key, value) VALUES (?1, ?2)
                     ON CONFLICT(key) DO UPDATE SET value = excluded.value",
                    params![k, val.trim()],
                )?;
            }
            Ok(())
        };
        set_key("cloud_hetzner_token", creds.hetzner_token.as_deref())?;
        set_key("cloud_do_token", creds.digitalocean_token.as_deref())?;
        set_key("cloud_proxmox_url", creds.proxmox_url.as_deref())?;
        set_key("cloud_proxmox_token", creds.proxmox_token.as_deref())?;
        set_key(
            "cloud_proxmox_insecure",
            Some(if creds.proxmox_insecure { "1" } else { "0" }),
        )?;
        Ok(())
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_hetzner_servers_and_power_states() {
        let sample = r#"{
            "servers": [
                {
                    "id": 4201,
                    "name": "prod-api-01",
                    "status": "running",
                    "public_net": {
                        "ipv4": { "ip": "159.69.10.20" },
                        "ipv6": { "ip": "2a01:4f8:1c1c::1/64" }
                    },
                    "server_type": { "name": "cpx31" },
                    "datacenter": { "name": "fsn1-dc14" },
                    "image": { "os_flavor": "ubuntu", "name": "ubuntu-24.04" },
                    "labels": { "env": "prod" }
                },
                {
                    "id": 4202,
                    "name": "staging-worker",
                    "status": "off",
                    "public_net": {
                        "ipv4": { "ip": "159.69.10.21" }
                    },
                    "server_type": { "name": "cx22" },
                    "datacenter": { "name": "nbg1-dc3" },
                    "image": { "os_flavor": "debian" }
                }
            ]
        }"#;

        let list = parse_hetzner_response(sample).unwrap();
        assert_eq!(list.len(), 2);
        assert_eq!(list[0].name, "prod-api-01");
        assert_eq!(list[0].ip, "159.69.10.20");
        assert!(list[0].online);
        assert_eq!(list[0].os.as_deref(), Some("ubuntu"));
        assert_eq!(list[0].instance_type.as_deref(), Some("cpx31"));

        assert_eq!(list[1].name, "staging-worker");
        assert!(!list[1].online);
        assert_eq!(list[1].status, "off");
        assert_eq!(list[1].os.as_deref(), Some("debian"));
    }

    #[test]
    fn parses_digitalocean_droplets_and_active_status() {
        let sample = r#"{
            "droplets": [
                {
                    "id": 9901,
                    "name": "do-k8s-node-1",
                    "status": "active",
                    "size_slug": "s-2vcpu-4gb",
                    "region": { "slug": "fra1" },
                    "image": { "distribution": "Rocky Linux", "name": "9.4 x64" },
                    "networks": {
                        "v4": [
                            { "ip_address": "10.114.0.2", "type": "private" },
                            { "ip_address": "167.99.200.15", "type": "public" }
                        ]
                    },
                    "tags": ["k8s", "prod"]
                }
            ]
        }"#;

        let list = parse_digitalocean_response(sample).unwrap();
        assert_eq!(list.len(), 1);
        assert_eq!(list[0].name, "do-k8s-node-1");
        assert_eq!(list[0].ip, "167.99.200.15");
        assert!(list[0].online);
        assert_eq!(list[0].status, "running");
        assert_eq!(list[0].os.as_deref(), Some("rocky"));
        assert!(list[0].tags.contains(&"k8s".to_string()));
    }

    #[test]
    fn parses_proxmox_cluster_resources_and_skips_templates() {
        let sample = r#"{
            "data": [
                {
                    "vmid": 100,
                    "name": "ct-nextcloud",
                    "node": "pve01",
                    "type": "lxc",
                    "status": "running",
                    "tags": "storage;homelab",
                    "template": 0
                },
                {
                    "vmid": 9000,
                    "name": "ubuntu-cloudinit-template",
                    "node": "pve01",
                    "type": "qemu",
                    "status": "stopped",
                    "template": 1
                }
            ]
        }"#;

        let list = parse_proxmox_resources(sample, "192.168.1.50").unwrap();
        assert_eq!(list.len(), 1);
        assert_eq!(list[0].3.name, "ct-nextcloud");
        assert!(list[0].3.online);
        assert_eq!(list[0].3.instance_type.as_deref(), Some("lxc #100"));
        assert!(list[0].3.tags.contains(&"homelab".to_string()));
    }
}
