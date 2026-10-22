//! SFTP file manager. Uses a dedicated *blocking* SSH connection per terminal
//! session (opened lazily with the same vault credentials), so large transfers
//! never stall the interactive PTY thread.

use crate::error::{AppError, AppResult};
use crate::ssh::{open_authenticated_uncompressed, SshManager};
use crate::vault::{HostProfile, Vault};
use parking_lot::Mutex;
use serde::Serialize;
use ssh2::{Session, Sftp};
use std::collections::HashMap;
use std::io::{BufReader, BufWriter, Read, Write};
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
    session: Session,
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

    fn resolve_host_id(&self, session_id: &str, ssh: &SshManager) -> AppResult<String> {
        match self.session_hosts.lock().get(session_id).cloned() {
            Some(h) => Ok(h),
            None => ssh.host_of(session_id),
        }
    }

    fn get(&self, session_id: &str, ssh: &SshManager, vault: &Vault) -> AppResult<Arc<Mutex<SftpConn>>> {
        if let Some(c) = self.conns.lock().get(session_id) {
            return Ok(c.clone());
        }
        let host_id = self.resolve_host_id(session_id, ssh)?;
        let (host, secret) = vault.host_with_secret(&host_id)?;
        let (session, _) = open_authenticated_uncompressed(&host, &secret, vault)?;
        let sftp = session.sftp()?;
        let mut conns = self.conns.lock();
        if let Some(existing) = conns.get(session_id) {
            return Ok(existing.clone());
        }
        let conn = Arc::new(Mutex::new(SftpConn {
            session,
            sftp,
            _bg_guard: crate::ssh::BackgroundSessionGuard::acquire(),
        }));
        conns.insert(session_id.to_string(), conn.clone());
        Ok(conn)
    }

    /// Opens an isolated, uncompressed SFTP connection for bulk file transfers so
    /// directory browsing (`sftp_list`) on the UI session never blocks. Falls back
    /// to the shared session only if the server rejects additional connections.
    fn acquire_transfer_conn(
        &self,
        session_id: &str,
        ssh: &SshManager,
        vault: &Vault,
    ) -> AppResult<(Arc<Mutex<SftpConn>>, bool)> {
        let host_id = self.resolve_host_id(session_id, ssh)?;
        let (host, secret) = vault.host_with_secret(&host_id)?;
        if let Ok((session, _)) = open_authenticated_uncompressed(&host, &secret, vault) {
            if let Ok(sftp) = session.sftp() {
                let conn = Arc::new(Mutex::new(SftpConn {
                    session,
                    sftp,
                    _bg_guard: crate::ssh::BackgroundSessionGuard::acquire(),
                }));
                return Ok((conn, true));
            }
        }
        let shared = self.get(session_id, ssh, vault)?;
        Ok((shared, false))
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

/// 2 MiB transfer chunk: allows `libssh2` to keep ~64 SFTP read/write packets
/// in flight across high-bandwidth-delay-product (WAN) links.
const CHUNK: usize = 2 * 1024 * 1024;
/// Number of 2 MiB chunks buffered between reader and writer threads in
/// host-to-host transfers (up to 8 MiB in flight).
const PIPELINE_DEPTH: usize = 4;

/// Coalesces multiple ~30 KB SFTP packets from `libssh2_sftp_read` (or any
/// `Read` source) until `buf` is completely filled or EOF is reached.
/// Handing a full `CHUNK` slice to `dst.write_all` is essential because
/// `libssh2_sftp_write` only pipelines outbound `SSH_FXP_WRITE` packets within
/// a single write call and drains ACKs before returning.
fn read_full_chunk<R: Read + ?Sized>(reader: &mut R, buf: &mut [u8]) -> std::io::Result<usize> {
    let mut filled = 0;
    while filled < buf.len() {
        match reader.read(&mut buf[filled..]) {
            Ok(0) => break,
            Ok(n) => filled += n,
            Err(ref e) if e.kind() == std::io::ErrorKind::Interrupted => continue,
            Err(e) => return Err(e),
        }
    }
    Ok(filled)
}

/// Returns true if two host profiles resolve to the same remote user and endpoint.
fn is_same_remote_endpoint(a: &HostProfile, b: &HostProfile) -> bool {
    a.id == b.id
        || (a.hostname.eq_ignore_ascii_case(&b.hostname)
            && a.port == b.port
            && a.username == b.username
            && a.jump_host_id == b.jump_host_id
            && a.proxy_command == b.proxy_command)
}

/// Quotes a POSIX path for remote shell commands, prefixing `./` if the path
/// begins with `-` so `cp`/`mv`/`rm` never misinterpret it as an option flag.
fn safe_posix_path_quote(p: &str) -> String {
    if p.starts_with('-') {
        crate::ssh::shell_quote(&format!("./{p}"))
    } else {
        crate::ssh::shell_quote(p)
    }
}

/// Attempts an instant server-side atomic file copy (`cp -f` + `mv -f`) over an
/// SSH exec channel on the remote machine, avoiding a full download + upload
/// round-trip when both SFTP panes are connected to the same host.
fn try_server_side_copy(
    session: &Session,
    src_path: &str,
    temp_remote: &str,
    dst_path: &str,
) -> AppResult<()> {
    let mut ch = session.channel_session()?;
    let cmd = format!(
        "cp -f {} {} && mv -f {} {}",
        safe_posix_path_quote(src_path),
        safe_posix_path_quote(temp_remote),
        safe_posix_path_quote(temp_remote),
        safe_posix_path_quote(dst_path),
    );
    ch.exec(&cmd)?;
    let mut output = Vec::new();
    let _ = ch.read_to_end(&mut output);
    let _ = ch.stderr().read_to_end(&mut output);
    ch.wait_close()?;
    if ch.exit_status()? == 0 {
        Ok(())
    } else {
        if let Ok(mut cleanup) = session.channel_session() {
            let _ = cleanup.exec(&format!("rm -f {}", safe_posix_path_quote(temp_remote)));
            let _ = cleanup.wait_close();
        }
        Err(AppError::Other("Server-side copy command failed".into()))
    }
}

/// Atomically renames `temp_remote_path` onto `target_path`, falling back to a
/// rollback-safe backup swap when the server does not support `ATOMIC | OVERWRITE`.
fn atomic_sftp_rename(sftp: &Sftp, temp_remote_path: &Path, target_path: &Path, target_str: &str) -> AppResult<()> {
    let rename_res = sftp.rename(
        temp_remote_path,
        target_path,
        Some(ssh2::RenameFlags::ATOMIC | ssh2::RenameFlags::OVERWRITE),
    );
    let rename_res = match rename_res {
        Ok(()) => Ok(()),
        Err(_) => {
            let backup_remote = format!("{}.drexius-bak.{}", target_str, uuid::Uuid::new_v4());
            let backup_path = Path::new(&backup_remote);
            let had_target = sftp.rename(target_path, backup_path, None).is_ok();
            match sftp.rename(temp_remote_path, target_path, None) {
                Ok(()) => {
                    if had_target {
                        let _ = sftp.unlink(backup_path);
                    }
                    Ok(())
                }
                Err(e) => {
                    if had_target {
                        let _ = sftp.rename(backup_path, target_path, None);
                    }
                    Err(e)
                }
            }
        }
    };
    if let Err(e) = rename_res {
        let _ = sftp.unlink(temp_remote_path);
        return Err(AppError::from(e));
    }
    Ok(())
}

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
        let (conn, _dedicated) = mgr.acquire_transfer_conn(&session_id, &ssh, &vault)?;
        let c = conn.lock();
        let mut src = c.sftp.open(Path::new(&remote))?;
        let total = src.stat()?.size.unwrap_or(0);
        let temp_local = format!("{}.drexius-{}.part", local, uuid::Uuid::new_v4());
        let raw_dst = std::fs::File::create(&temp_local)?;
        let mut dst = BufWriter::with_capacity(CHUNK, raw_dst);
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
            dst.get_ref().sync_all()?;
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
        let (conn, _dedicated) = mgr.acquire_transfer_conn(&session_id, &ssh, &vault)?;
        let c = conn.lock();
        let raw_src = std::fs::File::open(&local)?;
        let total = raw_src.metadata()?.len();
        let mut src = BufReader::with_capacity(CHUNK, raw_src);
        let temp_remote = format!("{}.drexius-{}.part", remote, uuid::Uuid::new_v4());
        let mut dst = c.sftp.create(Path::new(&temp_remote))?;
        let mut buf = vec![0u8; CHUNK];
        let mut done = 0u64;
        let mut last_emit = Instant::now();
        let loop_result: AppResult<()> = (|| {
            loop {
                let n = read_full_chunk(&mut src, &mut buf)?;
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

        atomic_sftp_rename(&c.sftp, Path::new(&temp_remote), Path::new(&remote), &remote)?;
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

        let temp_remote = format!("{}.drexius-{}.part", dst_path, uuid::Uuid::new_v4());

        // Fast Path: Check if both panes point to the same remote host.
        // If so, attempt an instant server-side atomic copy (`cp -f` + `mv -f`)
        // over SSH exec so 0 bytes travel across the client's network.
        if let (Ok(src_hid), Ok(dst_hid)) = (
            mgr.resolve_host_id(&src_session_id, &ssh),
            mgr.resolve_host_id(&dst_session_id, &ssh),
        ) {
            if let (Ok((src_host, _)), Ok((dst_host, _))) = (
                vault.host_with_secret(&src_hid),
                vault.host_with_secret(&dst_hid),
            ) {
                if is_same_remote_endpoint(&src_host, &dst_host) {
                    if src_path == dst_path {
                        let conn = mgr.get(&src_session_id, &ssh, &vault)?;
                        let total = conn
                            .lock()
                            .sftp
                            .stat(Path::new(&src_path))
                            .ok()
                            .and_then(|st| st.size)
                            .unwrap_or(0);
                        let _ = on_progress.send(TransferProgress { transferred: total, total });
                        return Ok(());
                    }
                    if let Ok(conn) = mgr.get(&src_session_id, &ssh, &vault) {
                        let c = conn.lock();
                        let total = c
                            .sftp
                            .stat(Path::new(&src_path))
                            .ok()
                            .and_then(|st| st.size)
                            .unwrap_or(0);
                        let _ = on_progress.send(TransferProgress { transferred: 0, total });
                        if try_server_side_copy(&c.session, &src_path, &temp_remote, &dst_path).is_ok() {
                            let _ = on_progress.send(TransferProgress { transferred: total, total });
                            return Ok(());
                        }
                    }
                }
            }
        }

        // Streaming Path: Open dedicated transfer connections so UI browsing stays unlocked
        // and reader/writer can run concurrently on separate threads.
        let (src_conn, src_dedicated) = mgr.acquire_transfer_conn(&src_session_id, &ssh, &vault)?;
        let (dst_conn, dst_dedicated) = mgr.acquire_transfer_conn(&dst_session_id, &ssh, &vault)?;
        let same_conn = Arc::ptr_eq(&src_conn, &dst_conn);

        let mut done = 0u64;
        let mut last_emit = Instant::now();

        let (total, loop_result) = if same_conn {
            let c = src_conn.lock();
            let mut src = c.sftp.open(Path::new(&src_path))?;
            let total = src.stat()?.size.unwrap_or(0);
            let mut dst = c.sftp.create(Path::new(&temp_remote))?;
            let mut buf = vec![0u8; CHUNK];
            let res: AppResult<()> = (|| {
                loop {
                    let n = read_full_chunk(&mut src, &mut buf)?;
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
        } else if src_dedicated && dst_dedicated {
            // Parallel 2-Thread Producer-Consumer Pipeline:
            // Thread 1 (Producer) continuously reads coalesced 2 MiB chunks from Source Host
            // while Thread 2 (Consumer) simultaneously writes 2 MiB chunks to Destination Host.
            let total = {
                let c_src = src_conn.lock();
                c_src.sftp.stat(Path::new(&src_path))?.size.unwrap_or(0)
            };
            let src_conn_reader = src_conn.clone();
            let src_path_reader = src_path.clone();
            let (tx, rx) = std::sync::mpsc::sync_channel::<AppResult<Vec<u8>>>(PIPELINE_DEPTH);

            let res: AppResult<()> = std::thread::scope(|s| {
                s.spawn(move || {
                    let c_src = src_conn_reader.lock();
                    let mut src = match c_src.sftp.open(Path::new(&src_path_reader)) {
                        Ok(f) => f,
                        Err(e) => {
                            let _ = tx.send(Err(AppError::from(e)));
                            return;
                        }
                    };
                    loop {
                        let mut chunk = vec![0u8; CHUNK];
                        match read_full_chunk(&mut src, &mut chunk) {
                            Ok(0) => break,
                            Ok(n) => {
                                chunk.truncate(n);
                                if tx.send(Ok(chunk)).is_err() {
                                    break;
                                }
                            }
                            Err(e) => {
                                let _ = tx.send(Err(AppError::Io(e)));
                                break;
                            }
                        }
                    }
                });

                let c_dst = dst_conn.lock();
                let mut dst = c_dst.sftp.create(Path::new(&temp_remote))?;
                while let Ok(chunk_res) = rx.recv() {
                    let chunk = chunk_res?;
                    dst.write_all(&chunk)?;
                    done += chunk.len() as u64;
                    if last_emit.elapsed().as_millis() >= 50 || done == total {
                        let _ = on_progress.send(TransferProgress { transferred: done, total });
                        last_emit = Instant::now();
                    }
                }
                dst.flush()?;
                Ok(())
            });
            (total, res)
        } else {
            // Fallback when sharing connection mutexes: acquire locks in deterministic
            // pointer address order to prevent ABBA deadlocks, and stream coalesced 2 MiB chunks.
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
            let mut buf = vec![0u8; CHUNK];
            let res: AppResult<()> = (|| {
                loop {
                    let n = read_full_chunk(&mut src, &mut buf)?;
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
        atomic_sftp_rename(&c_dst.sftp, Path::new(&temp_remote), Path::new(&dst_path), &dst_path)?;

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
    atomic_sftp_rename(&c.sftp, Path::new(&temp_remote), Path::new(&path), &path)?;
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

#[cfg(test)]
mod tests {
    use super::*;
    use crate::vault::AuthMethod;

    struct FragmentedReader {
        data: Vec<u8>,
        pos: usize,
        max_fragment: usize,
    }

    impl Read for FragmentedReader {
        fn read(&mut self, buf: &mut [u8]) -> std::io::Result<usize> {
            if self.pos >= self.data.len() {
                return Ok(0);
            }
            let remaining = self.data.len() - self.pos;
            let take = remaining.min(buf.len()).min(self.max_fragment);
            buf[..take].copy_from_slice(&self.data[self.pos..self.pos + take]);
            self.pos += take;
            Ok(take)
        }
    }

    #[test]
    fn test_read_full_chunk_coalesces_30kb_sftp_packets() {
        // Simulate a 5 MB file arriving in 30,000-byte libssh2 SFTP packets
        let total_size = 5 * 1024 * 1024 + 12345;
        let payload: Vec<u8> = (0..total_size).map(|i| (i % 251) as u8).collect();
        let mut reader = FragmentedReader {
            data: payload.clone(),
            pos: 0,
            max_fragment: 30_000,
        };

        let mut reconstructed = Vec::with_capacity(total_size);
        let mut buf = vec![0u8; CHUNK];

        // First two reads must fill the entire 2 MiB CHUNK despite 30 KB fragments
        let n1 = read_full_chunk(&mut reader, &mut buf).unwrap();
        assert_eq!(n1, CHUNK);
        reconstructed.extend_from_slice(&buf[..n1]);

        let n2 = read_full_chunk(&mut reader, &mut buf).unwrap();
        assert_eq!(n2, CHUNK);
        reconstructed.extend_from_slice(&buf[..n2]);

        // Third read collects the remaining tail (1 MiB + 12345 bytes)
        let n3 = read_full_chunk(&mut reader, &mut buf).unwrap();
        assert_eq!(n3, total_size - 2 * CHUNK);
        reconstructed.extend_from_slice(&buf[..n3]);

        // Fourth read hits EOF
        let n4 = read_full_chunk(&mut reader, &mut buf).unwrap();
        assert_eq!(n4, 0);

        assert_eq!(reconstructed, payload);
    }

    #[test]
    fn test_is_same_remote_endpoint_detects_matching_hosts() {
        let h1 = HostProfile {
            id: "host-1".into(),
            label: "Prod A".into(),
            hostname: "Prod.Example.com".into(),
            port: 22,
            username: "ubuntu".into(),
            auth_method: AuthMethod::Key,
            keychain_id: None,
            group: None,
            tags: vec![],
            color: None,
            has_secret: true,
            os: None,
            jump_host_id: None,
            proxy_command: None,
            vault_id: None,
            startup_command: None,
        };
        let mut h2 = h1.clone();
        h2.id = "host-2".into();
        h2.hostname = "prod.example.com".into();

        assert!(is_same_remote_endpoint(&h1, &h2));

        let mut h3 = h2.clone();
        h3.username = "root".into();
        assert!(!is_same_remote_endpoint(&h1, &h3));
    }

    #[test]
    fn test_safe_posix_path_quote_escapes_leading_dash() {
        assert_eq!(safe_posix_path_quote("/var/www/index.html"), "'/var/www/index.html'");
        assert_eq!(safe_posix_path_quote("-rf"), "'./-rf'");
    }

    #[test]
    fn test_lock_ordering_is_strictly_deterministic() {
        let a = Arc::new(10u32);
        let b = Arc::new(20u32);

        let ptr_a = Arc::as_ptr(&a) as usize;
        let ptr_b = Arc::as_ptr(&b) as usize;

        // Regardless of which order two endpoints arrive in, lock ordering is strictly deterministic
        let order_ab = if ptr_a < ptr_b { (ptr_a, ptr_b) } else { (ptr_b, ptr_a) };
        let order_ba = if ptr_b < ptr_a { (ptr_b, ptr_a) } else { (ptr_a, ptr_b) };

        assert_eq!(order_ab, order_ba);
        assert!(order_ab.0 < order_ab.1);
    }
}

