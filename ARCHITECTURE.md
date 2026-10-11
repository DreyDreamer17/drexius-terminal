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
│   │   ├── SftpDrawer.tsx              # Graphical remote file manager
│   │   ├── SnippetsPanel.tsx           # Snippet library → broadcast to sessions
│   │   ├── KeychainPanel.tsx           # Reusable identities, key import/generation
│   │   ├── PortForwardingPanel.tsx     # Local / dynamic (SOCKS5) tunnels
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
└── src-tauri/                          # Rust core (all secrets live here, never in JS)
    ├── Cargo.toml · build.rs · tauri.conf.json
    ├── capabilities/default.json       # Least-privilege IPC permissions
    └── src/
        ├── main.rs · lib.rs            # Entry, builder, state, command registration
        ├── error.rs                    # Serializable `{ kind, message }` error type
        ├── vault.rs                    # SQLCipher store, Argon2id KDF, all CRUD, multi-vault, team bundles
        ├── ssh.rs                      # SSH sessions (PTY ⇄ ipc::Channel), jump hosts, host-key TOFU
        ├── sftp.rs                     # SFTP on a dedicated blocking connection per terminal
        ├── local_pty.rs                # Local shells via portable-pty
        ├── tunnel.rs                   # Port forwarding (local + dynamic SOCKS5), AI SSH proxy tunnel
        ├── snapshot.rs                 # cwd / last-command snapshots → vault, resume on reconnect
        ├── ai_client.rs                # AI HTTP relay: key/proxy pools, auth injection, failover, cancel
        ├── pairing.rs                  # Direct device-to-device pairing over the LAN
        └── sync.rs                     # Zero-knowledge sync: crypto core done, transport/engine are stubs
```

## 1. Trust boundaries

```
┌──────────────── WebView (untrusted-ish UI) ────────────────┐
│  React · xterm.js · AI panel                               │
│  ▸ refers to hosts and AI providers by opaque id           │
│  ▸ only ever holds MASKED API keys / proxy URLs            │
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
* Host passwords and private keys are read by Rust only; the UI refers to hosts by UUID.
* **AI keys and proxy credentials never reach the webview** (see §5). `ai_configs_list` returns
  masked values, `ai_config_save` never writes secrets, and secrets are changed only through
  dedicated commands (`ai_keys_*`, `ai_proxies_*`).
* The CSP allows `https:` and localhost for `connect-src` so the browser-only demo mode works;
  in the desktop app AI traffic goes through the Rust relay, not the webview.
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
* **Device pairing (`pairing.rs`):** Device A shows a QR code + 6-digit PIN and runs an ephemeral
  listener (port 48291, falling back to an OS-assigned port). Device B connects with the PIN,
  performs an X25519 key exchange (HKDF → XChaCha20-Poly1305) and clones the vault archive
  directly over the LAN. Because this is *your own* device, the archive does include AI configs.
* **Cloud sync (`sync.rs`) — blueprint:** the crypto core (`K_sync`/`K_index` via HKDF, blinded
  record ids, padded sealed blobs, HLC last-writer-wins) is implemented, but `SyncTransport` /
  `HttpRelay` and `sync_now` are stubs; nothing is uploaded yet.

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
  ├─ last 80 terminal lines → sanitizeContext() (regex redaction; also applied to cwd,
  │    last command, user prompts and history when "scrub secrets" is on)
  ├─ messages: system prompt · user-role "UNTRUSTED terminal data" block · last 10 turns
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

**Known limitations**

* The relay accepts arbitrary `http(s)` destinations because custom endpoints (vLLM, Ollama on a
  VPS, …) are a feature; a compromised webview could use it to make requests with the user's
  pooled keys only when the request names a provider. Requests without a provider carry no keys.
* Secret redaction is pattern-based and can miss unusual formats.
