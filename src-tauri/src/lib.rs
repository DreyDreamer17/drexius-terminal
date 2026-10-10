//! NexusTerminal Rust core — wires state + IPC commands into the Tauri runtime.

mod error;
mod local_pty;
mod sftp;
mod snapshot;
mod ssh;
mod sync;
mod tunnel;
mod vault;

use std::time::Duration;
use tauri::Manager;

pub fn run() {
    env_logger::init();

    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_shell::init())
        .setup(|app| {
            let data_dir = app
                .path()
                .app_data_dir()
                .expect("no app data dir available");
            std::fs::create_dir_all(&data_dir)?;

            let vault = vault::Vault::new(data_dir.join("nexus.vault"));
            let snapshots = snapshot::SnapshotStore::default();

            app.manage(vault);
            app.manage(snapshots.clone());
            app.manage(ssh::SshManager::default());
            app.manage(sftp::SftpManager::default());
            app.manage(sync::SyncEngine::default());
            app.manage(local_pty::LocalPtyManager::default());
            app.manage(tunnel::TunnelManager::default());

            // Background snapshot flusher: persists dirty session state every 10 s.
            let handle = app.handle().clone();
            std::thread::Builder::new()
                .name("snapshot-flusher".into())
                .spawn(move || loop {
                    std::thread::sleep(Duration::from_secs(10));
                    let vault = handle.state::<vault::Vault>();
                    if let Err(e) = snapshots.flush(&vault) {
                        log::debug!("snapshot flush skipped: {e}");
                    }
                })?;
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            // vault core
            vault::vault_status,
            vault::vault_unlock,
            vault::vault_lock,
            vault::vault_list,
            vault::vault_save,
            vault::vault_delete,
            vault::serial_list_ports,
            vault::team_vault_export,
            vault::team_vault_import,
            // hosts
            vault::hosts_list,
            vault::host_save,
            vault::host_delete,
            vault::host_trust_key,
            // keychain (reusable identities)
            vault::keychain_list,
            vault::keychain_save,
            vault::keychain_delete,
            vault::keychain_import_from_hosts,
            vault::keychain_detect_local_keys,
            vault::keychain_import_local_key,
            vault::keychain_generate_key,
            // connection logs
            vault::logs_list,
            vault::log_toggle_saved,
            vault::logs_clear,
            // known hosts
            vault::known_hosts_list,
            vault::known_host_delete,
            // tunnels / port forwarding
            vault::tunnels_list,
            vault::tunnel_save,
            vault::tunnel_delete,
            tunnel::tunnel_start,
            tunnel::tunnel_stop,
            tunnel::tunnel_status_all,
            // snippets
            vault::snippets_list,
            vault::snippet_save,
            vault::snippet_delete,
            // ssh
            ssh::ssh_connect,
            ssh::ssh_write,
            ssh::ssh_resize,
            ssh::ssh_disconnect,
            ssh::ssh_sessions,
            // local pty
            local_pty::local_pty_spawn,
            local_pty::local_pty_write,
            local_pty::local_pty_resize,
            local_pty::local_pty_close,
            // sftp
            sftp::sftp_list,
            sftp::sftp_download,
            sftp::sftp_upload,
            sftp::sftp_mkdir,
            sftp::sftp_remove,
            sftp::sftp_rename,
            // snapshots
            snapshot::snapshot_get,
            snapshot::snapshot_list,
            // sync
            sync::sync_status,
            sync::sync_configure,
            sync::sync_now,
        ])
        .run(tauri::generate_context!())
        .expect("error while running NexusTerminal");
}
