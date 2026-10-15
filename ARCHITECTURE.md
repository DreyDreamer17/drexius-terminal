# NexusTerminal — Architecture

> A secure, local-first, open-source alternative to Termius.
> Stack: **Tauri 2 (Rust)** backend · **React 19 + Tailwind 4 + xterm.js** frontend.

```
nexusterminal/
├── ARCHITECTURE.md
├── index.html · package.json · vite.config.ts · tsconfig.json
├── src/                                # React frontend (WebView)
│   ├── App.tsx                         # Workspace shell: lock screen · sidebar rail · tabs · panes · panels
│   ├── components/
│   │   ├── LockScreen.tsx              # Master-password unlock
│   │   ├── HostSidebar.tsx / HostModal.tsx   # Connection profiles (vault-backed) + Quick Connect
│   │   ├── TerminalPane.tsx            # xterm.js, OSC-7 cwd tracking, search, broadcast input
│   │   ├── AIPanel.tsx                 # AI assistant, provider/key/proxy settings, Run/Insert gating
│   │   ├── SftpTab.tsx                 # Graphical local/remote file manager
│   │   ├── SnippetsPanel.tsx           # Snippet library → broadcast to sessions
│   │   ├── KeychainPanel.tsx           # Reusable identities, key import/generation
│   │   ├── PortForwardingPanel.tsx     # Local / remote (reverse) / dynamic (SOCKS5) tunnels
│   │   ├── KnownHostsPanel.tsx · LogsPanel.tsx · SerialModal.tsx
│   │   ├── VaultMenu.tsx · TeamShareModal.tsx   # Multi-vault + encrypted team bundles
│   │   ├── DevicePairingModal.tsx      # QR + PIN device pairing
│   │   └── OsIcon.tsx
│   └── lib/
│       ├── bridge.ts                   # Single IPC surface: Tauri invoke() ⇄ in-browser demo sandbox
│       ├── demoShell.ts                # Sandbox shell & virtual FS (preview mode only)
│       ├── ollama.ts                   # AI provider engine (all providers, not just Ollama)
│       ├── sessions.ts · themes.ts · os.ts · types.ts
│       └── (utils/cn.ts)
└── src-tauri/                          # Rust core (vault, SSH, AI relay; WebView can handle secrets)
    ├── Cargo.toml · build.rs · tauri.conf.json
    ├── capabilities/default.json       # Least-privilege IPC permissions
    └── src/
        ├── main.rs · lib.rs            # Entry, builder, state, command registration
        ├── error.rs                    # Serializable `{ kind, message }` error type
        ├── vault.rs                    # SQLCipher store, Argon2id KDF, all CRUD, multi-vault, team bundles
        ├── ssh.rs                      # SSH sessions (PTY ⇄ ipc::Channel), jump hosts, host-key TOFU
        ├── sftp.rs                     # SFTP on a dedicated blocking connection per terminal
        ├── local_pty.rs                # Local shells via portable-pty
        ├── tunnel.rs                   # Port forwarding (local + remote reverse + dynamic SOCKS5), AI SSH proxy tunnel
        ├── snapshot.rs                 # cwd / last-command snapshots → vault, resume on reconnect
        ├── ai_client.rs                # AI HTTP relay: key/proxy pools, auth injection, failover, cancel
        ├── pairing.rs                  # Direct device-to-device pairing over the LAN
        ├── sync.rs                     # v2 shared-seed encrypted relay sync + HLC merges
        ├── ssh_config.rs               # SSH config preview/import
        ├── fs_guard.rs                 # Filesystem access guardrails
        ├── serial.rs                   # Hardware serial port connections (UART) via serialport
        └── opencode.rs                 # OpenCode runner: isolated scratch workspace, streaming, security filters
```

## 1. Trust boundaries

```
┌──────────────── WebView (privileged UI) ───────────────────┐
│  React · xterm.js · AI panel                               │
│  ▸ enters passwords, displays recovery codes               │
│  ▸ generated private keys pass through JS before storage   │
│  ▸ AI config listings mask API keys / proxy URLs           │
└───────────────┬────────────────────────────────────────────┘
                │ Tauri IPC (allow-listed commands only, CSP set)
┌───────────────▼────────────────────────────────────────────┐
│  Rust core                                                 │
│  vault.rs      SQLCipher AES-256, Argon2id KDF             │
│  ssh/sftp/tunnel   libssh2 sessions, host-key TOFU         │
│  ai_client.rs  holds provider keys + proxy creds in memory │
│  pairing.rs    X25519 + HKDF + XChaCha20-Poly1305          │
└────────────────────────────────────────────────────────────┘
```

* The master key is derived with **Argon2id** and handed to SQLCipher as a raw hex key
  (`PRAGMA key = "x'…'"`), so SQLCipher's internal PBKDF2 is bypassed.
* **OS keychain (optional, opt-in):** the master password can be stored in the platform
  credential store (macOS Keychain via Touch ID / Face ID, Windows Credential Manager via
  Windows Hello, Linux Secret Service via `org.freedesktop.Secret`) via the `keyring`
  crate, gated behind an explicit "Remember in OS keychain" checkbox. Storage, retrieval
  and deletion are explicit commands (`os_keychain_store/unlock/delete`); we never write
  to the keychain without user action. Critically, we do **not** probe the keychain on
  startup (on macOS, any read triggers a Touch ID dialog) — the frontend tracks opt-in
  with a localStorage flag and only calls `os_keychain_unlock` when the user clicks a
  visible "Unlock with Touch ID" button. `os_keychain_status` follows the same rule: it
  answers from a `stat()` of the device-lock file unless the caller explicitly passes
  `probeKeyring: true`, which only the Quick Unlock settings sheet does. If the OS keychain is unavailable (headless
  Linux, sandboxed builds) commands return an error and the UI falls back to password
  entry.
* **The WebView can handle secrets.** Host credentials are entered in React forms before IPC
  saves them; `keychain_generate_key` returns a private key to JS for `KeychainPanel` to save;
  master passwords and recovery codes also pass through the lock UI. Vault *storage* and SSH
  authentication live in Rust, but the WebView must be treated as trusted application code.
* **AI keys/proxy credentials (desktop):** `ai_configs_list` masks stored credentials and the
  AI relay injects them in Rust; when the user adds a key or proxy, its input necessarily passes
  through the WebView. Browser demo mode keeps credentials client-side (not a security boundary).
* The desktop CSP's `connect-src` permits `https:` to **any** HTTPS host plus localhost/IPC;
  it is not a provider allowlist. The Rust AI relay checks configured origins before attaching
  pooled credentials, but do not treat the CSP as an exfiltration defense.
* **Not shared with teams:** team vault bundles exclude AI configs, and importing a bundle never
  touches the recipient's own AI settings.

## 2. SSH data path

`ssh_connect` spawns one OS thread per session. The thread owns the non-blocking libssh2 channel
and multiplexes:

1. PTY output → `tauri::ipc::Channel<SshEvent>` (ordered, high-throughput, no global event bus)
2. Frontend commands (`Write`, `Resize`, `Close`) ← `std::sync::mpsc`
3. Keep-alives and dropped-link detection → `SshEvent::Disconnected`

Jump hosts (ProxyJump) are supported. SFTP uses its own blocking connection so large transfers
never stall the interactive PTY. Local tabs use `local_pty.rs` (`portable-pty`).

## 3. Session snapshotting

An idempotent shell hook makes every prompt emit an OSC-7 sequence with the cwd. The SSH I/O
thread records cwd and last command in memory; `snapshot.rs` flushes dirty entries to the vault
every 10 s. On reconnect with `resume: true`, the session replays `cd <cwd>`.

## 4. Vaults, sharing and sync

* **Multi-vault:** rows carry a `vault_id` (default `personal`); team vaults are exported as an
  encrypted bundle (`EncryptedTeamVaultBundle`, XChaCha20-Poly1305 under a passphrase-derived
  key). Bundles contain hosts, keychain, tunnels and snippets — **not** AI settings.
* **Device pairing (`pairing.rs`):** Device A shows a pairing link (`nxpair://host:port?pin=…&pk=…`) with a
  6-digit PIN and its X25519 public key, and runs an ephemeral listener (port 48291, falling back to an
  OS-assigned port). Device B pastes the link. The `pk` is pinned, not taken from the wire. B sends its
  ephemeral key plus an HMAC proof of PIN knowledge, bound to the ECDH secret and both public keys. The PIN
  is only the HKDF salt and is never sent. A checks the proof (constant-time), then returns the vault archive
  under an XChaCha20-Poly1305 key derived from the same secret. Plain HTTP carries only proof and ciphertext,
  and the pairing responses send no CORS headers. The archive is a **one-time transfer**, not
  continuous synchronization. It includes hosts (and their secrets), keychain, tunnels, snippets
  and AI provider configuration, but `dump_full_vault` clears AI API keys and proxy URLs before
  encryption. If relay sync was configured on the source, pairing also carries a stable random
  group seed and relay settings inside the authenticated encrypted archive; the receiving vault
  must be empty or already hold the same seed. Revoking a peer prevents future pairing, not use
  of data it already received.
* **Relay sync (`sync.rs`, v2):** `K_sync`/`K_index` are derived via HKDF from the **shared random
  group seed stored in each device's SQLCipher vault**, not from its password-derived local root
  key. Pairing transfers the seed; both devices can choose separate local master passwords.
  v2 HMAC-blinded IDs and 256-byte-bucket padded CBOR blobs are sealed with XChaCha20-Poly1305
  and merged using HLC last-writer-wins/tombstones. Legacy v1 blobs are ignored (not migrated).
  The relay sees access patterns, timing and bucketed blob sizes, not plaintext. Synced tables:
  `hosts` (with inline host-specific `secrets`), `keychain` (including passwords/private keys),
  `snippets`, `tunnels`, `vaults`. `ai_configs` and `known_hosts` stay local. This is not a
  substitute for backups: edits to the same record may conflict and revoking a paired device
  does **not** rotate its existing group seed. See [relay/README.md](relay/README.md).

## 5. AI assistant

The assistant is a multi-provider chat panel (`AIPanel.tsx` + `lib/ollama.ts`) backed by a Rust
relay (`ai_client.rs`).

**Providers:** Ollama (local/VPS, NDJSON), OpenAI-compatible (OpenAI, DeepSeek, Groq, OpenRouter,
custom; SSE, with `reasoning_content` rendered as a "thinking" block), Anthropic Messages API, and
Google Gemini through its OpenAI-compatible endpoint. The static model lists in `ollama.ts` are
only fallbacks; the live `/models` endpoint is the source of truth, and configs pointing at models
listed in `RETIRED_MODELS` are migrated on load.

**Request flow (desktop app)**

```
AIPanel.ask()
  ├─ terminal output is opt-in: only ```terminal blocks the user attached (+ menu, up to the
  │    user's context-lines setting) or quick actions that request it are sent; sanitizeContext()
  │    applies when "scrub secrets" is on. cwd and last command are not sent by default.
  ├─ messages: system prompt · user-role UNTRUSTED-data note · last 10 turns
  └─ chatStreamMultiProvider → bridge.streamAiProxy({ providerId, auth, url, body })
        │  (no key in the request)
        ▼
ai_client::ai_stream_proxy
  ├─ resolve_route: load provider from vault → key pool, proxy pool, strategies
  ├─ select key + proxy (round-robin | random | P2C), skipping 60 s cool-downs
  ├─ inject auth (bearer | x-api-key | gemini) and send, optionally via HTTP/SOCKS proxy
  ├─ on HTTP 429 or proxy failure: rotate key/proxy (max 3 attempts), emit Failover event
  └─ stream back `Data` / `Meta` / `Failover` events over an ipc::Channel
```

* **Key/proxy storage:** `ai_configs` table in the encrypted vault. `ai_configs_list` returns
  masked strings of the same length/order so the UI can show counts and remove by index.
* **Proxy routing:** a per-provider proxy pool, or an automatic SOCKS5 tunnel over a saved SSH
  host (`ai_tunnel_start`, bound to an OS-assigned loopback port). The relay never silently falls
  back to a direct connection when proxies are configured.
* **Relay hardening:** only `http`/`https` URLs and `GET`/`POST` are accepted; streaming has a
  20 s connect timeout and a 90 s idle timeout (no total deadline); `ai_stream_cancel` makes the
  Stop button cancel the upstream request.
* **Command safety:** suggested commands are shown in code blocks with a regex risk classifier
  (`classifyRisk`: safe / caution / danger). **Insert** types the command without pressing Enter;
  **Run** requires an extra "Confirm run" click for danger-level or multi-line blocks. The
  classifier is a heuristic safety net, not a security boundary.
* **Offline fallback:** `offlineAnswer()` gives canned diagnostics when no provider is reachable.
* **Browser demo mode** (no Tauri): there is no Rust relay, so keys live in the demo sandbox and
  the pooling logic in `ollama.ts` runs client-side.

## 6. OpenCode agent & serial UART

* **OpenCode CLI (`opencode.rs`):** runs a local or remote `opencode` binary; remote execution uses an SSH exec channel streaming JSON events and falls back to local execution if OpenCode is unavailable on the host. Local runs use `~/NexusTerminal/ai-workspace`. Tool permissions are deny-by-default: read-only and autonomous modes differ in which actions they allow/ask for; sensitive paths and dangerous shell patterns are denied. This is policy-based filtering, not a sandbox or a guarantee against every shell escape.
* **Serial UART (`serial.rs`):** enumerates local serial hardware ports and bridges interactive terminal streams over configurable baud rates, data bits, parity, and stop bits directly to xterm.js.

**Build/config notes and known limitations**

* The npm package name is still `react-vite-tailwind` (a project scaffold label), not the desktop product name. `tauri-plugin-shell` is a declared and initialized dependency, but the default Tauri capability grants no shell permission to the WebView; local terminals use `local_pty.rs` instead.
* On Windows, local PTYs launch `%COMSPEC%` when set (normally `cmd.exe`), falling back to `powershell.exe` only if that variable is absent. Do not assume PowerShell is the default.
* The AI relay verifies configured provider origins before attaching pooled credentials. Requests without a matching provider carry no pooled keys. The WebView CSP is broader (see §1).
* Secret redaction is pattern-based and can miss unusual formats. Self-hosted relay sync is not a replacement for independent backups (see §4).
