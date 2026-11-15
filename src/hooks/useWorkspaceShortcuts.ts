import { useEffect, type Dispatch, type MutableRefObject, type SetStateAction } from 'react';
import { hasPendingConfirm } from '../components/ConfirmDialog';
import { clampTerminalFontSize } from '../lib/mobileTerminal';
import { registry } from '../lib/sessions';
import {
  bindingMatches,
  DEFAULT_TERMINAL_FONT_SIZE,
  isShortcutUnbound,
  normalizeCombo,
  type ShortcutBinding,
} from '../lib/settings';
import type { SplitDirection } from '../lib/splitTree';
import type { Host, Pane, PopoutPaneEntry, Tab } from '../lib/types';
import type { SplitMenuState, WorkspacePanelKind } from '../lib/workspaceState';

export interface UseWorkspaceShortcutsParams {
  shortcuts: Record<string, ShortcutBinding>;
  quick: boolean;
  setQuick: Dispatch<SetStateAction<boolean>>;
  showThemes: boolean;
  setShowThemes: Dispatch<SetStateAction<boolean>>;
  panel: WorkspacePanelKind | null;
  setPanel: Dispatch<SetStateAction<WorkspacePanelKind | null>>;
  modal: { host: Host | null } | null;
  setModal: Dispatch<SetStateAction<{ host: Host | null } | null>>;
  showAutoLockMenu: boolean;
  setShowAutoLockMenu: Dispatch<SetStateAction<boolean>>;
  showDockerModal: boolean;
  setShowDockerModal: Dispatch<SetStateAction<boolean>>;
  setDockerHostId: Dispatch<SetStateAction<string | null>>;
  splitMenu: SplitMenuState | null;
  setSplitMenu: Dispatch<SetStateAction<SplitMenuState | null>>;
  showSettings: boolean;
  setShowSettings: Dispatch<SetStateAction<boolean>>;
  showSavePresetModal: boolean;
  setShowSavePresetModal: Dispatch<SetStateAction<boolean>>;
  setPresetNameInput: Dispatch<SetStateAction<string>>;
  showPopoutMenu: boolean;
  setShowPopoutMenu: Dispatch<SetStateAction<boolean>>;
  closeTerminalDrawerRef: MutableRefObject<(() => boolean) | null>;
  activeTab: Tab | null;
  terminalContext: Tab | undefined | null;
  activePaneId: string | null;
  activePane: Pane | undefined;
  tabs: Tab[];
  broadcast: boolean;
  setBroadcast: Dispatch<SetStateAction<boolean>>;
  setShowAI: Dispatch<SetStateAction<boolean>>;
  setZen: Dispatch<SetStateAction<boolean>>;
  setShowRail: Dispatch<SetStateAction<boolean>>;
  setShowStatusBar: Dispatch<SetStateAction<boolean>>;
  setFontSize: Dispatch<SetStateAction<number>>;
  fontSizeRef: MutableRefObject<number>;
  isPopoutWindow: boolean;
  popoutPaneId: string;
  poppedOutPanes: PopoutPaneEntry[];
  toggleQuick: () => void;
  openLocalTerminal: () => void;
  openSftpTab: (initialHostId?: string) => void;
  navigateSplitDirection: (dir: 'left' | 'right' | 'up' | 'down') => void;
  swapSplitDirection: (dir: 'left' | 'right' | 'up' | 'down') => void;
  cyclePane: (delta: 1 | -1) => void;
  splitPaneInDirection: (direction: SplitDirection, targetHost?: Host, fromPaneId?: string) => void;
  equalizeActiveTab: () => void;
  closePane: (tabId: string, paneId: string) => void;
  closeActivePaneOrTab: () => void;
  duplicateOrNewTab: () => Promise<void> | void;
  toggleMaximizePane: (paneId?: string) => void;
  popOutPane: (tabId: string, paneId: string) => void;
  sendPopoutAction: (action: 'dock' | 'close') => void;
  updatePaneFontSize: (tabId: string, paneId: string, nextSize: number | undefined) => void;
  showFontZoomHud: (size: number) => void;
  toast: (msg: string) => void;
}

export function useWorkspaceShortcuts({
  shortcuts,
  quick,
  setQuick,
  showThemes,
  setShowThemes,
  panel,
  setPanel,
  modal,
  setModal,
  showAutoLockMenu,
  setShowAutoLockMenu,
  showDockerModal,
  setShowDockerModal,
  setDockerHostId,
  splitMenu,
  setSplitMenu,
  showSettings,
  setShowSettings,
  showSavePresetModal,
  setShowSavePresetModal,
  setPresetNameInput,
  showPopoutMenu,
  setShowPopoutMenu,
  closeTerminalDrawerRef,
  activeTab,
  terminalContext,
  activePaneId,
  activePane,
  tabs,
  broadcast,
  setBroadcast,
  setShowAI,
  setZen,
  setShowRail,
  setShowStatusBar,
  setFontSize,
  fontSizeRef,
  isPopoutWindow,
  popoutPaneId,
  poppedOutPanes,
  toggleQuick,
  openLocalTerminal,
  openSftpTab,
  navigateSplitDirection,
  swapSplitDirection,
  cyclePane,
  splitPaneInDirection,
  equalizeActiveTab,
  closePane,
  closeActivePaneOrTab,
  duplicateOrNewTab,
  toggleMaximizePane,
  popOutPane,
  sendPopoutAction,
  updatePaneFontSize,
  showFontZoomHud,
  toast,
}: UseWorkspaceShortcutsParams) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        // An open confirm sheet owns Escape (it cancels itself); don't tear down the panel under it.
        if (hasPendingConfirm()) return;
        // A terminal-screen drawer (AI / snippets) is the topmost layer on mobile: Escape dismisses it first.
        if (closeTerminalDrawerRef.current?.()) {
          e.preventDefault();
          e.stopPropagation();
          return;
        }
        if (
          quick ||
          showThemes ||
          panel ||
          modal ||
          showAutoLockMenu ||
          showDockerModal ||
          splitMenu ||
          showSettings ||
          showSavePresetModal ||
          showPopoutMenu
        ) {
          e.preventDefault();
          e.stopPropagation();
          setQuick(false);
          setShowThemes(false);
          setPanel(null);
          setModal(null);
          setShowAutoLockMenu(false);
          setShowDockerModal(false);
          setSplitMenu(null);
          setShowSettings(false);
          setShowSavePresetModal(false);
          setShowPopoutMenu(false);
        }
        return;
      }
      const target = e.target as HTMLElement | null;

      // ── Never intercept when shortcut recorder is active ──
      if (target && target.closest('[data-shortcut-recorder]')) return;

      // ── When settings modal is open, don't execute background workspace shortcuts ──
      if (showSettings) {
        if (bindingMatches(e, shortcuts.open_settings, 'Ctrl+,')) {
          e.preventDefault();
          e.stopPropagation();
          setShowSettings(false);
        }
        return;
      }

      // xterm's hidden textarea is a terminal surface, not a text input: the
      // Ctrl+Shift+* workspace shortcuts must keep working while a terminal
      // has focus (the TerminalPane also blocks those sequences from leaking
      // to the shell). Plain Ctrl+T/Ctrl+K stay with the shell (^T transpose,
      // ^K kill-line) when the terminal is focused.
      const inTerminal = !!(target && target.closest && target.closest('.xterm'));
      const isInput =
        target && !inTerminal && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable);
      if (isInput) return;

      // ── Directional Split Swap / Move (Alt+Shift+Arrow) ──
      if (bindingMatches(e, shortcuts.swap_split_left, 'Alt+Shift+ArrowLeft')) {
        e.preventDefault();
        e.stopPropagation();
        swapSplitDirection('left');
        return;
      }
      if (bindingMatches(e, shortcuts.swap_split_right, 'Alt+Shift+ArrowRight')) {
        e.preventDefault();
        e.stopPropagation();
        swapSplitDirection('right');
        return;
      }
      if (bindingMatches(e, shortcuts.swap_split_up, 'Alt+Shift+ArrowUp')) {
        e.preventDefault();
        e.stopPropagation();
        swapSplitDirection('up');
        return;
      }
      if (bindingMatches(e, shortcuts.swap_split_down, 'Alt+Shift+ArrowDown')) {
        e.preventDefault();
        e.stopPropagation();
        swapSplitDirection('down');
        return;
      }

      // ── Directional Split Navigation ──
      if (bindingMatches(e, shortcuts.focus_split_left, 'Alt+ArrowLeft')) {
        e.preventDefault();
        e.stopPropagation();
        navigateSplitDirection('left');
        return;
      }
      if (bindingMatches(e, shortcuts.focus_split_right, 'Alt+ArrowRight')) {
        e.preventDefault();
        e.stopPropagation();
        navigateSplitDirection('right');
        return;
      }
      if (bindingMatches(e, shortcuts.focus_split_up, 'Alt+ArrowUp')) {
        e.preventDefault();
        e.stopPropagation();
        navigateSplitDirection('up');
        return;
      }
      if (bindingMatches(e, shortcuts.focus_split_down, 'Alt+ArrowDown')) {
        e.preventDefault();
        e.stopPropagation();
        navigateSplitDirection('down');
        return;
      }

      // ── Open Settings (Ctrl/Cmd + ,) ──
      if (bindingMatches(e, shortcuts.open_settings, 'Ctrl+,')) {
        e.preventDefault();
        e.stopPropagation();
        setShowSettings((v) => !v);
        return;
      }

      // ── Close Active Split Pane or Tab (Ctrl+Shift+W / Cmd+W on macOS / Ctrl+W outside terminal) ──
      const isPlainCtrlW =
        e.ctrlKey && !e.metaKey && !e.shiftKey && !e.altKey && (e.key.toLowerCase() === 'w' || e.code === 'KeyW');
      const isMacCmdW =
        e.metaKey && !e.ctrlKey && !e.shiftKey && !e.altKey && (e.key.toLowerCase() === 'w' || e.code === 'KeyW');
      if (
        bindingMatches(e, shortcuts.close_pane, 'Ctrl+Shift+W') ||
        (!isShortcutUnbound(shortcuts.close_pane) && (isMacCmdW || (!inTerminal && isPlainCtrlW)))
      ) {
        if (!inTerminal || !isPlainCtrlW) {
          e.preventDefault();
          e.stopPropagation();
          closeActivePaneOrTab();
          return;
        }
      }

      // ── Toggle Maximize / Zoom Active Split Pane (Ctrl+Shift+M) ──
      if (bindingMatches(e, shortcuts.maximize_pane, 'Ctrl+Shift+M')) {
        if (activeTab && activeTab.panes.length > 1) {
          e.preventDefault();
          e.stopPropagation();
          toggleMaximizePane();
          return;
        }
      }

      // ── Pop Out Active Pane / Dock Back (Ctrl+Shift+P) ──
      if (bindingMatches(e, shortcuts.popout_pane, 'Ctrl+Shift+P')) {
        if (isPopoutWindow) {
          e.preventDefault();
          e.stopPropagation();
          sendPopoutAction('dock');
          return;
        }
        if (activeTab && activeTab.kind !== 'sftp' && activeTab.panes.length > 0) {
          e.preventDefault();
          e.stopPropagation();
          popOutPane(activeTab.id, activeTab.activePaneId);
          return;
        }
      }

      // ── Next / Previous Split Pane (Ctrl+] / Ctrl+[) ──
      if (bindingMatches(e, shortcuts.next_pane, 'Ctrl+]')) {
        if (activeTab && activeTab.panes.length > 1) {
          e.preventDefault();
          e.stopPropagation();
          cyclePane(1);
          return;
        }
      }
      if (bindingMatches(e, shortcuts.prev_pane, 'Ctrl+[')) {
        if (activeTab && activeTab.panes.length > 1) {
          e.preventDefault();
          e.stopPropagation();
          cyclePane(-1);
          return;
        }
      }

      // ── Duplicate Active Tab / New Terminal (Cmd+T, Ctrl+T outside terminal, Ctrl+Shift+T) ──
      const isPlainCtrlT =
        e.ctrlKey && !e.metaKey && !e.shiftKey && !e.altKey && (e.key.toLowerCase() === 't' || e.code === 'KeyT');
      const isShiftNewTab =
        !isShortcutUnbound(shortcuts.new_terminal) &&
        e.shiftKey &&
        (e.ctrlKey || e.metaKey) &&
        !e.altKey &&
        (e.key.toLowerCase() === 't' || e.code === 'KeyT');
      if (bindingMatches(e, shortcuts.new_terminal, 'Ctrl+T') || isShiftNewTab) {
        if (!inTerminal || !isPlainCtrlT) {
          e.preventDefault();
          e.stopPropagation();
          void duplicateOrNewTab();
          return;
        }
      }

      // ── Quick Connect / Palette (Ctrl+K) ──
      if (
        bindingMatches(e, shortcuts.open_quick, 'Ctrl+K') ||
        (e.shiftKey && (e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k')
      ) {
        if (!inTerminal || e.shiftKey) {
          e.preventDefault();
          e.stopPropagation();
          toggleQuick();
          return;
        }
      }

      // ── Cluster Broadcast (Ctrl+Shift+I) ──
      if (bindingMatches(e, shortcuts.toggle_broadcast, 'Ctrl+Shift+I')) {
        e.preventDefault();
        e.stopPropagation();
        setBroadcast((b) => {
          const next = !b;
          toast(next ? '⚡ Broadcast Cluster Mode: ON (Input sent to all panes in tab)' : 'Broadcast Cluster Mode: OFF');
          return next;
        });
        return;
      }

      // ── Instant splits: copy the focused pane, no menu ──
      // Ctrl+Shift+D / E split right / down; Alt+Shift+D / E split left / up.
      const instantSplits: Array<[string, string, SplitDirection]> = [
        ['split_vertical', 'Ctrl+Shift+D', 'right'],
        ['split_horizontal', 'Ctrl+Shift+E', 'down'],
        ['split_left', 'Alt+Shift+D', 'left'],
        ['split_up', 'Alt+Shift+E', 'up'],
      ];
      for (const [id, fallback, direction] of instantSplits) {
        if (bindingMatches(e, shortcuts[id], fallback) && activeTab && activeTab.kind !== 'sftp' && activeTab.panes.length > 0) {
          e.preventDefault();
          e.stopPropagation();
          splitPaneInDirection(direction);
          return;
        }
      }

      // ── Split with a different host (opens the menu) ──
      if (bindingMatches(e, shortcuts.split_menu, 'Ctrl+Shift+O')) {
        e.preventDefault();
        e.stopPropagation();
        setSplitMenu((prev) =>
          prev?.tab === 'split' ? null : { tab: 'split', direction: 'right', pref: 'vertical', left: 400, top: 45 }
        );
        return;
      }

      // ── Equalize all splits in the tab (Ctrl+Shift+N) ──
      if (bindingMatches(e, shortcuts.equalize_splits, 'Ctrl+Shift+N')) {
        if (activeTab && activeTab.kind !== 'sftp' && activeTab.panes.length > 1) {
          e.preventDefault();
          e.stopPropagation();
          equalizeActiveTab();
          return;
        }
      }

      // ── Open Layout & Presets Menu (Ctrl+Shift+L) ──
      if (bindingMatches(e, shortcuts.open_layout_menu, 'Ctrl+Shift+L')) {
        e.preventDefault();
        e.stopPropagation();
        setSplitMenu((prev) =>
          prev?.tab === 'presets' ? null : { tab: 'presets', direction: 'right', pref: 'vertical', left: 460, top: 45 }
        );
        return;
      }

      // ── Save Layout Preset (Ctrl+Shift+S) ──
      if (bindingMatches(e, shortcuts.save_layout_preset, 'Ctrl+Shift+S')) {
        if (activeTab && (activeTab.panes.length > 1 || poppedOutPanes.length > 0)) {
          e.preventDefault();
          e.stopPropagation();
          setPresetNameInput(activeTab.title || 'My Workspace');
          setShowSavePresetModal(true);
          return;
        }
      }

      // ── Toggle AI Assistant (Ctrl+Shift+A) ──
      if (bindingMatches(e, shortcuts.toggle_ai, 'Ctrl+Shift+A')) {
        e.preventDefault();
        e.stopPropagation();
        setShowAI((v) => !v);
        return;
      }

      // ── Open SFTP Browser (Ctrl+Shift+F) ──
      if (bindingMatches(e, shortcuts.open_sftp, 'Ctrl+Shift+F')) {
        e.preventDefault();
        e.stopPropagation();
        openSftpTab();
        return;
      }

      // ── Toggle Zen Mode (Ctrl+Shift+Z) ──
      if (bindingMatches(e, shortcuts.toggle_zen, 'Ctrl+Shift+Z')) {
        e.preventDefault();
        e.stopPropagation();
        setZen((v) => !v);
        return;
      }

      // ── Command History search (Ctrl+Shift+R) ──
      if (bindingMatches(e, shortcuts.command_history, 'Ctrl+Shift+R')) {
        const live = activePaneId ? registry.get(activePaneId) : undefined;
        if (live?.openHistory) {
          e.preventDefault();
          e.stopPropagation();
          live.openHistory();
          return;
        }
      }

      // ── Toggle Sidebar Rail (Ctrl+Shift+B) ──
      if (bindingMatches(e, shortcuts.toggle_rail, 'Ctrl+Shift+B')) {
        e.preventDefault();
        e.stopPropagation();
        setShowRail((v) => !v);
        return;
      }

      // ── Docker Manager (Ctrl+Shift+U or Alt+D) ──
      if ((e.ctrlKey || e.metaKey) && (e.key.toLowerCase() === 'u' || (e.altKey && e.key.toLowerCase() === 'd'))) {
        e.preventDefault();
        e.stopPropagation();
        const activeP = terminalContext?.panes.find((p) => p.id === activePaneId);
        setDockerHostId(activeP?.isLocal ? '__local__' : activeP?.hostId ?? null);
        setShowDockerModal((v) => !v);
        return;
      }

      // ── Toggle Status Bar (Ctrl+/) ──
      if ((e.ctrlKey || e.metaKey) && e.key === '/') {
        e.preventDefault();
        e.stopPropagation();
        setShowStatusBar((v) => !v);
        return;
      }

      // ── On-the-fly terminal font size (Ctrl/Cmd+=, Ctrl/Cmd+-, Ctrl/Cmd+0) ──
      // Not shell control characters, so plain-Ctrl is safe to intercept. Ctrl++ (the shifted
      // '+' on most layouts) is the same action as Ctrl+=, but only while the binding still uses
      // its default — a user who rebound zoom-in keeps exactly what they configured.
      // Adjusts the focused pane only (falling back to global fontSize when no pane is open).
      const focusedPaneFontSize = activePane?.fontSize ?? fontSizeRef.current;
      const zoomInAtDefault =
        normalizeCombo(shortcuts.font_zoom_in?.keys ?? 'Ctrl+=') === normalizeCombo('Ctrl+=');
      if (
        bindingMatches(e, shortcuts.font_zoom_in, 'Ctrl+=') ||
        (zoomInAtDefault && (e.ctrlKey || e.metaKey) && !e.altKey && (e.key === '=' || e.key === '+'))
      ) {
        e.preventDefault();
        e.stopPropagation();
        const next = clampTerminalFontSize(focusedPaneFontSize + 1);
        if (terminalContext && activePane) {
          updatePaneFontSize(terminalContext.id, activePane.id, next);
        } else {
          setFontSize(next);
        }
        showFontZoomHud(next);
        return;
      }
      if (bindingMatches(e, shortcuts.font_zoom_out, 'Ctrl+-')) {
        e.preventDefault();
        e.stopPropagation();
        const next = clampTerminalFontSize(focusedPaneFontSize - 1);
        if (terminalContext && activePane) {
          updatePaneFontSize(terminalContext.id, activePane.id, next);
        } else {
          setFontSize(next);
        }
        showFontZoomHud(next);
        return;
      }
      if (bindingMatches(e, shortcuts.font_zoom_reset, 'Ctrl+0')) {
        e.preventDefault();
        e.stopPropagation();
        if (terminalContext && activePane) {
          updatePaneFontSize(terminalContext.id, activePane.id, undefined);
          showFontZoomHud(fontSizeRef.current);
        } else {
          setFontSize(DEFAULT_TERMINAL_FONT_SIZE);
          showFontZoomHud(DEFAULT_TERMINAL_FONT_SIZE);
        }
        return;
      }
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [
    toggleQuick,
    openLocalTerminal,
    openSftpTab,
    broadcast,
    tabs,
    quick,
    showThemes,
    panel,
    modal,
    showAutoLockMenu,
    showDockerModal,
    splitMenu,
    showSettings,
    shortcuts,
    navigateSplitDirection,
    swapSplitDirection,
    cyclePane,
    splitPaneInDirection,
    equalizeActiveTab,
    closePane,
    closeActivePaneOrTab,
    duplicateOrNewTab,
    toggleMaximizePane,
    popOutPane,
    isPopoutWindow,
    popoutPaneId,
    poppedOutPanes.length,
    showPopoutMenu,
    showSavePresetModal,
    toast,
    terminalContext,
    activePaneId,
    activePane,
    activeTab,
    updatePaneFontSize,
    showFontZoomHud,
  ]);
}
