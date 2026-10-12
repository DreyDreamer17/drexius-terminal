//! Local PTY manager — runs native shells (bash/zsh/fish/powershell) in local tabs.
//! Uses `portable-pty` for cross-platform pseudo-terminal support.

use crate::error::{AppError, AppResult};
use base64::{engine::general_purpose::STANDARD as B64, Engine};
use parking_lot::Mutex;
use portable_pty::{native_pty_system, CommandBuilder, MasterPty, PtySize};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::io::{Read, Write};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::{self, Receiver, SyncSender};
use std::sync::Arc;
use std::thread;
use std::time::Duration;
use tauri::{ipc::Channel as IpcChannel, AppHandle, Manager, State};

/// Maximum number of buffered input commands before back-pressure kicks in.
/// Prevents unbounded memory growth when the UI sends a large paste faster
/// than the PTY can consume it.
const INPUT_QUEUE_CAP: usize = 256;

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
    tx: SyncSender<PtyCmd>,
    /// Shared handle to the child process so `local_pty_close` can send
    /// SIGKILL / TerminateProcess before the master fd is dropped.
    /// Guarantees the reader thread's `read()` call unblocks even when
    /// the shell is blocked on I/O and would otherwise ignore EOF.
    child: Arc<Mutex<Box<dyn portable_pty::Child + Send + Sync>>>,
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
        h.tx.try_send(cmd).map_err(|e| match e {
            mpsc::TrySendError::Full(_) =>
                AppError::Other("terminal input queue is full; try again in a moment".into()),
            mpsc::TrySendError::Disconnected(_) =>
                AppError::SessionNotFound(session_id.into()),
        })
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

    let child = pair
        .slave
        .spawn_command(cmd)
        .map_err(|e| AppError::Other(format!("Failed to spawn shell '{shell_path}': {e}")))?;

    drop(pair.slave); // Ensure EOF is seen when child exits

    // Wrap child in Arc<Mutex<…>> so local_pty_close can kill it from another
    // thread while the I/O thread is blocked in reader.read().
    let child: Arc<Mutex<Box<dyn portable_pty::Child + Send + Sync>>> =
        Arc::new(Mutex::new(child));

    let session_id = uuid::Uuid::new_v4().to_string();
    let (tx, rx) = mpsc::sync_channel::<PtyCmd>(INPUT_QUEUE_CAP);

    mgr.sessions.lock().insert(
        session_id.clone(),
        LocalSessionHandle { tx, child: child.clone() },
    );

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
    if let Err(e) = thread::Builder::new()
        .name(format!("local-pty-{}", &sid[..8]))
        .spawn(move || {
            pty_io_loop(pair.master, rx, &on_event);
            // Reap the child so exited shells don't linger as zombies.
            let _ = child.lock().wait();
            let _ = on_event.send(PtyEvent::Disconnected {
                reason: "shell process exited".into(),
                resumable: false,
            });
            app.state::<LocalPtyManager>().sessions.lock().remove(&sid_thread);
        })
    {
        // Spawn failed — remove the handle we just inserted so the session
        // slot doesn't stay occupied forever (Finding #30).
        mgr.sessions.lock().remove(&session_id);
        return Err(AppError::Io(e));
    }

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
    // Remove the handle from the map first so no further commands can be queued.
    let handle = mgr.sessions.lock().remove(&session_id);
    if let Some(h) = handle {
        // Kill the child process (SIGKILL on Unix, TerminateProcess on Windows).
        // This causes the PTY master to return EOF on the next read, unblocking
        // the reader thread immediately without waiting for the shell to exit
        // cleanly. Descendants are also killed via the PTY session.
        let _ = h.child.lock().kill();
        // Tell the write thread to stop (best-effort; it also exits when the
        // Receiver is dropped because the SyncSender becomes Disconnected).
        let _ = h.tx.try_send(PtyCmd::Close);
    }
    Ok(())
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

    let running = Arc::new(AtomicBool::new(true));
    let running_w = running.clone();

    // Spawn a dedicated thread for writing from UI commands to PTY
    let write_thread = thread::spawn(move || {
        while running_w.load(Ordering::Relaxed) {
            match rx.recv_timeout(Duration::from_millis(100)) {
                Ok(PtyCmd::Write(bytes)) => {
                    if writer.write_all(&bytes).is_err() || writer.flush().is_err() {
                        break;
                    }
                }
                Ok(PtyCmd::Resize(cols, rows)) => {
                    let _ = master.resize(PtySize {
                        rows: rows.max(5) as u16,
                        cols: cols.max(10) as u16,
                        pixel_width: 0,
                        pixel_height: 0,
                    });
                }
                Ok(PtyCmd::Close) => break,
                Err(mpsc::RecvTimeoutError::Timeout) => continue,
                Err(mpsc::RecvTimeoutError::Disconnected) => break,
            }
        }
        running_w.store(false, Ordering::Relaxed);
    });

    let mut buf = [0u8; 16 * 1024];
    loop {
        if !running.load(Ordering::Relaxed) {
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
                thread::sleep(Duration::from_millis(10));
            }
            Err(_) => break,
        }
    }

    running.store(false, Ordering::Relaxed);
    let _ = write_thread.join();
}
