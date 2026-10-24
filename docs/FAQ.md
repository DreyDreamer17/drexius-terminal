# Frequently asked questions

> Short answers to the questions that come up most. For depth, follow the links at the
> bottom of each section.

---

## Getting started

### What do I need to try it?

A browser. `npm install && npm run dev` gives you the full UI in a **browser preview**: a
simulated shell, a virtual filesystem, and a demo vault encrypted with WebCrypto in
`localStorage`. Nothing is sent anywhere.

For real SSH, the OS keychain and the SQLCipher vault, build the desktop app with
`npm run tauri:dev`. See [DEVELOPMENT.md §3](DEVELOPMENT.md#3-running-the-app).

### Is the browser preview safe to put real credentials in?

**No.** It is a demo sandbox, not a security boundary. The demo vault uses WebCrypto
AES-256-GCM keyed by PBKDF2-SHA256 (310k iterations) and lives in `localStorage`; AI
credentials and proxy URLs are held in JavaScript; "SSH" is a simulated shell. It is a
faithful preview of the **UI** and the **crypto shape**, not of the **trust boundary**.
Details in [Security model §3](SECURITY.md#3-the-webview-is-a-privileged-surface).

### How do I build it for real?

See [DEVELOPMENT.md §1](DEVELOPMENT.md#1-prerequisites) for the system libraries, then
`npm run tauri:dev` to run it or `npm run tauri:build` to package it.

### Which platforms are supported?

Windows, macOS, and Linux are the desktop targets, alongside native Android support.
The responsive mobile shell, virtual accessory keypad, and native services are fully
implemented (see [mobile-ui.md](mobile-ui.md)).

---

## The vault

### Where is my data stored?

In a **SQLCipher AES-256** database inside the platform application-data directory. The
master key is derived with **Argon2id**; SQLCipher's own PBKDF2 is bypassed by handing it
the derived key directly.

### I forgot my master password. Can you reset it?

No, and that is the point. There is no master-key reset, no back door, and no recovery
service. Your **Emergency Recovery Key** is the only way back in. It is generated once,
shown once, and you are asked to save it — offline, in a password manager, not in a
screenshot on your desktop.

If you have neither the password nor the recovery key, the vault is unrecoverable. This
is the same property every zero-knowledge system has.

### Why does the app ask for at least 8 characters when creating a vault, but accepts
shorter ones when unlocking?

Because the two situations are different. *Choosing* a password is where you can still be
told what a good one looks like, so the app requires 8+ characters, in the backend as well
as the lock screen. *Unlocking* an existing vault keeps a 4-character floor on purpose: a
vault created by an older, weaker build must never become unopenable because the app was
upgraded. The rule is asymmetric by design.

### What is the "Emergency Recovery Key" and where do I store it?

A 128-bit key, generated when you create the vault, that re-derives access to your vault
if the master password is lost. Save it **offline** — a password manager, a printed copy
in a safe, a hardware wallet. Not in the same vault, and not in the same cloud account.

### Can I see my stored API keys in the app?

No, and that is intentional. The key list returns **masked strings of the same length and
order**, which is enough to show counts and to remove an entry, and not enough to read a
key back. To change a key, remove it and add a new one.

The same pattern applies to the **Tailscale API token** — with one difference: that token
*is* returned to the WebView in the clear, because the panel needs it to prefill the field.
See [ARCHITECTURE.md §7](../ARCHITECTURE.md#7-tailscale-netbird-cloud-sync--docker).

### Where does the vault file live, and can other apps read it?

In the platform application-data directory. The app's own generic local-filesystem
commands are **denied** for the vault, for every vault sidecar file, and for credential
directories such as `~/.ssh`, `~/.aws`, `~/.gnupg`, `~/.kube` and `~/.docker`. Another
process running as your user could of course read the file — but it would get ciphertext
without your master password.

---

## SSH and host keys

### What happens the first time I connect to a host?

You get a fingerprint and must **approve it explicitly**. This is trust-on-first-use
(TOFU): the app has no certificate authority and no pre-shared fingerprint, so the first
connection is a decision you make.

**Verify the fingerprint out of band** the first time. A host whose key silently changes
later is rejected, not re-approved — but if you approve a fingerprint an attacker gave you
on the first try, nothing later will catch it.

### Why is the host key not shared between my devices?

Deliberately. The known-hosts trust store is **local to each device** and is not synced.
A phone that has never seen a host asks you to approve it, even if your laptop already
trusts it. Synced trust would turn one compromised device into a compromised fleet.

### Can I import my existing `~/.ssh/config`?

Yes — the workspace has an **Import ~/.ssh/config** action, and `ssh_config.rs` previews
what it found before anything is written. Imported hosts land in the encrypted vault, with
their inline secrets.

### Why did my SFTP transfer stall the terminal?

It should not: SFTP uses its **own blocking connection** precisely so a large transfer
never stalls the interactive PTY. If it did, you are probably on the browser preview,
where the demo filesystem is simulated.

### What is the "Local Shell" tab?

A real local shell via `portable-pty`, with automatic child reaping. It is not a
`sh -c` one-liner; it is a PTY, so full-screen programs work.

On Windows it launches `%COMSPEC%` (normally `cmd.exe`) when that variable is set, and
only falls back to `powershell.exe` when it is absent. Do not assume PowerShell.

---

## Sync and pairing

### Do I need a relay for sync?

Yes, for **ongoing** sync. There is no Drexius-hosted relay; you run your own. LAN
**pairing** is a one-time snapshot and needs no server. See
[SYNC.md](SYNC.md).

### Why don't my two vaults sync even though the passwords match?

Because they were created **independently**. Sync identity is a random 32-byte *group
seed* stored in the vault — not a password. Two vaults with the same password have
completely different SQLCipher keys and are cryptographically unrelated. Use **Join
existing vault** during first-run setup on the new device, then pair it.

### What exactly does the relay see?

Ciphertext, HMAC-blinded record identifiers, request timing, bucketed blob sizes, client
IPs and the bearer token. It does **not** see your hosts, your keys, your passwords, your
snippets, or the record type a blob belongs to. It also cannot stop a device that already
holds the group seed from reading previously synced data.

### Is relay sync a backup?

**No.** It replicates forward; it does not protect against deleting something everywhere
at once, or against losing every enrolled device. Back up the relay database *and* each
device's vault file, and keep the recovery keys. See [SYNC.md §5](SYNC.md#5-backups).

### I revoked a device. Is my data safe?

Revocation prevents **future** pairings. It does **not** rotate the group seed, and it
cannot retract data the device already downloaded. If you believe a device is compromised,
rotate the relay token, rotate the credentials that were stored in it, and — if the seed
itself is suspect — create a fresh sync group. See
[SYNC.md §6](SYNC.md#6-rotating-credentials).

### Why does the app refuse `http://` for my relay?

HTTP is accepted **only for loopback** (`127.0.0.1` / `localhost`), where the traffic
never leaves the machine. Any other relay must be HTTPS, because the bearer token and the
change cursor would otherwise be readable on the network. Put a TLS-terminating reverse
proxy in front of the relay and keep the Python service bound to loopback.

---

## The AI assistant

### Do my API keys get sent to the model provider?

**No.** The key lives in the encrypted vault. Rust attaches it to the request at the last
moment, and only when the request's origin matches the provider's saved `base_url`. The
prompt itself never carries a key.

### Does my terminal output get sent to the AI?

**Not automatically.** Terminal context is **opt-in**: it is sent only when you attach a
` ```terminal ` block yourself, via the menu or a quick action. The working directory and
the last command are not sent by default.

### What does "scrub secrets" actually catch?

PEM private keys, `sk-`, `AIza`, `ghp_`/`gho_`, `xoxb-`/`xoxp-`, `AKIA`, `Bearer`,
`password=`/`secret=`/`token=`/`api_key=` assignments, and `user:pass@` URL credentials. It
is **pattern-based**, so it will miss unusual formats. It is a helpful default, not a
guarantee. See [AI.md §5](AI.md#5-prompt-hygiene).

### The AI suggested a command. Why can't I just run it?

Because it is an **AI suggestion**. Insert types the command without pressing Enter so you
can read it; Run requires an extra confirmation for danger-level or multi-line blocks.
The risk classifier is a heuristic safety net, not a security boundary.

### Why is my provider request failing with a 401?

Most often the **origin does not match** the saved `base_url`. The origin *is* the
allowlist, and a credentialed cross-origin request is refused. A second common cause is a
stale key after a pool rotation. See [AI.md §4](AI.md#4-destination-policy).

### My requests work in the browser preview but not in the desktop app.

The browser preview runs the key-pool logic **client-side** and holds demo credentials in
JavaScript. The desktop app goes through the Rust relay, which enforces the origin check,
the destination policy and the key pool. A failure that only appears in the desktop app is
usually one of those three rules rejecting the request — and the reason is visible in the
logs.

### What is OpenCode, and is it sandboxed?

OpenCode is an external CLI that DrexiusTerminal drives for multi-step background work. It
runs with **deny-by-default** tool permissions, in a scratch workspace at
`~/DrexiusTerminal/ai-workspace`. That is **policy filtering, not a sandbox** — a strong
safety net around a tool you chose to install, not an isolation boundary. See
[AI.md §7](AI.md#7-the-opencode-agent).

---

## The interface

### How do I lock the app automatically?

The auto-lock setting lives in the icon rail and offers **off, 5, 15, 30 and 60 minutes**.
Auto-lock re-locks the vault but **does not kill your sessions** — they keep running in
Rust, and unlocking brings the same terminals back.

### Can I have several terminals at once?

Yes. Split any pane in any direction, as many times as you like (up to 16 per tab), and run
independent sessions in each. Splits are free-form rather than a fixed grid, and the dividers
between panes can be dragged.

| Shortcut | Action |
|---|---|
| `Ctrl+Shift+D` / `Ctrl+Shift+E` | Split right / down with a copy of the focused pane (same host, same directory), instantly |
| `Alt+Shift+D` / `Alt+Shift+E` | Split left / up the same way |
| `Ctrl+Shift+O` | Split with a *different* host or a local shell (opens the picker) |
| `Alt+Arrow` / `Alt+Shift+Arrow` | Move focus / swap the pane in that direction |
| `Ctrl+]` / `Ctrl+[` | Next / previous pane |
| `Ctrl+Shift+N` | Equalize all splits |
| `Ctrl+Shift+M` / `Ctrl+Shift+W` | Zoom / close the focused pane |

Double-click a divider to split it evenly. Every shortcut can be rebound in Settings → Shortcuts.

Broadcast input sends what you type to every pane at once — useful for a fleet, and worth
being deliberate about.

### Does the app remember my window layout?

Yes. The workspace state (tabs, panes and splits) is persisted locally and restored. On a
phone, only the selected pane is shown; returning to desktop restores the original splits,
and the session identity does not change.

### What are the themes?

Thirteen: Drexius Night, Aurora, Ember, Phosphor, Dracula, Nord, Tokyo Night, Gruvbox,
Solarized Dark, Monokai, Catppuccin, One Dark and Homebrew. The theme drives the whole
UI, including the terminal palette and the accent colour.

### The terminal is blank on my machine.

The WebGL renderer can fail on some GPUs and drivers. The app falls back to xterm's DOM
renderer automatically when the WebGL context is lost. If it stays blank, try switching
the renderer by reloading, and check whether the app logged a WebGL context loss.

### Does the mobile app really work?

The mobile shell is built and tested — five-tab navigation, a Termius-style full-screen
terminal with an extended keypad, bottom drawers, pinch-to-zoom font sizing, long-press
selection with draggable handles. But **headless Chromium emulation does not validate**
native keyboards, platform biometrics, filesystem sandboxes, or live SSH over a real
network. The physical-device checklist in [mobile-ui.md](mobile-ui.md) is still required
before a mobile release.

---

## Building and contributing

### How do I run the tests?

```bash
npm run typecheck
npm run test:mobile
npm run build
cd src-tauri && cargo test --locked --no-fail-fast
python3 -m unittest discover -s relay -v
```

The full matrix, and the browser smoke test that needs `CHROMIUM_PATH`, are in
[DEVELOPMENT.md §4](DEVELOPMENT.md#4-the-test-matrix).

### Which suite actually protects the security behaviour?

The **Rust** one. `cargo test` covers the vault, the AI destination policy (including the
address pinning), the local-filesystem guard, and the asymmetric master-password policy.
If you touch `vault.rs`, `ai_client.rs`, `fs_guard.rs`, `pairing.rs`, `sync.rs` or
`opencode.rs`, run it.

### I added a file next to the vault. Is it protected?

Only if you list it in `VAULT_SIDECAR_NAMES` in `src-tauri/src/fs_guard.rs`. The vault's
directory is under an approved root, so an unlisted sidecar is readable through the generic
`local_fs_*` commands. See
[DEVELOPMENT.md §7](DEVELOPMENT.md#7-working-on-the-rust-core).

### How do I report a security problem?

Privately, through GitHub's **"Report a vulnerability"** button on the repository's
[Security tab](https://github.com/DreyDreamer17/drexius-terminal/security/advisories/new).
Not as a public issue. See [Security model §7](SECURITY.md#7-reporting-a-vulnerability).

---

## See also

- [ARCHITECTURE.md](../ARCHITECTURE.md) — the design document.
- [Security model](SECURITY.md) — what is protected, and what is not.
- [Sync & pairing](SYNC.md) — running a relay, enrolling devices, rotating credentials.
- [AI workspace](AI.md) — providers, key pools, proxies, prompt hygiene.
- [Development guide](DEVELOPMENT.md) — layout, test matrix, releases.
- [Mobile UI](mobile-ui.md) — the responsive shell.
