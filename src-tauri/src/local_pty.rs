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

#[tauri::command]
pub fn local_read_file(path: String, offset: Option<usize>, limit: Option<usize>) -> Result<String, String> {
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

    let lines: Vec<&str> = content.lines().collect();
    let start = offset.unwrap_or(1).saturating_sub(1);
    let count = limit.unwrap_or(2000);

    let selected = lines.iter().skip(start).take(count);
    let mut out = String::new();
    for (i, line) in selected.enumerate() {
        use std::fmt::Write;
        let _ = writeln!(out, "{:>4} | {}", start + i + 1, line);
    }
    if out.is_empty() {
        out = "(File is empty)".to_string();
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

    if !content.contains(&old_string) {
        return Err(format!("oldString not found in {}", expanded));
    }

    let occurrences = content.matches(&old_string).count();
    if occurrences > 1 && !replace_all.unwrap_or(false) {
        return Err(format!(
            "oldString occurs {} times in {}. Include more context or set replaceAll: true",
            occurrences, expanded
        ));
    }

    let new_content = if replace_all.unwrap_or(false) {
        content.replace(&old_string, &new_string)
    } else {
        content.replacen(&old_string, &new_string, 1)
    };

    std::fs::write(&expanded, new_content).map_err(|e| format!("Failed to write {}: {}", expanded, e))
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
