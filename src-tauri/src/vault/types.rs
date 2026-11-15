//! Data structures and DTOs for the encrypted local vault.

use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use zeroize::{Zeroize, ZeroizeOnDrop};

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct VaultRecord {
    pub id: String,
    pub name: String,
    pub kind: String, // "personal" | "team"
    pub color: Option<String>,
    pub description: Option<String>,
    pub created_at: i64,
    #[serde(default)]
    pub role: Option<String>, // "owner" | "editor" | "readonly"
    #[serde(default)]
    pub relay_url: Option<String>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, Zeroize, ZeroizeOnDrop)]
#[serde(rename_all = "camelCase")]
pub struct SharedSecret {
    pub password: Option<String>,
    pub private_key: Option<String>,
    pub passphrase: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Zeroize, ZeroizeOnDrop)]
#[serde(rename_all = "camelCase")]
pub struct TeamRelayBundleConfig {
    pub relay_url: String,
    pub relay_token: String,
    pub relay_seed: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SerialPortInfo {
    pub port_name: String,
    pub description: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AiProviderConfig {
    pub provider_id: String,
    pub name: String,
    pub base_url: String,
    pub api_keys: Vec<String>,
    pub selected_model: String,
    pub models_cache: Vec<String>,
    pub balance_strategy: String, // "round_robin" | "p2c" | "random"
    pub enabled: bool,
    pub updated_at: i64,
    #[serde(default)]
    pub use_proxies: bool,
    #[serde(default)]
    pub proxy_urls: Vec<String>,
    #[serde(default = "default_proxy_strategy")]
    pub proxy_strategy: String,
    #[serde(default)]
    pub auto_ssh_proxy: bool,
    #[serde(default)]
    pub auto_ssh_host_id: Option<String>,
}

fn default_proxy_strategy() -> String {
    "p2c".into()
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TeamVaultPayload {
    pub vault: VaultRecord,
    pub hosts: Vec<HostProfile>,
    pub keychain: Vec<KeychainItem>,
    pub tunnels: Vec<TunnelConfig>,
    pub snippets: Vec<Snippet>,
    #[serde(default)]
    pub ai_configs: Vec<AiProviderConfig>,
    #[serde(default)]
    pub include_secrets: bool,
    #[serde(default)]
    pub host_secrets: HashMap<String, SharedSecret>,
    #[serde(default)]
    pub keychain_secrets: HashMap<String, SharedSecret>,
    #[serde(default)]
    pub team_relay: Option<TeamRelayBundleConfig>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EncryptedTeamVaultBundle {
    pub version: u32,
    pub format: String,
    pub vault_name: String,
    pub salt: String,
    pub nonce: String,
    pub ciphertext: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PairedDevice {
    pub id: String,
    pub device_name: String,
    pub device_type: String,
    pub ip_address: Option<String>,
    pub public_key: Option<String>,
    pub paired_at: i64,
    pub last_sync: i64,
    /// Stable peer device identity (`sync_device_id`) reported at pairing.
    /// Legacy peers that predate the field send an empty string.
    #[serde(default)]
    pub device_id: String,
    /// When set, this peer is revoked: it is refused at future pairings.
    pub revoked_at: Option<i64>,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum AuthMethod {
    Password,
    Key,
    Agent,
}

impl AuthMethod {
    pub fn as_str(&self) -> &'static str {
        match self {
            AuthMethod::Password => "password",
            AuthMethod::Key => "key",
            AuthMethod::Agent => "agent",
        }
    }
    pub fn parse(s: &str) -> Self {
        match s {
            "key" => AuthMethod::Key,
            "agent" => AuthMethod::Agent,
            _ => AuthMethod::Password,
        }
    }
}

/// Non-secret host metadata — safe to send to the WebView.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HostProfile {
    pub id: String,
    pub label: String,
    pub hostname: String,
    pub port: u16,
    pub username: String,
    pub auth_method: AuthMethod,
    pub group: Option<String>,
    pub tags: Vec<String>,
    pub color: Option<String>,
    pub has_secret: bool,
    #[serde(default)]
    pub os: Option<String>,
    #[serde(default)]
    pub keychain_id: Option<String>,
    #[serde(default)]
    pub jump_host_id: Option<String>,
    #[serde(default)]
    pub vault_id: Option<String>,
    #[serde(default)]
    pub startup_command: Option<String>,
    #[serde(default)]
    pub proxy_command: Option<String>,
}

/// Credentials — never serialized back to the frontend. Wiped on drop.
#[derive(Default, Clone, Deserialize, Zeroize, ZeroizeOnDrop)]
#[serde(rename_all = "camelCase")]
pub struct HostSecret {
    pub password: Option<String>,
    pub private_key: Option<String>,
    pub passphrase: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HostInput {
    #[serde(flatten)]
    pub profile: HostProfile,
    /// `None` = keep existing secret.
    pub secret: Option<HostSecret>,
}

/// Reusable Identity in Keychain (stored encrypted in the vault)
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct KeychainItem {
    pub id: String,
    pub label: String,
    pub username: Option<String>,
    pub auth_method: AuthMethod,
    pub has_secret: bool,
    pub updated_at: i64,
    #[serde(default)]
    pub vault_id: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct KeychainInput {
    pub id: String,
    pub label: String,
    pub username: Option<String>,
    pub auth_method: AuthMethod,
    pub password: Option<String>,
    pub private_key: Option<String>,
    pub passphrase: Option<String>,
    pub vault_id: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConnectionLog {
    pub id: String,
    pub host_id: Option<String>,
    pub host_label: String,
    pub username: String,
    pub hostname: String,
    pub started_at: i64,
    pub ended_at: Option<i64>,
    pub duration: Option<i64>,
    pub status: String,
    pub saved: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct KnownHost {
    pub host: String,
    pub port: u16,
    pub fingerprint: String,
    pub added_at: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TunnelConfig {
    pub id: String,
    pub label: String,
    pub host_id: String,
    pub forward_type: String, // "local", "remote", "dynamic"
    pub local_host: String,
    pub local_port: u16,
    pub remote_host: String,
    pub remote_port: u16,
    #[serde(default)]
    pub updated_at: i64,
    #[serde(default)]
    pub vault_id: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Snippet {
    pub id: String,
    pub name: String,
    pub command: String,
    pub folder: Option<String>,
    pub tags: Vec<String>,
    #[serde(default)]
    pub vault_id: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VaultStatus {
    pub initialized: bool,
    pub unlocked: bool,
}
