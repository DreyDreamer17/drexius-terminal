//! Local PTY manager — runs native shells (bash/zsh/fish/powershell) in local tabs.
//! Uses `portable-pty` for cross-platform pseudo-terminal support.

use crate::error::{AppError, AppResult};
use base64::{engine::general_purpose::STANDARD as B64, Engine};
use parking_lot::Mutex;
use portable_pty::{native_pty_system, CommandBuilder, MasterPty, PtySize};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::io::{Read, Write};
use std::sync::mpsc::{self, Receiver, Sender};
use std::thread;
use tauri::{ipc::Channel as IpcChannel, AppHandle, Manager, State};

#[derive(Clone, Serialize)]
#[serde(tag = "event", content = "data", rename_all = "camelCase")]
pub enum PtyEvent {
    #[serde(rename_all = "camelCase")]
    Connected {
        session_id: String,
        fingerprint: String,
        banner: Option<String>,
        os: Option<String>,
    },
    Output { b64: String },
    Cwd { path: String },
    #[serde(rename_all = "camelCase")]
    Disconnected { reason: String, resumable: bool },
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LocalPtyRequest {
    pub cols: u32,
    pub rows: u32,
    pub shell: Option<String>,
    pub cwd: Option<String>,
}

enum PtyCmd {
    Write(Vec<u8>),
    Resize(u32, u32),
    Close,
}

struct LocalSessionHandle {
    tx: Sender<PtyCmd>,
}

#[derive(Default)]
pub struct LocalPtyManager {
    sessions: Mutex<HashMap<String, LocalSessionHandle>>,
}

impl LocalPtyManager {
    fn send(&self, session_id: &str, cmd: PtyCmd) -> AppResult<()> {
        let guard = self.sessions.lock();
        let h = guard
            .get(session_id)
            .ok_or_else(|| AppError::SessionNotFound(session_id.into()))?;
        h.tx.send(cmd).map_err(|_| AppError::SessionNotFound(session_id.into()))
    }
}

fn detect_default_shell() -> String {
    if cfg!(windows) {
        std::env::var("COMSPEC").unwrap_or_else(|_| "powershell.exe".into())
    } else {
        std::env::var("SHELL").unwrap_or_else(|_| "/bin/bash".into())
    }
}

#[tauri::command(async)]
pub fn local_pty_spawn(
    app: AppHandle,
    req: LocalPtyRequest,
    on_event: IpcChannel<PtyEvent>,
    mgr: State<'_, LocalPtyManager>,
) -> AppResult<String> {
    let pty_system = native_pty_system();
    let pair = pty_system
        .openpty(PtySize {
            rows: req.rows.max(5) as u16,
            cols: req.cols.max(10) as u16,
            pixel_width: 0,
            pixel_height: 0,
        })
        .map_err(|e| AppError::Other(format!("Failed to open PTY: {e}")))?;

    let shell_path = req.shell.unwrap_or_else(detect_default_shell);
    let mut cmd = CommandBuilder::new(&shell_path);
    cmd.env("TERM", "xterm-256color");
    cmd.env("COLORTERM", "truecolor");

    let work_dir = req
        .cwd
        .map(std::path::PathBuf::from)
        .or_else(dirs::home_dir)
        .unwrap_or_else(|| std::path::PathBuf::from("/"));
    cmd.cwd(work_dir.clone());

    let _child = pair
        .slave
        .spawn_command(cmd)
        .map_err(|e| AppError::Other(format!("Failed to spawn shell '{shell_path}': {e}")))?;

    drop(pair.slave); // Ensure EOF is seen when child exits

    let session_id = uuid::Uuid::new_v4().to_string();
    let (tx, rx) = mpsc::channel::<PtyCmd>();

    mgr.sessions
        .lock()
        .insert(session_id.clone(), LocalSessionHandle { tx });

    let sid = session_id.clone();
    let os_name = if cfg!(target_os = "macos") {
        "macos"
    } else if cfg!(target_os = "windows") {
        "windows"
    } else {
        "linux"
    };

    let _ = on_event.send(PtyEvent::Connected {
        session_id: session_id.clone(),
        fingerprint: "local".into(),
        banner: Some(format!("Local Shell ({shell_path})")),
        os: Some(os_name.into()),
    });

    let _ = on_event.send(PtyEvent::Cwd {
        path: work_dir.to_string_lossy().to_string(),
    });

    let sid_thread = session_id.clone();
    thread::Builder::new()
        .name(format!("local-pty-{}", &sid[..8]))
        .spawn(move || {
            pty_io_loop(pair.master, rx, &on_event);
            let _ = on_event.send(PtyEvent::Disconnected {
                reason: "shell process exited".into(),
                resumable: false,
            });
            app.state::<LocalPtyManager>().sessions.lock().remove(&sid_thread);
        })
        .map_err(|e| AppError::Io(e))?;

    Ok(session_id)
}

#[tauri::command]
pub fn local_pty_write(session_id: String, data: String, mgr: State<'_, LocalPtyManager>) -> AppResult<()> {
    mgr.send(&session_id, PtyCmd::Write(data.into_bytes()))
}

#[tauri::command]
pub fn local_pty_resize(session_id: String, cols: u32, rows: u32, mgr: State<'_, LocalPtyManager>) -> AppResult<()> {
    mgr.send(&session_id, PtyCmd::Resize(cols, rows))
}

#[tauri::command]
pub fn local_pty_close(session_id: String, mgr: State<'_, LocalPtyManager>) -> AppResult<()> {
    mgr.send(&session_id, PtyCmd::Close)
}

fn normalize_for_match(s: &str) -> String {
    s.replace(['\u{2018}', '\u{2019}', '\u{201A}', '\u{201B}'], "'")
        .replace(['\u{201C}', '\u{201D}', '\u{201E}', '\u{201F}'], "\"")
        .replace(
            ['\u{2010}', '\u{2011}', '\u{2012}', '\u{2013}', '\u{2014}', '\u{2015}', '\u{2212}'],
            "-",
        )
        .replace(
            [
                '\u{00A0}', '\u{2002}', '\u{2003}', '\u{2004}', '\u{2005}', '\u{2006}',
                '\u{2007}', '\u{2008}', '\u{2009}', '\u{200A}', '\u{202F}', '\u{205F}',
                '\u{3000}',
            ],
            " ",
        )
}

#[tauri::command]
pub fn local_read_file(
    path: String,
    offset: Option<usize>,
    limit: Option<usize>,
    raw: Option<bool>,
) -> Result<String, String> {
    let clean = path.trim().trim_matches('\'').trim_matches('"');
    let expanded = if clean.starts_with("~/") {
        if let Some(home) = dirs::home_dir() {
            home.join(&clean[2..]).to_string_lossy().to_string()
        } else {
            clean.to_string()
        }
    } else {
        clean.to_string()
    };

    let content = std::fs::read_to_string(&expanded)
        .map_err(|e| format!("Failed to read {}: {}", expanded, e))?;

    if raw.unwrap_or(false) {
        return Ok(content);
    }

    let lines: Vec<&str> = content.lines().collect();
    let total_lines = lines.len();
    if total_lines == 0 {
        return Ok(format!("Read file {}, 0 lines (File is empty)", clean));
    }

    let start_1based = offset.unwrap_or(1).max(1);
    let start_idx = start_1based.saturating_sub(1);
    if start_idx >= total_lines {
        return Err(format!(
            "Offset {} is out of range for this file ({} {})",
            start_1based,
            total_lines,
            if total_lines == 1 { "line" } else { "lines" }
        ));
    }

    let count = limit.unwrap_or(2000).max(1);
    let end_idx = (start_idx + count).min(total_lines);
    let end_1based = end_idx;

    let max_line_len = 2000;
    use std::fmt::Write;
    let mut out = String::new();
    let _ = writeln!(
        out,
        "Read file {}, lines {}-{} of {}",
        clean, start_1based, end_1based, total_lines
    );

    for (i, line) in lines[start_idx..end_idx].iter().enumerate() {
        let line_num = start_idx + i + 1;
        if line.len() > max_line_len {
            let clamped = &line[..max_line_len];
            let _ = writeln!(
                out,
                "{:>4} | {}... (line truncated to {} chars)",
                line_num, clamped, max_line_len
            );
        } else {
            let _ = writeln!(out, "{:>4} | {}", line_num, line);
        }
    }

    if end_idx < total_lines {
        let next_offset = end_idx + 1;
        let _ = writeln!(
            out,
            "\n[Output truncated. Continue reading with offset: {}]",
            next_offset
        );
    }

    Ok(out)
}

#[tauri::command]
pub fn local_write_file(path: String, content: String) -> Result<(), String> {
    let clean = path.trim().trim_matches('\'').trim_matches('"');
    let expanded = if clean.starts_with("~/") {
        if let Some(home) = dirs::home_dir() {
            home.join(&clean[2..]).to_string_lossy().to_string()
        } else {
            clean.to_string()
        }
    } else {
        clean.to_string()
    };

    if let Some(parent) = std::path::Path::new(&expanded).parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    std::fs::write(&expanded, content).map_err(|e| format!("Failed to write {}: {}", expanded, e))
}

#[tauri::command]
pub fn local_edit_file(
    path: String,
    old_string: String,
    new_string: String,
    replace_all: Option<bool>,
) -> Result<(), String> {
    if old_string == new_string {
        return Err("No changes to apply: old_string and new_string are identical.".into());
    }
    if old_string.is_empty() {
        return Err("old_string must not be empty. Use write_file to create or overwrite a file.".into());
    }

    let clean = path.trim().trim_matches('\'').trim_matches('"');
    let expanded = if clean.starts_with("~/") {
        if let Some(home) = dirs::home_dir() {
            home.join(&clean[2..]).to_string_lossy().to_string()
        } else {
            clean.to_string()
        }
    } else {
        clean.to_string()
    };

    let content = std::fs::read_to_string(&expanded)
        .map_err(|e| format!("Failed to read {}: {}", expanded, e))?;

    let replace_all = replace_all.unwrap_or(false);

    // 1. Direct exact string replacement
    if content.contains(&old_string) {
        let occurrences = content.matches(&old_string).count();
        if occurrences > 1 && !replace_all {
            return Err(format!(
                "old_string occurs {} times in {}. Add more surrounding context to make it unique, or set replace_all: true",
                occurrences, expanded
            ));
        }
        let new_content = if replace_all {
            content.replace(&old_string, &new_string)
        } else {
            content.replacen(&old_string, &new_string, 1)
        };
        return std::fs::write(&expanded, new_content).map_err(|e| format!("Failed to write {}: {}", expanded, e));
    }

    // 2. Unicode-normalized matching (handles smart quotes, dashes, non-breaking spaces)
    let norm_content = normalize_for_match(&content);
    let norm_old = normalize_for_match(&old_string);
    if norm_content.contains(&norm_old) {
        let occurrences = norm_content.matches(&norm_old).count();
        if occurrences > 1 && !replace_all {
            return Err(format!(
                "old_string occurs {} times (via unicode normalization) in {}. Add more surrounding context or set replace_all: true",
                occurrences, expanded
            ));
        }
        // Locate matching byte offset in normalized content and slice corresponding part
        if let Some(start_byte) = norm_content.find(&norm_old) {
            let end_byte = start_byte + norm_old.len();
            if content.is_char_boundary(start_byte) && content.is_char_boundary(end_byte) {
                let mut new_c = String::with_capacity(content.len() + new_string.len());
                new_c.push_str(&content[..start_byte]);
                new_c.push_str(&new_string);
                new_c.push_str(&content[end_byte..]);
                return std::fs::write(&expanded, new_c).map_err(|e| format!("Failed to write {}: {}", expanded, e));
            }
        }
    }

    // 3. Line-by-line whitespace-trimmed matching (handles trailing whitespace / indent nuances)
    let content_lines: Vec<&str> = content.lines().collect();
    let old_lines: Vec<&str> = old_string.lines().collect();

    if !old_lines.is_empty() && content_lines.len() >= old_lines.len() {
        let norm_old_trimmed: Vec<String> = old_lines.iter().map(|l| normalize_for_match(l.trim_end())).collect();
        let mut match_indices = Vec::new();

        for i in 0..=(content_lines.len() - old_lines.len()) {
            let slice = &content_lines[i..i + old_lines.len()];
            let matches = slice
                .iter()
                .zip(&norm_old_trimmed)
                .all(|(c, o)| normalize_for_match(c.trim_end()) == *o);
            if matches {
                match_indices.push(i);
            }
        }

        if !match_indices.is_empty() {
            if match_indices.len() > 1 && !replace_all {
                return Err(format!(
                    "Found {} matching blocks for old_string in {}. Add more surrounding context to make it unique, or set replace_all: true",
                    match_indices.len(), expanded
                ));
            }

            let crlf = content.contains("\r\n");
            let line_ending = if crlf { "\r\n" } else { "\n" };

            let mut result_lines = Vec::new();
            let mut curr = 0;
            for &idx in &match_indices {
                result_lines.extend_from_slice(&content_lines[curr..idx]);
                result_lines.push(&new_string);
                curr = idx + old_lines.len();
                if !replace_all {
                    break;
                }
            }
            result_lines.extend_from_slice(&content_lines[curr..]);

            let mut new_c = result_lines.join(line_ending);
            if content.ends_with(line_ending) || content.ends_with('\n') {
                new_c.push_str(line_ending);
            }
            return std::fs::write(&expanded, new_c).map_err(|e| format!("Failed to write {}: {}", expanded, e));
        }

        // 4. Indent-flexible line matching (handles differences in indentation levels e.g. 2 vs 4 spaces or tabs)
        let norm_old_trimmed_both: Vec<String> = old_lines.iter().map(|l| normalize_for_match(l.trim())).collect();
        let mut match_indices_indent = Vec::new();

        for i in 0..=(content_lines.len() - old_lines.len()) {
            let slice = &content_lines[i..i + old_lines.len()];
            let matches = slice
                .iter()
                .zip(&norm_old_trimmed_both)
                .all(|(c, o)| normalize_for_match(c.trim()) == *o);
            if matches {
                match_indices_indent.push(i);
            }
        }

        if !match_indices_indent.is_empty() {
            if match_indices_indent.len() > 1 && !replace_all {
                return Err(format!(
                    "Found {} matching blocks for old_string (via indent-flexible match) in {}. Add more surrounding context to make it unique, or set replace_all: true",
                    match_indices_indent.len(), expanded
                ));
            }

            let crlf = content.contains("\r\n");
            let line_ending = if crlf { "\r\n" } else { "\n" };

            let mut result_lines = Vec::new();
            let mut curr = 0;
            for &idx in &match_indices_indent {
                result_lines.extend_from_slice(&content_lines[curr..idx]);
                result_lines.push(&new_string);
                curr = idx + old_lines.len();
                if !replace_all {
                    break;
                }
            }
            result_lines.extend_from_slice(&content_lines[curr..]);

            let mut new_c = result_lines.join(line_ending);
            if content.ends_with(line_ending) || content.ends_with('\n') {
                new_c.push_str(line_ending);
            }
            return std::fs::write(&expanded, new_c).map_err(|e| format!("Failed to write {}: {}", expanded, e));
        }
    }

    // 5. Whitespace-collapsed token matching
    // Handles single-line vs multi-line differences or extra whitespace
    // (e.g. `.btn:active { transform: scale(0.96); }` vs `.btn:active {\n  transform: scale(0.96);\n}`)
    let old_tokens: Vec<&str> = old_string.split_whitespace().collect();
    if !old_tokens.is_empty() {
        // Collect tokens from content along with their byte start and end positions
        let mut content_tokens: Vec<(&str, usize, usize)> = Vec::new();
        let mut in_token = false;
        let mut tok_start = 0;

        for (idx, ch) in content.char_indices() {
            if ch.is_whitespace() {
                if in_token {
                    content_tokens.push((&content[tok_start..idx], tok_start, idx));
                    in_token = false;
                }
            } else if !in_token {
                tok_start = idx;
                in_token = true;
            }
        }
        if in_token {
            content_tokens.push((&content[tok_start..], tok_start, content.len()));
        }

        if content_tokens.len() >= old_tokens.len() {
            let mut token_matches = Vec::new();
            for i in 0..=(content_tokens.len() - old_tokens.len()) {
                let slice = &content_tokens[i..i + old_tokens.len()];
                let matches = slice
                    .iter()
                    .zip(&old_tokens)
                    .all(|((c, _, _), o)| normalize_for_match(c) == normalize_for_match(o));
                if matches {
                    let start_byte = slice.first().unwrap().1;
                    let end_byte = slice.last().unwrap().2;
                    token_matches.push((start_byte, end_byte));
                }
            }

            if !token_matches.is_empty() {
                if token_matches.len() > 1 && !replace_all {
                    return Err(format!(
                        "Found {} matching blocks for old_string (via whitespace-collapsed match) in {}. Add more surrounding context to make it unique, or set replace_all: true",
                        token_matches.len(), expanded
                    ));
                }

                let mut new_c = String::with_capacity(content.len() + new_string.len());
                let mut curr = 0;
                for &(sb, eb) in &token_matches {
                    new_c.push_str(&content[curr..sb]);
                    new_c.push_str(&new_string);
                    curr = eb;
                    if !replace_all {
                        break;
                    }
                }
                new_c.push_str(&content[curr..]);
                return std::fs::write(&expanded, new_c).map_err(|e| format!("Failed to write {}: {}", expanded, e));
            }
        }
    }

    Err(format!(
        "old_string not found in {}. Ensure the text matches the file content, or use read_file to inspect line numbers and indentation.",
        expanded
    ))
}

fn pty_io_loop(
    master: Box<dyn MasterPty + Send>,
    rx: Receiver<PtyCmd>,
    events: &IpcChannel<PtyEvent>,
) {
    let mut reader = match master.try_clone_reader() {
        Ok(r) => r,
        Err(_) => return,
    };
    let mut writer = match master.take_writer() {
        Ok(w) => w,
        Err(_) => return,
    };

    // Spawn a dedicated thread for writing from UI commands to PTY
    let (done_tx, done_rx) = mpsc::channel::<()>();
    let write_thread = thread::spawn(move || {
        while let Ok(cmd) = rx.recv() {
            match cmd {
                PtyCmd::Write(bytes) => {
                    if writer.write_all(&bytes).is_err() || writer.flush().is_err() {
                        break;
                    }
                }
                PtyCmd::Resize(cols, rows) => {
                    let _ = master.resize(PtySize {
                        rows: rows.max(5) as u16,
                        cols: cols.max(10) as u16,
                        pixel_width: 0,
                        pixel_height: 0,
                    });
                }
                PtyCmd::Close => break,
            }
        }
        let _ = done_tx.send(());
    });

    let mut buf = [0u8; 16 * 1024];
    loop {
        if done_rx.try_recv().is_ok() {
            break;
        }
        match reader.read(&mut buf) {
            Ok(0) => break, // EOF, child process terminated
            Ok(n) => {
                let chunk = &buf[..n];
                if events.send(PtyEvent::Output { b64: B64.encode(chunk) }).is_err() {
                    break;
                }
            }
            Err(e) if e.kind() == std::io::ErrorKind::WouldBlock => {
                thread::sleep(std::time::Duration::from_millis(5));
            }
            Err(_) => break,
        }
    }

    let _ = write_thread.join();
}
