//! DrexiusTerminal Rust core — wires state + IPC commands into the Tauri runtime.

mod error;
mod fs_guard;
mod local_pty;
mod pairing;
mod serial;
mod sftp;
mod snapshot;
mod ssh;
mod sync;
mod tunnel;
mod vault;
mod ai_client;
mod opencode;
mod ssh_config;
mod tailscale;
mod netbird;
mod cloud_sync;
mod docker;

use std::time::Duration;
use tauri::Manager;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    env_logger::init();

    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_clipboard_manager::init())
        .plugin(tauri_plugin_biometric::init())
        .setup(|app| {
            let data_dir = app
                .path()
                .app_data_dir()
                .expect("no app data dir available");
            std::fs::create_dir_all(&data_dir)?;

            let vault = vault::Vault::new(data_dir.join("drexius.vault"));
            let snapshots = snapshot::SnapshotStore::default();

            app.manage(vault);
            app.manage(snapshots.clone());
            app.manage(ssh::SshManager::default());
            app.manage(sftp::SftpManager::default());
            app.manage(sync::SyncEngine::default());
            app.manage(local_pty::LocalPtyManager::default());
            app.manage(tunnel::TunnelManager::default());
            app.manage(serial::SerialManager::default());
            app.manage(pairing::PairingManager::default());

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
            vault::vault_verify_password,
            vault::vault_recover,
            vault::vault_reset,
            vault::vault_get_recovery_key,
            vault::vault_regenerate_recovery_key,
            vault::vault_save_emergency_kit,
            vault::vault_lock,
            vault::vault_list,
            vault::vault_save,
            vault::vault_delete,
            serial::serial_list_ports,
            vault::team_vault_export,
            vault::team_vault_import,
            // os keychain (biometric unlock)
            vault::os_keychain_unlock,
            vault::os_keychain_store,
            vault::os_keychain_delete,
            vault::os_keychain_status,
            vault::check_storage_permission,
            vault::request_storage_permission,
            // ai configs & multi-provider settings
            vault::ai_configs_list,
            vault::ai_config_save,
            vault::ai_keys_add,
            vault::ai_key_remove,
            vault::ai_keys_clear,
            vault::ai_proxies_add,
            vault::ai_proxy_remove,
            vault::ai_proxies_clear,
            vault::ai_active_provider_get,
            vault::ai_active_provider_set,
            ai_client::ai_stream_proxy,
            ai_client::ai_stream_cancel,
            ai_client::ai_fetch_proxy,
            // hosts
            vault::hosts_list,
            vault::host_save,
            vault::host_save_with_new_keychain,
            vault::host_delete,
            vault::host_trust_key,
            // keychain (reusable identities)
            vault::keychain_list,
            vault::keychain_save,
            vault::keychain_delete,
            vault::keychain_import_from_hosts,
            vault::keychain_detect_local_keys,
            vault::keychain_import_local_key,
            vault::keychain_generate_and_save,
            // connection logs
            vault::logs_list,
            vault::log_toggle_saved,
            vault::logs_clear,
            // command history
            vault::command_history_add,
            vault::command_history_list,
            vault::command_history_toggle_star,
            vault::command_history_delete,
            vault::command_history_clear,
            // clipboard history
            vault::clipboard_history_add,
            vault::clipboard_history_list,
            vault::clipboard_history_toggle_pin,
            vault::clipboard_history_delete,
            vault::clipboard_history_clear,
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
            tunnel::ai_tunnel_start,
            tunnel::ai_tunnel_stop,
            // snippets
            vault::snippets_list,
            vault::snippet_save,
            vault::snippet_delete,
            // ssh
            ssh::ssh_connect,
            ssh::ssh_attach,
            ssh::ssh_write,
            ssh::ssh_resize,
            ssh::ssh_disconnect,
            ssh::ssh_sessions,
            // local pty
            local_pty::local_pty_spawn,
            local_pty::local_pty_attach,
            local_pty::local_pty_write,
            local_pty::local_pty_resize,
            local_pty::local_pty_close,
            local_pty::read_file_base64,
            // native serial port
            serial::serial_open,
            serial::serial_write,
            serial::serial_close,
            // sftp
            sftp::sftp_connect,
            sftp::sftp_list,
            sftp::sftp_download,
            sftp::sftp_upload,
            sftp::sftp_transfer_remote,
            sftp::sftp_mkdir,
            sftp::sftp_remove,
            sftp::sftp_rename,
            sftp::sftp_read_text,
            sftp::sftp_write_text,
            sftp::sftp_close,
            sftp::local_fs_home,
            sftp::local_fs_list,
            sftp::local_fs_copy,
            sftp::local_fs_mkdir,
            sftp::local_fs_remove,
            sftp::local_fs_rename,
            sftp::local_fs_read_text,
            sftp::local_fs_write_text,
            // ssh config importer
            ssh_config::ssh_config_detect,
            ssh_config::ssh_config_preview,
            ssh_config::ssh_config_import,
            // snapshots
            snapshot::snapshot_get,
            snapshot::snapshot_list,
            // sync
            sync::sync_status,
            sync::sync_configure,
            sync::sync_now,
            // direct device pairing
            pairing::pairing_start_host,
            pairing::pairing_stop_host,
            pairing::pairing_join_client,
            pairing::pairing_list_devices,
            pairing::pairing_remove_device,
            pairing::pairing_revoke_device,
            pairing::pairing_allow_device,
            pairing::pairing_get_local_info,
            // local filesystem operations for agent
            // opencode integration
            opencode::opencode_detect,
            opencode::opencode_detect_session,
            opencode::opencode_stream,
            opencode::opencode_stream_cancel,
            // tailscale integration
            tailscale::tailscale_detect_cli,
            tailscale::tailscale_fetch_api,
            tailscale::tailscale_import,
            tailscale::tailscale_get_credentials,
            tailscale::tailscale_save_credentials,
            // netbird mesh integration
            netbird::netbird_detect_cli,
            netbird::netbird_fetch_api,
            netbird::netbird_import_devices,
            netbird::netbird_get_credentials,
            netbird::netbird_save_credentials,
            // cloud provider fleet sync
            cloud_sync::cloud_fetch_instances,
            cloud_sync::cloud_import_instances,
            cloud_sync::cloud_get_credentials,
            cloud_sync::cloud_save_credentials,
            // docker container management
            docker::docker_list_containers,
            docker::docker_container_action,
            docker::docker_container_logs,
        ])
        .run(tauri::generate_context!())
        .expect("error while running DrexiusTerminal");
}
