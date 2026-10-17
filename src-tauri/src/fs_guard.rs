//! Local filesystem access policy for commands that touch the user's disk.
//!
//! The WebView is a presentation layer: even a fully compromised frontend must
//! not be able to roam the whole disk through `local_fs_*`, SFTP transfers or
//! key import. Two layers of defense:
//!
//!   1. **Approved roots** — the home directory, removable/media mounts and the
//!      system temp dir (plus drive roots on Windows). Paths are canonicalized
//!      before the check, so symlinks cannot escape the roots.
//!   2. **Sensitive denylist** — well-known credential stores are refused even
//!      inside those roots (`.ssh`, `.gnupg`, `.aws`, … and DrexiusTerminal's own
//!      vault data).
//!
//! Dialog-mediated flows (SFTP upload/download pickers) only apply the
//! sensitive denylist: the user explicitly chose that path in an OS dialog, but
//! a scripted call must still not be able to read SSH keys or drop files into
//! `~/.ssh`.

use crate::error::{AppError, AppResult};
use std::path::{Component, Path, PathBuf};

/// Directory/file names that must never be read or written through the generic
/// local-FS commands, wherever they appear in a path.
const SENSITIVE_NAMES: &[&str] = &[
    ".ssh",
    ".gnupg",
    ".aws",
    ".kube",
    ".docker",
    ".password-store",
    ".git-credentials",
    ".netrc",
];

/// Exact file names of the vault's sidecar files, living next to the vault
/// database inside the app data directory.
///
/// The vault database itself and its SQLite `-wal`/`-shm` companions are
/// covered by the `drexius.vault` prefix rule in `is_sensitive_path`; these
/// are the remaining sidecars, which the prefix rule does not reach:
///
///   * `drexius.salt`       — Argon2id salt for the master key
///   * `drexius.recovery`   — XChaCha20-Poly1305 recovery envelope
///   * `drexius.device_lock`— device-local quick-unlock credential
///   * `drexius.rekey`      — rekey intent journal (new key sealed under the old one)
///   * `drexius.pre-rekey`  — byte copy of the pre-rekey database
///
/// The last two matter most: the journal holds the *next* master key (sealed
/// under the current one) and the snapshot is a second, full copy of the
/// encrypted vault. Both live under the user's home directory, which is an
/// approved root, so without this list the generic `local_fs_*` commands could
/// read them.
///
/// `vault.rs` has a unit test that asserts every sidecar the vault can create
/// is denied here, so adding a new sidecar without listing it fails CI.
pub(crate) const VAULT_SIDECAR_NAMES: &[&str] = &[
    "drexius.salt",
    "drexius.recovery",
    "drexius.device_lock",
    "drexius.rekey",
    "drexius.pre-rekey",
];

/// True when any path component names a credential store or app-state file.
pub(crate) fn is_sensitive_path(p: &Path) -> bool {
    for comp in p.components() {
        if let Component::Normal(s) = comp {
            let name = s.to_string_lossy().to_ascii_lowercase();
            if SENSITIVE_NAMES.iter().any(|d| name == *d) {
                return true;
            }
            // The vault database (and its `-wal`/`-shm` companions) plus every
            // sidecar file listed in `VAULT_SIDECAR_NAMES`.
            if name.starts_with("drexius.vault") || VAULT_SIDECAR_NAMES.contains(&name.as_str()) {
                return true;
            }
            // The Tauri application data directory (stores the vault).
            if name == "dev.drexius.terminal" {
                return true;
            }
        }
    }
    false
}

/// Folders the generic local-FS commands may operate in.
fn approved_roots() -> Vec<PathBuf> {
    let mut roots = Vec::new();
    if let Some(home) = dirs::home_dir() {
        roots.push(home);
    }
    roots.push(PathBuf::from("/mnt"));
    roots.push(PathBuf::from("/media"));
    roots.push(PathBuf::from("/Volumes"));
    roots.push(std::env::temp_dir());
    #[cfg(target_os = "android")]
    {
        roots.push(PathBuf::from("/storage"));
        roots.push(PathBuf::from("/sdcard"));
        roots.push(PathBuf::from("/data/user/0/dev.drexius.terminal"));
        roots.push(PathBuf::from("/data/data/dev.drexius.terminal"));
    }
    if std::path::Path::new("/storage/emulated/0").exists() {
        roots.push(PathBuf::from("/storage"));
        roots.push(PathBuf::from("/sdcard"));
    }
    if cfg!(windows) {
        // Allow drive roots (e.g. `D:\`) so removable drives stay reachable.
        for letter in b'A'..=b'Z' {
            roots.push(PathBuf::from(format!("{}:\\", letter as char)));
        }
    }
    roots
}

/// Resolve `raw` as far as it exists on disk. The existing prefix is
/// canonicalized (symlink-safe); `..` segments in the not-yet-created remainder
/// are rejected outright (`file_name()` is None for `..`).
fn resolved_path(raw: &str) -> AppResult<PathBuf> {
    let p = Path::new(raw);
    let mut missing: Vec<std::ffi::OsString> = Vec::new();
    let mut cur = p.to_path_buf();
    let base = loop {
        match cur.canonicalize() {
            Ok(c) => break c,
            Err(_) => {
                let name_os = match cur.file_name() {
                    Some(n) => n.to_os_string(),
                    // `..` / `.` / bare roots cannot exist as "new" segments.
                    None => {
                        return Err(AppError::Other(format!(
                            "Cannot resolve path (missing parent or '..' in the new part): {raw}"
                        )))
                    }
                };
                let mut parent_buf = match cur.parent() {
                    Some(par) => par.to_path_buf(),
                    None => {
                        return Err(AppError::Other(format!("Cannot resolve path: {raw}")))
                    }
                };
                if parent_buf.as_os_str().is_empty() {
                    parent_buf = PathBuf::from(".");
                }
                missing.push(name_os);
                cur = parent_buf;
            }
        }
    };
    let mut full = base;
    for seg in missing.iter().rev() {
        full.push(seg);
    }
    Ok(full)
}

fn ensure_within_roots(full: &Path) -> AppResult<()> {
    for r in &approved_roots() {
        // Compare canonicalized-to-canonicalized when the root exists (handles
        // Windows `\\?\` verbatim prefixes and symlinked homes).
        if let Ok(rc) = r.canonicalize() {
            if full.starts_with(&rc) {
                return Ok(());
            }
        }
        if full.starts_with(r) {
            return Ok(());
        }
    }
    Err(AppError::Other(
        "Path is outside the approved folders (home, /mnt, /media, /Volumes, temp). \
         Use the file picker dialogs to reach other locations."
            .into(),
    ))
}

/// Full policy: approved roots + sensitive-name denylist. Used by the generic
/// `local_fs_*` browser/editor commands.
pub fn ensure_local_path_allowed(raw: &str) -> AppResult<PathBuf> {
    if raw.trim().is_empty() {
        return Err(AppError::Other("Empty path".into()));
    }
    let full = resolved_path(raw)?;
    if is_sensitive_path(&full) {
        return Err(AppError::Other(
            "Access to credential stores (SSH keys, GnuPG, cloud credentials) \
             and DrexiusTerminal data is blocked here"
                .into(),
        ));
    }
    ensure_within_roots(&full)?;
    Ok(full)
}

/// Roots only — used for SSH key import, where reading key material is the
/// feature itself (still refuses paths outside home / removable / temp).
pub fn ensure_local_path_in_roots(raw: &str) -> AppResult<PathBuf> {
    if raw.trim().is_empty() {
        return Err(AppError::Other("Empty path".into()));
    }
    let full = resolved_path(raw)?;
    ensure_within_roots(&full)?;
    Ok(full)
}

/// Sensitive denylist only — used for dialog-mediated transfers (SFTP
/// upload/download), where the user picked the path in an OS dialog but a
/// scripted call must still not touch credential stores.
pub fn ensure_local_path_not_sensitive(raw: &str) -> AppResult<PathBuf> {
    if raw.trim().is_empty() {
        return Err(AppError::Other("Empty path".into()));
    }
    let full = resolved_path(raw)?;
    if is_sensitive_path(&full) {
        return Err(AppError::Other(
            "Access to credential stores (SSH keys, GnuPG, cloud credentials) \
             and DrexiusTerminal data is blocked here"
                .into(),
        ));
    }
    Ok(full)
}
