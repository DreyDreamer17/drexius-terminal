# Development guide

> Repository layout, prerequisites, the test matrix, the two ways to run the app, and how
> releases are built. Read this before your first pull request.

---

## 1. Prerequisites

| Tool | Version | Why |
|---|---|---|
| **Node.js** | 20+ (**22.6+** for `npm run test:mobile`) | Vite 7, React 19, and the `--experimental-strip-types` test runner |
| **Rust** | 1.77+ (`rust-version` in `Cargo.toml`) | The Tauri 2 backend |
| **npm** | ships with Node | — |
| **Python** | 3.9+ (stdlib only) | The reference relay and its unit tests |

### Linux system libraries

Tauri v2 links against WebKitGTK and GTK at compile time.

```bash
# Debian / Ubuntu / Mint
sudo apt-get install -y libwebkit2gtk-4.1-dev build-essential curl wget file \
  libxdo-dev libssl-dev libayatana-appindicator3-dev librsvg2-dev

# Arch Linux / Manjaro
sudo pacman -S --needed webkit2gtk-4.1 base-devel curl wget openssl
```

`patchelf` is also needed on Linux for the release build.

### macOS

```bash
xcode-select --install
```

### Windows

Install the [Rust toolchain](https://rustup.rs), the
[WebView2 runtime](https://developer.microsoft.com/microsoft-edge/webview2/) and the
Visual Studio Build Tools with the **Desktop development with C++** workload. The SSH
dependency vendors OpenSSL with `openssl-on-win32`, so no separate OpenSSL is required.

---

## 2. Repository layout

```
drexius-terminal/
├── ARCHITECTURE.md            # The authoritative design document
├── index.html                 # Vite entry
├── vite.config.ts             # Vite + Tailwind + single-file plugin
├── package.json               # Frontend scripts and dependencies
├── src/                       # React frontend (the WebView)
│   ├── App.tsx                # Workspace shell: lock screen, rail, tabs, panes, panels
│   │   ├── components/            # LockScreen, TerminalPane, AIPanel, SftpTab, HostSidebar, …
│   └── lib/
│       ├── bridge.ts          # THE IPC surface: Tauri invoke() ⇄ in-browser demo sandbox
│       ├── demoShell.ts       # Sandbox shell and virtual filesystem (preview mode only)
│       ├── ollama.ts          # Multi-provider AI engine
│       ├── splitTree.ts       # Pane layout as a binary split tree (pure, unit-tested)
│       └── sessions.ts        # Imperative LivePane registry used by mobile drawers
├── src-tauri/                 # Rust core
│   ├── Cargo.toml · build.rs · tauri.conf.json
│   ├── capabilities/default.json  # Least-privilege IPC permissions
│   └── src/                   # vault, ssh, sftp, tunnel, sync, pairing, ai_client, …
├── relay/                     # Reference self-hosted relay (Python, stdlib only)
├── tests/                     # Node unit tests + the Playwright browser smoke test
├── docs/                      # You are here
└── .github/workflows/         # CI, release, CodeQL
```

### The one rule that matters most

**`src/lib/bridge.ts` is the only IPC surface.** If a component needs something from Rust,
it goes through `bridge.ts`, and `bridge.ts` is the only place that knows whether it is
running inside Tauri or inside the browser-preview sandbox. Never call `invoke()` directly
from a component — you will break the browser preview, which is the fastest way for a
contributor to lose their way in this codebase.

---

## 3. Running the app

There are **two** ways to run it, and they behave differently on purpose.

### 3.1 The browser preview (fastest loop)

```bash
npm install
npm run dev
```

Open <http://localhost:5173>. The frontend runs against `demoShell.ts`: a simulated shell, a
virtual filesystem, and a demo vault encrypted with WebCrypto AES-256-GCM in
`localStorage`.

**What is real:** the whole UI, the vault *shape*, the AI panel, the SFTP browser, the
mobile shell, the risk classifier, the redaction.

**What is not:** SQLCipher, Argon2id, libssh2, the OS keychain, the Rust AI relay, the
real pairing and sync protocols. The preview is a UI and crypto *shape*, never a security
boundary — see [Security model §3](SECURITY.md#3-the-webview-is-a-privileged-surface).

### 3.2 The real app (Tauri)

```bash
npm run tauri:dev
```

This starts the Vite dev server **and** the Rust backend. You get the SQLCipher vault,
Argon2id, real SSH, the OS keychain, the Rust AI relay, and real pairing.

> `tauri.conf.json` points `frontendDist` at `../dist`, and `dist/` is gitignored. A clean
> checkout therefore has nothing for `tauri-build` to resolve when `build.rs` runs — run
> `npm run build` once first if a build fails oddly. This is masked locally by an
> existing `dist/`, and CI handles it explicitly.

---

## 4. The test matrix

Several suites. Each catches a different class of regression.

| Suite | Command | Covers |
|---|---|---|
| **Frontend typecheck** | `npm run typecheck` | `tsc --noEmit` over the whole frontend; the contract between `src/lib/types.ts` and the component bindings |
| **Frontend build** | `npm run build` | Typecheck *plus* a real Vite bundle, including the single-file plugin |
| **Mobile unit tests** | `npm run test:mobile` | The accessory-key pipeline: ASCII control mapping, ALT and combined modifiers, normal vs application cursor-mode arrows, paste/IME preservation, every accessory key sequence |
| **Split-tree unit tests** | `npm run test:split` | The pure pane-layout logic in `src/lib/splitTree.ts`: splitting in every direction with no pane limit, tiling without gaps or overlap, close/swap/resize/equalize, geometric focus navigation, migration of every legacy layout name, repair of corrupted saved trees, and preset round trips |
| **Split-layout browser smoke** | `npm run test:split-ui` | Real Chromium, desktop size: instant `Ctrl+Shift+D/E` splits without a menu, eight panes, a free-form (non-grid) arrangement, divider drag and double-click reset, directional focus, cycling, closing and equalizing. Needs `CHROMIUM_PATH` and the Vite dev server like the mobile smoke test |
| **Mobile browser smoke** | `npm run test:mobile-ui` | The real UI in a real browser: layouts at 320/390/640/767/768/1280 px, CTRL+C, ALT+X, TAB, latches, focus preservation, touch scrolling, long-press selection with handle dragging, pinch-to-zoom, drawer detents, split↔single-pane transitions |
| **Rust core** | `cd src-tauri && cargo test --locked --no-fail-fast` | The vault, Argon2id, SQLCipher CRUD, SSH, the AI destination policy, pairing, sync, the local-FS guard, and the OpenCode policy |
| **Relay** | `python3 -m unittest discover -s relay -v` | The reference relay's auth, blob caps, and change paging |

**The Rust suite is the only place the security-relevant behaviour is actually verified.**
If you change `vault.rs`, `ai_client.rs`, `fs_guard.rs`, `pairing.rs`, `sync.rs` or
`opencode.rs`, run it.

### The browser smoke test needs a real Chromium

`playwright-core` is a dev-only dependency and **does not download a browser**. Supply
one:

```bash
npm run dev                                     # in one terminal
CHROMIUM_PATH=/path/to/chromium npm run test:mobile-ui
```

| Variable | Default | Meaning |
|---|---|---|
| `CHROMIUM_PATH` | — | Path to a Chromium/Chrome executable. **Required.** |
| `BASE_URL` | `http://localhost:5173` | Must point at the **Vite dev server** — the test instruments source modules from the server to inspect live session state. |
| `CHROMIUM_ARGS` | — | JSON array of extra browser flags, for restricted sandboxes. |

Screenshots are written under the ignored `node_modules/.cache/mobile-ui/`. The test uses a
new isolated browser context and a disposable preview vault — never real credentials.

> **After editing `src/lib/sessions.ts` or `src/lib/bridge.ts`, restart `npm run dev`**
> before running the smoke test. Vite otherwise serves the test a different, timestamped
> module instance than the app, and the session registry looks empty.

---

## 5. Continuous integration

| Workflow | Trigger | What it does |
|---|---|---|
| [`.github/workflows/ci.yml`](../.github/workflows/ci.yml) | push to `master`, pull requests, manual | Frontend typecheck + build + mobile unit tests, relay unit tests, and `cargo test --locked --no-fail-fast`. `cargo fmt` and `clippy` run **advisorily** (`continue-on-error`) because the tree is not yet formatted; both become blocking once `cargo fmt --all` has been run. |
| [`.github/workflows/release.yml`](../.github/workflows/release.yml) | version tag | Builds and uploads Tauri bundles for macOS, Windows and Linux. |
| [`.github/workflows/codeql.yml`](../.github/workflows/codeql.yml) | push, pull request, schedule | CodeQL for JavaScript/TypeScript and Rust. |

The CI is deliberately conservative: it runs the checks that can fail **for a real
reason**, without needing a display, a browser, a device, or signing keys. The browser
smoke test is excluded from CI because it requires a real Chromium binary; `tauri build`
is excluded because it needs signing; and anything touching the OS keychain is excluded
because CI runners have no keyring service — which is exactly the path
`os_keychain_status` guards at startup.

---

## 6. Building and releasing

```bash
npm run build          # frontend → dist/
npm run tauri:build    # installable bundles
```

The bundle configuration lives in `src-tauri/tauri.conf.json`:

- `productName`: `DrexiusTerminal`
- `identifier`: `dev.drexius.terminal` — this is the application identifier and it is a
  **trademark**; see the licence section of the [README](../README.md).
- `bundle.targets`: `all`
- Icons: `icons/32x32.png`, `icons/128x128.png`, `icons/icon.icns`, `icons/icon.ico`

### Release checklist

1. Bump `version` in `src-tauri/Cargo.toml` **and** `src-tauri/tauri.conf.json` — they
   are separate files and are not synchronised automatically.
2. Bump the version in `package.json`.
3. Run the full matrix locally (§4). All five suites, not just the one you touched.
4. Tag: `git tag -a vX.Y.Z -m "vX.Y.Z"` and push the tag. The release workflow builds
   and attaches the bundles.
5. Write the release notes. **Call out security-relevant changes explicitly** — a user
   reading only the notes should know if the trust model changed.

### Code signing

Unsigned bundles are produced by default. Signing is configured through the standard
Tauri environment variables (`APPLE_CERTIFICATE`, `APPLE_SIGNING_IDENTITY`,
`APPLE_ID`, `APPLE_PASSWORD`, `APPLE_TEAM_ID`, and the `WINDOWS_CERTIFICATE` /
`WINDOWS_CERTIFICATE_PASSWORD` pair) and is **not** required for a build to succeed.

---

## 7. Working on the Rust core

```bash
cd src-tauri
cargo test --locked --no-fail-fast
cargo clippy --all-targets -- -D warnings
cargo fmt --all
```

Conventions the crate follows:

- **One error type.** `error.rs` defines a serialisable `{ kind, message }` that crosses
  IPC. Commands return `Result<T, AppError>`.
- **Secrets do not become `Serialize`.** If a struct holds key material, it is
  deliberately not serialisable, so no command can hand it to the WebView. This is how
  `GeneratedKeyPair` stays in Rust.
- **`--locked` always.** `Cargo.lock` is committed; a dependency that drifted out of the
  lock should fail loudly, not be silently re-resolved.
- **Vendored OpenSSL.** `ssh2` and `rusqlite` both vendor OpenSSL so builds are
  reproducible across platforms. Do not "simplify" that away.

### Adding a vault sidecar file

If you add a new file next to the vault database, you **must** list it in
`VAULT_SIDECAR_NAMES` in `fs_guard.rs` — otherwise the generic `local_fs_*` commands can
read it, because the vault's own directory is under an approved root. The Rust test
`every_vault_sidecar_is_blocked_by_the_filesystem_policy` enumerates the sidecars the
vault creates and fails if one is not denied.

> The test fires when the *enumeration* changes. If you add a sidecar and forget the
> denylist entry, the test will not catch it for you — add the path to the test's
> enumeration as well.

---

## 8. Adding a feature

A checklist that keeps the two run modes in sync:

1. **Decide where the logic lives.** If it needs a secret, a socket, or the filesystem, it
   belongs in Rust.
2. **Add the command** in `src-tauri/src/`, with the error type and no `Serialize` on
   anything secret.
3. **Add it to `bridge.ts`** — the Tauri branch and the demo-sandbox branch. The preview
   branch should degrade gracefully, not throw.
4. **Add the UI** in `src/components/`, going through `bridge.ts` only.
5. **Add tests.** Rust for anything in the core; Node for the mobile pipeline; extend the
   browser smoke test for anything user-visible.
6. **Update the docs.** [ARCHITECTURE.md](../ARCHITECTURE.md) if you changed the design;
   the relevant file in `docs/` if you changed behaviour someone depends on.
7. **Run the full matrix** (§4).

---

## 9. Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| `tauri build` fails to find `../dist` | `dist/` is gitignored and absent | `npm run build` first |
| The smoke test's session registry looks empty | Vite served the test a different module instance | Restart `npm run dev` after editing `src/lib/` |
| `npm run test:mobile` errors on `--experimental-strip-types` | Node < 22.6 | Use Node 22.6+ |
| The smoke test cannot find a browser | `playwright-core` ships no browser | Set `CHROMIUM_PATH` |
| `cargo test` fails to link on Linux | Missing WebKitGTK/GTK dev packages | Install the §1 system libraries |
| A command returns "not allowed" in the app | Tauri capabilities are least-privilege | Add the permission to `src-tauri/capabilities/default.json` — and justify it |
| The AI panel works in the browser but not in Tauri | The demo branch was implemented and the Tauri branch was not | Implement both branches of `bridge.ts` |
| `cargo fmt --check` fails in CI | The advisory gate is still advisory | Run `cargo fmt --all`; it is a separate commit from your change |

---

## 10. Further reading

- [ARCHITECTURE.md](../ARCHITECTURE.md) — how the system is designed.
- [Security model](SECURITY.md) — what is protected and what is not.
- [Sync & pairing](SYNC.md) — running a relay and enrolling devices.
- [AI workspace](AI.md) — providers, keys, proxies, hygiene.
- [FAQ](FAQ.md) — the questions that come up most.
- [docs/mobile-ui.md](mobile-ui.md) — the mobile shell and the physical-device checklist.
