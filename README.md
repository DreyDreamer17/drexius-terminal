# NexusTerminal

> **Local-first, secure, open-source terminal workspace and Termius alternative.**  
> Built with **Tauri 2 (Rust)**, **React 19**, **Tailwind CSS 4**, and **xterm.js 6**.

NexusTerminal provides a terminal workspace with multi-pane splits, SSH/SFTP, serial connections, a local SQLCipher vault, encrypted team bundles, and a multi-provider AI assistant. New devices can join an existing vault via encrypted LAN pairing; ongoing sync uses a [self-hosted relay](relay/README.md) (see [limitations](#sync-and-pairing-limitations)).

---

## Key Features

- **Terminal Engine**: Full xterm.js 6 support with WebGL renderer (DOM fallback), bracketed paste mode, OSC-7 cwd tracking, session auto-resume, ghost-text autosuggest, and broadcast input across panes.
- **Protocols & Shells**:
  - **SSH & Jump Hosts**: Dedicated OS threads per session via libssh2, fail-closed TOFU host-key verification, keep-alive monitoring, and multi-hop jump hosts.
  - **SFTP**: Dedicated blocking connections for high-throughput remote file transfers without stalling the interactive shell.
  - **Local PTY**: Native local shells powered by `portable-pty` with automatic child process reaping.
  - **Serial UART**: Hardware serial communication via `serialport` with customizable baud rates and flow control.
  - **Port Forwarding**: Local, Remote (reverse), and Dynamic (SOCKS5) tunnels.
- **Security & Encrypted Vault**:
  - **SQLCipher AES-256 Store**: PBKDF2 bypassed in favor of high-memory **Argon2id** key derivation.
  - **OS Keychain Integration**: Optional master password storage via macOS Keychain, Windows Credential Manager, or Linux Secret Service (`keyring`).
  - **Sensitive Data Hygiene**: Secret filtering across command history, session snapshots, and clipboard ingestion.
  - **LAN Enrollment & Self-hosted Relay Sync**: X25519/HKDF/XChaCha20-Poly1305 encrypted pairing transfers a snapshot and shared sync seed when a relay is configured; v2 relay sync uses encrypted blobs, HLC merge and tombstones.
  - **Multi-Vault & Team Bundles**: Partition personal and team workspaces; export encrypted `.nxvault` bundles without leaking AI settings.
- **AI Workspace & OpenCode**:
  - **Multi-Provider AI Relay**: Support for Ollama, OpenAI-compatible APIs (OpenAI, DeepSeek, Groq, OpenRouter), Anthropic, and Gemini.
  - **Secure Outbound Relay (desktop)**: AI keys and proxy settings are stored in the encrypted SQLCipher vault; Rust injects credentials for configured provider origins. Browser demo mode handles credentials in JavaScript.
  - **OpenCode Agent Integration**: Background execution via OpenCode CLI locally in a scratch workspace (`~/NexusTerminal/ai-workspace`) or over SSH, with deny-by-default tool permissions (read-only or autonomous modes).

---

## Security Architecture

The desktop app stores vault data in SQLCipher and handles SSH connections and AI HTTP requests in Rust. **The WebView is not a secret-free boundary**: master passwords and recovery codes are entered/displayed there; host credentials and imported keys can be entered in forms. Generated key material is the exception: `keychain_generate_and_save` creates the key pair and writes the private key into the vault in one Rust call, so a freshly generated private key never crosses IPC.

1. **Host verification**: Unknown host keys require explicit approval; changed keys are rejected.
2. **AI proxy relay (desktop)**: Configured API keys and proxy credentials are stored in SQLCipher and injected by Rust. Browser demo mode uses JavaScript-held demo credentials.
3. **CSP**: The desktop `connect-src` currently permits any HTTPS origin and localhost, not just approved provider origins. The Rust AI relay applies its own origin checks before attaching pooled credentials; CSP alone is not a network allowlist.

For implementation details and limitations, see [ARCHITECTURE.md](ARCHITECTURE.md).

### Sync and pairing limitations

- LAN pairing sends a **one-time snapshot**. If the source has configured a relay, the encrypted transfer also enrolls a new, empty vault into its sync group (stable shared seed, relay URL and token). The new device has its **own local master password**. Pairing includes host/keychain credentials, snippets, tunnels and AI provider configuration **without API keys or proxy URLs**. A revoked device keeps data it already received.
- Ongoing relay sync requires a [self-hosted relay](relay/README.md); no Nexus-hosted service is provided. Independently created vaults—even with identical passwords—cannot read each other's encrypted blobs: use **Join existing vault** during setup. Synced tables are hosts **including inline host secrets**, keychain (including private keys), snippets, tunnels and vault metadata. AI configs and known-host trust are local only. The relay sees ciphertext plus traffic metadata; it cannot prevent a device that already has the group seed from reading previously synced data.
- This is an initial implementation, **not a substitute for backups**: conflict resolution is record-level last-writer-wins; compromised-device revocation does not rotate the group seed; recovery from loss of all enrolled devices is not yet supported. Team bundles exclude AI configurations and are separate from pairing and relay sync.

---

## Getting Started

### Prerequisites

- **Node.js**: 20.x or later (`npm`)
- **Rust**: 1.77 or later (`cargo`)
- **System Libraries (Linux)**:
  ```bash
  # Debian / Ubuntu / Mint
  sudo apt-get install -y libwebkit2gtk-4.1-dev build-essential curl wget file libxdo-dev libssl-dev libayatana-appindicator3-dev librsvg2-dev

  # Arch Linux / Manjaro
  sudo pacman -S --needed webkit2gtk-4.1 base-devel curl wget openssl
  ```

### Development

1. **Install dependencies**:
   ```bash
   npm install
   ```

2. **Run in browser preview mode (demo sandbox)**:
   ```bash
   npm run dev
   ```

3. **Run desktop app via Tauri**:
   ```bash
   npm run tauri
   ```

### Building

- **Typecheck and bundle frontend**:
  ```bash
  npm run build
  ```

- **Build desktop binary (Linux, macOS, or Windows)**:
  ```bash
  npm run tauri:build
  ```

---

## License

NexusTerminal is open-source software licensed under the **GNU General Public License v3.0 or later (`GPL-3.0-or-later`)**. See [LICENSE](./LICENSE) for full details.

