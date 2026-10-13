# NexusTerminal

> **Local-first, secure, open-source terminal workspace and Termius alternative.**  
> Built with **Tauri 2 (Rust)**, **React 19**, **Tailwind CSS 4**, and **xterm.js 6**.

NexusTerminal provides a high-performance terminal environment featuring multi-pane splits, SSH/SFTP, serial hardware connections, zero-knowledge encrypted vaults, team sharing, and an integrated multi-provider AI assistant with local execution relays.

---

## Key Features

- **Terminal Engine**: Full xterm.js 6 support with WebGL and Canvas renderers, bracketed paste mode, OSC-7 cwd tracking, session auto-resume, ghost-text autosuggest, and broadcast input across panes.
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
  - **Zero-Knowledge Sync & LAN Pairing**: P2P device pairing over LAN using X25519, HKDF, and XChaCha20-Poly1305; E2EE cloud sync with Hybrid Logical Clocks (HLC) and tombstone propagation.
  - **Multi-Vault & Team Bundles**: Partition personal and team workspaces; export encrypted `.nxvault` bundles without leaking AI settings.
- **AI Workspace & OpenCode**:
  - **Multi-Provider AI Relay**: Support for Ollama, OpenAI-compatible APIs (OpenAI, DeepSeek, Groq, OpenRouter), Anthropic, and Gemini.
  - **Secure Outbound Relay**: AI keys and proxies are stored exclusively in the Rust vault; outbound routes enforce strict origin allowlists and loopback SOCKS5 tunnel overrides.
  - **OpenCode Agent Integration**: Background execution via OpenCode CLI in an isolated scratch workspace (`~/NexusTerminal/ai-workspace`) with strict security filters against dangerous primitives and shell escapes.

---

## Security Architecture

NexusTerminal is built around a rigorous threat model where the WebView is treated as a presentation layer and all sensitive state remains strictly within Rust:

1. **Host Credentials**: Private keys and passwords never leak into JavaScript. The frontend references connections via opaque UUIDs and masked credentials.
2. **Fail-Closed Verification**: Unknown host keys prompt explicit approval; modified keys reject immediately.
3. **AI Proxy Relay**: API keys and proxy credentials never reach webview code. Outbound connections are authenticated and routed within Rust.

For full architecture diagrams and cryptographic specifications, see [ARCHITECTURE.md](ARCHITECTURE.md).

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

NexusTerminal is open-source software dual-licensed under either:

* **[Apache License, Version 2.0](LICENSE-APACHE)** ([http://www.apache.org/licenses/LICENSE-2.0](http://www.apache.org/licenses/LICENSE-2.0))
* **[MIT License](LICENSE-MIT)** ([http://opensource.org/licenses/MIT](http://opensource.org/licenses/MIT))

at your option.
