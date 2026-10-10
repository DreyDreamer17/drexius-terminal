# NexusTerminal — Architecture Blueprint

> A secure, local-first, open-source alternative to Termius.
> Stack: **Tauri 2 (Rust)** backend · **React 19 + Tailwind 4 + xterm.js** frontend.

```
nexus-terminal/
├── ARCHITECTURE.md
├── index.html
├── package.json
├── src/                              # React frontend (WebView)
│   ├── App.tsx                       # Workspace shell: hosts · tabs · panes · AI · SFTP
│   ├── components/
│   │   ├── HostSidebar.tsx           # Connection profiles (vault-backed)
│   │   ├── TabBar.tsx                # Multi-tab sessions
│   │   ├── TerminalPane.tsx          # xterm.js + OSC-7 cwd tracking + snapshots
│   │   ├── AIPanel.tsx               # Local LLM assistant (Ollama-compatible API)
│   │   ├── SftpDrawer.tsx            # Graphical remote file manager
│   │   ├── SnippetsPanel.tsx         # Snippet library → broadcast to sessions
│   │   └── HostModal.tsx             # New / edit host (password · RSA · ED25519)
│   └── lib/
│       ├── bridge.ts                 # Single IPC surface: Tauri invoke() ⇄ demo sandbox
│       ├── demoShell.ts              # In-browser sandbox shell & virtual FS (preview mode)
│       ├── ollama.ts                 # Streaming client for /api/chat
│       ├── themes.ts                 # Terminal colour themes
│       └── types.ts
└── src-tauri/                        # Rust core (all secrets live here, never in JS)
    ├── Cargo.toml
    ├── build.rs
    ├── tauri.conf.json
    ├── capabilities/default.json     # Least-privilege IPC permissions
    └── src/
        ├── main.rs                   # Binary entry
        ├── lib.rs                    # Builder, state, command registration
        ├── error.rs                  # Serializable error type
        ├── ssh.rs                    # SSH session manager (PTY ⇄ ipc::Channel)
        ├── sftp.rs                   # SFTP ops multiplexed on the SSH session
        ├── vault.rs                  # SQLCipher (AES-256) encrypted store + Argon2id KDF
        ├── snapshot.rs               # Session snapshotting & resume
        └── sync.rs                   # Zero-knowledge E2EE sync (blueprint + stubs)
```

## 1. Trust boundaries

```
┌──────────────── WebView (untrusted-ish UI) ────────────────┐
│  React · xterm.js · AI panel                               │
│  ▸ never sees private keys or passwords after save         │
│  ▸ refers to hosts by opaque UUID                          │
└───────────────┬────────────────────────────────────────────┘
                │ Tauri IPC (allow-listed commands only, CSP locked)
┌───────────────▼────────────────────────────────────────────┐
│  Rust core                                                 │
│  vault.rs  ─ SQLCipher AES-256 (page-level), Argon2id KDF  │
│  ssh.rs    ─ libssh2 sessions, host-key TOFU verification  │
│  sftp.rs   ─ file ops on the same authenticated session    │
│  snapshot  ─ cwd/env state → vault, resumes on reconnect   │
│  sync.rs   ─ XChaCha20-Poly1305 sealed blobs → any relay   │
└────────────────────────────────────────────────────────────┘
```

* Secrets are zeroized (`zeroize`) after use; decrypted keys only live inside `ssh2::Session::userauth_pubkey_memory`.
* The master key is derived with **Argon2id (m=64 MiB, t=3, p=1)** and passed to SQLCipher as a raw hex key (`PRAGMA key = "x'…'"`) — no SQLCipher-internal PBKDF2 weakness.
* Optional: master key wrapped in the OS keychain (`keyring` crate) for unlock-with-biometrics.

## 2. SSH data path

`ssh_connect` spawns one OS thread per session. The thread owns the non-blocking
libssh2 channel and multiplexes:

1. PTY output → `tauri::ipc::Channel<SshEvent>` (ordered, high-throughput, no global event bus)
2. Frontend commands (`Write`, `Resize`, `Close`) ← `std::sync::mpsc`
3. Keep-alives every 15 s, dropped-link detection → `SshEvent::Disconnected`

## 3. Session snapshotting

On connect we inject a tiny, idempotent shell hook:

```sh
__nx_osc7(){ printf '\e]7;file://%s%s\a' "$HOSTNAME" "$PWD"; }; PROMPT_COMMAND="__nx_osc7;$PROMPT_COMMAND"
```

Every prompt emits an OSC-7 sequence. Both the Rust reader and xterm.js parse it,
and `snapshot.rs` persists `{host_id, cwd, last_command, env_whitelist, ts}` every 10 s.
When a link drops, the UI shows a reconnect banner; on reconnect the session is
re-established and the shell is restored to `cd <cwd>` (plus optional `tmux attach`
when tmux is detected — true process persistence).

## 4. Zero-knowledge sync

```
 Device A                         Relay (dumb blob store)                Device B
 ────────                         ──────────────────────                ────────
 vault rows ─► CBOR ─► XChaCha20-Poly1305(K_sync) ─► PUT /blobs/{HMAC(id)} ─► GET ─► decrypt ─► merge (HLC LWW)
```

* `K_root  = Argon2id(master_password, salt)`
* `K_sync  = HKDF-SHA256(K_root, "nexus/sync/v1")`, `K_index = HKDF(K_root, "nexus/index/v1")`
* Record ids are blinded with `HMAC(K_index, id)`; the relay sees only opaque, padded blobs.
* New devices pair via a QR code containing `K_sync` wrapped in an X25519 ephemeral exchange.
* Transport is a trait (`SyncTransport`) → WebDAV, S3, Git, or a self-hosted relay.

## 5. Local AI assistant

The AI panel calls an **Ollama-compatible** endpoint (`http://localhost:11434/api/chat`)
with streaming. Context = the last N lines of the active terminal buffer + cwd + OS.
Generated commands are **never auto-executed**: they're shown with a risk classifier
(`rm -rf`, `dd`, `mkfs`, `chmod -R 777`, fork-bombs …) and require an explicit "Run" click.
