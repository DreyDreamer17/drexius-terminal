//! OpenCode Free Models Integration.
//!
//! Checks whether OpenCode CLI is installed on the user's system, lists available free models,
//! and runs inference via the local `opencode run` CLI streaming stdout JSON events.

use crate::ai_client::AiStreamEvent;
use parking_lot::Mutex;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::OnceLock;
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::sync::oneshot;

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

/// Emit text in token-sized chunks with adaptive micro-delays so that the UI
/// renders a live, smooth streaming response even when OpenCode outputs batch blocks.
async fn emit_chunked_stream(
    text: &str,
    channel: &tauri::ipc::Channel<AiStreamEvent>,
    cancel_rx: &mut oneshot::Receiver<()>,
) -> bool {
    let mut tokens = Vec::new();
    let mut current = String::new();

    for ch in text.chars() {
        current.push(ch);
        if ch == ' ' || ch == '\n' || ch == '\t' || current.len() >= 24 {
            tokens.push(std::mem::take(&mut current));
        }
    }
    if !current.is_empty() {
        tokens.push(current);
    }

    if tokens.is_empty() {
        return true;
    }

    // Adaptive pacing: Keep overall streaming duration between 200ms and 1200ms
    let count = tokens.len();
    let delay_ms = if count <= 15 {
        12
    } else if count <= 50 {
        8
    } else if count <= 120 {
        4
    } else if count <= 250 {
        2
    } else {
        1
    };

    for token in tokens {
        if cancel_rx.try_recv().is_ok() {
            return false;
        }
        let _ = channel.send(AiStreamEvent::Data { text: token });
        if delay_ms > 0 {
            tokio::time::sleep(std::time::Duration::from_millis(delay_ms)).await;
        }
    }

    true
}

/// Run inference via OpenCode CLI and stream tokens over Tauri Channel.
#[tauri::command]
pub async fn opencode_stream(
    prompt: String,
    model: String,
    cwd: Option<String>,
    stream_id: Option<String>,
    autonomous: Option<bool>,
    channel: tauri::ipc::Channel<AiStreamEvent>,
) -> Result<(), String> {
    // Autonomous mode (--auto) is opt-in. Without it, edits, web fetches and shell commands are
    // denied outright; with it, they run unless an explicit deny rule matches.
    let autonomous = autonomous.unwrap_or(false);
    let bin_path = find_opencode_binary().ok_or_else(|| {
        "OpenCode binary not found on this system. Please verify ~/.opencode/bin/opencode or PATH.".to_string()
    })?;

    let s_id = stream_id.unwrap_or_else(|| uuid::Uuid::new_v4().to_string());
    let (cancel_tx, mut cancel_rx) = oneshot::channel::<()>();
    cancel_channels().lock().insert(s_id.clone(), cancel_tx);

    let _guard = CancelGuard(Some(s_id));

    // Every run happens in a dedicated scratch workspace, never in the user's home directory.
    // The `cwd` argument from the UI refers to the remote/pane shell and is intentionally ignored here.
    let _ = cwd;
    let workspace = ai_workspace_dir();
    std::fs::create_dir_all(&workspace)
        .map_err(|e| format!("Failed to create OpenCode workspace {}: {e}", workspace.display()))?;

    // Per-run permission config, passed inline so no config file is written.
    // Rule syntax follows OpenCode's `permission` config (edit/webfetch/bash, with pattern maps for bash).
    let permission = if autonomous {
        serde_json::json!({
            "permission": {
                "edit": "deny",
                "webfetch": "deny",
                "bash": {
                    "*": "allow",
                    "rm *": "deny",
                    "sudo *": "deny",
                    "curl *": "deny",
                    "wget *": "deny",
                    "ssh *": "deny",
                    "scp *": "deny",
                    "nc *": "deny",
                    "dd *": "deny",
                    "mkfs*": "deny",
                    "chmod *": "deny",
                    "chown *": "deny",
                    "kill *": "deny",
                    "killall *": "deny",
                    "pkill *": "deny"
                }
            }
        })
    } else {
        // In read-only mode, set tools to "ask" instead of "deny".
        // Completely denying all tools causes OpenCode to strip tools from the request payload,
        // which triggers the free tier server-side anti-abuse error:
        // "OpenCode's free tier can only be used from within OpenCode".
        // With "ask", tools remain declared in the request payload, and because `--auto` is omitted
        // in non-autonomous mode, OpenCode's non-interactive runner automatically rejects any tool
        // execution attempt without running it.
        serde_json::json!({
            "permission": { "edit": "ask", "webfetch": "ask", "bash": "ask" }
        })
    };

    let mut cmd = tokio::process::Command::new(&bin_path);
    cmd.arg("run")
        .arg("--format")
        .arg("json")
        .arg("--thinking")
        .arg("--pure");
    if autonomous {
        cmd.arg("--auto");
    }
    cmd.arg("-m")
        .arg(&model)
        .env("OPENCODE_CONFIG_CONTENT", permission.to_string())
        .arg("--dir")
        .arg(&workspace)
        .current_dir(&workspace);

    cmd.stdin(std::process::Stdio::piped())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped());
    // If this future is dropped (e.g. the UI closes the stream), don't leave an orphaned OpenCode process behind.
    cmd.kill_on_drop(true);

    let mut child = cmd
        .spawn()
        .map_err(|e| format!("Failed to spawn OpenCode process: {}", e))?;

    // L5: drain stderr concurrently. Reading it only after stdout closes deadlocks when the child fills
    // the stderr pipe before exiting. Keep at most 16 KB for the error message, but keep reading to EOF.
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

    // Determine model key mask badge
    let key_mask = if is_free_model(&model) {
        "Free (Local OpenCode)".to_string()
    } else {
        let provider = model.split('/').next().unwrap_or("opencode");
        format!("OpenCode ({})", provider)
    };

    // Send meta event informing frontend of local runner and provider
    let _ = channel.send(AiStreamEvent::Meta {
        key_mask: Some(key_mask),
        proxy_mask: None,
    });

    // Write prompt to stdin and close stdin so OpenCode proceeds
    if let Some(mut stdin) = child.stdin.take() {
        if let Err(e) = stdin.write_all(prompt.as_bytes()).await {
            let _ = child.kill().await;
            return Err(format!("Failed to write prompt to OpenCode stdin: {}", e));
        }
        let _ = stdin.shutdown().await;
    }

    let stdout = child.stdout.take().ok_or("Failed to capture OpenCode stdout")?;
    let mut lines = BufReader::new(stdout).lines();

    let mut had_reasoning = false;
    let mut reasoning_done = false;
    let mut last_error_msg: Option<String> = None;

    loop {
        tokio::select! {
            _ = &mut cancel_rx => {
                let _ = child.kill().await;
                return Ok(());
            }
            line_res = lines.next_line() => {
                match line_res {
                    Ok(Some(line)) => {
                        let trimmed = line.trim();
                        if trimmed.is_empty() {
                            continue;
                        }
                        if let Ok(parsed) = serde_json::from_str::<OpencodeJsonLine>(trimmed) {
                            match parsed.event_type.as_deref() {
                                Some("reasoning") => {
                                    if let Some(part) = parsed.part {
                                        if let Some(text) = part.text {
                                            if !text.is_empty() {
                                                if !had_reasoning {
                                                    had_reasoning = true;
                                                    let _ = channel.send(AiStreamEvent::Data {
                                                        text: "💭 *Thinking…*\n> ".to_string(),
                                                    });
                                                }
                                                let formatted = text.replace('\n', "\n> ");
                                                if !emit_chunked_stream(&formatted, &channel, &mut cancel_rx).await {
                                                    let _ = child.kill().await;
                                                    return Ok(());
                                                }
                                            }
                                        }
                                    }
                                }
                                Some("text") => {
                                    if let Some(part) = parsed.part {
                                        if let Some(text) = part.text {
                                            if !text.is_empty() {
                                                if had_reasoning && !reasoning_done {
                                                    reasoning_done = true;
                                                    let _ = channel.send(AiStreamEvent::Data {
                                                        text: "\n\n---\n\n".to_string(),
                                                    });
                                                }
                                                if !emit_chunked_stream(&text, &channel, &mut cancel_rx).await {
                                                    let _ = child.kill().await;
                                                    return Ok(());
                                                }
                                            }
                                        }
                                    }
                                }
                                Some("tool_use") => {
                                    if had_reasoning && !reasoning_done {
                                        reasoning_done = true;
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
                                        if let Some(m) = err_val.get("message").and_then(|v| v.as_str()) {
                                            m.to_string()
                                        } else if let Some(s) = err_val.as_str() {
                                            s.to_string()
                                        } else {
                                            err_val.to_string()
                                        }
                                    } else if let Some(part) = &parsed.part {
                                        part.text.clone().unwrap_or_else(|| trimmed.to_string())
                                    } else {
                                        trimmed.to_string()
                                    };
                                    last_error_msg = Some(msg);
                                }
                                Some("step_finish") => {
                                    // Finished step successfully
                                }
                                _ => {}
                            }
                        }
                    }
                    Ok(None) => {
                        // EOF
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
        if let Some(err_text) = last_error_msg {
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
