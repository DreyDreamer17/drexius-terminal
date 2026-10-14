# Responsive mobile workspace

The mobile shell is enabled below **768 CSS pixels**; `md:` retains the desktop header, rail, multi-pane grid, resizable AI panel, and dual-pane SFTP explorer.

## Architecture

- `MobileNavigation`: five primary destinations. Hosts includes the existing vault selector and touch-accessible profile actions. Settings exposes locking, auto-lock, pairing, relay sync, themes, keychain, tunnels, known hosts, logs, and broadcast input.
- `App`: retains mounted terminal/SFTP tabs. On a phone, only the selected terminal pane is displayed; the Sessions sheet can select every pane of every terminal tab. Returning to desktop restores the original split layouts. AI/snippets retain the last terminal context when entering from SFTP.
- `useMobileViewport`: applies visual viewport height and offset to the whole shell on resize/scroll, coalesced to an animation frame. A focused input plus a height reduction hides bottom navigation during keyboard input. Safe-area padding is applied to the shell/navigation/sheets. `interactive-widget=resizes-content` handles supported Android browsers; the Visual Viewport path handles overlay keyboards.
- `TerminalAccessory`: one-shot CTRL/ALT latches, standard control keys, normal/application-mode arrows. Input goes through `Terminal.input()` → the existing `onData` pipeline, preserving history and broadcast behavior. Native **non-passive** touchstart listeners and prevented mousedown preserve the terminal textarea focus; no synthetic duplicate touch/mouse input. Multi-character paste/composition data is not rewritten.
- `useTerminalTouch`: captures one-finger scrolling before xterm's own listeners, accumulates fractional rows, applies decaying inertia, cancels animation/timers on unmount, and selects the word under the finger on a stationary long-press (a long-press on blank space opens a Paste menu instead). `TerminalSelection` draws two draggable handles at the selection edges — dragging extends the selection cell by cell, swaps ends when they cross and auto-scrolls near the screen edges — plus a floating Copy · Paste · Select all · clipboard-history bubble positioned from xterm's buffer coordinates, so it follows wrapped lines, scrolling and resizes. A plain tap clears the selection. A two-finger pinch zooms the font: while the fingers move the terminal is only CSS-scaled (anchored bottom-left, composited, no reflow) with a small `Aa 16 px` readout; on release the preview eases onto the nearest whole size inside `TERMINAL_FONT_MIN..MAX`, the app's font-size setting is committed (persisted, shared by every pane) and the transform is dropped in the same frame xterm repaints. There is no page header on phones (the bottom navigation already shows the location). The terminal screen is Termius-style: the terminal fills the screen to the top, the bottom navigation is hidden, and a session bar sits under the terminal — back to Hosts (the session stays alive and the host shows an Active chip; tapping it returns to the same session), a theme-coloured session pill (tap = session switcher sheet, × = close that session), a + button with a small anchored menu (connect to host / local terminal / SFTP / serial) and the keyboard button. Tapping the terminal never opens the on-screen keyboard: xterm's textarea carries `inputmode="none"` until the keyboard button flips it, and it is reset when the system dismisses the keyboard. The key row beneath the session bar also holds the AI Assistant and Snippets keys plus search and history. The Hosts page adds hosts through a floating action button. The AI page (bottom-nav "AI") is the assistant alone — no tab row above it; snippets are reached from the terminal key row's Snippets drawer. Settings uses no native form controls on phones: Auto-lock and Theme rows open themed `MobileSheet` pickers (radio rows with a check, the theme list previews live), font size is a stepper, and line height is a themed range (`.nx-range`, accent-filled track).
- `BottomDrawer` (`useBottomDrawer` + `DrawerGrip` + `DrawerShell`): the key-row tools open bottom drawers over the terminal screen (`.nx-drawer`) — AI Assistant, Snippets, the Extended Keypad and Command History. `App` owns one `terminalDrawer` state and one drawer instance for all of them; `DrawerShell` gives every tool the modal design language (theme terminal background, top ambient radial glow, icon badge + uppercase title + close). Two detents: half (the terminal refits into the top half and the session bar/key row step aside) and full (an overlay). The AI drawer opens full; Snippets, Keypad and History open half because they are used *with* the terminal in view; the grip drags the sheet between detents, a tap on it toggles, a fast downward fling or pulling below 30% dismisses, Escape closes. Keypad keys and history insert/run reach the active pane through the session registry (`LivePane.key` / `LivePane.insert`), so they use the pane's own key pipeline (application cursor mode, modifier latches, suggestion resync) and never take focus away from the terminal. Find-in-terminal is not a drawer: on phones it docks under the terminal (`.nx-terminal-search-docked`, rows refit above it) and the Search key raises the keyboard straight into it. Settled drawers keep `min(320px, 70%)` so the AI header and composer stay visible when the on-screen keyboard shrinks the viewport, and the terminal container mirrors that limit. The AI `<aside>` is the same element on both the Assistant page and the drawer, so a half-typed prompt and the chat history survive closing and reopening. The grip consumes raw `touchmove` (non-passive) so Chrome never turns a fling into a page gesture that swallows the next tap, and `pointerdown` is cancelled so dragging never steals focus from the composer (the keyboard stays up).
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
- Touch scrolling, long-press selection with handle dragging, Copy / Select all / Paste bubble, pinch-to-zoom font size, and swipe-down sheet dismissal.
- Terminal-screen drawers: the AI key opens a full-height drawer, arrow keys/drag move it to the half detent (session bar hidden, terminal refit), Escape closes it; Snippets, Extended Keypad (F1 reaches the PTY through the key pipeline, terminal keeps focus) and Command History open at half; find-in-terminal docks under the terminal with focus.
- The smoke test imports `/src/lib/sessions.ts` and `/src/lib/bridge.ts` straight from the dev server to inspect live state; after editing those files restart `npm run dev` before running it, otherwise Vite serves the test a different (timestamped) module instance than the app and the registry looks empty.
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
