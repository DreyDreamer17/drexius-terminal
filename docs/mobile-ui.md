# Responsive mobile workspace

The mobile shell is enabled below **768 CSS pixels**; `md:` retains the desktop header, rail, multi-pane grid, resizable AI panel, and dual-pane SFTP explorer.

## Architecture

- `MobileNavigation`: five primary destinations. Hosts includes the existing vault selector and touch-accessible profile actions. Settings exposes locking, auto-lock, pairing, relay sync, themes, keychain, tunnels, known hosts, logs, and broadcast input.
- `App`: retains mounted terminal/SFTP tabs. On a phone, only the selected terminal pane is displayed; the Sessions sheet can select every pane of every terminal tab. Returning to desktop restores the original split layouts. AI/snippets retain the last terminal context when entering from SFTP.
- `useMobileViewport`: applies visual viewport height and offset to the whole shell on resize/scroll, coalesced to an animation frame. A focused input plus a height reduction hides bottom navigation during keyboard input. Safe-area padding is applied to the shell/navigation/sheets. `interactive-widget=resizes-content` handles supported Android browsers; the Visual Viewport path handles overlay keyboards.
- `TerminalAccessory`: one-shot CTRL/ALT latches, standard control keys, normal/application-mode arrows. Input goes through `Terminal.input()` → the existing `onData` pipeline, preserving history and broadcast behavior. Native **non-passive** touchstart listeners and prevented mousedown preserve the terminal textarea focus; no synthetic duplicate touch/mouse input. Multi-character paste/composition data is not rewritten.
- `useTerminalTouch`: captures one-finger scrolling before xterm's own listeners, accumulates fractional rows, applies decaying inertia, cancels animation/timers on unmount, and selects a word on a stationary long-press. Selection actions include Copy, Paste, Clear, Select All, and clipboard history. The header exposes font scaling, search, history, and an explicit keyboard button (mobile navigation does not force the keyboard open).
- `ResponsiveOverlay` / `MobileSheet`: preserve desktop modal markup; provide mobile sheet styling, a dedicated swipe-dismiss handle, Escape/backdrop dismissal, focus trapping/restoration, and reduced-motion support. Only the handle owns dismissal gestures, so scrolling a form cannot dismiss it. Portaled sheets inherit the vault lock through context.
- `SftpTab`: Remote/Local segmented single-pane navigation, one-tap folders and parent navigation, breadcrumb drill-down, and file/folder action sheets. Existing transfer, rename, edit, delete-confirmation and creation APIs remain unchanged.
- `SftpCodeEditor`: wrap defaults on for phones; measured wrapped line heights keep the gutter aligned. Touch scrolling, syntax highlighting, and saving remain in the existing editor.

**Permissions are read-only:** the current file bridge exposes permission metadata but no chmod command. The Permissions sheet displays the reported symbolic/octal mode and explains the limitation; it never pretends to save a permission change. Native filesystem, biometric, SSH, relay and pairing capabilities still depend on the existing Tauri backend/platform support; no new native plugin or backend command is introduced here.

## Automated checks

Use Node **22.6+** for the TypeScript-stripping unit runner:

```sh
npm ci
npm run typecheck
npm run build
npm run test:mobile
```

`test:mobile` covers ASCII control mapping, ALT and combined modifiers, normal/application-mode arrows, paste/IME preservation, and all accessory key sequences.

For the browser regression, run `npm run dev` in a separate terminal, supply an installed Chromium/Chrome executable, then run:

```sh
CHROMIUM_PATH=/path/to/chromium npm run test:mobile-ui
```

Optional environment variables:
- `BASE_URL` (defaults to `http://localhost:5173`): must point to the **Vite dev server**, because the test instruments source-module session/bridge instances to verify bytes and connection identity.
- `CHROMIUM_ARGS`: JSON array of extra browser flags, if your test sandbox needs them.

`playwright-core` is a dev-only dependency and does **not** download a browser. Screenshots are written under ignored `node_modules/.cache/mobile-ui/`. The test uses a new isolated browser context and a disposable browser-preview vault, not any native/user credentials.

The Chromium smoke test covers:
- 320, 390, 640, 767, 768 and 1280px layouts; mobile navigation and desktop breakpoint.
- CTRL+C (`0x03`), ALT+X, TAB; latched highlights, one-shot reset, focus preservation and no duplicate touch dispatch.
- Visual-viewport keyboard simulation and toolbar docking, session switching without reconnects.
- Desktop splits → a single mobile pane → desktop splits, with session identity unchanged.
- Touch scrolling, long-press selection, Select All, and swipe-down sheet dismissal.
- Host sheets/actions, SFTP pane visibility, permissions and editing, wrapped editor, AI/snippets, settings and pairing UI.
- Auto-lock hiding portaled sheets while leaving sessions running.
- No uncaught browser runtime errors or passive-listener prevention errors.

## Physical-device release checklist (still required)

Headless Chromium emulation does not validate native keyboard animation, WebKit, platform biometrics, filesystem sandboxes, or live SSH/SFTP/LAN/relay operations. Before release, test on an actual iOS Safari/WKWebView device and Android Chrome/Tauri WebView:

1. Portrait/landscape, cutouts, gesture navigation, browser chrome expansion/collapse, and external keyboards. Verify no safe-area overlap or body bounce.
2. Open/close the virtual keyboard repeatedly, including password, AI and editor fields. Accessory keys must remain flush with the keyboard and xterm must fit after the animation settles.
3. CTRL+C/D/Z, ALT+word navigation, arrows/TAB in bash, vim and tmux; CJK composition and bracketed paste. Check both application and normal cursor modes.
4. Long-press word selection, clipboard permission denial, large scrollback inertia, font-size limits and keyboard search.
5. Multiple real SSH sessions and saved desktop splits; change destinations/orientation and verify no disconnects or broadcast surprises.
6. Remote SFTP transfers to the selected local folder, rename, cancellation of delete, large wrapped files, and unsaved-editor confirmation. Local access follows the native app's sandbox permissions.
7. Locked vault, biometric unlock where supported, recovery actions, LAN pairing, relay sync, AI provider settings, tunnels and snippet execution. Never accept a new host fingerprint without verifying it independently.
8. VoiceOver/TalkBack names, tab/focus order, reduced motion, 44px controls and large text settings.
