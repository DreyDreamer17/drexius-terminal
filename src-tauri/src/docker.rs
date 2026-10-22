//! Docker container manager for local shells and remote SSH hosts.
//! Inspects running/stopped containers, streams logs, and executes actions.

use crate::error::{AppError, AppResult};
use crate::vault::Vault;
use serde::{Deserialize, Serialize};
use std::io::Read;
use std::process::Command;
use tauri::State;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DockerContainer {
    pub id: String,
    pub names: String,
    pub image: String,
    pub status: String,
    pub state: String,
    pub ports: String,
    pub created_at: String,
    pub command: String,
}

#[derive(Deserialize)]
struct RawDockerPs {
    #[serde(rename = "ID")]
    id: Option<String>,
    #[serde(rename = "Names")]
    names: Option<String>,
    #[serde(rename = "Image")]
    image: Option<String>,
    #[serde(rename = "Status")]
    status: Option<String>,
    #[serde(rename = "State")]
    state: Option<String>,
    #[serde(rename = "Ports")]
    ports: Option<String>,
    #[serde(rename = "CreatedAt")]
    created_at: Option<String>,
    #[serde(rename = "Command")]
    command: Option<String>,
}

fn exec_on_target(
    host_id: &str,
    cmd: &str,
    vault: &State<'_, Vault>,
) -> AppResult<String> {
    if host_id == "__local__" || host_id.is_empty() || host_id == "local" {
        let out = Command::new("sh")
            .args(["-c", cmd])
            .output()
            .map_err(|e| AppError::Other(format!("Failed to execute command locally: {e}")))?;
        let stdout = String::from_utf8_lossy(&out.stdout).to_string();
        let stderr = String::from_utf8_lossy(&out.stderr).to_string();
        if !out.status.success() && stdout.trim().is_empty() {
            return Err(AppError::Other(if !stderr.trim().is_empty() { stderr.trim().to_string() } else { format!("Process exited with status {}", out.status) }));
        }
        Ok(if !stdout.trim().is_empty() { stdout } else { stderr })
    } else {
        let (host, secret) = vault.host_with_secret(host_id)?;
        let (sess, _fp) = crate::ssh::open_authenticated(&host, &secret, vault)?;
        let mut ch = sess.channel_session()?;
        sess.set_timeout(10000);
        ch.exec(cmd)?;
        let mut out = String::new();
        let _ = ch.read_to_string(&mut out);
        let mut err = String::new();
        let _ = ch.stderr().read_to_string(&mut err);
        let _ = ch.wait_close();
        if out.trim().is_empty() && !err.trim().is_empty() {
            return Err(AppError::Other(err.trim().to_string()));
        }
        Ok(if !out.trim().is_empty() { out } else { err })
    }
}

/// Lists all Docker containers (running and stopped) on the target host.
#[tauri::command(async)]
pub fn docker_list_containers(
    host_id: String,
    vault: State<'_, Vault>,
) -> AppResult<Vec<DockerContainer>> {
    let cmd = "docker ps -a --no-trunc --format '{{json .}}'";
    let out = exec_on_target(&host_id, cmd, &vault).map_err(|e| {
        let msg = e.to_string();
        if msg.contains("not found") || msg.contains("No such file") {
            AppError::Other("Docker is not installed or not in PATH on this host.".into())
        } else if msg.contains("permission denied") || msg.contains("Got permission denied") {
            AppError::Other("Permission denied connecting to Docker socket. Add user to docker group: `sudo usermod -aG docker $USER`".into())
        } else if msg.contains("Cannot connect") || msg.contains("Is the docker daemon running") {
            AppError::Other("Docker daemon is not running on this host.".into())
        } else {
            e
        }
    })?;

    let mut containers = Vec::new();
    for line in out.lines() {
        let line = line.trim();
        if line.is_empty() {
            continue;
        }
        if let Ok(raw) = serde_json::from_str::<RawDockerPs>(line) {
            let id = raw.id.unwrap_or_default();
            let short_id = if id.len() > 12 { &id[..12] } else { &id };
            containers.push(DockerContainer {
                id: short_id.to_string(),
                names: raw.names.unwrap_or_default().trim_start_matches('/').to_string(),
                image: raw.image.unwrap_or_default(),
                status: raw.status.unwrap_or_default(),
                state: raw.state.unwrap_or_else(|| "unknown".into()),
                ports: raw.ports.unwrap_or_default(),
                created_at: raw.created_at.unwrap_or_default(),
                command: raw.command.unwrap_or_default(),
            });
        }
    }

    Ok(containers)
}

/// Executes a container lifecycle action (start, stop, restart, pause, unpause).
#[tauri::command(async)]
pub fn docker_container_action(
    host_id: String,
    container_id: String,
    action: String,
    vault: State<'_, Vault>,
) -> AppResult<String> {
    let allowed = ["start", "stop", "restart", "pause", "unpause"];
    if !allowed.contains(&action.as_str()) {
        return Err(AppError::Other(format!("Invalid action: {action}")));
    }
    let safe_id = container_id.replace(|c: char| !c.is_alphanumeric() && c != '_' && c != '-', "");
    let cmd = format!("docker {action} {safe_id}");
    exec_on_target(&host_id, &cmd, &vault)
}

/// Fetches the last N lines of logs for a container.
#[tauri::command(async)]
pub fn docker_container_logs(
    host_id: String,
    container_id: String,
    tail: Option<u32>,
    vault: State<'_, Vault>,
) -> AppResult<String> {
    let safe_id = container_id.replace(|c: char| !c.is_alphanumeric() && c != '_' && c != '-', "");
    let t = tail.unwrap_or(200).min(1000);
    let cmd = format!("docker logs --tail {t} {safe_id} 2>&1");
    exec_on_target(&host_id, &cmd, &vault)
}
