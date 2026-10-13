//! SFTP file manager. Uses a dedicated *blocking* SSH connection per terminal
//! session (opened lazily with the same vault credentials), so large transfers
//! never stall the interactive PTY thread.

use crate::error::{AppError, AppResult};
use crate::ssh::{open_authenticated, SshManager};
use crate::vault::Vault;
use parking_lot::Mutex;
use serde::Serialize;
use ssh2::{Session, Sftp};
use std::collections::HashMap;
use std::io::{Read, Write};
use std::path::Path;
use std::sync::Arc;
use std::time::Instant;
use tauri::{ipc::Channel as IpcChannel, Manager, State};

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FileEntry {
    pub name: String,
    pub path: String,
    pub is_dir: bool,
    pub is_symlink: bool,
    pub size: u64,
    pub modified: Option<u64>,
    pub permissions: Option<u32>,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TransferProgress {
    pub transferred: u64,
    pub total: u64,
}

struct SftpConn {
    _session: Session,
    sftp: Sftp,
}

#[derive(Default)]
pub struct SftpManager {
    conns: Mutex<HashMap<String, Arc<Mutex<SftpConn>>>>,
}

impl SftpManager {
    pub fn close(&self, session_id: &str) {
        self.conns.lock().remove(session_id);
    }

    fn get(&self, session_id: &str, ssh: &SshManager, vault: &Vault) -> AppResult<Arc<Mutex<SftpConn>>> {
        if let Some(c) = self.conns.lock().get(session_id) {
            return Ok(c.clone());
        }
        let host_id = ssh.host_of(session_id)?;
        let (host, secret) = vault.host_with_secret(&host_id)?;
        let (session, _) = open_authenticated(&host, &secret, vault)?;
        let sftp = session.sftp()?;
        let conn = Arc::new(Mutex::new(SftpConn { _session: session, sftp }));
        let mut conns = self.conns.lock();
        if let Some(existing) = conns.get(session_id) {
            return Ok(existing.clone());
        }
        conns.insert(session_id.to_string(), conn.clone());
        Ok(conn)
    }
}

const CHUNK: usize = 256 * 1024;

#[tauri::command(async)]
pub fn sftp_list(
    session_id: String,
    path: String,
    mgr: State<'_, SftpManager>,
    ssh: State<'_, SshManager>,
    vault: State<'_, Vault>,
) -> AppResult<Vec<FileEntry>> {
    let conn = mgr.get(&session_id, &ssh, &vault)?;
    let c = conn.lock();
    let base = if path.is_empty() { c.sftp.realpath(Path::new("."))? } else { path.into() };
    let mut out: Vec<FileEntry> = c
        .sftp
        .readdir(&base)?
        .into_iter()
        .filter_map(|(p, st)| {
            let name = p.file_name()?.to_string_lossy().to_string();
            Some(FileEntry {
                name,
                path: p.to_string_lossy().to_string(),
                is_dir: st.is_dir(),
                is_symlink: st.file_type().is_symlink(),
                size: st.size.unwrap_or(0),
                modified: st.mtime,
                permissions: st.perm,
            })
        })
        .collect();
    out.sort_by_cached_key(|e| (std::cmp::Reverse(e.is_dir), e.name.to_lowercase()));
    Ok(out)
}

#[tauri::command]
pub async fn sftp_download(
    session_id: String,
    remote: String,
    local: String,
    on_progress: IpcChannel<TransferProgress>,
    app: tauri::AppHandle,
) -> AppResult<()> {
    tauri::async_runtime::spawn_blocking(move || {
        let mgr = app.state::<SftpManager>();
        let ssh = app.state::<SshManager>();
        let vault = app.state::<Vault>();
        let conn = mgr.get(&session_id, &ssh, &vault)?;
        let c = conn.lock();
        let mut src = c.sftp.open(Path::new(&remote))?;
        let total = src.stat()?.size.unwrap_or(0);
        let temp_local = format!("{}.nexus-{}.part", local, uuid::Uuid::new_v4());
        let mut dst = std::fs::File::create(&temp_local)?;
        let mut buf = vec![0u8; CHUNK];
        let mut done = 0u64;
        let mut last_emit = Instant::now();
        let loop_result: AppResult<()> = (|| {
            loop {
                let n = src.read(&mut buf)?;
                if n == 0 {
                    break;
                }
                dst.write_all(&buf[..n])?;
                done += n as u64;
                if last_emit.elapsed().as_millis() >= 50 || done == total {
                    let _ = on_progress.send(TransferProgress { transferred: done, total });
                    last_emit = Instant::now();
                }
            }
            dst.sync_all()?;
            Ok(())
        })();

        drop(dst);

        if let Err(e) = loop_result {
            let _ = std::fs::remove_file(&temp_local);
            return Err(e);
        }
        let temp_local_path = std::path::Path::new(&temp_local);
        let local_path = std::path::Path::new(&local);
        let rename_res = if local_path.exists() {
            let backup_local = format!("{}.nexus-bak.{}", local, uuid::Uuid::new_v4());
            let backup_path = std::path::Path::new(&backup_local);
            if let Err(_) = std::fs::rename(local_path, backup_path) {
                std::fs::rename(temp_local_path, local_path)
            } else {
                match std::fs::rename(temp_local_path, local_path) {
                    Ok(()) => {
                        let _ = std::fs::remove_file(backup_path);
                        Ok(())
                    }
                    Err(e) => {
                        let _ = std::fs::rename(backup_path, local_path);
                        Err(e)
                    }
                }
            }
        } else {
            std::fs::rename(temp_local_path, local_path)
        };
        if let Err(e) = rename_res {
            let _ = std::fs::remove_file(&temp_local);
            return Err(AppError::Io(e));
        }
        let _ = on_progress.send(TransferProgress { transferred: done, total });
        Ok::<(), AppError>(())
    })
    .await
    .map_err(|e| AppError::Other(e.to_string()))?
}

#[tauri::command]
pub async fn sftp_upload(
    session_id: String,
    local: String,
    remote: String,
    on_progress: IpcChannel<TransferProgress>,
    app: tauri::AppHandle,
) -> AppResult<()> {
    tauri::async_runtime::spawn_blocking(move || {
        let mgr = app.state::<SftpManager>();
        let ssh = app.state::<SshManager>();
        let vault = app.state::<Vault>();
        let conn = mgr.get(&session_id, &ssh, &vault)?;
        let c = conn.lock();
        let mut src = std::fs::File::open(&local)?;
        let total = src.metadata()?.len();
        let temp_remote = format!("{}.nexus-{}.part", remote, uuid::Uuid::new_v4());
        let mut dst = c.sftp.create(Path::new(&temp_remote))?;
        let mut buf = vec![0u8; CHUNK];
        let mut done = 0u64;
        let mut last_emit = Instant::now();
        let loop_result: AppResult<()> = (|| {
            loop {
                let n = src.read(&mut buf)?;
                if n == 0 {
                    break;
                }
                dst.write_all(&buf[..n])?;
                done += n as u64;
                if last_emit.elapsed().as_millis() >= 50 || done == total {
                    let _ = on_progress.send(TransferProgress { transferred: done, total });
                    last_emit = Instant::now();
                }
            }
            dst.flush()?;
            Ok(())
        })();

        if let Err(e) = loop_result {
            let _ = c.sftp.unlink(Path::new(&temp_remote));
            return Err(e);
        }
        drop(dst);

        let remote_path = Path::new(&remote);
        let temp_remote_path = Path::new(&temp_remote);
        let rename_res = c.sftp.rename(
            temp_remote_path,
            remote_path,
            Some(ssh2::RenameFlags::ATOMIC | ssh2::RenameFlags::OVERWRITE),
        );
        let rename_res = match rename_res {
            Ok(()) => Ok(()),
            Err(_) => {
                // Server might not support ATOMIC|OVERWRITE flags; use rollback-safe backup rename
                let backup_remote = format!("{}.nexus-bak.{}", remote, uuid::Uuid::new_v4());
                let backup_path = Path::new(&backup_remote);
                let had_remote = c.sftp.rename(remote_path, backup_path, None).is_ok();
                match c.sftp.rename(temp_remote_path, remote_path, None) {
                    Ok(()) => {
                        if had_remote {
                            let _ = c.sftp.unlink(backup_path);
                        }
                        Ok(())
                    }
                    Err(e) => {
                        if had_remote {
                            let _ = c.sftp.rename(backup_path, remote_path, None);
                        }
                        Err(e)
                    }
                }
            }
        };
        if let Err(e) = rename_res {
            let _ = c.sftp.unlink(temp_remote_path);
            return Err(AppError::from(e));
        }
        let _ = on_progress.send(TransferProgress { transferred: done, total });
        Ok::<(), AppError>(())
    })
    .await
    .map_err(|e| AppError::Other(e.to_string()))?
}

#[tauri::command(async)]
pub fn sftp_mkdir(session_id: String, path: String, mgr: State<'_, SftpManager>, ssh: State<'_, SshManager>, vault: State<'_, Vault>) -> AppResult<()> {
    let conn = mgr.get(&session_id, &ssh, &vault)?;
    conn.lock().sftp.mkdir(Path::new(&path), 0o755)?;
    Ok(())
}

#[tauri::command(async)]
pub fn sftp_remove(session_id: String, path: String, is_dir: bool, mgr: State<'_, SftpManager>, ssh: State<'_, SshManager>, vault: State<'_, Vault>) -> AppResult<()> {
    let conn = mgr.get(&session_id, &ssh, &vault)?;
    let c = conn.lock();
    if is_dir { c.sftp.rmdir(Path::new(&path))? } else { c.sftp.unlink(Path::new(&path))? }
    Ok(())
}

#[tauri::command(async)]
pub fn sftp_rename(session_id: String, from: String, to: String, mgr: State<'_, SftpManager>, ssh: State<'_, SshManager>, vault: State<'_, Vault>) -> AppResult<()> {
    let conn = mgr.get(&session_id, &ssh, &vault)?;
    let c = conn.lock();
    c.sftp
        .rename(Path::new(&from), Path::new(&to), None)
        .map_err(AppError::from)
}

#[tauri::command(async)]
pub fn sftp_read_text(
    session_id: String,
    path: String,
    mgr: State<'_, SftpManager>,
    ssh: State<'_, SshManager>,
    vault: State<'_, Vault>,
) -> AppResult<String> {
    const MAX_EDITOR_BYTES: usize = 5 * 1024 * 1024;
    let conn = mgr.get(&session_id, &ssh, &vault)?;
    let c = conn.lock();
    let mut file = c.sftp.open(Path::new(&path))?;
    let stat = file.stat()?;
    if let Some(sz) = stat.size {
        if sz > MAX_EDITOR_BYTES as u64 {
            return Err(AppError::Other("File is too large to open in editor (maximum 5 MB)".into()));
        }
    }
    let capacity = stat.size.unwrap_or(0).min(MAX_EDITOR_BYTES as u64) as usize;
    let mut bytes = Vec::with_capacity(capacity);
    let mut limited = file.take((MAX_EDITOR_BYTES + 1) as u64);
    limited.read_to_end(&mut bytes)?;
    if bytes.len() > MAX_EDITOR_BYTES {
        return Err(AppError::Other("File is too large to open in editor (maximum 5 MB)".into()));
    }
    let text = String::from_utf8(bytes)
        .map_err(|e| AppError::Other(format!("File is not valid UTF-8 text: {e}")))?;
    Ok(text)
}

#[tauri::command(async)]
pub fn sftp_write_text(
    session_id: String,
    path: String,
    content: String,
    mgr: State<'_, SftpManager>,
    ssh: State<'_, SshManager>,
    vault: State<'_, Vault>,
) -> AppResult<()> {
    let conn = mgr.get(&session_id, &ssh, &vault)?;
    let c = conn.lock();
    let temp_remote = format!("{}.nexus-{}.part", path, uuid::Uuid::new_v4());
    let write_res: AppResult<()> = (|| {
        let mut file = c.sftp.create(Path::new(&temp_remote))?;
        file.write_all(content.as_bytes())?;
        file.flush()?;
        Ok(())
    })();
    if let Err(e) = write_res {
        let _ = c.sftp.unlink(Path::new(&temp_remote));
        return Err(e);
    }
    let remote_path = Path::new(&path);
    let temp_remote_path = Path::new(&temp_remote);
    let rename_res = c.sftp.rename(
        temp_remote_path,
        remote_path,
        Some(ssh2::RenameFlags::ATOMIC | ssh2::RenameFlags::OVERWRITE),
    );
    let rename_res = match rename_res {
        Ok(()) => Ok(()),
        Err(_) => {
            // Server might not support ATOMIC|OVERWRITE flags; use rollback-safe backup rename
            let backup_remote = format!("{}.nexus-bak.{}", path, uuid::Uuid::new_v4());
            let backup_path = Path::new(&backup_remote);
            let had_remote = c.sftp.rename(remote_path, backup_path, None).is_ok();
            match c.sftp.rename(temp_remote_path, remote_path, None) {
                Ok(()) => {
                    if had_remote {
                        let _ = c.sftp.unlink(backup_path);
                    }
                    Ok(())
                }
                Err(e) => {
                    if had_remote {
                        let _ = c.sftp.rename(backup_path, remote_path, None);
                    }
                    Err(e)
                }
            }
        }
    };
    if let Err(e) = rename_res {
        let _ = c.sftp.unlink(temp_remote_path);
        return Err(AppError::from(e));
    }
    Ok(())
}

#[tauri::command]
pub fn sftp_close(session_id: String, mgr: State<'_, SftpManager>) -> AppResult<()> {
    mgr.close(&session_id);
    Ok(())
}

