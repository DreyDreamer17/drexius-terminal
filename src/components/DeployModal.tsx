import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Rocket,
  GitBranch,
  FolderGit2,
  Play,
  RotateCcw,
  Plus,
  Trash2,
  CheckCircle2,
  XCircle,
  Loader2,
  Copy,
  Check,
  Terminal,
  RefreshCw,
  Code2,
  Layers,
  History,
  Settings2,
  X,
  AlertTriangle,
  Sparkles,
  Server,
} from 'lucide-react';
import type {
  DeployPresetKind,
  DeployProfile,
  DeployReleaseState,
  DeployRunResult,
  Host,
  Snippet,
} from '../lib/types';
import { bridge } from '../lib/bridge';
import {
  BUILTIN_RUNTIME_VARS,
  DEPLOY_PRESETS,
  buildStandaloneDeployShellScript,
  composeDeployBuildScript,
  extractCustomPlaceholders,
  interpolateVariables,
} from '../lib/deployPresets';
import { ResponsiveOverlay, SheetHandle } from './MobileSheet';
import { THEMES, type DrexiusTheme } from '../lib/themes';
import { confirmDialog } from './ConfirmDialog';
import { CustomSelect } from './CustomSelect';
import { cn } from '../utils/cn';

interface Props {
  hosts: Host[];
  snippets: Snippet[];
  activeHostId?: string | null;
  onOpenTerminalWithCommand?: (host: Host, command: string, title?: string) => void;
  toast: (msg: string) => void;
  theme?: DrexiusTheme;
  onClose: () => void;
}

const LOCAL_HOST_OPTION: Host = {
  id: '__local__',
  label: 'Local Machine',
  hostname: 'localhost',
  port: 0,
  username: 'local',
  authMethod: 'agent',
  tags: ['local'],
  hasSecret: false,
  os: 'linux',
};

function createNewProfile(hostId: string, preset: DeployPresetKind = 'custom'): DeployProfile {
  const def = DEPLOY_PRESETS[preset];
  return {
    id: '',
    name: '',
    hostId,
    preset,
    repoUrl: '',
    branch: 'main',
    appDir: '/var/www/app',
    keepReleases: 2,
    sharedFiles: [...def.sharedFiles],
    sharedDirs: [...def.sharedDirs],
    buildScript: def.buildScript,
    postSwapScript: def.postSwapScript,
    snippetIds: [],
    variables: { ...def.defaultVars },
    lastDeployedAt: null,
    lastReleaseId: null,
  };
}

export function DeployModal({
  hosts,
  snippets,
  activeHostId,
  onOpenTerminalWithCommand,
  toast,
  theme,
  onClose,
}: Props) {
  const activeTheme =
    theme ||
    THEMES.find((t) => t.id === (localStorage.getItem('drx.theme') ?? 'drexius')) ||
    THEMES[0];
  const accentColor = activeTheme.accent;
  const bgColor = activeTheme.xterm.background || '#0f141f';

  const selectableHosts = useMemo(() => [LOCAL_HOST_OPTION, ...hosts], [hosts]);
  const defaultHostId =
    activeHostId && selectableHosts.some((h) => h.id === activeHostId)
      ? activeHostId
      : hosts[0]?.id ?? '__local__';

  const [profiles, setProfiles] = useState<DeployProfile[]>([]);
  const [selectedId, setSelectedId] = useState<string>('');
  const [draft, setDraft] = useState<DeployProfile>(() => createNewProfile(defaultHostId, 'custom'));
  const [activeTab, setActiveTab] = useState<'config' | 'run' | 'releases'>('config');

  const [sharedFilesInput, setSharedFilesInput] = useState('.env');
  const [sharedDirsInput, setSharedDirsInput] = useState('');
  const [customVarKey, setCustomVarKey] = useState('');
  const [customVarVal, setCustomVarVal] = useState('');

  const [deploying, setDeploying] = useState(false);
  const [rollingBack, setRollingBack] = useState<string | null>(null);
  const [runResult, setRunResult] = useState<DeployRunResult | null>(null);
  const [releaseState, setReleaseState] = useState<DeployReleaseState | null>(null);
  const [loadingReleases, setLoadingReleases] = useState(false);
  const [releaseError, setReleaseError] = useState<string | null>(null);
  const [copiedScript, setCopiedScript] = useState(false);

  const syncInputsFromProfile = useCallback((p: DeployProfile) => {
    setDraft(p);
    setSharedFilesInput((p.sharedFiles || []).join(', '));
    setSharedDirsInput((p.sharedDirs || []).join(', '));
  }, []);

  const loadProfiles = useCallback(async () => {
    try {
      const list = await bridge.deployProfilesList();
      setProfiles(list);
      if (list.length > 0) {
        const first = list[0];
        setSelectedId(first.id);
        syncInputsFromProfile(first);
      } else {
        const fresh = createNewProfile(defaultHostId, 'custom');
        setSelectedId('');
        syncInputsFromProfile(fresh);
      }
    } catch (e: any) {
      toast(e?.message || 'Failed to load deploy profiles');
    }
  }, [defaultHostId, syncInputsFromProfile, toast]);

  useEffect(() => {
    loadProfiles();
  }, [loadProfiles]);

  const parsedDraft = useMemo<DeployProfile>(() => {
    const sharedFiles = sharedFilesInput
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
    const sharedDirs = sharedDirsInput
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
    return {
      ...draft,
      sharedFiles,
      sharedDirs,
    };
  }, [draft, sharedFilesInput, sharedDirsInput]);

  // Detect all custom {{var}} placeholders across buildScript, postSwapScript, and attached snippets
  const detectedCustomVars = useMemo(() => {
    const attachedCommands = (parsedDraft.snippetIds || [])
      .map((id) => snippets.find((s) => s.id === id)?.command || '')
      .filter(Boolean);
    const keys = new Set<string>([
      ...extractCustomPlaceholders(
        parsedDraft.buildScript,
        parsedDraft.postSwapScript,
        ...attachedCommands
      ),
      ...Object.keys(parsedDraft.variables || {}),
    ]);
    return [...keys];
  }, [parsedDraft.buildScript, parsedDraft.postSwapScript, parsedDraft.snippetIds, parsedDraft.variables, snippets]);

  const refreshReleases = useCallback(
    async (hostId = parsedDraft.hostId, appDir = parsedDraft.appDir) => {
      if (!appDir.trim().startsWith('/')) return;
      setLoadingReleases(true);
      setReleaseError(null);
      try {
        const state = await bridge.deployListReleases(hostId, appDir.trim());
        setReleaseState(state);
      } catch (e: any) {
        setReleaseError(e?.message || String(e));
      } finally {
        setLoadingReleases(false);
      }
    },
    [parsedDraft.hostId, parsedDraft.appDir]
  );

  useEffect(() => {
    if (activeTab === 'releases') {
      refreshReleases();
    }
  }, [activeTab, refreshReleases]);

  const handleSelectProfile = (p: DeployProfile) => {
    setSelectedId(p.id);
    syncInputsFromProfile(p);
    setRunResult(null);
    setReleaseState(null);
  };

  const handleApplyPreset = (preset: DeployPresetKind) => {
    const prevDef = DEPLOY_PRESETS[parsedDraft.preset];
    const def = DEPLOY_PRESETS[preset];
    // Remove untouched default variables from the previous preset so switching stacks stays clean
    const cleanedVars: Record<string, string> = {};
    for (const [k, v] of Object.entries(parsedDraft.variables || {})) {
      if (!(k in prevDef.defaultVars && prevDef.defaultVars[k] === v)) {
        cleanedVars[k] = v;
      }
    }
    const next: DeployProfile = {
      ...parsedDraft,
      preset,
      sharedFiles: [...def.sharedFiles],
      sharedDirs: [...def.sharedDirs],
      buildScript: def.buildScript,
      postSwapScript: def.postSwapScript,
      variables: { ...def.defaultVars, ...cleanedVars },
    };
    syncInputsFromProfile(next);
  };

  const handleSaveProfile = async (): Promise<DeployProfile | null> => {
    if (!parsedDraft.name.trim()) {
      toast('Please enter a profile name');
      return null;
    }
    if (!parsedDraft.appDir.trim().startsWith('/')) {
      toast('Application directory must be an absolute path (e.g. /var/www/myapp)');
      return null;
    }
    try {
      const saved = await bridge.deployProfileSave(parsedDraft);
      const updated = await bridge.deployProfilesList();
      setProfiles(updated);
      setSelectedId(saved.id);
      syncInputsFromProfile(saved);
      toast(`Saved deployment profile "${saved.name}"`);
      return saved;
    } catch (e: any) {
      toast(e?.message || 'Failed to save profile');
      return null;
    }
  };

  const handleDeleteProfile = async (p: DeployProfile) => {
    const ok = await confirmDialog({
      title: `Delete deploy profile "${p.name}"?`,
      message: 'This only removes the saved deployment configuration in Drexius. Remote server files are untouched.',
      confirmLabel: 'Delete Profile',
      danger: true,
    });
    if (!ok) return;
    try {
      await bridge.deployProfileDelete(p.id);
      const nextList = await bridge.deployProfilesList();
      setProfiles(nextList);
      if (nextList.length > 0) {
        setSelectedId(nextList[0].id);
        syncInputsFromProfile(nextList[0]);
      } else {
        const fresh = createNewProfile(defaultHostId, 'custom');
        setSelectedId('');
        syncInputsFromProfile(fresh);
      }
      toast('Deployment profile deleted');
    } catch (e: any) {
      toast(e?.message || 'Failed to delete profile');
    }
  };

  const handleRunDeploy = async () => {
    if (!parsedDraft.repoUrl.trim()) {
      toast('Please enter a GitHub / Git repository URL');
      setActiveTab('config');
      return;
    }
    if (!parsedDraft.appDir.trim().startsWith('/')) {
      toast('Application path must be an absolute server path (e.g. /var/www/app)');
      setActiveTab('config');
      return;
    }
    const saved = await handleSaveProfile();
    const activeProfile = saved || parsedDraft;
    const combinedBuild = composeDeployBuildScript(activeProfile, snippets);

    setActiveTab('run');
    setDeploying(true);
    setRunResult(null);
    try {
      const res = await bridge.deployRunRelease({
        hostId: activeProfile.hostId,
        repoUrl: activeProfile.repoUrl.trim(),
        branch: activeProfile.branch.trim() || 'main',
        appDir: activeProfile.appDir.trim(),
        keepReleases: Math.max(2, activeProfile.keepReleases || 2),
        sharedFiles: activeProfile.sharedFiles,
        sharedDirs: activeProfile.sharedDirs,
        buildScript: combinedBuild,
        postSwapScript: activeProfile.postSwapScript,
        variables: activeProfile.variables,
        profileId: activeProfile.id || null,
      });
      setRunResult(res);
      if (res.state) setReleaseState(res.state);
      if (res.success) {
        toast(`Deployed release ${res.releaseId} successfully`);
        const updated = await bridge.deployProfilesList();
        setProfiles(updated);
      } else {
        toast(res.error || 'Deployment failed — live symlink was not modified');
      }
    } catch (e: any) {
      toast(e?.message || String(e));
      setRunResult({
        success: false,
        releaseId: '-',
        releaseDir: activeProfile.appDir,
        steps: [],
        error: e?.message || String(e),
      });
    } finally {
      setDeploying(false);
    }
  };

  const handleRollback = async (targetReleaseId?: string) => {
    const label = targetReleaseId ? `release ${targetReleaseId}` : 'the previous release folder';
    const ok = await confirmDialog({
      title: `Roll back to ${label}?`,
      message: `This will atomically swap ${parsedDraft.appDir}/current back to ${label} and run your post-swap reload hook.`,
      confirmLabel: 'Roll Back Now',
      danger: false,
    });
    if (!ok) return;
    setRollingBack(targetReleaseId || '__prev__');
    try {
      const cleanAppDir = parsedDraft.appDir.trim().replace(/\/+$/, '');
      const resolvedPostSwap = interpolateVariables(parsedDraft.postSwapScript, {
        ...parsedDraft.variables,
        app_dir: cleanAppDir,
        current_dir: `${cleanAppDir}/current`,
        shared_dir: `${cleanAppDir}/shared`,
        branch: parsedDraft.branch.trim() || 'main',
        repo_url: parsedDraft.repoUrl.trim(),
      });
      const res = await bridge.deployRollback(
        parsedDraft.hostId,
        cleanAppDir,
        targetReleaseId ?? null,
        resolvedPostSwap
      );
      setRunResult(res);
      if (res.state) setReleaseState(res.state);
      if (res.success) {
        toast(`Rolled back current → releases/${res.releaseId}`);
      } else {
        toast(res.error || 'Rollback failed');
      }
    } catch (e: any) {
      toast(e?.message || String(e));
    } finally {
      setRollingBack(null);
    }
  };

  const handleDeleteReleaseFolder = async (releaseId: string) => {
    const ok = await confirmDialog({
      title: `Delete release folder ${releaseId}?`,
      message: `Permanently removes ${parsedDraft.appDir}/releases/${releaseId} from the server.`,
      confirmLabel: 'Delete Folder',
      danger: true,
    });
    if (!ok) return;
    try {
      const nextState = await bridge.deployDeleteRelease(
        parsedDraft.hostId,
        parsedDraft.appDir.trim(),
        releaseId
      );
      setReleaseState(nextState);
      toast(`Removed release folder ${releaseId}`);
    } catch (e: any) {
      toast(e?.message || String(e));
    }
  };

  const handleSendToTerminal = () => {
    const targetHost =
      selectableHosts.find((h) => h.id === parsedDraft.hostId) || LOCAL_HOST_OPTION;
    const script = buildStandaloneDeployShellScript(parsedDraft, snippets);
    if (onOpenTerminalWithCommand) {
      onOpenTerminalWithCommand(targetHost, script, `Deploy: ${parsedDraft.name || 'Release'}`);
      onClose();
    }
  };

  const handleCopyScript = async () => {
    const script = buildStandaloneDeployShellScript(parsedDraft, snippets);
    await bridge.writeClipboard(script);
    setCopiedScript(true);
    toast('Copied atomic deploy shell script to clipboard');
    setTimeout(() => setCopiedScript(false), 2000);
  };

  const toggleSnippetAttachment = (snippetId: string) => {
    setDraft((prev) => {
      const exists = prev.snippetIds.includes(snippetId);
      return {
        ...prev,
        snippetIds: exists
          ? prev.snippetIds.filter((id) => id !== snippetId)
          : [...prev.snippetIds, snippetId],
      };
    });
  };

  const inputCls =
    'w-full rounded-xl border border-white/10 bg-black/40 px-3 py-2 text-xs text-slate-100 placeholder:text-slate-500 focus:border-cyan-400/50 focus:outline-none';

  return (
    <ResponsiveOverlay
      portal
      onClose={onClose}
      label="Application Deployment Manager"
      className="fixed inset-0 z-[70] flex items-center justify-center bg-black/80 p-3 sm:p-5 backdrop-blur-md animate-in fade-in duration-150"
    >
      <div
        className="nx-sheet relative flex h-[88vh] max-md:max-h-[92dvh] w-full max-w-5xl flex-col overflow-hidden rounded-2xl border shadow-2xl text-slate-200"
        style={
          {
            backgroundColor: bgColor,
            borderColor: `${accentColor}30`,
            '--nx-accent': accentColor,
          } as React.CSSProperties
        }
        onClick={(e) => e.stopPropagation()}
      >
        <SheetHandle onClose={onClose} />

        {/* Ambient Top Glow */}
        <div
          className="pointer-events-none absolute inset-x-0 top-0 h-40 opacity-20"
          style={{
            background: `radial-gradient(ellipse at top, ${accentColor} 0%, transparent 70%)`,
          }}
        />

        {/* Header */}
        <header className="flex shrink-0 flex-wrap items-center justify-between gap-2.5 border-b border-white/10 bg-white/[0.02] px-3.5 py-2.5 sm:gap-3 sm:px-5 sm:py-3.5">
          <div className="flex min-w-0 items-center gap-2.5 sm:gap-3">
            <div
              className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl border shadow-lg sm:h-10 sm:w-10"
              style={{
                backgroundColor: `${accentColor}18`,
                borderColor: `${accentColor}40`,
                color: accentColor,
              }}
            >
              <Rocket className="h-4 w-4 sm:h-5 sm:w-5" />
            </div>
            <div className="min-w-0">
              <div className="flex flex-wrap items-center gap-1.5 sm:gap-2">
                <h2 className="truncate text-xs font-bold text-white sm:text-sm">
                  1-Click Atomic Application Deployment
                </h2>
                <span className="hidden rounded-full border border-emerald-400/30 bg-emerald-500/10 px-2 py-0.5 text-[10px] font-semibold text-emerald-300 sm:inline-block">
                  Zero-Downtime Symlink
                </span>
              </div>
              <p className="hidden text-[11px] text-slate-400 sm:block">
                Clone into <code className="text-slate-300">releases/&lt;timestamp&gt;</code> · run
                hooks &amp; snippets with <code className="text-cyan-300">{'{{vars}}'}</code> · swap{' '}
                <code className="text-slate-300">current</code> · retain previous version &amp;
                prune old releases
              </p>
            </div>
          </div>

          <div className="flex shrink-0 items-center gap-1.5 sm:gap-2">
            <button
              type="button"
              onClick={handleRunDeploy}
              disabled={deploying}
              className="flex items-center gap-1.5 rounded-xl px-3 py-1.5 text-xs font-semibold text-black shadow-lg transition hover:brightness-110 disabled:opacity-50 sm:px-3.5 sm:py-2"
              style={{ backgroundColor: accentColor }}
            >
              {deploying ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
              ) : (
                <Play className="h-3.5 w-3.5 fill-current" />
              )}
              <span>{deploying ? 'Deploying…' : 'Deploy Now'}</span>
            </button>
            <button
              type="button"
              onClick={onClose}
              className="rounded-xl p-1.5 text-slate-400 hover:bg-white/10 hover:text-white transition sm:p-2"
            >
              <X className="h-4 w-4" />
            </button>
          </div>
        </header>

        {/* Body: Sidebar + Main Content */}
        <div className="flex min-h-0 flex-1 flex-col md:flex-row">
          {/* Left Sidebar: Saved Deployment Profiles */}
          <aside className="flex w-full shrink-0 flex-col border-b border-white/10 bg-black/25 md:w-64 md:border-b-0 md:border-r">
            <div className="flex items-center justify-between border-b border-white/10 px-3.5 py-2 sm:py-2.5">
              <span className="text-[11px] font-semibold uppercase tracking-wider text-slate-400">
                Deploy Profiles ({profiles.length})
              </span>
              <button
                type="button"
                onClick={() => {
                  const fresh = createNewProfile(defaultHostId, 'custom');
                  setSelectedId('');
                  syncInputsFromProfile(fresh);
                  setActiveTab('config');
                }}
                className="flex items-center gap-1 rounded-lg border border-white/10 bg-white/[0.05] px-2 py-1 text-[11px] font-medium text-slate-200 hover:bg-white/10 transition"
              >
                <Plus className="h-3 w-3" />
                <span>New</span>
              </button>
            </div>

            <div className="flex max-h-28 flex-col gap-1 overflow-y-auto p-2 md:max-h-none md:flex-1">
              {profiles.map((p) => {
                const active = p.id === selectedId;
                const hostLabel =
                  selectableHosts.find((h) => h.id === p.hostId)?.label || 'Local Machine';
                return (
                  <div
                    key={p.id}
                    onClick={() => handleSelectProfile(p)}
                    className={cn(
                      'group flex cursor-pointer items-center justify-between rounded-xl border px-3 py-2 text-left transition',
                      active
                        ? 'border-cyan-400/40 bg-cyan-400/10 text-white'
                        : 'border-transparent bg-white/[0.02] text-slate-300 hover:border-white/10 hover:bg-white/[0.05]'
                    )}
                  >
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-1.5">
                        <FolderGit2 className="h-3.5 w-3.5 shrink-0 text-cyan-400" />
                        <span className="truncate text-xs font-semibold">{p.name}</span>
                      </div>
                      <div className="mt-0.5 truncate text-[10px] text-slate-400">
                        {hostLabel} · <span className="font-mono">{p.branch}</span>
                      </div>
                    </div>
                    <button
                      type="button"
                      onClick={(e) => {
                        e.stopPropagation();
                        handleDeleteProfile(p);
                      }}
                      title="Delete profile"
                      className="ml-1 rounded p-1 text-slate-500 opacity-0 hover:bg-rose-500/15 hover:text-rose-300 group-hover:opacity-100 transition"
                    >
                      <Trash2 className="h-3 w-3" />
                    </button>
                  </div>
                );
              })}

              {profiles.length === 0 && (
                <div className="px-3 py-6 text-center text-xs text-slate-500">
                  No saved profiles yet. Configure your repository on the right and click Save or
                  Deploy Now.
                </div>
              )}
            </div>
          </aside>

          {/* Main Area */}
          <div className="flex min-h-0 flex-1 flex-col">
            {/* Sub-navigation Tabs */}
            <div className="flex shrink-0 items-center justify-between gap-2 border-b border-white/10 bg-white/[0.01] px-2 sm:px-4">
              <div className="flex min-w-0 flex-1 items-center gap-1 overflow-x-auto no-scrollbar">
                {[
                  { id: 'config' as const, label: '1. Configure & Hooks', icon: Settings2 },
                  { id: 'run' as const, label: '2. Deploy & Step Logs', icon: Sparkles },
                  {
                    id: 'releases' as const,
                    label: `3. Releases & Rollback${releaseState?.releases.length ? ` (${releaseState.releases.length})` : ''}`,
                    icon: History,
                  },
                ].map((t) => {
                  const Icon = t.icon;
                  const on = activeTab === t.id;
                  return (
                    <button
                      key={t.id}
                      type="button"
                      onClick={() => setActiveTab(t.id)}
                      className={cn(
                        'flex shrink-0 whitespace-nowrap items-center gap-1.5 border-b-2 px-2.5 py-2.5 text-xs font-semibold transition sm:px-3.5',
                        on
                          ? 'border-cyan-400 text-white'
                          : 'border-transparent text-slate-400 hover:text-slate-200'
                      )}
                    >
                      <Icon className="h-3.5 w-3.5" />
                      <span>{t.label}</span>
                    </button>
                  );
                })}
              </div>

              <div className="hidden shrink-0 items-center gap-1.5 py-1.5 sm:flex">
                <button
                  type="button"
                  onClick={handleCopyScript}
                  className="flex items-center gap-1 rounded-lg border border-white/10 bg-white/[0.04] px-2.5 py-1 text-[11px] font-medium text-slate-300 hover:bg-white/10 transition"
                >
                  {copiedScript ? (
                    <Check className="h-3 w-3 text-emerald-400" />
                  ) : (
                    <Copy className="h-3 w-3" />
                  )}
                  <span>{copiedScript ? 'Copied' : 'Copy Shell Script'}</span>
                </button>
                {onOpenTerminalWithCommand && (
                  <button
                    type="button"
                    onClick={handleSendToTerminal}
                    className="flex items-center gap-1 rounded-lg border border-cyan-400/30 bg-cyan-400/10 px-2.5 py-1 text-[11px] font-medium text-cyan-300 hover:bg-cyan-400/20 transition"
                  >
                    <Terminal className="h-3 w-3" />
                    <span>Run in Terminal</span>
                  </button>
                )}
              </div>
            </div>

            {/* Mobile script actions bar */}
            <div className="flex shrink-0 items-center justify-end gap-1.5 border-b border-white/10 bg-white/[0.01] px-3 py-1.5 sm:hidden">
              <button
                type="button"
                onClick={handleCopyScript}
                className="flex items-center gap-1 rounded-lg border border-white/10 bg-white/[0.04] px-2.5 py-1 text-[11px] font-medium text-slate-300 active:bg-white/10"
              >
                {copiedScript ? (
                  <Check className="h-3 w-3 text-emerald-400" />
                ) : (
                  <Copy className="h-3 w-3" />
                )}
                <span>{copiedScript ? 'Copied' : 'Copy Script'}</span>
              </button>
              {onOpenTerminalWithCommand && (
                <button
                  type="button"
                  onClick={handleSendToTerminal}
                  className="flex items-center gap-1 rounded-lg border border-cyan-400/30 bg-cyan-400/10 px-2.5 py-1 text-[11px] font-medium text-cyan-300 active:bg-cyan-400/20"
                >
                  <Terminal className="h-3 w-3" />
                  <span>Run in Terminal</span>
                </button>
              )}
            </div>

            {/* Tab 1: Configure & Hooks */}
            {activeTab === 'config' && (
              <div className="flex-1 space-y-5 overflow-y-auto p-5">
                {/* Framework Preset Picker */}
                <div>
                  <label className="mb-1.5 block text-[11px] font-semibold uppercase tracking-wider text-slate-400">
                    Application Preset Template
                  </label>
                  <div className="grid grid-cols-2 gap-2 sm:grid-cols-5">
                    {(Object.keys(DEPLOY_PRESETS) as DeployPresetKind[]).map((key) => {
                      const p = DEPLOY_PRESETS[key];
                      const on = draft.preset === key;
                      return (
                        <button
                          key={key}
                          type="button"
                          onClick={() => handleApplyPreset(key)}
                          className={cn(
                            'flex flex-col items-start rounded-xl border p-2.5 text-left transition',
                            on
                              ? 'border-cyan-400/50 bg-cyan-400/15 text-white'
                              : 'border-white/10 bg-white/[0.02] text-slate-300 hover:border-white/20 hover:bg-white/[0.05]'
                          )}
                        >
                          <span className="rounded bg-white/10 px-1.5 py-0.5 text-[9.5px] font-semibold text-cyan-300">
                            {p.badge}
                          </span>
                          <span className="mt-1.5 text-xs font-semibold leading-snug">
                            {p.label}
                          </span>
                        </button>
                      );
                    })}
                  </div>
                  <p className="mt-1.5 text-[11px] text-slate-400">
                    {DEPLOY_PRESETS[draft.preset]?.description}
                  </p>
                </div>

                {/* Core Target & Git Settings */}
                <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                  <div>
                    <label className="mb-1 block text-xs font-medium text-slate-300">
                      Profile Name
                    </label>
                    <input
                      className={inputCls}
                      placeholder="e.g. My App, Laravel API, Next.js Web, Docker Stack"
                      value={draft.name}
                      onChange={(e) => setDraft({ ...draft, name: e.target.value })}
                    />
                  </div>

                  <div>
                    <label className="mb-1 block text-xs font-medium text-slate-300">
                      Target SSH Host
                    </label>
                    <CustomSelect
                      value={draft.hostId}
                      onChange={(val) => setDraft({ ...draft, hostId: val })}
                      theme={activeTheme}
                      accentColor={accentColor}
                      placeholder="Select target host"
                      className="rounded-xl border-white/10 bg-black/40 px-3 py-2 text-xs"
                      options={selectableHosts.map((h) => ({
                        value: h.id,
                        label: h.label,
                        sublabel:
                          h.id === '__local__' ? 'local shell' : `${h.username}@${h.hostname}`,
                        icon:
                          h.id === '__local__' ? (
                            <Terminal className="h-3.5 w-3.5" style={{ color: accentColor }} />
                          ) : (
                            <Server className="h-3.5 w-3.5" style={{ color: accentColor }} />
                          ),
                      }))}
                    />
                  </div>

                  <div>
                    <label className="mb-1 block text-xs font-medium text-slate-300">
                      GitHub / Git Repository URL
                    </label>
                    <input
                      className={cn(inputCls, 'font-mono')}
                      placeholder="git@github.com:org/laravel-app.git or https://github.com/..."
                      value={draft.repoUrl}
                      onChange={(e) => setDraft({ ...draft, repoUrl: e.target.value })}
                    />
                  </div>

                  <div className="grid grid-cols-2 gap-2">
                    <div>
                      <label className="mb-1 block text-xs font-medium text-slate-300">
                        Branch / Tag
                      </label>
                      <div className="relative">
                        <GitBranch className="pointer-events-none absolute left-2.5 top-2.5 h-3.5 w-3.5 text-slate-500" />
                        <input
                          className={cn(inputCls, 'pl-8 font-mono')}
                          placeholder="main"
                          value={draft.branch}
                          onChange={(e) => setDraft({ ...draft, branch: e.target.value })}
                        />
                      </div>
                    </div>

                    <div>
                      <label
                        className="mb-1 block text-xs font-medium text-slate-300"
                        title="Keeps the newly deployed release + previous release(s), and deletes older release folders"
                      >
                        Keep Releases
                      </label>
                      <input
                        type="number"
                        min={2}
                        max={20}
                        className={cn(inputCls, 'font-mono')}
                        value={draft.keepReleases}
                        onChange={(e) =>
                          setDraft({
                            ...draft,
                            keepReleases: Math.max(2, Number(e.target.value) || 2),
                          })
                        }
                      />
                    </div>
                  </div>

                  <div>
                    <label className="mb-1 block text-xs font-medium text-slate-300">
                      Remote Base Directory (<code className="text-cyan-300">{'{{app_dir}}'}</code>)
                    </label>
                    <input
                      className={cn(inputCls, 'font-mono')}
                      placeholder="/var/www/myapp"
                      value={draft.appDir}
                      onChange={(e) => setDraft({ ...draft, appDir: e.target.value })}
                    />
                    <span className="mt-0.5 block text-[10px] text-slate-500">
                      Creates <code className="text-slate-400">{draft.appDir || '/var/www/app'}/releases/*</code>,{' '}
                      <code className="text-slate-400">shared/</code>, and live symlink{' '}
                      <code className="text-emerald-300">{draft.appDir || '/var/www/app'}/current</code>
                    </span>
                  </div>

                  <div className="grid grid-cols-2 gap-2">
                    <div>
                      <label className="mb-1 block text-xs font-medium text-slate-300">
                        Shared Files (comma-sep)
                      </label>
                      <input
                        className={cn(inputCls, 'font-mono')}
                        placeholder=".env"
                        value={sharedFilesInput}
                        onChange={(e) => setSharedFilesInput(e.target.value)}
                      />
                    </div>
                    <div>
                      <label className="mb-1 block text-xs font-medium text-slate-300">
                        Shared Folders (comma-sep)
                      </label>
                      <input
                        className={cn(inputCls, 'font-mono')}
                        placeholder="storage, uploads"
                        value={sharedDirsInput}
                        onChange={(e) => setSharedDirsInput(e.target.value)}
                      />
                    </div>
                  </div>
                </div>

                {/* Template Variables ({{var}}) */}
                <div className="rounded-xl border border-cyan-400/20 bg-cyan-400/[0.03] p-3.5">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <div>
                      <h3 className="text-xs font-semibold text-cyan-200">
                        Template Variables (<code className="font-mono">{'{{var}}'}</code>)
                      </h3>
                      <p className="text-[11px] text-slate-400">
                        Auto-injected:{' '}
                        {[...BUILTIN_RUNTIME_VARS].map((v) => (
                          <code
                            key={v}
                            className="mr-1 rounded bg-white/5 px-1 py-0.5 font-mono text-[10px] text-slate-300"
                          >
                            {`{{${v}}}`}
                          </code>
                        ))}
                      </p>
                    </div>
                  </div>

                  {detectedCustomVars.length > 0 && (
                    <div className="mt-3 grid grid-cols-1 gap-2.5 sm:grid-cols-3">
                      {detectedCustomVars.map((key) => (
                        <div key={key}>
                          <label className="mb-1 block font-mono text-[11px] text-cyan-300">
                            {`{{${key}}}`}
                          </label>
                          <input
                            className={cn(inputCls, 'font-mono')}
                            placeholder={`Value for ${key}`}
                            value={draft.variables[key] ?? ''}
                            onChange={(e) =>
                              setDraft({
                                ...draft,
                                variables: { ...draft.variables, [key]: e.target.value },
                              })
                            }
                          />
                        </div>
                      ))}
                    </div>
                  )}

                  <div className="mt-3 flex items-center gap-2">
                    <input
                      className={cn(inputCls, 'max-w-[160px] font-mono')}
                      placeholder="new_var_name"
                      value={customVarKey}
                      onChange={(e) =>
                        setCustomVarKey(e.target.value.replace(/[^a-zA-Z0-9_]/g, ''))
                      }
                    />
                    <input
                      className={cn(inputCls, 'flex-1 font-mono')}
                      placeholder="Default value"
                      value={customVarVal}
                      onChange={(e) => setCustomVarVal(e.target.value)}
                    />
                    <button
                      type="button"
                      disabled={!customVarKey.trim()}
                      onClick={() => {
                        const k = customVarKey.trim();
                        if (!k) return;
                        setDraft({
                          ...draft,
                          variables: { ...draft.variables, [k]: customVarVal },
                        });
                        setCustomVarKey('');
                        setCustomVarVal('');
                      }}
                      className="shrink-0 rounded-xl border border-cyan-400/30 bg-cyan-400/15 px-3 py-2 text-xs font-semibold text-cyan-200 hover:bg-cyan-400/25 disabled:opacity-40"
                    >
                      Add Variable
                    </button>
                  </div>
                </div>

                {/* Build Script & Attached Snippets */}
                <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
                  <div className="space-y-3 lg:col-span-2">
                    <div>
                      <label className="mb-1 block text-xs font-medium text-slate-300">
                        Pre-Swap Build Script (runs inside{' '}
                        <code className="text-cyan-300">{'{{release_dir}}'}</code>)
                      </label>
                      <textarea
                        rows={6}
                        className={cn(inputCls, 'font-mono leading-relaxed')}
                        placeholder="composer install --no-dev --optimize-autoloader&#10;php artisan migrate --force"
                        value={draft.buildScript}
                        onChange={(e) => setDraft({ ...draft, buildScript: e.target.value })}
                      />
                    </div>

                    <div>
                      <label className="mb-1 block text-xs font-medium text-slate-300">
                        Post-Swap Reload Hook (runs inside{' '}
                        <code className="text-emerald-300">{'{{current_dir}}'}</code> after symlink
                        swap)
                      </label>
                      <textarea
                        rows={2}
                        className={cn(inputCls, 'font-mono leading-relaxed')}
                        placeholder="php artisan queue:restart || true"
                        value={draft.postSwapScript}
                        onChange={(e) => setDraft({ ...draft, postSwapScript: e.target.value })}
                      />
                    </div>
                  </div>

                  {/* Attach Saved Vault Snippets */}
                  <div className="flex flex-col rounded-xl border border-white/10 bg-black/30 p-3">
                    <div className="flex items-center gap-1.5 pb-2">
                      <Code2 className="h-4 w-4 text-violet-300" />
                      <span className="text-xs font-semibold text-white">
                        Chain Saved Snippets ({draft.snippetIds.length})
                      </span>
                    </div>
                    <p className="mb-2 text-[11px] text-slate-400">
                      Select any saved snippets from your Vault to execute inside{' '}
                      <code className="text-slate-300">{'{{release_dir}}'}</code> before swapping
                      folders:
                    </p>
                    <div className="max-h-48 flex-1 space-y-1.5 overflow-y-auto pr-1">
                      {snippets.map((s) => {
                        const checked = draft.snippetIds.includes(s.id);
                        return (
                          <label
                            key={s.id}
                            className={cn(
                              'flex cursor-pointer items-start gap-2 rounded-lg border p-2 text-xs transition',
                              checked
                                ? 'border-violet-400/40 bg-violet-400/15 text-white'
                                : 'border-white/5 bg-white/[0.02] text-slate-300 hover:border-white/15'
                            )}
                          >
                            <input
                              type="checkbox"
                              checked={checked}
                              onChange={() => toggleSnippetAttachment(s.id)}
                              className="mt-0.5 accent-violet-400"
                            />
                            <div className="min-w-0 flex-1">
                              <div className="truncate font-medium">{s.name}</div>
                              <div className="truncate font-mono text-[10px] text-slate-400">
                                {s.command}
                              </div>
                            </div>
                          </label>
                        );
                      })}
                      {snippets.length === 0 && (
                        <div className="py-4 text-center text-[11px] text-slate-500">
                          No snippets saved yet.
                        </div>
                      )}
                    </div>
                  </div>
                </div>

                {/* Footer Save Action */}
                <div className="flex items-center justify-end gap-2 border-t border-white/10 pt-3">
                  <button
                    type="button"
                    onClick={handleSaveProfile}
                    className="rounded-xl border border-white/15 bg-white/[0.06] px-4 py-2 text-xs font-semibold text-white hover:bg-white/10 transition"
                  >
                    Save Profile
                  </button>
                  <button
                    type="button"
                    onClick={handleRunDeploy}
                    disabled={deploying}
                    className="flex items-center gap-1.5 rounded-xl px-4 py-2 text-xs font-semibold text-black shadow-lg hover:brightness-110 disabled:opacity-50 transition"
                    style={{ backgroundColor: accentColor }}
                  >
                    <Rocket className="h-3.5 w-3.5" />
                    <span>Save &amp; Deploy Release</span>
                  </button>
                </div>
              </div>
            )}

            {/* Tab 2: Live Deployment Step Logs */}
            {activeTab === 'run' && (
              <div className="flex-1 space-y-4 overflow-y-auto p-5">
                {deploying && (
                  <div className="flex items-center gap-3 rounded-xl border border-cyan-400/30 bg-cyan-400/10 p-4 text-xs text-cyan-200">
                    <Loader2 className="h-5 w-5 shrink-0 animate-spin text-cyan-300" />
                    <div>
                      <div className="font-semibold text-white">
                        Executing Atomic Release Deployment on{' '}
                        {selectableHosts.find((h) => h.id === parsedDraft.hostId)?.label}…
                      </div>
                      <div className="mt-0.5 text-[11px] text-slate-300">
                        Cloning {parsedDraft.repoUrl} ({parsedDraft.branch}) into a fresh{' '}
                        <code>{parsedDraft.appDir}/releases/&lt;timestamp&gt;</code> directory. Live{' '}
                        <code>current</code> symlink remains untouched until all build hooks pass.
                      </div>
                    </div>
                  </div>
                )}

                {!deploying && !runResult && (
                  <div className="flex flex-col items-center justify-center rounded-2xl border border-white/10 bg-black/20 py-14 text-center">
                    <Rocket className="h-8 w-8 text-slate-500" />
                    <p className="mt-2 text-xs font-medium text-slate-300">
                      {parsedDraft.name.trim()
                        ? `Ready to deploy “${parsedDraft.name.trim()}”`
                        : 'Configure a repository and click Deploy Now'}
                    </p>
                    <p className="mt-1 max-w-md text-[11px] text-slate-500">
                      Click <strong>Deploy Now</strong> above to clone into a new timestamped
                      release folder, run your build scripts &amp; snippets, swap folders, and
                      clean up older releases.
                    </p>
                  </div>
                )}

                {runResult && (
                  <div className="space-y-3">
                    <div
                      className={cn(
                        'flex items-center justify-between rounded-xl border p-4',
                        runResult.success
                          ? 'border-emerald-400/30 bg-emerald-500/10 text-emerald-200'
                          : 'border-rose-500/30 bg-rose-500/10 text-rose-200'
                      )}
                    >
                      <div className="flex items-center gap-2.5">
                        {runResult.success ? (
                          <CheckCircle2 className="h-5 w-5 shrink-0 text-emerald-400" />
                        ) : (
                          <XCircle className="h-5 w-5 shrink-0 text-rose-400" />
                        )}
                        <div>
                          <div className="text-xs font-bold text-white">
                            {runResult.success
                              ? `Deployment Complete — Active Release: ${runResult.releaseId}`
                              : 'Deployment Aborted — Live Production Symlink Untouched'}
                          </div>
                          <div className="text-[11px] opacity-85">
                            {runResult.error || `Target: ${runResult.releaseDir}`}
                          </div>
                        </div>
                      </div>
                      <button
                        type="button"
                        onClick={() => setActiveTab('releases')}
                        className="rounded-lg border border-white/15 bg-black/30 px-3 py-1.5 text-xs font-medium text-white hover:bg-black/50 transition"
                      >
                        View Releases
                      </button>
                    </div>

                    <div className="space-y-2.5">
                      {runResult.steps.map((st, idx) => (
                        <div
                          key={`${st.step}-${idx}`}
                          className="overflow-hidden rounded-xl border border-white/10 bg-black/40"
                        >
                          <div className="flex items-center justify-between border-b border-white/5 bg-white/[0.02] px-3.5 py-2">
                            <div className="flex items-center gap-2">
                              {st.status === 'ok' ? (
                                <CheckCircle2 className="h-4 w-4 text-emerald-400" />
                              ) : (
                                <XCircle className="h-4 w-4 text-rose-400" />
                              )}
                              <span className="text-xs font-semibold text-slate-200">
                                {st.title}
                              </span>
                            </div>
                            <span className="font-mono text-[10.5px] text-slate-400">
                              {st.durationMs}ms
                            </span>
                          </div>
                          {st.output.trim() && (
                            <pre className="max-h-56 overflow-auto p-3 font-mono text-[11px] leading-relaxed text-slate-300">
                              {st.output}
                            </pre>
                          )}
                        </div>
                      ))}
                    </div>
                  </div>
                )}
              </div>
            )}

            {/* Tab 3: Releases & 1-Click Rollback */}
            {activeTab === 'releases' && (
              <div className="flex-1 space-y-4 overflow-y-auto p-5">
                <div className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-white/10 bg-white/[0.02] p-3.5">
                  <div>
                    <div className="text-xs font-semibold text-white">
                      Release Directory:{' '}
                      <code className="font-mono text-cyan-300">
                        {parsedDraft.appDir}/releases
                      </code>
                    </div>
                    <div className="mt-0.5 text-[11px] text-slate-400">
                      Current live symlink:{' '}
                      <code className="font-mono text-emerald-300">
                        {releaseState?.currentReleaseId
                          ? `current → releases/${releaseState.currentReleaseId}`
                          : 'Not linked yet'}
                      </code>
                    </div>
                  </div>

                  <div className="flex items-center gap-2">
                    {releaseState?.previousReleaseId && (
                      <button
                        type="button"
                        disabled={!!rollingBack}
                        onClick={() => handleRollback(releaseState.previousReleaseId!)}
                        className="flex items-center gap-1.5 rounded-xl border border-amber-400/40 bg-amber-500/15 px-3 py-1.5 text-xs font-semibold text-amber-200 hover:bg-amber-500/25 disabled:opacity-50 transition"
                      >
                        {rollingBack ? (
                          <Loader2 className="h-3.5 w-3.5 animate-spin" />
                        ) : (
                          <RotateCcw className="h-3.5 w-3.5" />
                        )}
                        <span>
                          1-Click Rollback to Previous ({releaseState.previousReleaseId})
                        </span>
                      </button>
                    )}
                    <button
                      type="button"
                      onClick={() => refreshReleases()}
                      disabled={loadingReleases}
                      className="flex items-center gap-1 rounded-xl border border-white/10 bg-white/[0.04] px-3 py-1.5 text-xs text-slate-200 hover:bg-white/10 transition"
                    >
                      <RefreshCw
                        className={cn('h-3.5 w-3.5', loadingReleases && 'animate-spin')}
                      />
                      <span>Refresh</span>
                    </button>
                  </div>
                </div>

                {releaseError && (
                  <div className="flex items-center gap-2 rounded-xl border border-rose-500/30 bg-rose-500/10 p-3 text-xs text-rose-200">
                    <AlertTriangle className="h-4 w-4 shrink-0 text-rose-400" />
                    <span>{releaseError}</span>
                  </div>
                )}

                <div className="space-y-2">
                  {(releaseState?.releases || []).map((rel) => (
                    <div
                      key={rel.id}
                      className={cn(
                        'flex flex-wrap items-center justify-between gap-3 rounded-xl border p-3.5 transition',
                        rel.isCurrent
                          ? 'border-emerald-400/40 bg-emerald-500/[0.07]'
                          : 'border-white/10 bg-black/30'
                      )}
                    >
                      <div className="min-w-0 flex-1">
                        <div className="flex flex-wrap items-center gap-2">
                          <Layers className="h-4 w-4 text-cyan-400" />
                          <span className="font-mono text-xs font-bold text-white">{rel.id}</span>
                          {rel.isCurrent && (
                            <span className="rounded-full bg-emerald-500/20 px-2 py-0.5 text-[10px] font-bold uppercase text-emerald-300 ring-1 ring-emerald-400/40">
                              Live (current)
                            </span>
                          )}
                          {rel.isPrevious && (
                            <span className="rounded-full bg-amber-500/20 px-2 py-0.5 text-[10px] font-semibold uppercase text-amber-300 ring-1 ring-amber-400/30">
                              Previous Version (Kept)
                            </span>
                          )}
                          {rel.commit && rel.commit !== '-' && (
                            <span className="rounded bg-white/10 px-1.5 py-0.5 font-mono text-[10px] text-slate-300">
                              {rel.branch} @ {rel.commit}
                            </span>
                          )}
                        </div>
                        {rel.subject && (
                          <div className="mt-1 truncate text-xs text-slate-300">{rel.subject}</div>
                        )}
                        <div className="mt-0.5 font-mono text-[10.5px] text-slate-500">
                          {rel.path}
                        </div>
                      </div>

                      {!rel.isCurrent && (
                        <div className="flex items-center gap-1.5">
                          <button
                            type="button"
                            disabled={!!rollingBack}
                            onClick={() => handleRollback(rel.id)}
                            className="flex items-center gap-1 rounded-lg border border-amber-400/30 bg-amber-500/15 px-2.5 py-1.5 text-xs font-medium text-amber-200 hover:bg-amber-500/25 transition"
                          >
                            <RotateCcw className="h-3 w-3" />
                            <span>Activate / Rollback</span>
                          </button>
                          <button
                            type="button"
                            onClick={() => handleDeleteReleaseFolder(rel.id)}
                            title="Remove release folder"
                            className="rounded-lg border border-white/10 bg-white/[0.03] p-1.5 text-slate-400 hover:border-rose-500/30 hover:bg-rose-500/15 hover:text-rose-300 transition"
                          >
                            <Trash2 className="h-3.5 w-3.5" />
                          </button>
                        </div>
                      )}
                    </div>
                  ))}

                  {!loadingReleases && (releaseState?.releases.length ?? 0) === 0 && (
                    <div className="rounded-xl border border-white/10 bg-black/20 py-10 text-center text-xs text-slate-500">
                      No releases found in <code>{parsedDraft.appDir}/releases</code> yet. Run your
                      first deployment to populate this list.
                    </div>
                  )}
                </div>
              </div>
            )}
          </div>
        </div>
      </div>
    </ResponsiveOverlay>
  );
}
