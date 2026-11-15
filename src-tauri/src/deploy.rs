//! Zero-downtime atomic application deployment manager (Issue #49).
//!
//! Implements the Capistrano / Deployer / Envoyer atomic symlink workflow over SSH or local shell:
//!   1. Prepare `$app_dir/releases` and `$app_dir/shared`
//!   2. Clone Git repository/branch into `$app_dir/releases/$release_id`
//!   3. Symlink shared persistent files & directories (e.g. `.env`, `storage`)
//!   4. Execute user-defined build scripts & snippet templates with `{{variable}}` substitution
//!   5. Atomically swap `$app_dir/current -> $app_dir/releases/$release_id`
//!   6. Keep the previous version folder(s) for 1-click rollback and remove older release folders

use crate::error::{AppError, AppResult};
use crate::vault::Vault;
use chrono::Utc;
use rusqlite::{params, OptionalExtension};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::io::Read;
use std::process::{Command, Stdio};
use tauri::State;

const DEPLOY_PROFILES_KEY: &str = "deploy_profiles_v1";

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DeployProfile {
    pub id: String,
    pub name: String,
    pub host_id: String,
    pub preset: String, // "laravel" | "nodejs" | "static" | "docker" | "custom"
    pub repo_url: String,
    pub branch: String,
    pub app_dir: String,
    pub keep_releases: u32,
    pub shared_files: Vec<String>,
    pub shared_dirs: Vec<String>,
    pub build_script: String,
    pub post_swap_script: String,
    #[serde(default)]
    pub snippet_ids: Vec<String>,
    #[serde(default)]
    pub variables: HashMap<String, String>,
    #[serde(default)]
    pub last_deployed_at: Option<i64>,
    #[serde(default)]
    pub last_release_id: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DeployReleaseItem {
    pub id: String,
    pub path: String,
    pub is_current: bool,
    pub is_previous: bool,
    pub commit: String,
    pub branch: String,
    pub subject: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DeployReleaseState {
    pub app_dir: String,
    pub current_release_id: Option<String>,
    pub previous_release_id: Option<String>,
    pub releases: Vec<DeployReleaseItem>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DeployStepLog {
    pub step: String,
    pub title: String,
    pub status: String, // "ok" | "error" | "skipped"
    pub output: String,
    pub duration_ms: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DeployRunRequest {
    pub host_id: String,
    pub repo_url: String,
    pub branch: String,
    pub app_dir: String,
    pub keep_releases: u32,
    #[serde(default)]
    pub shared_files: Vec<String>,
    #[serde(default)]
    pub shared_dirs: Vec<String>,
    pub build_script: String,
    #[serde(default)]
    pub post_swap_script: String,
    #[serde(default)]
    pub variables: HashMap<String, String>,
    #[serde(default)]
    pub profile_id: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DeployRunResult {
    pub success: bool,
    pub release_id: String,
    pub release_dir: String,
    pub steps: Vec<DeployStepLog>,
    pub state: Option<DeployReleaseState>,
    pub error: Option<String>,
}

/// Safely quotes a single-quoted POSIX shell token (`'foo'\''bar'`).
pub fn sh_quote(s: &str) -> String {
    format!("'{}'", s.replace('\'', "'\\''"))
}

/// Validates that `app_dir` is an absolute path and not `/` or empty.
pub fn validate_app_dir(app_dir: &str) -> AppResult<String> {
    let trimmed = app_dir.trim().trim_end_matches('/');
    if trimmed.is_empty() || !trimmed.starts_with('/') || trimmed == "/" {
        return Err(AppError::Other(
            "Application directory must be a non-root absolute path (e.g. /var/www/myapp)".into(),
        ));
    }
    if trimmed.contains('\0') || trimmed.contains('\n') {
        return Err(AppError::Other("Invalid characters in application directory path".into()));
    }
    Ok(trimmed.to_string())
}

/// Validates a relative path inside `shared/` or `releases/` to prevent `..` traversal.
pub fn validate_rel_path(rel: &str) -> AppResult<String> {
    let clean = rel.trim().trim_matches('/');
    if clean.is_empty()
        || clean.contains("..")
        || clean.contains('\0')
        || clean.contains('\n')
        || clean.starts_with('-')
    {
        return Err(AppError::Other(format!("Invalid relative path: {rel}")));
    }
    Ok(clean.to_string())
}

/// Substitutes `{{var}}` placeholders in a script using the provided map.
pub fn interpolate_template(template: &str, vars: &HashMap<String, String>) -> String {
    let mut out = String::with_capacity(template.len());
    let mut rest = template;
    while let Some(start) = rest.find("{{") {
        out.push_str(&rest[..start]);
        let after_open = &rest[start + 2..];
        if let Some(end) = after_open.find("}}") {
            let key = after_open[..end].trim();
            if !key.is_empty() && key.chars().all(|c| c.is_alphanumeric() || c == '_') {
                if let Some(val) = vars.get(key) {
                    out.push_str(val);
                } else {
                    out.push_str(&rest[start..start + 2 + end + 2]);
                }
            } else {
                out.push_str(&rest[start..start + 2 + end + 2]);
            }
            rest = &after_open[end + 2..];
        } else {
            out.push_str(&rest[start..]);
            rest = "";
        }
    }
    out.push_str(rest);
    out
}

/// Prepend non-interactive CI/tooling flags and common user/server binary paths
/// (Composer, PHP, Bun, Cargo, `.local/bin`, `/usr/local/sbin`, and `nvm` Node)
/// safely under `set -e` for non-login SSH `exec` channels.
fn wrap_deploy_script(cmd: &str) -> String {
    let preamble = r#"export GIT_TERMINAL_PROMPT=0 COMPOSER_NO_INTERACTION=1 CI=true DEBIAN_FRONTEND=noninteractive
for _drx_p in "$HOME/.local/bin" "$HOME/.config/composer/vendor/bin" "$HOME/.composer/vendor/bin" "$HOME/.bun/bin" "$HOME/.cargo/bin" /usr/local/sbin /usr/local/bin; do
  case ":$PATH:" in
    *":$_drx_p:"*) ;;
    *) [ -d "$_drx_p" ] && PATH="$_drx_p:$PATH" ;;
  esac
done
if ! command -v node >/dev/null 2>&1 && [ -d "$HOME/.nvm/versions/node" ]; then
  _drx_nvm=""
  for _drx_nb in "$HOME/.nvm/versions/node"/*/bin; do
    [ -d "$_drx_nb" ] && _drx_nvm="$_drx_nb"
  done
  if [ -n "$_drx_nvm" ]; then
    case ":$PATH:" in
      *":$_drx_nvm:"*) ;;
      *) PATH="$_drx_nvm:$PATH" ;;
    esac
  fi
fi
export PATH"#;
    format!("{preamble}\n{cmd}")
}

/// Reusable execution target (either local `sh` or one authenticated SSH `Session`
/// guarded for background execution so multi-step deploys avoid repeated SSH handshakes).
enum DeployTarget {
    Local,
    Remote {
        session: ssh2::Session,
        _bg_guard: crate::ssh::BackgroundSessionGuard,
    },
}

impl DeployTarget {
    fn connect(host_id: &str, vault: Option<&Vault>) -> AppResult<Self> {
        if host_id == "__local__" || host_id.is_empty() || host_id == "local" {
            Ok(Self::Local)
        } else {
            let v = vault.ok_or_else(|| AppError::Other("Vault state required for SSH host".into()))?;
            let (host, secret) = v.host_with_secret(host_id)?;
            let bg_guard = crate::ssh::BackgroundSessionGuard::acquire();
            let (session, _fp) = crate::ssh::open_authenticated(&host, &secret, v)?;
            Ok(Self::Remote {
                session,
                _bg_guard: bg_guard,
            })
        }
    }

    fn exec(&self, cmd: &str, timeout_ms: u32) -> AppResult<(bool, String)> {
        let wrapped = wrap_deploy_script(cmd);
        let q_wrapped = sh_quote(&wrapped);
        match self {
            Self::Local => {
                // Execute via `sh -c ... 2>&1` so stdout & stderr preserve chronological order
                // and stdin is closed so commands never block waiting for user input.
                let out = Command::new("sh")
                    .args(["-c", &format!("sh -c {q_wrapped} 2>&1")])
                    .stdin(Stdio::null())
                    .output()
                    .map_err(|e| {
                        AppError::Other(format!("Failed to execute local shell command: {e}"))
                    })?;
                let stdout = String::from_utf8_lossy(&out.stdout).to_string();
                let stderr = String::from_utf8_lossy(&out.stderr).to_string();
                let combined = match (stdout.trim().is_empty(), stderr.trim().is_empty()) {
                    (false, false) => format!("{}\n{}", stdout.trim_end(), stderr.trim_end()),
                    (false, true) => stdout,
                    (true, false) => stderr,
                    (true, true) => String::new(),
                };
                Ok((out.status.success(), combined))
            }
            Self::Remote { session, .. } => {
                session.set_timeout(timeout_ms);
                let mut ch = session.channel_session()?;
                // Merge stderr into stdout (`2>&1`) and detach stdin (`</dev/null`) so libssh2's
                // 32KB channel stderr window cannot deadlock long npm/composer/git builds.
                ch.exec(&format!("sh -c {q_wrapped} </dev/null 2>&1"))?;
                let mut out = String::new();
                let _ = ch.read_to_string(&mut out);
                let mut err = String::new();
                let _ = ch.stderr().read_to_string(&mut err);
                let wait_res = ch.wait_close();
                let exit_status = ch.exit_status().unwrap_or(-1);
                let killed_by_signal = ch
                    .exit_signal()
                    .map(|s| s.exit_signal.is_some())
                    .unwrap_or(false);
                let combined = match (out.trim().is_empty(), err.trim().is_empty()) {
                    (false, false) => format!("{}\n{}", out.trim_end(), err.trim_end()),
                    (false, true) => out,
                    (true, false) => err,
                    (true, true) => String::new(),
                };
                if let Err(e) = wait_res {
                    if combined.trim().is_empty() {
                        return Err(e.into());
                    }
                    return Ok((
                        false,
                        format!("{}\n[SSH channel error: {e}]", combined.trim_end()),
                    ));
                }
                Ok((exit_status == 0 && !killed_by_signal, combined))
            }
        }
    }
}

fn load_profiles_from_conn(conn: &rusqlite::Connection) -> Vec<DeployProfile> {
    let raw: Option<String> = conn
        .query_row(
            "SELECT value FROM ai_settings WHERE key = ?1",
            params![DEPLOY_PROFILES_KEY],
            |r| r.get(0),
        )
        .optional()
        .ok()
        .flatten();
    raw.and_then(|s| serde_json::from_str::<Vec<DeployProfile>>(&s).ok())
        .unwrap_or_default()
}

fn save_profiles_to_conn(conn: &rusqlite::Connection, profiles: &[DeployProfile]) -> AppResult<()> {
    let json = serde_json::to_string(profiles)
        .map_err(|e| AppError::Other(format!("Failed to serialize deploy profiles: {e}")))?;
    conn.execute(
        "INSERT INTO ai_settings(key, value) VALUES(?1, ?2)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value",
        params![DEPLOY_PROFILES_KEY, json],
    )?;
    Ok(())
}

#[tauri::command]
pub fn deploy_profiles_list(vault: State<'_, Vault>) -> AppResult<Vec<DeployProfile>> {
    vault.with(|conn| Ok(load_profiles_from_conn(conn)))
}

#[tauri::command]
pub fn deploy_profile_save(
    mut profile: DeployProfile,
    vault: State<'_, Vault>,
) -> AppResult<DeployProfile> {
    profile.app_dir = validate_app_dir(&profile.app_dir)?;
    if profile.id.trim().is_empty() {
        profile.id = uuid::Uuid::new_v4().to_string();
    }
    if profile.keep_releases == 0 {
        profile.keep_releases = 2;
    }
    vault.with(|conn| {
        let mut list = load_profiles_from_conn(conn);
        if let Some(existing) = list.iter_mut().find(|p| p.id == profile.id) {
            *existing = profile.clone();
        } else {
            list.push(profile.clone());
        }
        save_profiles_to_conn(conn, &list)?;
        Ok(profile)
    })
}

#[tauri::command]
pub fn deploy_profile_delete(id: String, vault: State<'_, Vault>) -> AppResult<()> {
    vault.with(|conn| {
        let mut list = load_profiles_from_conn(conn);
        list.retain(|p| p.id != id);
        save_profiles_to_conn(conn, &list)
    })
}

fn inspect_releases_on_target(
    target: &DeployTarget,
    app_dir: &str,
) -> AppResult<DeployReleaseState> {
    let clean_dir = validate_app_dir(app_dir)?;
    let q_dir = sh_quote(&clean_dir);
    let script = format!(
        r#"APP_DIR={q_dir}
CUR=""
if [ -L "$APP_DIR/current" ] || [ -d "$APP_DIR/current" ]; then
  CUR=$(readlink "$APP_DIR/current" 2>/dev/null || true)
  CUR=$(basename "$CUR" 2>/dev/null || true)
fi
echo "CURRENT:$CUR"
if [ -d "$APP_DIR/releases" ]; then
  for d in $(ls -1d "$APP_DIR/releases"/* 2>/dev/null | sort -r); do
    if [ -d "$d" ]; then
      REL=$(basename "$d")
      COMMIT=$(git -C "$d" rev-parse --short HEAD 2>/dev/null || echo "-")
      BRANCH=$(git -C "$d" rev-parse --abbrev-ref HEAD 2>/dev/null || echo "-")
      SUBJ=$(git -C "$d" log -1 --format=%s 2>/dev/null | tr '\n\r|' '   ' || echo "")
      echo "REL:$REL|$COMMIT|$BRANCH|$SUBJ"
    fi
  done
fi"#
    );

    let (ok, out) = target.exec(&script, 15_000)?;
    if !ok && !out.contains("CURRENT:") {
        return Err(AppError::Other(if out.trim().is_empty() {
            "Failed to inspect release directory".into()
        } else {
            out.trim().to_string()
        }));
    }

    let mut current_id: Option<String> = None;
    let mut raw_releases: Vec<(String, String, String, String)> = Vec::new();

    for line in out.lines() {
        let line = line.trim();
        if let Some(rest) = line.strip_prefix("CURRENT:") {
            let val = rest.trim();
            if !val.is_empty() {
                current_id = Some(val.to_string());
            }
        } else if let Some(rest) = line.strip_prefix("REL:") {
            let parts: Vec<&str> = rest.splitn(4, '|').collect();
            if !parts.is_empty() && !parts[0].trim().is_empty() {
                let id = parts[0].trim().to_string();
                let commit = parts.get(1).copied().unwrap_or("-").trim().to_string();
                let branch = parts.get(2).copied().unwrap_or("-").trim().to_string();
                let subject = parts.get(3).copied().unwrap_or("").trim().to_string();
                raw_releases.push((id, commit, branch, subject));
            }
        }
    }

    // Determine previous release: the first release after current (or the second item if current is first)
    let cur_idx = current_id
        .as_ref()
        .and_then(|cid| raw_releases.iter().position(|(id, _, _, _)| id == cid));
    let previous_id = match cur_idx {
        Some(idx) if idx + 1 < raw_releases.len() => Some(raw_releases[idx + 1].0.clone()),
        None if raw_releases.len() > 1 => Some(raw_releases[1].0.clone()),
        _ => None,
    };

    let releases = raw_releases
        .into_iter()
        .map(|(id, commit, branch, subject)| {
            let is_current = current_id.as_deref() == Some(id.as_str());
            let is_previous = previous_id.as_deref() == Some(id.as_str());
            DeployReleaseItem {
                path: format!("{clean_dir}/releases/{id}"),
                id,
                is_current,
                is_previous,
                commit,
                branch,
                subject,
            }
        })
        .collect();

    Ok(DeployReleaseState {
        app_dir: clean_dir,
        current_release_id: current_id,
        previous_release_id: previous_id,
        releases,
    })
}

pub fn inspect_releases_internal(
    host_id: &str,
    app_dir: &str,
    vault: Option<&Vault>,
) -> AppResult<DeployReleaseState> {
    let target = DeployTarget::connect(host_id, vault)?;
    inspect_releases_on_target(&target, app_dir)
}

#[tauri::command(async)]
pub fn deploy_list_releases(
    host_id: String,
    app_dir: String,
    vault: State<'_, Vault>,
) -> AppResult<DeployReleaseState> {
    inspect_releases_internal(&host_id, &app_dir, Some(&vault))
}

pub fn run_release_internal(
    req: DeployRunRequest,
    vault: Option<&Vault>,
) -> AppResult<DeployRunResult> {
    let app_dir = validate_app_dir(&req.app_dir)?;
    let repo_url = req.repo_url.trim().to_string();
    if repo_url.is_empty() {
        return Err(AppError::Other("Repository URL is required".into()));
    }
    let branch = if req.branch.trim().is_empty() {
        "main".to_string()
    } else {
        req.branch.trim().to_string()
    };
    let keep_releases = req.keep_releases.max(2);
    let release_id = Utc::now().format("%Y%m%d_%H%M%S_%3f").to_string();
    let release_dir = format!("{app_dir}/releases/{release_id}");
    let shared_dir = format!("{app_dir}/shared");
    let current_dir = format!("{app_dir}/current");

    let mut vars = req.variables.clone();
    vars.insert("app_dir".into(), app_dir.clone());
    vars.insert("release_dir".into(), release_dir.clone());
    vars.insert("shared_dir".into(), shared_dir.clone());
    vars.insert("current_dir".into(), current_dir.clone());
    vars.insert("release_id".into(), release_id.clone());
    vars.insert("repo_url".into(), repo_url.clone());
    vars.insert("branch".into(), branch.clone());
    vars.insert("keep_releases".into(), keep_releases.to_string());

    let target = DeployTarget::connect(&req.host_id, vault)?;
    let mut steps: Vec<DeployStepLog> = Vec::new();

    // 1. Prepare directory layout & clone repo into release folder
    let t1 = std::time::Instant::now();
    let q_app = sh_quote(&app_dir);
    let q_rel = sh_quote(&release_dir);
    let q_shared = sh_quote(&shared_dir);
    let q_branch = sh_quote(&branch);
    let q_repo = sh_quote(&repo_url);

    let clone_cmd = format!(
        "set -e\nmkdir -p {q_app}/releases {q_shared}\ngit clone --depth 1 --branch {q_branch} {q_repo} {q_rel} 2>&1"
    );
    let (ok1, out1) = target.exec(&clone_cmd, 180_000)?;
    steps.push(DeployStepLog {
        step: "clone".into(),
        title: format!("Clone {branch} into releases/{release_id}"),
        status: if ok1 { "ok".into() } else { "error".into() },
        output: out1.clone(),
        duration_ms: t1.elapsed().as_millis() as u64,
    });
    if !ok1 {
        let _ = target.exec(&format!("rm -rf {q_rel}"), 10_000);
        return Ok(DeployRunResult {
            success: false,
            release_id,
            release_dir,
            steps,
            state: inspect_releases_on_target(&target, &app_dir).ok(),
            error: Some(format!("Git clone failed: {}", out1.trim())),
        });
    }

    // 2. Link shared files and directories
    let t2 = std::time::Instant::now();
    let mut link_lines = vec!["set -e".to_string()];
    for dir_item in &req.shared_dirs {
        let rel = validate_rel_path(dir_item)?;
        let s_target = sh_quote(&format!("{shared_dir}/{rel}"));
        let r_target = sh_quote(&format!("{release_dir}/{rel}"));
        link_lines.push(format!(
            "mkdir -p {s_target} && mkdir -p $(dirname {r_target}) && rm -rf {r_target} && ln -sfn {s_target} {r_target}"
        ));
    }
    for file_item in &req.shared_files {
        let rel = validate_rel_path(file_item)?;
        let s_target = sh_quote(&format!("{shared_dir}/{rel}"));
        let r_target = sh_quote(&format!("{release_dir}/{rel}"));
        // Seed shared file from release example/template if not present yet
        link_lines.push(format!(
            "mkdir -p $(dirname {s_target}) $(dirname {r_target}) && \
             if [ ! -f {s_target} ]; then \
               if [ -f {r_target} ]; then cp {r_target} {s_target}; \
               elif [ -f {r_target}.example ]; then cp {r_target}.example {s_target}; \
               else touch {s_target}; fi; \
             fi && rm -f {r_target} && ln -sfn {s_target} {r_target}"
        ));
    }

    if link_lines.len() > 1 {
        let link_cmd = link_lines.join("\n");
        let (ok2, out2) = target.exec(&link_cmd, 30_000)?;
        steps.push(DeployStepLog {
            step: "shared".into(),
            title: "Link shared persistent files & directories".into(),
            status: if ok2 { "ok".into() } else { "error".into() },
            output: if out2.trim().is_empty() {
                format!(
                    "Linked {} shared dir(s) and {} shared file(s)",
                    req.shared_dirs.len(),
                    req.shared_files.len()
                )
            } else {
                out2.clone()
            },
            duration_ms: t2.elapsed().as_millis() as u64,
        });
        if !ok2 {
            let _ = target.exec(&format!("rm -rf {q_rel}"), 10_000);
            return Ok(DeployRunResult {
                success: false,
                release_id,
                release_dir,
                steps,
                state: inspect_releases_on_target(&target, &app_dir).ok(),
                error: Some(format!("Shared symlink step failed: {}", out2.trim())),
            });
        }
    }

    // 3. Run user scripts/snippets with {{variable}} template interpolation
    let resolved_build = interpolate_template(req.build_script.trim(), &vars);
    if !resolved_build.is_empty() {
        let t3 = std::time::Instant::now();
        let build_cmd = format!("set -e\ncd {q_rel}\n{resolved_build}\n");
        let (ok3, out3) = target.exec(&build_cmd, 300_000)?;
        steps.push(DeployStepLog {
            step: "build".into(),
            title: "Run build scripts & user snippets".into(),
            status: if ok3 { "ok".into() } else { "error".into() },
            output: out3.clone(),
            duration_ms: t3.elapsed().as_millis() as u64,
        });
        if !ok3 {
            // Clean up failed release so broken build never litters releases/ or touches live site
            let _ = target.exec(&format!("rm -rf {q_rel}"), 10_000);
            return Ok(DeployRunResult {
                success: false,
                release_id,
                release_dir,
                steps,
                state: inspect_releases_on_target(&target, &app_dir).ok(),
                error: Some(format!("Build script failed (live site untouched): {}", out3.trim())),
            });
        }
    }

    // 4. Atomic symlink swap (`current -> releases/$release_id`) + post-swap reload
    let t4 = std::time::Instant::now();
    let resolved_post_swap = interpolate_template(req.post_swap_script.trim(), &vars);
    let q_cur = sh_quote(&current_dir);
    let q_tmp = sh_quote(&format!("{app_dir}/.current_tmp_{release_id}"));
    let swap_cmd = format!(
        "set -e\n\
         if [ -d {q_cur} ] && [ ! -L {q_cur} ]; then mv {q_cur} {q_app}/current_backup_{release_id}; fi\n\
         ln -sfn {q_rel} {q_tmp} && (mv -Tf {q_tmp} {q_cur} 2>/dev/null || (rm -f {q_tmp} && ln -sfn {q_rel} {q_cur}))\n\
         cd {q_cur}\n\
         {resolved_post_swap}\n"
    );
    let (ok4, out4) = target.exec(&swap_cmd, 60_000)?;
    steps.push(DeployStepLog {
        step: "swap".into(),
        title: format!("Atomic symlink swap (current → releases/{release_id})"),
        status: if ok4 { "ok".into() } else { "error".into() },
        output: if out4.trim().is_empty() {
            format!("Swapped {current_dir} → {release_dir}")
        } else {
            out4.clone()
        },
        duration_ms: t4.elapsed().as_millis() as u64,
    });
    if !ok4 {
        return Ok(DeployRunResult {
            success: false,
            release_id,
            release_dir,
            steps,
            state: inspect_releases_on_target(&target, &app_dir).ok(),
            error: Some(format!("Symlink swap / post-swap hook failed: {}", out4.trim())),
        });
    }

    // 5. Keep previous release folder(s) and prune older releases
    let t5 = std::time::Instant::now();
    let prune_start = keep_releases + 1;
    let q_rel_id = sh_quote(&release_id);
    let prune_cmd = format!(
        "cd {q_app}/releases && \
         REMOVED=$(ls -1d */ 2>/dev/null | tr -d '/' | sort -r | tail -n +{prune_start} | grep -vxF {q_rel_id} || true) && \
         if [ -n \"$REMOVED\" ]; then \
           echo \"$REMOVED\" | xargs rm -rf -- && echo \"Removed older releases: $(echo $REMOVED | tr '\\n' ' ')\"; \
         else \
           echo \"Retained active + previous release folders (<= {keep_releases} total)\"; \
         fi"
    );
    let (ok5, out5) = target.exec(&prune_cmd, 30_000)?;
    steps.push(DeployStepLog {
        step: "cleanup".into(),
        title: format!("Retain last {keep_releases} releases & prune older folders"),
        status: if ok5 { "ok".into() } else { "error".into() },
        output: out5,
        duration_ms: t5.elapsed().as_millis() as u64,
    });

    // Update profile metadata if profile_id was supplied
    if let (Some(pid), Some(v)) = (req.profile_id.as_ref(), vault) {
        let _ = v.with(|conn| {
            let mut list = load_profiles_from_conn(conn);
            if let Some(p) = list.iter_mut().find(|p| &p.id == pid) {
                p.last_deployed_at = Some(Utc::now().timestamp());
                p.last_release_id = Some(release_id.clone());
                let _ = save_profiles_to_conn(conn, &list);
            }
            Ok(())
        });
    }

    let state = inspect_releases_on_target(&target, &app_dir).ok();
    Ok(DeployRunResult {
        success: true,
        release_id,
        release_dir,
        steps,
        state,
        error: None,
    })
}

#[tauri::command(async)]
pub fn deploy_run_release(
    req: DeployRunRequest,
    vault: State<'_, Vault>,
) -> AppResult<DeployRunResult> {
    run_release_internal(req, Some(&vault))
}

pub fn rollback_internal(
    host_id: &str,
    app_dir: &str,
    target_release_id: Option<String>,
    post_swap_script: Option<String>,
    vault: Option<&Vault>,
) -> AppResult<DeployRunResult> {
    let clean_dir = validate_app_dir(app_dir)?;
    let target = DeployTarget::connect(host_id, vault)?;
    let state_before = inspect_releases_on_target(&target, &clean_dir)?;
    let target_id = target_release_id
        .filter(|s| !s.trim().is_empty())
        .or_else(|| state_before.previous_release_id.clone())
        .ok_or_else(|| {
            AppError::Other("No previous release folder available to roll back to.".into())
        })?;
    let clean_rel_id = validate_rel_path(&target_id)?;
    let target_dir = format!("{clean_dir}/releases/{clean_rel_id}");
    let current_dir = format!("{clean_dir}/current");
    let shared_dir = format!("{clean_dir}/shared");

    let mut vars = HashMap::new();
    vars.insert("app_dir".into(), clean_dir.clone());
    vars.insert("release_dir".into(), target_dir.clone());
    vars.insert("current_dir".into(), current_dir.clone());
    vars.insert("shared_dir".into(), shared_dir);
    vars.insert("release_id".into(), clean_rel_id.clone());

    let t = std::time::Instant::now();
    let q_rel = sh_quote(&target_dir);
    let q_cur = sh_quote(&current_dir);
    let q_tmp = sh_quote(&format!("{clean_dir}/.current_rollback_tmp"));
    let post = interpolate_template(&post_swap_script.unwrap_or_default(), &vars);

    let cmd = format!(
        "set -e\n\
         if [ ! -d {q_rel} ]; then echo \"Release folder not found: {q_rel}\" >&2; exit 1; fi\n\
         ln -sfn {q_rel} {q_tmp} && (mv -Tf {q_tmp} {q_cur} 2>/dev/null || (rm -f {q_tmp} && ln -sfn {q_rel} {q_cur}))\n\
         cd {q_cur}\n\
         {post}\n\
         echo \"Rolled back current symlink to releases/{clean_rel_id}\""
    );
    let (ok, out) = target.exec(&cmd, 30_000)?;
    let step = DeployStepLog {
        step: "rollback".into(),
        title: format!("Atomic rollback (current → releases/{clean_rel_id})"),
        status: if ok { "ok".into() } else { "error".into() },
        output: out.clone(),
        duration_ms: t.elapsed().as_millis() as u64,
    };

    let state_after = inspect_releases_on_target(&target, &clean_dir).ok();
    Ok(DeployRunResult {
        success: ok,
        release_id: clean_rel_id,
        release_dir: target_dir,
        steps: vec![step],
        state: state_after,
        error: if ok { None } else { Some(out.trim().to_string()) },
    })
}

#[tauri::command(async)]
pub fn deploy_rollback(
    host_id: String,
    app_dir: String,
    target_release_id: Option<String>,
    post_swap_script: Option<String>,
    vault: State<'_, Vault>,
) -> AppResult<DeployRunResult> {
    rollback_internal(&host_id, &app_dir, target_release_id, post_swap_script, Some(&vault))
}

#[tauri::command(async)]
pub fn deploy_delete_release(
    host_id: String,
    app_dir: String,
    release_id: String,
    vault: State<'_, Vault>,
) -> AppResult<DeployReleaseState> {
    let clean_dir = validate_app_dir(&app_dir)?;
    let clean_rel = validate_rel_path(&release_id)?;
    let target = DeployTarget::connect(&host_id, Some(&vault))?;
    let state = inspect_releases_on_target(&target, &clean_dir)?;
    if state.current_release_id.as_deref() == Some(clean_rel.as_str()) {
        return Err(AppError::Other(
            "Cannot delete the currently active live release.".into(),
        ));
    }
    let q_target = sh_quote(&format!("{clean_dir}/releases/{clean_rel}"));
    let (ok, out) = target.exec(&format!("rm -rf -- {q_target}"), 15_000)?;
    if !ok {
        return Err(AppError::Other(format!("Failed to delete release: {out}")));
    }
    inspect_releases_on_target(&target, &clean_dir)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_validate_app_dir() {
        assert_eq!(validate_app_dir("/var/www/laravel/").unwrap(), "/var/www/laravel");
        assert!(validate_app_dir("/").is_err());
        assert!(validate_app_dir("relative/path").is_err());
        assert!(validate_app_dir("").is_err());
    }

    #[test]
    fn test_validate_rel_path() {
        assert_eq!(validate_rel_path("/storage/").unwrap(), "storage");
        assert_eq!(validate_rel_path(".env").unwrap(), ".env");
        assert!(validate_rel_path("../etc/passwd").is_err());
        assert!(validate_rel_path("-rf").is_err());
    }

    #[test]
    fn test_interpolate_template() {
        let mut vars = HashMap::new();
        vars.insert("branch".into(), "main".into());
        vars.insert("php_bin".into(), "php8.3".into());
        let script = "git checkout {{branch}} && {{ php_bin }} artisan migrate --force && echo {{unknown}}";
        assert_eq!(
            interpolate_template(script, &vars),
            "git checkout main && php8.3 artisan migrate --force && echo {{unknown}}"
        );
    }

    #[test]
    fn test_wrap_deploy_script_and_local_stderr_merge() {
        let wrapped = wrap_deploy_script("set -e\necho \"out-1\"\necho \"err-1\" >&2\necho \"$GIT_TERMINAL_PROMPT|$COMPOSER_NO_INTERACTION\"");
        assert!(wrapped.contains("COMPOSER_NO_INTERACTION=1"));
        assert!(wrapped.contains(".composer/vendor/bin"));

        let target = DeployTarget::connect("__local__", None).unwrap();
        let (ok, output) = target
            .exec(
                "set -e\necho \"out-1\"\necho \"err-1\" >&2\necho \"$GIT_TERMINAL_PROMPT|$COMPOSER_NO_INTERACTION\"",
                10_000,
            )
            .unwrap();
        assert!(ok, "wrapped local exec failed: {output}");
        let out_pos = output.find("out-1").expect("stdout missing");
        let err_pos = output.find("err-1").expect("stderr missing");
        assert!(out_pos < err_pos, "expected merged output order: {output}");
        assert!(output.contains("0|1"), "expected non-interactive env vars: {output}");
    }

    #[test]
    fn test_full_atomic_deploy_and_rollback_lifecycle() {
        let base = std::env::temp_dir().join(format!("drexius_deploy_e2e_{}", uuid::Uuid::new_v4()));
        let repo_dir = base.join("origin_repo");
        let app_dir = base.join("var_www_laravel");
        std::fs::create_dir_all(&repo_dir).unwrap();

        let commit_version = |ver: &str| {
            let cmd = format!(
                "cd '{}' && \
                 git init -b main >/dev/null 2>&1 || true && \
                 git config user.email 'test@drexius.dev' && \
                 git config user.name 'Drexius Test' && \
                 echo 'APP_NAME=Drexius' > .env.example && \
                 echo '{}' > version.txt && \
                 git add -A && \
                 git commit -m 'Release {}' >/dev/null 2>&1",
                repo_dir.display(),
                ver,
                ver
            );
            let out = Command::new("sh").args(["-c", &cmd]).output().unwrap();
            assert!(out.status.success(), "git commit failed: {:?}", out);
        };

        let make_req = || {
            let mut vars = HashMap::new();
            vars.insert("custom_greeting".into(), "hello-laravel".into());
            DeployRunRequest {
                host_id: "__local__".into(),
                repo_url: repo_dir.to_string_lossy().to_string(),
                branch: "main".into(),
                app_dir: app_dir.to_string_lossy().to_string(),
                keep_releases: 2,
                shared_files: vec![".env".into()],
                shared_dirs: vec!["storage".into()],
                build_script: "echo '{{custom_greeting}} from {{release_id}}' > built.txt && echo 'log-entry' >> storage/app.log".into(),
                post_swap_script: "echo 'swapped:{{release_id}}' > '{{app_dir}}/last_swap.txt'".into(),
                variables: vars,
                profile_id: None,
            }
        };

        // 1. Deploy v1
        commit_version("v1");
        let res1 = run_release_internal(make_req(), None).unwrap();
        assert!(res1.success, "v1 deploy failed: {:?}", res1.error);
        assert_eq!(
            std::fs::read_to_string(app_dir.join("current/version.txt")).unwrap().trim(),
            "v1"
        );
        assert_eq!(
            std::fs::read_to_string(app_dir.join("shared/.env")).unwrap().trim(),
            "APP_NAME=Drexius"
        );
        assert!(
            std::fs::read_to_string(app_dir.join("current/built.txt"))
                .unwrap()
                .contains("hello-laravel")
        );

        std::thread::sleep(std::time::Duration::from_millis(15));

        // 2. Deploy v2
        commit_version("v2");
        let res2 = run_release_internal(make_req(), None).unwrap();
        assert!(res2.success, "v2 deploy failed: {:?}", res2.error);
        assert_eq!(
            std::fs::read_to_string(app_dir.join("current/version.txt")).unwrap().trim(),
            "v2"
        );

        std::thread::sleep(std::time::Duration::from_millis(15));

        // 3. Deploy v3 — keep_releases=2 should keep v3 (current) and v2 (previous), and prune v1!
        commit_version("v3");
        let res3 = run_release_internal(make_req(), None).unwrap();
        assert!(res3.success, "v3 deploy failed: {:?}", res3.error);
        let state = res3.state.unwrap();
        assert_eq!(state.releases.len(), 2, "Expected exactly 2 retained releases (v3 and v2)");
        assert_eq!(state.current_release_id.as_deref(), Some(res3.release_id.as_str()));
        assert_eq!(state.previous_release_id.as_deref(), Some(res2.release_id.as_str()));
        assert!(!app_dir.join("releases").join(&res1.release_id).exists(), "v1 should have been pruned");

        // Shared storage log should have persisted across all 3 releases!
        let log_count = std::fs::read_to_string(app_dir.join("shared/storage/app.log"))
            .unwrap()
            .lines()
            .count();
        assert_eq!(log_count, 3, "Shared storage directory should persist across releases");

        // 4. Test failed build does NOT touch live symlink (`current` stays on v3)
        let mut bad_req = make_req();
        bad_req.build_script = "exit 1".into();
        let bad_res = run_release_internal(bad_req, None).unwrap();
        assert!(!bad_res.success);
        assert_eq!(
            std::fs::read_to_string(app_dir.join("current/version.txt")).unwrap().trim(),
            "v3"
        );

        // 5. Rollback to previous release (v2)
        let rb = rollback_internal(
            "__local__",
            &app_dir.to_string_lossy(),
            None,
            Some("echo 'rolled_back:{{release_id}}' > '{{app_dir}}/last_swap.txt'".into()),
            None,
        )
        .unwrap();
        assert!(rb.success, "rollback failed: {:?}", rb.error);
        assert_eq!(rb.release_id, res2.release_id);
        assert_eq!(
            std::fs::read_to_string(app_dir.join("current/version.txt")).unwrap().trim(),
            "v2"
        );
        assert_eq!(
            std::fs::read_to_string(app_dir.join("last_swap.txt")).unwrap().trim(),
            format!("rolled_back:{}", res2.release_id)
        );

        let _ = std::fs::remove_dir_all(&base);
    }
}
