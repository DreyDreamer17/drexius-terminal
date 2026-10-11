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
use tauri::{ipc::Channel as IpcChannel, State};

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
        self.conns.lock().insert(session_id.to_string(), conn.clone());
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
    out.sort_by(|a, b| b.is_dir.cmp(&a.is_dir).then(a.name.to_lowercase().cmp(&b.name.to_lowercase())));
    Ok(out)
}

#[tauri::command(async)]
pub fn sftp_download(
    session_id: String,
    remote: String,
    local: String,
    on_progress: IpcChannel<TransferProgress>,
    mgr: State<'_, SftpManager>,
    ssh: State<'_, SshManager>,
    vault: State<'_, Vault>,
) -> AppResult<()> {
    let conn = mgr.get(&session_id, &ssh, &vault)?;
    let c = conn.lock();
    let mut src = c.sftp.open(Path::new(&remote))?;
    let total = src.stat()?.size.unwrap_or(0);
    let mut dst = std::fs::File::create(&local)?;
    let mut buf = vec![0u8; CHUNK];
    let mut done = 0u64;
    loop {
        let n = src.read(&mut buf)?;
        if n == 0 {
            break;
        }
        dst.write_all(&buf[..n])?;
        done += n as u64;
        let _ = on_progress.send(TransferProgress { transferred: done, total });
    }
    Ok(())
}

#[tauri::command(async)]
pub fn sftp_upload(
    session_id: String,
    local: String,
    remote: String,
    on_progress: IpcChannel<TransferProgress>,
    mgr: State<'_, SftpManager>,
    ssh: State<'_, SshManager>,
    vault: State<'_, Vault>,
) -> AppResult<()> {
    let conn = mgr.get(&session_id, &ssh, &vault)?;
    let c = conn.lock();
    let mut src = std::fs::File::open(&local)?;
    let total = src.metadata()?.len();
    let mut dst = c.sftp.create(Path::new(&remote))?;
    let mut buf = vec![0u8; CHUNK];
    let mut done = 0u64;
    loop {
        let n = src.read(&mut buf)?;
        if n == 0 {
            break;
        }
        dst.write_all(&buf[..n])?;
        done += n as u64;
        let _ = on_progress.send(TransferProgress { transferred: done, total });
    }
    Ok(())
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
    let conn = mgr.get(&session_id, &ssh, &vault)?;
    let c = conn.lock();
    let mut file = c.sftp.open(Path::new(&path))?;
    let stat = file.stat()?;
    if let Some(sz) = stat.size {
        if sz > 5 * 1024 * 1024 {
            return Err(AppError::Other("File is too large to open in editor (maximum 5 MB)".into()));
        }
    }
    let mut bytes = Vec::new();
    file.read_to_end(&mut bytes)?;
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
    let mut file = c.sftp.create(Path::new(&path))?;
    file.write_all(content.as_bytes())?;
    file.flush()?;
    Ok(())
}

#[tauri::command]
pub fn sftp_close(session_id: String, mgr: State<'_, SftpManager>) -> AppResult<()> {
    mgr.close(&session_id);
    Ok(())
}

