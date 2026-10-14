//! OpenCode Free Models Integration.
//!
//! Checks whether OpenCode CLI is installed on the user's system, lists available free models,
//! and runs inference via the local `opencode run` CLI streaming stdout JSON events.

use crate::ai_client::AiStreamEvent;
use crate::ssh::SshManager;
use crate::vault::{HostProfile, HostSecret, Vault};
use parking_lot::Mutex;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::OnceLock;
use std::time::{Duration, Instant};
use tauri::State;
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::sync::oneshot;

#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct OpencodeHostStatus {
    pub is_remote: bool,
    pub host_id: Option<String>,
    pub host_label: Option<String>,
    pub installed: bool,
    pub binary_path: Option<String>,
}

static REMOTE_PROBE_CACHE: OnceLock<Mutex<HashMap<String, (bool, Option<String>, Instant)>>> = OnceLock::new();

#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct OpencodeStatus {
    pub installed: bool,
    pub binary_path: Option<String>,
    pub models: Vec<String>,
}

fn cancel_channels() -> &'static Mutex<HashMap<String, oneshot::Sender<()>>> {
    static CHANNELS: OnceLock<Mutex<HashMap<String, oneshot::Sender<()>>>> = OnceLock::new();
    CHANNELS.get_or_init(|| Mutex::new(HashMap::new()))
}

/// Fallback list of curated high-quality free models provided by OpenCode.
pub fn default_free_models() -> Vec<String> {
    vec![
        "opencode/nemotron-3-ultra-free".to_string(),
        "opencode/nemotron-3.5-lightning-free".to_string(),
        "opencode/ling-3.1-flash-free".to_string(),
        "opencode/ling-3.0-flash-fin-free".to_string(),
        "opencode/big-pickle".to_string(),
        "opencode/exo-free".to_string(),
        "opencode/longcat-2.5-preview-free".to_string(),
        "opencode/mimo-v2.6-flash-free".to_string(),
        "opencode/muse-spark-1.3-contributor-free".to_string(),
        "opencode/space-bunny-free".to_string(),
        "opencode/step-5-preview-free".to_string(),
    ]
}

/// Locate the `opencode` binary on the machine.
pub fn find_opencode_binary() -> Option<PathBuf> {
    // 1. Check user PATH
    if let Ok(path_var) = std::env::var("PATH") {
        let separator = if cfg!(windows) { ';' } else { ':' };
        for dir in path_var.split(separator) {
            let candidate = Path::new(dir).join(if cfg!(windows) { "opencode.exe" } else { "opencode" });
            if candidate.is_file() {
                return Some(candidate);
            }
        }
    }

    // 2. Check standard installation location: ~/.opencode/bin/opencode
    if let Some(home) = dirs::home_dir() {
        let candidate = home
            .join(".opencode")
            .join("bin")
            .join(if cfg!(windows) { "opencode.exe" } else { "opencode" });
        if candidate.is_file() {
            return Some(candidate);
        }
    }

    // 3. Check common UNIX locations
    #[cfg(unix)]
    {
        for p in &["/usr/local/bin/opencode", "/usr/bin/opencode", "/opt/opencode/bin/opencode"] {
            let path = PathBuf::from(p);
            if path.is_file() {
                return Some(path);
            }
        }
    }

    None
}

/// Helper to determine if a model is considered a free OpenCode model.
pub fn is_free_model(model: &str) -> bool {
    let m = model.to_lowercase();
    m.starts_with("opencode/")
        || m.ends_with("-free")
        || m.contains(":free")
        || m.contains("/free")
        || m == "opencode/big-pickle"
}

/// Detect whether OpenCode is installed and retrieve all models, sorting free models to the top.
#[tauri::command]
pub async fn opencode_detect() -> Result<OpencodeStatus, String> {
    let bin_path = match find_opencode_binary() {
        Some(p) => p,
        None => {
            return Ok(OpencodeStatus {
                installed: false,
                binary_path: None,
                models: Vec::new(),
            });
        }
    };

    let bin_str = bin_path.to_string_lossy().to_string();

    let mut free_models = Vec::new();
    let mut other_models = Vec::new();

    // Query all models from `opencode models` (unfiltered)
    let query_res = tokio::time::timeout(
        std::time::Duration::from_secs(8),
        tokio::process::Command::new(&bin_path)
            .arg("models")
            .output(),
    )
    .await;

    if let Ok(Ok(output)) = query_res {
        if output.status.success() {
            let stdout = String::from_utf8_lossy(&output.stdout);
            for line in stdout.lines() {
                let trimmed = line.trim();
                if trimmed.is_empty()
                    || trimmed.starts_with('#')
                    || trimmed.starts_with('┌')
                    || trimmed.starts_with('│')
                    || trimmed.starts_with('└')
                    || trimmed.starts_with('●')
                {
                    continue;
                }
                if is_free_model(trimmed) {
                    if !free_models.contains(&trimmed.to_string()) {
                        free_models.push(trimmed.to_string());
                    }
                } else {
                    if !other_models.contains(&trimmed.to_string()) {
                        other_models.push(trimmed.to_string());
                    }
                }
            }
        }
    }

    if free_models.is_empty() {
        free_models = default_free_models();
    }

    // Free models first, followed by all other configured models
    let mut all_models = free_models;
    all_models.extend(other_models);

    Ok(OpencodeStatus {
        installed: true,
        binary_path: Some(bin_str),
        models: all_models,
    })
}

/// Probe whether OpenCode is installed on a remote host via SSH.
pub async fn detect_remote_opencode(host_id: &str, vault: &Vault) -> Result<Option<String>, String> {
    if let Some((installed, path, ts)) = REMOTE_PROBE_CACHE
        .get_or_init(|| Mutex::new(HashMap::new()))
        .lock()
        .get(host_id)
    {
        if ts.elapsed() < Duration::from_secs(60) {
            return Ok(if *installed { path.clone() } else { None });
        }
    }

    let (host, secret) = vault.host_with_secret(host_id).map_err(|e| e.to_string())?;
    let (sess, _) = crate::ssh::open_authenticated(&host, &secret, vault)
        .map_err(|e| format!("Failed to reach host: {}", e))?;
    let _ = sess.set_timeout(3500);
    let mut ch = sess
        .channel_session()
        .map_err(|e| format!("Failed to open channel: {}", e))?;
    ch.exec("export PATH=\"$HOME/.opencode/bin:$HOME/.local/bin:$PATH\"; command -v opencode 2>/dev/null || (test -x \"$HOME/.opencode/bin/opencode\" && echo \"$HOME/.opencode/bin/opencode\")")
        .map_err(|e| format!("Exec failed: {}", e))?;
    let mut out = String::new();
    use std::io::Read;
    let _ = ch.read_to_string(&mut out);
    let _ = ch.wait_close();
    let trimmed = out.trim();
    let result = if !trimmed.is_empty() && !trimmed.contains("not found") {
        Some(trimmed.to_string())
    } else {
        None
    };

    let installed = result.is_some();
    let path = result.clone();
    REMOTE_PROBE_CACHE
        .get_or_init(|| Mutex::new(HashMap::new()))
        .lock()
        .insert(host_id.to_string(), (installed, path, Instant::now()));

    Ok(result)
}

/// Invalidate cached probe status for a host (e.g. after user runs installation script).
pub fn invalidate_remote_probe_cache(host_id: &str) {
    if let Some(cache) = REMOTE_PROBE_CACHE.get() {
        cache.lock().remove(host_id);
    }
}

/// Detect whether OpenCode is installed on the active session target (remote SSH host or local).
#[tauri::command]
pub async fn opencode_detect_session(
    session_id: Option<String>,
    host_id: Option<String>,
    force: Option<bool>,
    ssh: State<'_, SshManager>,
    vault: State<'_, Vault>,
) -> Result<OpencodeHostStatus, String> {
    let target_host_id = host_id
        .filter(|h| h != "__local__" && !h.starts_with("local") && !h.starts_with("serial_"))
        .or_else(|| {
            session_id.as_deref().and_then(|sid| ssh.host_of(sid).ok())
        });

    if let Some(hid) = target_host_id {
        if let Ok((host, _)) = vault.host_with_secret(&hid) {
            let host_label = host.label.clone();

            let force_refresh = force.unwrap_or(false);
            if force_refresh {
                invalidate_remote_probe_cache(&hid);
            } else if let Some((installed, path, ts)) = REMOTE_PROBE_CACHE
                .get_or_init(|| Mutex::new(HashMap::new()))
                .lock()
                .get(&hid)
            {
                if ts.elapsed() < Duration::from_secs(60) {
                    return Ok(OpencodeHostStatus {
                        is_remote: true,
                        host_id: Some(hid),
                        host_label: Some(host_label),
                        installed: *installed,
                        binary_path: path.clone(),
                    });
                }
            }

            let detected = detect_remote_opencode(&hid, &vault).await?;
            let installed = detected.is_some();
            return Ok(OpencodeHostStatus {
                is_remote: true,
                host_id: Some(hid),
                host_label: Some(host_label),
                installed,
                binary_path: detected,
            });
        }
    }

    let local_bin = find_opencode_binary();
    let installed = local_bin.is_some();
    Ok(OpencodeHostStatus {
        is_remote: false,
        host_id: None,
        host_label: None,
        installed,
        binary_path: local_bin.map(|p| p.to_string_lossy().into_owned()),
    })
}

#[derive(Deserialize, Debug)]
struct OpencodeJsonLine {
    #[serde(rename = "type")]
    event_type: Option<String>,
    part: Option<OpencodeJsonPart>,
    error: Option<serde_json::Value>,
}

#[derive(Deserialize, Debug)]
struct OpencodeJsonPart {
    text: Option<String>,
    tool: Option<String>,
    state: Option<OpencodeToolState>,
}

#[derive(Deserialize, Debug)]
struct OpencodeToolState {
    status: Option<String>,
    input: Option<serde_json::Value>,
    output: Option<serde_json::Value>,
    error: Option<String>,
    metadata: Option<OpencodeToolMetadata>,
    time: Option<OpencodeToolTime>,
}

#[derive(Deserialize, Debug)]
#[allow(dead_code)]
struct OpencodeToolMetadata {
    exit: Option<i32>,
    truncated: Option<bool>,
    title: Option<String>,
}

#[derive(Deserialize, Debug)]
struct OpencodeToolTime {
    start: Option<u64>,
    end: Option<u64>,
}

#[derive(Serialize)]
struct OpencodeWorkflowPayload {
    tool: String,
    target: String,
    status: String,
    #[serde(rename = "exit_code")]
    exit_code: Option<i32>,
    #[serde(rename = "duration_ms")]
    duration_ms: Option<u64>,
    output: String,
}

fn safe_truncate_str(s: &str, max_bytes: usize) -> &str {
    if s.len() <= max_bytes {
        return s;
    }
    let mut end = max_bytes;
    while end > 0 && !s.is_char_boundary(end) {
        end -= 1;
    }
    &s[..end]
}

fn format_tool_workflow_block(part: &OpencodeJsonPart) -> Option<String> {
    let tool_name = part.tool.as_deref().unwrap_or("tool");
    let state = part.state.as_ref()?;
    let status = state.status.as_deref().unwrap_or("completed");

    let exit_code = state.metadata.as_ref().and_then(|m| m.exit);
    let duration_ms = state.time.as_ref().and_then(|t| {
        if let (Some(start), Some(end)) = (t.start, t.end) {
            if end >= start {
                Some(end - start)
            } else {
                None
            }
        } else {
            None
        }
    });

    let target = if let Some(input) = &state.input {
        if let Some(cmd) = input.get("command").and_then(|v| v.as_str()) {
            cmd.to_string()
        } else if let Some(path) = input.get("filePath").or_else(|| input.get("path")).or_else(|| input.get("file")).and_then(|v| v.as_str()) {
            path.to_string()
        } else if let Some(pattern) = input.get("pattern").and_then(|v| v.as_str()) {
            pattern.to_string()
        } else if let Some(query) = input.get("query").and_then(|v| v.as_str()) {
            query.to_string()
        } else if let Some(url) = input.get("url").and_then(|v| v.as_str()) {
            url.to_string()
        } else {
            input.to_string()
        }
    } else {
        String::new()
    };

    let target = if !target.is_empty() {
        target
    } else if let Some(title) = state.metadata.as_ref().and_then(|m| m.title.as_ref()) {
        title.clone()
    } else {
        String::new()
    };

    let raw_output = if let Some(out) = &state.output {
        if let Some(s) = out.as_str() {
            s.to_string()
        } else {
            serde_json::to_string_pretty(out).unwrap_or_default()
        }
    } else if let Some(err) = &state.error {
        err.clone()
    } else {
        String::new()
    };

    let output = if raw_output.len() > 8000 {
        format!("{}\n\n... [output truncated at 8000 bytes] ...", safe_truncate_str(&raw_output, 8000))
    } else {
        raw_output
    };

    let payload = OpencodeWorkflowPayload {
        tool: tool_name.to_string(),
        target,
        status: status.to_string(),
        exit_code,
        duration_ms,
        output,
    };

    if let Ok(json_str) = serde_json::to_string(&payload) {
        Some(format!("\n\n```opencode_workflow\n{}\n```\n\n", json_str))
    } else {
        None
    }
}

struct CancelGuard(Option<String>);
impl Drop for CancelGuard {
    fn drop(&mut self) {
        if let Some(id) = &self.0 {
            cancel_channels().lock().remove(id);
        }
    }
}

/// Dedicated scratch directory for OpenCode runs (created on demand).
fn ai_workspace_dir() -> PathBuf {
    dirs::home_dir()
        .unwrap_or_else(std::env::temp_dir)
        .join("NexusTerminal")
        .join("ai-workspace")
}

/// Cancel an ongoing OpenCode stream if running.
#[tauri::command]
pub async fn opencode_stream_cancel(stream_id: String) -> Result<(), String> {
    if let Some(tx) = cancel_channels().lock().remove(&stream_id) {
        let _ = tx.send(());
    }
    Ok(())
}

/// Emit text chunks immediately to the UI channel without synthetic sleep delays.
async fn emit_chunked_stream(
    text: &str,
    channel: &tauri::ipc::Channel<AiStreamEvent>,
    cancel_rx: &mut oneshot::Receiver<()>,
) -> bool {
    if text.is_empty() {
        return true;
    }
    if cancel_rx.try_recv().is_ok() {
        return false;
    }
    let _ = channel.send(AiStreamEvent::Data { text: text.to_string() });
    true
}

// ── OpenCode permission policy ───────────────────────────────────────────────
// Deny-by-default, read-only agent. OpenCode evaluates permission rules with
// LAST-MATCH-WINS wildcard globs, so this JSON's key order is load-bearing:
//
//   1. catch-all `"*"` first,
//   2. explicit allows for read-only commands,
//   3. hard denials LAST (they beat the allows above them).
//
// It is shipped as a raw string (never round-tripped through serde_json, whose
// default map ordering would scramble the sequence).
//
// Two matcher generations in the wild are both covered:
//   • newer OpenCode parses the shell line and permission-checks each parsed
//     command separately (its `resource` includes any redirect text);
//   • older builds glob the whole line — the trailing operator/redirect denials
//     (`*;*`, `*&&*`, `*|*`, `*>*`, …) are what stop `ls ; rm -rf /` smuggling
//     there. On new builds those denials only fire on the command that
//     actually contains the operator.
//
// `--auto` is deliberately NOT passed anymore: it auto-approves every `ask`,
// which would defeat `doom_loop: ask` and any future mis-globbed rule. With
// this policy every rule is `allow` or `deny`, so autonomy no longer depends
// on the auto-approve flag.
//
// Output redirection (`>`, `2>`, `>>`) is denied wholesale — `>` is the one
// shell primitive that turns any allowed read command into a file write. (The
// bash tool returns stderr to the model anyway, so `2>/dev/null` is not needed.)
//
// The two `__TOP_FALLBACK__` / `__BASH_FALLBACK__` slots are filled per mode:
// autonomous runs hard-block anything unlisted; assisted runs ask (and the
// headless `opencode run` auto-rejects asks with model-visible feedback).
const PERMISSION_CONFIG_TEMPLATE: &str = r#"{
    "permission": {
        "*": "__TOP_FALLBACK__",
        "read": "allow",
        "glob": "allow",
        "grep": "allow",
        "question": "allow",
        "doom_loop": "ask",
        "edit": "deny",
        "webfetch": "deny",
        "websearch": "deny",
        "task": "deny",
        "skill": "deny",
        "lsp": "deny",
        "external_directory": {
            "*": "deny",
            "/*": "allow",
            "~/*": "allow",
            "~/.ssh": "deny",
            "~/.ssh/*": "deny",
            "~/.gnupg/*": "deny",
            "~/.aws/*": "deny",
            "~/.kube/*": "deny",
            "~/.docker/*": "deny",
            "~/.password-store/*": "deny",
            "~/.netrc": "deny",
            "~/.git-credentials": "deny",
            "/*/.ssh/*": "deny",
            "/*/.gnupg/*": "deny",
            "/*/.aws/*": "deny",
            "/*/.kube/*": "deny",
            "/*/.docker/*": "deny",
            "/*/.password-store/*": "deny",
            "/*/.netrc": "deny",
            "/*/.git-credentials": "deny",
            "/*/*/nexus.vault*": "deny",
            "/*/dev.nexusterminal.app/*": "deny",
            "~/.local/share/dev.nexusterminal.app/*": "deny"
        },
        "bash": {
            "*": "__BASH_FALLBACK__",
            "ls *": "allow",
            "lsblk *": "allow",
            "lsof *": "allow",
            "lsusb *": "allow",
            "lscpu *": "allow",
            "cat *": "allow",
            "head *": "allow",
            "tail *": "allow",
            "wc *": "allow",
            "stat *": "allow",
            "file *": "allow",
            "du *": "allow",
            "df *": "allow",
            "tree *": "allow",
            "grep *": "allow",
            "egrep *": "allow",
            "fgrep *": "allow",
            "rg *": "allow",
            "find *": "allow",
            "pwd": "allow",
            "which *": "allow",
            "whereis *": "allow",
            "command -v *": "allow",
            "whoami": "allow",
            "id *": "allow",
            "date *": "allow",
            "uname *": "allow",
            "hostname *": "allow",
            "uptime *": "allow",
            "free *": "allow",
            "ps *": "allow",
            "top *": "allow",
            "systemctl status *": "allow",
            "systemctl is-active *": "allow",
            "systemctl is-enabled *": "allow",
            "systemctl is-failed *": "allow",
            "systemctl list-units *": "allow",
            "systemctl list-unit-files *": "allow",
            "systemctl list-timers *": "allow",
            "systemctl show *": "allow",
            "systemctl cat *": "allow",
            "journalctl *": "allow",
            "crontab -l *": "allow",
            "docker ps *": "allow",
            "docker logs *": "allow",
            "docker inspect *": "allow",
            "docker images *": "allow",
            "docker version *": "allow",
            "docker info *": "allow",
            "docker top *": "allow",
            "git status *": "allow",
            "git log *": "allow",
            "git diff *": "allow",
            "git show *": "allow",
            "git blame *": "allow",
            "git rev-parse *": "allow",
            "git describe *": "allow",
            "git remote -v *": "allow",
            "git config --get *": "allow",
            "git config --list *": "allow",
            "git branch *": "allow",
            "echo *": "allow",
            "true": "allow",
            "false": "allow",
            "sleep *": "allow",
            "md5sum *": "allow",
            "sha1sum *": "allow",
            "sha256sum *": "allow",
            "sha512sum *": "allow",
            "find*-delete*": "deny",
            "find*-exec*": "deny",
            "find*-execdir*": "deny",
            "find*-ok*": "deny",
            "find*-okdir*": "deny",
            "find*-fprint*": "deny",
            "find*-fprintf*": "deny",
            "find*-fls*": "deny",
            "journalctl*--vacuum*": "deny",
            "journalctl*--rotate*": "deny",
            "journalctl*--flush*": "deny",
            "git branch -d*": "deny",
            "git branch -D*": "deny",
            "git branch --delete*": "deny",
            "git branch -m*": "deny",
            "git branch -M*": "deny",
            "git branch --move*": "deny",
            "git branch -f*": "deny",
            "git branch --force*": "deny",
            "git branch -c*": "deny",
            "git branch -C*": "deny",
            "git branch --copy*": "deny",
            "*--output=*": "deny",
            "* *.env*": "deny",
            "*>*": "deny",
            "*;*": "deny",
            "*&&*": "deny",
            "*||*": "deny",
            "*|*": "deny",
            "*$(*": "deny",
            "*`*": "deny",
            "*<(*": "deny"
        }
    }
}"#;

/// Build the OpenCode permission config as a raw JSON string (never via
/// serde_json — its map ordering would break the last-match-wins sequence).
fn get_permission_config(autonomous: bool) -> String {
    let (top, bash) = if autonomous {
        ("deny", "deny")
    } else {
        ("ask", "ask")
    };
    PERMISSION_CONFIG_TEMPLATE
        .replace("__TOP_FALLBACK__", top)
        .replace("__BASH_FALLBACK__", bash)
}

struct OpenCodeStreamState {
    had_reasoning: bool,
    reasoning_done: bool,
    last_error_msg: Option<String>,
}

impl OpenCodeStreamState {
    fn new() -> Self {
        Self {
            had_reasoning: false,
            reasoning_done: false,
            last_error_msg: None,
        }
    }

    async fn handle_line(
        &mut self,
        line: &str,
        channel: &tauri::ipc::Channel<AiStreamEvent>,
        cancel_rx: &mut oneshot::Receiver<()>,
    ) -> Result<bool, ()> {
        let trimmed = line.trim();
        if trimmed.is_empty() {
            return Ok(true);
        }
        let Ok(parsed) = serde_json::from_str::<OpencodeJsonLine>(trimmed) else {
            return Ok(true);
        };

        match parsed.event_type.as_deref() {
            Some("reasoning") => {
                if let Some(part) = parsed.part {
                    if let Some(text) = part.text {
                        if !text.is_empty() {
                            if !self.had_reasoning {
                                self.had_reasoning = true;
                                let _ = channel.send(AiStreamEvent::Data {
                                    text: "💭 *Thinking…*\n> ".to_string(),
                                });
                            }
                            let formatted = text.replace('\n', "\n> ");
                            if !emit_chunked_stream(&formatted, channel, cancel_rx).await {
                                return Err(());
                            }
                        }
                    }
                }
            }
            Some("text") => {
                if let Some(part) = parsed.part {
                    if let Some(text) = part.text {
                        if !text.is_empty() {
                            if self.had_reasoning && !self.reasoning_done {
                                self.reasoning_done = true;
                                let _ = channel.send(AiStreamEvent::Data {
                                    text: "\n\n---\n\n".to_string(),
                                });
                            }
                            if !emit_chunked_stream(&text, channel, cancel_rx).await {
                                return Err(());
                            }
                        }
                    }
                }
            }
            Some("tool_use") => {
                if self.had_reasoning && !self.reasoning_done {
                    self.reasoning_done = true;
                    let _ = channel.send(AiStreamEvent::Data {
                        text: "\n\n---\n\n".to_string(),
                    });
                }
                if let Some(part) = &parsed.part {
                    if let Some(block) = format_tool_workflow_block(part) {
                        let _ = channel.send(AiStreamEvent::Data { text: block });
                    }
                }
            }
            Some("error") => {
                let msg = if let Some(err_val) = &parsed.error {
                    if let Some(s) = err_val.as_str() {
                        s.to_string()
                    } else if let Some(o) = err_val.as_object() {
                        o.get("message")
                            .and_then(|v| v.as_str())
                            .unwrap_or("Unknown OpenCode error")
                            .to_string()
                    } else {
                        err_val.to_string()
                    }
                } else {
                    "Unknown OpenCode error".to_string()
                };
                self.last_error_msg = Some(msg);
            }
            _ => {}
        }

        Ok(true)
    }
}

/// Stream OpenCode execution remotely over SSH.
async fn opencode_stream_remote(
    host: HostProfile,
    secret: HostSecret,
    model: String,
    prompt: String,
    cwd: Option<String>,
    autonomous: bool,
    stream_id: String,
    channel: tauri::ipc::Channel<AiStreamEvent>,
    mut cancel_rx: oneshot::Receiver<()>,
    vault: &Vault,
) -> Result<(), String> {
    let key_mask = if is_free_model(&model) {
        format!("Free (Remote: {})", host.label)
    } else {
        let provider = model.split('/').next().unwrap_or("opencode");
        format!("OpenCode [{}] ({})", provider, host.label)
    };

    let _ = channel.send(AiStreamEvent::Meta {
        key_mask: Some(key_mask),
        proxy_mask: None,
    });

    let (sess, _) = crate::ssh::open_authenticated(&host, &secret, vault)
        .map_err(|e| format!("Failed to authenticate SSH for remote OpenCode: {}", e))?;
    let _ = sess.set_timeout(30_000);

    let mut ch = sess
        .channel_session()
        .map_err(|e| format!("Failed to open remote exec channel: {}", e))?;

    let perm_json = get_permission_config(autonomous);
    let dir_flag = if let Some(ref d) = cwd {
        if !d.trim().is_empty() {
            format!(" --dir {}", crate::ssh::shell_quote(d.trim()))
        } else {
            String::new()
        }
    } else {
        String::new()
    };

    // No `--auto`: it would auto-approve every `ask` rule and defeat
    // `doom_loop: ask` — see PERMISSION_CONFIG_TEMPLATE.
    let cmd = format!(
        "export PATH=\"$HOME/.opencode/bin:$HOME/.local/bin:$PATH\"; \
         BIN=$(command -v opencode 2>/dev/null || (test -x \"$HOME/.opencode/bin/opencode\" && echo \"$HOME/.opencode/bin/opencode\") || echo \"opencode\"); \
         OPENCODE_CONFIG_CONTENT={} \"$BIN\" run --format json --thinking --pure -m {}{}",
        crate::ssh::shell_quote(&perm_json),
        crate::ssh::shell_quote(&model),
        dir_flag,
    );

    ch.exec(&cmd)
        .map_err(|e| format!("Failed to execute OpenCode on remote host: {}", e))?;

    use std::io::{BufRead, BufReader as StdBufReader, Write};
    ch.write_all(prompt.as_bytes())
        .map_err(|e| format!("Failed to send prompt to remote OpenCode stdin: {}", e))?;
    ch.send_eof()
        .map_err(|e| format!("Failed to send EOF to remote OpenCode stdin: {}", e))?;

    let (line_tx, mut line_rx) = tokio::sync::mpsc::channel::<Result<String, String>>(100);

    let sid_short = if stream_id.len() >= 8 { &stream_id[..8] } else { &stream_id };
    std::thread::Builder::new()
        .name(format!("opencode-ssh-{}", sid_short))
        .spawn(move || {
            let mut reader = StdBufReader::new(ch);
            let mut line = String::new();
            loop {
                line.clear();
                match reader.read_line(&mut line) {
                    Ok(0) => break,
                    Ok(_) => {
                        if line_tx.blocking_send(Ok(line.clone())).is_err() {
                            break;
                        }
                    }
                    Err(e) => {
                        let _ = line_tx.blocking_send(Err(e.to_string()));
                        break;
                    }
                }
            }
        })
        .map_err(|e| format!("Failed to spawn reader thread: {}", e))?;

    let mut state = OpenCodeStreamState::new();

    loop {
        tokio::select! {
            _ = &mut cancel_rx => {
                let _ = sess.disconnect(Some(ssh2::DisconnectCode::ByApplication), "Cancelled", None);
                return Ok(());
            }
            item = line_rx.recv() => {
                match item {
                    Some(Ok(line)) => {
                        if state.handle_line(&line, &channel, &mut cancel_rx).await.is_err() {
                            return Ok(());
                        }
                    }
                    Some(Err(err)) => {
                        return Err(format!("Remote OpenCode read error: {}", err));
                    }
                    None => {
                        break;
                    }
                }
            }
        }
    }

    if let Some(err) = state.last_error_msg {
        return Err(format!("Remote OpenCode error: {}", err));
    }

    Ok(())
}

/// Stream OpenCode execution locally in isolated scratch workspace.
async fn opencode_stream_local(
    prompt: String,
    model: String,
    autonomous: bool,
    channel: tauri::ipc::Channel<AiStreamEvent>,
    mut cancel_rx: oneshot::Receiver<()>,
) -> Result<(), String> {
    let bin_path = find_opencode_binary().ok_or_else(|| {
        "OpenCode binary not found on this system. Please verify ~/.opencode/bin/opencode or PATH.".to_string()
    })?;

    let workspace = ai_workspace_dir();
    std::fs::create_dir_all(&workspace)
        .map_err(|e| format!("Failed to create OpenCode workspace {}: {e}", workspace.display()))?;

    let perm_json = get_permission_config(autonomous);

    let mut cmd = tokio::process::Command::new(&bin_path);
    cmd.arg("run")
        .arg("--format")
        .arg("json")
        .arg("--thinking")
        .arg("--pure");
    // No `--auto`: it would auto-approve every `ask` rule and defeat
    // `doom_loop: ask` — see PERMISSION_CONFIG_TEMPLATE.
    cmd.arg("-m")
        .arg(&model)
        .env("OPENCODE_CONFIG_CONTENT", &perm_json)
        .arg("--dir")
        .arg(&workspace)
        .current_dir(&workspace);

    cmd.stdin(std::process::Stdio::piped())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped());
    cmd.kill_on_drop(true);

    let mut child = cmd
        .spawn()
        .map_err(|e| format!("Failed to spawn OpenCode process: {}", e))?;

    let stderr_task = child.stderr.take().map(|mut stderr| {
        tokio::spawn(async move {
            use tokio::io::AsyncReadExt;
            let mut kept: Vec<u8> = Vec::new();
            let mut chunk = [0u8; 4096];
            loop {
                match stderr.read(&mut chunk).await {
                    Ok(0) | Err(_) => break,
                    Ok(n) => {
                        if kept.len() < 16 * 1024 {
                            kept.extend_from_slice(&chunk[..n]);
                        }
                    }
                }
            }
            String::from_utf8_lossy(&kept).into_owned()
        })
    });

    let key_mask = if is_free_model(&model) {
        "Free (Local OpenCode)".to_string()
    } else {
        let provider = model.split('/').next().unwrap_or("opencode");
        format!("OpenCode ({})", provider)
    };

    let _ = channel.send(AiStreamEvent::Meta {
        key_mask: Some(key_mask),
        proxy_mask: None,
    });

    if let Some(mut stdin) = child.stdin.take() {
        if let Err(e) = stdin.write_all(prompt.as_bytes()).await {
            let _ = child.kill().await;
            return Err(format!("Failed to write prompt to OpenCode stdin: {}", e));
        }
        let _ = stdin.shutdown().await;
    }

    let stdout = child.stdout.take().ok_or("Failed to capture OpenCode stdout")?;
    let mut lines = BufReader::new(stdout).lines();

    let mut state = OpenCodeStreamState::new();

    loop {
        tokio::select! {
            _ = &mut cancel_rx => {
                let _ = child.kill().await;
                return Ok(());
            }
            line_res = lines.next_line() => {
                match line_res {
                    Ok(Some(line)) => {
                        if state.handle_line(&line, &channel, &mut cancel_rx).await.is_err() {
                            let _ = child.kill().await;
                            return Ok(());
                        }
                    }
                    Ok(None) => {
                        break;
                    }
                    Err(e) => {
                        log::warn!("OpenCode stream read error: {e}");
                        break;
                    }
                }
            }
        }
    }

    let status = child
        .wait()
        .await
        .map_err(|e| format!("OpenCode process wait error: {}", e))?;

    if !status.success() {
        let mut err_msg = format!("OpenCode exited with status {}", status);
        if let Some(err_text) = state.last_error_msg {
            err_msg = format!("{}: {}", err_msg, err_text);
        }
        if let Some(task) = stderr_task {
            if let Ok(err_buf) = task.await {
                if !err_buf.trim().is_empty() {
                    err_msg = format!("{}: {}", err_msg, err_buf.trim());
                }
            }
        }
        return Err(err_msg);
    }

    Ok(())
}

/// Run inference via OpenCode CLI and stream tokens over Tauri Channel.
/// Dynamically routes to remote OpenCode on the active host if installed,
/// otherwise falls back to local execution.
#[tauri::command]
pub async fn opencode_stream(
    prompt: String,
    model: String,
    cwd: Option<String>,
    stream_id: Option<String>,
    autonomous: Option<bool>,
    session_id: Option<String>,
    host_id: Option<String>,
    channel: tauri::ipc::Channel<AiStreamEvent>,
    ssh: State<'_, SshManager>,
    vault: State<'_, Vault>,
) -> Result<(), String> {
    let s_id = stream_id.unwrap_or_else(|| uuid::Uuid::new_v4().to_string());
    let (cancel_tx, cancel_rx) = oneshot::channel::<()>();
    cancel_channels().lock().insert(s_id.clone(), cancel_tx);
    let _guard = CancelGuard(Some(s_id.clone()));

    let autonomous = autonomous.unwrap_or(false);

    // Resolve target remote host either via explicit host_id or via active session_id
    let target_host_id = host_id
        .filter(|h| h != "__local__" && !h.starts_with("local") && !h.starts_with("serial_"))
        .or_else(|| {
            session_id.as_deref().and_then(|sid| ssh.host_of(sid).ok())
        });

    if let Some(ref hid) = target_host_id {
        // Check if remote OpenCode is installed on that host
        if let Ok(Some(_remote_bin)) = detect_remote_opencode(hid, &vault).await {
            let (host, secret) = vault.host_with_secret(hid).map_err(|e| e.to_string())?;
            return opencode_stream_remote(
                host,
                secret,
                model,
                prompt,
                cwd,
                autonomous,
                s_id,
                channel,
                cancel_rx,
                &vault,
            )
            .await;
        } else {
            // OpenCode is not installed on the remote host — notify UI of local fallback
            if let Ok((host, _)) = vault.host_with_secret(hid) {
                let _ = channel.send(AiStreamEvent::Meta {
                    key_mask: Some(format!("Local Agent (OpenCode not on {})", host.label)),
                    proxy_mask: None,
                });
            }
        }
    }

    // Fall back to local OpenCode execution
    opencode_stream_local(prompt, model, autonomous, channel, cancel_rx).await
}
