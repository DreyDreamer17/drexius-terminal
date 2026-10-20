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
    _bg_guard: crate::ssh::BackgroundSessionGuard,
}

#[derive(Default)]
pub struct SftpManager {
    conns: Mutex<HashMap<String, Arc<Mutex<SftpConn>>>>,
    session_hosts: Mutex<HashMap<String, String>>,
}

impl SftpManager {
    pub fn close(&self, session_id: &str) {
        self.conns.lock().remove(session_id);
        self.session_hosts.lock().remove(session_id);
    }

    fn get(&self, session_id: &str, ssh: &SshManager, vault: &Vault) -> AppResult<Arc<Mutex<SftpConn>>> {
        if let Some(c) = self.conns.lock().get(session_id) {
            return Ok(c.clone());
        }
        let host_id = match self.session_hosts.lock().get(session_id).cloned() {
            Some(h) => h,
            None => ssh.host_of(session_id)?,
        };
        let (host, secret) = vault.host_with_secret(&host_id)?;
        let (session, _) = open_authenticated(&host, &secret, vault)?;
        let sftp = session.sftp()?;
        let mut conns = self.conns.lock();
        if let Some(existing) = conns.get(session_id) {
            return Ok(existing.clone());
        }
        let conn = Arc::new(Mutex::new(SftpConn {
            _session: session,
            sftp,
            _bg_guard: crate::ssh::BackgroundSessionGuard::acquire(),
        }));
        conns.insert(session_id.to_string(), conn.clone());
        Ok(conn)
    }
}

#[tauri::command(async)]
pub fn sftp_connect(
    host_id: String,
    mgr: State<'_, SftpManager>,
    ssh: State<'_, SshManager>,
    vault: State<'_, Vault>,
) -> AppResult<String> {
    let session_id = format!("sftp_{}", uuid::Uuid::new_v4());
    mgr.session_hosts.lock().insert(session_id.clone(), host_id);
    // Eagerly authenticate/connect so errors surface immediately to caller
    mgr.get(&session_id, &ssh, &vault)?;
    Ok(session_id)
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
        // The save path comes from an OS dialog in the UI, but a scripted call
        // must still not be able to drop remote content into credential stores
        // (e.g. ~/.ssh/authorized_keys).
        crate::fs_guard::ensure_local_path_not_sensitive(&local)?;
        let mgr = app.state::<SftpManager>();
        let ssh = app.state::<SshManager>();
        let vault = app.state::<Vault>();
        let conn = mgr.get(&session_id, &ssh, &vault)?;
        let c = conn.lock();
        let mut src = c.sftp.open(Path::new(&remote))?;
        let total = src.stat()?.size.unwrap_or(0);
        let temp_local = format!("{}.drexius-{}.part", local, uuid::Uuid::new_v4());
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
            let backup_local = format!("{}.drexius-bak.{}", local, uuid::Uuid::new_v4());
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
        // Upload source: refuse credential stores even though the UI path came
        // from an OS dialog — otherwise a scripted call could exfiltrate
        // ~/.ssh/id_rsa (etc.) to the remote host.
        crate::fs_guard::ensure_local_path_not_sensitive(&local)?;
        let mgr = app.state::<SftpManager>();
        let ssh = app.state::<SshManager>();
        let vault = app.state::<Vault>();
        let conn = mgr.get(&session_id, &ssh, &vault)?;
        let c = conn.lock();
        let mut src = std::fs::File::open(&local)?;
        let total = src.metadata()?.len();
        let temp_remote = format!("{}.drexius-{}.part", remote, uuid::Uuid::new_v4());
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
                let backup_remote = format!("{}.drexius-bak.{}", remote, uuid::Uuid::new_v4());
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

#[tauri::command]
pub async fn sftp_transfer_remote(
    src_session_id: String,
    src_path: String,
    dst_session_id: String,
    dst_path: String,
    on_progress: IpcChannel<TransferProgress>,
    app: tauri::AppHandle,
) -> AppResult<()> {
    tauri::async_runtime::spawn_blocking(move || {
        let mgr = app.state::<SftpManager>();
        let ssh = app.state::<SshManager>();
        let vault = app.state::<Vault>();
        let src_conn = mgr.get(&src_session_id, &ssh, &vault)?;
        let dst_conn = mgr.get(&dst_session_id, &ssh, &vault)?;

        let temp_remote = format!("{}.drexius-{}.part", dst_path, uuid::Uuid::new_v4());
        let same_conn = Arc::ptr_eq(&src_conn, &dst_conn);

        let mut buf = vec![0u8; CHUNK];
        let mut done = 0u64;
        let mut last_emit = Instant::now();

        let (total, loop_result) = if same_conn {
            let c = src_conn.lock();
            let mut src = c.sftp.open(Path::new(&src_path))?;
            let total = src.stat()?.size.unwrap_or(0);
            let mut dst = c.sftp.create(Path::new(&temp_remote))?;
            let res: AppResult<()> = (|| {
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
            (total, res)
        } else {
            // Deadlock prevention: acquire locks in deterministic pointer address order
            // to avoid ABBA deadlocks when concurrent transfers run between the same endpoints in reverse.
            let (c_src, c_dst) = if (Arc::as_ptr(&src_conn) as usize) < (Arc::as_ptr(&dst_conn) as usize) {
                let s = src_conn.lock();
                let d = dst_conn.lock();
                (s, d)
            } else {
                let d = dst_conn.lock();
                let s = src_conn.lock();
                (s, d)
            };
            let mut src = c_src.sftp.open(Path::new(&src_path))?;
            let total = src.stat()?.size.unwrap_or(0);
            let mut dst = c_dst.sftp.create(Path::new(&temp_remote))?;
            let res: AppResult<()> = (|| {
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
            (total, res)
        };

        if let Err(e) = loop_result {
            let c_dst = dst_conn.lock();
            let _ = c_dst.sftp.unlink(Path::new(&temp_remote));
            return Err(e);
        }

        let c_dst = dst_conn.lock();
        let target_path = Path::new(&dst_path);
        let temp_path = Path::new(&temp_remote);
        let rename_res = c_dst.sftp.rename(
            temp_path,
            target_path,
            Some(ssh2::RenameFlags::ATOMIC | ssh2::RenameFlags::OVERWRITE),
        );
        let rename_res = match rename_res {
            Ok(()) => Ok(()),
            Err(_) => {
                let backup_remote = format!("{}.drexius-bak.{}", dst_path, uuid::Uuid::new_v4());
                let backup_path = Path::new(&backup_remote);
                let had_target = c_dst.sftp.rename(target_path, backup_path, None).is_ok();
                match c_dst.sftp.rename(temp_path, target_path, None) {
                    Ok(()) => {
                        if had_target {
                            let _ = c_dst.sftp.unlink(backup_path);
                        }
                        Ok(())
                    }
                    Err(e) => {
                        if had_target {
                            let _ = c_dst.sftp.rename(backup_path, target_path, None);
                        }
                        Err(e)
                    }
                }
            }
        };
        if let Err(e) = rename_res {
            let _ = c_dst.sftp.unlink(temp_path);
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
    let temp_remote = format!("{}.drexius-{}.part", path, uuid::Uuid::new_v4());
    // Keep the original mode (+x scripts, 0600 secrets) across the atomic
    // replace — a fresh temp file would otherwise reset it to the umask.
    let orig_perm = c.sftp.stat(Path::new(&path)).ok().and_then(|st| st.perm);
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
    if let Some(perm) = orig_perm {
        // Perm-only stat: size/mtime flags stay unset, so the new content is
        // not truncated or re-stamped. Best-effort — never fail the save.
        let _ = c.sftp.setstat(
            Path::new(&temp_remote),
            ssh2::FileStat {
                size: None,
                uid: None,
                gid: None,
                perm: Some(perm),
                atime: None,
                mtime: None,
            },
        );
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
            let backup_remote = format!("{}.drexius-bak.{}", path, uuid::Uuid::new_v4());
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

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LocalDirResponse {
    pub current_path: String,
    pub parent_path: Option<String>,
    pub entries: Vec<FileEntry>,
}

#[tauri::command]
pub fn local_fs_home() -> AppResult<String> {
    #[cfg(target_os = "android")]
    {
        let candidates = [
            "/storage/emulated/0/Download",
            "/storage/emulated/0/Documents",
            "/storage/emulated/0",
            "/sdcard",
        ];
        for candidate in &candidates {
            if std::path::Path::new(candidate).is_dir() {
                return Ok(candidate.to_string());
            }
        }
        return Ok("/storage/emulated/0".to_string());
    }

    #[cfg(not(target_os = "android"))]
    {
        if std::path::Path::new("/storage/emulated/0").is_dir() {
            return Ok("/storage/emulated/0".to_string());
        }
        dirs::home_dir()
            .map(|p| p.to_string_lossy().to_string())
            .ok_or_else(|| AppError::Other("Could not resolve home directory".into()))
    }
}

#[tauri::command]
pub fn local_fs_list(path: Option<String>) -> AppResult<LocalDirResponse> {
    let target = match path.as_deref() {
        Some(p) if !p.trim().is_empty() => {
            // Policy: approved roots only, credential stores never.
            crate::fs_guard::ensure_local_path_allowed(p)?
        }
        _ => std::path::PathBuf::from(local_fs_home()?),
    };

    let canonical = target.canonicalize().unwrap_or(target);
    let current_path = canonical.to_string_lossy().to_string();
    let parent_path = canonical.parent().map(|p| p.to_string_lossy().to_string());

    let read_dir = match std::fs::read_dir(&canonical) {
        Ok(rd) => rd,
        Err(err) => {
            if err.kind() == std::io::ErrorKind::PermissionDenied {
                return Err(AppError::Other(
                    "Storage permission required to browse this directory. Please grant storage access in Android App Settings."
                        .into(),
                ));
            }
            return Err(err.into());
        }
    };
    let mut entries = Vec::new();
    for item in read_dir.flatten() {
        let meta = match item.metadata() {
            Ok(m) => m,
            Err(_) => continue,
        };
        let name = item.file_name().to_string_lossy().to_string();
        let item_path = item.path().to_string_lossy().to_string();
        let is_dir = meta.is_dir();
        let is_symlink = meta.file_type().is_symlink();
        let size = meta.len();
        let modified = meta
            .modified()
            .ok()
            .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
            .map(|d| d.as_secs());

        #[cfg(unix)]
        let permissions = {
            use std::os::unix::fs::PermissionsExt;
            Some(meta.permissions().mode())
        };
        #[cfg(not(unix))]
        let permissions = None;

        entries.push(FileEntry {
            name,
            path: item_path,
            is_dir,
            is_symlink,
            size,
            modified,
            permissions,
        });
    }

    entries.sort_by_cached_key(|e| (std::cmp::Reverse(e.is_dir), e.name.to_lowercase()));

    Ok(LocalDirResponse {
        current_path,
        parent_path,
        entries,
    })
}

#[tauri::command]
pub fn local_fs_mkdir(path: String) -> AppResult<()> {
    let full = crate::fs_guard::ensure_local_path_allowed(&path)?;
    std::fs::create_dir_all(&full)?;
    Ok(())
}

#[tauri::command]
pub fn local_fs_remove(path: String, is_dir: bool) -> AppResult<()> {
    let p = crate::fs_guard::ensure_local_path_allowed(&path)?;
    if is_dir {
        std::fs::remove_dir_all(&p)?;
    } else {
        std::fs::remove_file(&p)?;
    }
    Ok(())
}

#[tauri::command]
pub fn local_fs_rename(from: String, to: String) -> AppResult<()> {
    let src = crate::fs_guard::ensure_local_path_allowed(&from)?;
    let dst = crate::fs_guard::ensure_local_path_allowed(&to)?;
    std::fs::rename(src, dst)?;
    Ok(())
}

#[tauri::command]
pub fn local_fs_read_text(path: String) -> AppResult<String> {
    let full = crate::fs_guard::ensure_local_path_allowed(&path)?;
    let s = std::fs::read_to_string(&full)?;
    Ok(s)
}

#[tauri::command]
pub fn local_fs_write_text(path: String, content: String) -> AppResult<()> {
    let full = crate::fs_guard::ensure_local_path_allowed(&path)?;
    std::fs::write(&full, content)?;
    Ok(())
}

#[tauri::command]
pub fn local_fs_copy(from: String, to: String) -> AppResult<()> {
    let src = crate::fs_guard::ensure_local_path_allowed(&from)?;
    let dst = crate::fs_guard::ensure_local_path_allowed(&to)?;
    std::fs::copy(src, dst)?;
    Ok(())
}

