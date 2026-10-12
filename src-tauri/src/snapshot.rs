//! Session snapshotting.
//!
//! The SSH I/O thread records cwd (from OSC-7) and last submitted command into
//! an in-memory map (cheap, lock-held for nanoseconds). A background thread
//! flushes dirty entries into the encrypted vault every 10 s. On reconnect,
//! `ssh_connect { resume: true }` replays `cd <cwd>` so the user lands exactly
//! where they were.

use crate::error::AppResult;
use crate::vault::Vault;
use parking_lot::Mutex;
use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};
use std::sync::Arc;
use tauri::State;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Snapshot {
    pub host_id: String,
    pub session_id: Option<String>,
    pub cwd: String,
    pub last_command: Option<String>,
    pub updated_at: i64,
}

#[derive(Default)]
struct Inner {
    live: HashMap<String, Snapshot>,
    dirty: HashSet<String>,
}

#[derive(Clone, Default)]
pub struct SnapshotStore(Arc<Mutex<Inner>>);

impl SnapshotStore {
    fn upsert(&self, host_id: &str, session_id: &str, f: impl FnOnce(&mut Snapshot)) {
        let mut g = self.0.lock();
        let snap = g.live.entry(host_id.to_string()).or_insert_with(|| Snapshot {
            host_id: host_id.into(),
            session_id: Some(session_id.into()),
            cwd: "~".into(),
            last_command: None,
            updated_at: 0,
        });
        f(snap);
        snap.updated_at = chrono::Utc::now().timestamp();
        g.dirty.insert(host_id.to_string());
    }

    pub fn record_cwd(&self, host_id: &str, session_id: &str, cwd: &str) {
        self.upsert(host_id, session_id, |s| s.cwd = cwd.to_string());
    }

    pub fn record_command(&self, host_id: &str, session_id: &str, cmd: &str) {
        // Never persist commands that look like they contain secrets (shared filter with command history).
        if crate::vault::looks_sensitive_command(cmd) {
            return;
        }
        self.upsert(host_id, session_id, |s| s.last_command = Some(cmd.to_string()));
    }

    pub fn get(&self, host_id: &str) -> Option<Snapshot> {
        self.0.lock().live.get(host_id).cloned()
    }

    pub fn flush(&self, vault: &Vault) -> AppResult<()> {
        let pending: Vec<Snapshot> = {
            let mut g = self.0.lock();
            let ids: Vec<String> = g.dirty.drain().collect();
            ids.iter().filter_map(|id| g.live.get(id).cloned()).collect()
        };
        for s in &pending {
            if let Err(e) = vault.save_snapshot(s) {
                // put back as dirty, retry next tick (e.g. vault locked)
                self.0.lock().dirty.insert(s.host_id.clone());
                return Err(e);
            }
        }
        Ok(())
    }
}

#[tauri::command]
pub fn snapshot_get(host_id: String, store: State<'_, SnapshotStore>, vault: State<'_, Vault>) -> AppResult<Option<Snapshot>> {
    if let Some(s) = store.get(&host_id) {
        return Ok(Some(s));
    }
    vault.load_snapshot(&host_id)
}

#[tauri::command]
pub fn snapshot_list(store: State<'_, SnapshotStore>) -> Vec<Snapshot> {
    store.0.lock().live.values().cloned().collect()
}
