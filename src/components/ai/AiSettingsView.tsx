import React, { useState } from 'react';
import {
  Sparkles,
  RefreshCw,
  Settings2,
  Key,
  Trash2,
  Plus,
  Check,
  ChevronDown,
  Layers,
  Scale,
  ShieldCheck,
  Eye,
  EyeOff,
  AlertCircle,
  X,
  ExternalLink,
  Globe,
  Network,
  History,
  MoreHorizontal,
  CheckCircle2,
} from 'lucide-react';
import {
  KNOWN_PROVIDERS,
  maskKey,
  maskProxyUrl,
  parseKeyBatch,
  parseProxyBatch,
  normalizeProxyUrl,
  type ProviderSpec,
} from '../../lib/ollama';
import { bridge } from '../../lib/bridge';
import type { AiBalanceStrategy, AiProviderConfig, Host, OpencodeHostStatus } from '../../lib/types';
import type { DrexiusTheme } from '../../lib/themes';
import { CustomSelect } from '../CustomSelect';
import { cn } from '../../utils/cn';
import { confirmDialog } from '../ConfirmDialog';
import { MobileSheet } from '../MobileSheet';
import { formatRelativeTime, type Msg, type SavedChatSession } from './aiSessionStorage';

export interface AiHeaderBarProps {
  msgs: Msg[];
  activeConfig: AiProviderConfig;
  mobile: boolean;
  theme?: DrexiusTheme;
  startNewChat: () => void;
  showHistory: boolean;
  setShowHistory: React.Dispatch<React.SetStateAction<boolean>>;
  historyRef: React.RefObject<HTMLDivElement | null>;
  hostSessionCount: number;
  allSessionCount: number;
  displaySessions: SavedChatSession[];
  sessionFilter: 'host' | 'all';
  setSessionFilter: React.Dispatch<React.SetStateAction<'host' | 'all'>>;
  currentHostLabel: string;
  currentSessionId: string;
  handleSelectSession: (session: SavedChatSession) => void;
  handleDeleteSession: (sessionId: string) => void;
  handleClearSessions: () => void;
  showCfg: boolean;
  setShowCfg: React.Dispatch<React.SetStateAction<boolean>>;
  onClose?: () => void;
}

export function AiHeaderBar({
  msgs,
  activeConfig,
  mobile,
  theme,
  startNewChat,
  showHistory,
  setShowHistory,
  historyRef,
  hostSessionCount,
  allSessionCount,
  displaySessions,
  sessionFilter,
  setSessionFilter,
  currentHostLabel,
  currentSessionId,
  handleSelectSession,
  handleDeleteSession,
  handleClearSessions,
  showCfg,
  setShowCfg,
  onClose,
}: AiHeaderBarProps) {
  return (
    <div className="flex items-center justify-between border-b border-white/5 px-3 py-2 sm:px-3.5 sm:py-2.5 bg-transparent shrink-0 min-w-0">
      <div className="flex items-center gap-2 min-w-0 flex-1 mr-2">
        <div className="h-6 w-6 rounded-lg bg-cyan-500/10 border border-cyan-500/20 flex items-center justify-center shrink-0">
          <Sparkles className="h-3.5 w-3.5 text-cyan-400" />
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-1.5 min-w-0">
            <span className="truncate text-xs font-semibold text-slate-200">
              {msgs.length > 0
                ? msgs[0].content.slice(0, 24) + (msgs[0].content.length > 24 ? '…' : '')
                : 'AI Assistant'}
            </span>
            {activeConfig.providerId === 'opencode' && (
              <span className="hidden sm:inline-flex items-center gap-0.5 rounded px-1.5 py-0.2 text-[9.5px] font-medium bg-emerald-500/10 text-emerald-400 border border-emerald-500/20">
                Free
              </span>
            )}
          </div>
          {mobile && (
            <span className="block truncate text-[10px] text-slate-400 font-mono">
              {(activeConfig.selectedModel || activeConfig.name).replace(/^opencode\//, '')}
            </span>
          )}
        </div>
      </div>

      <div className="flex items-center gap-0.5 sm:gap-1 text-slate-400 shrink-0">
        <button
          onClick={startNewChat}
          className="p-1.5 sm:p-2 hover:text-white rounded-lg hover:bg-white/5 transition"
          title="New Chat (Clear thread)"
        >
          <Plus className="w-3.5 h-3.5 sm:w-4 sm:h-4" />
        </button>

        <div className="relative" ref={historyRef}>
          <button
            onClick={() => setShowHistory(!showHistory)}
            className={cn(
              'p-1.5 sm:p-2 hover:text-white rounded-lg hover:bg-white/5 transition relative',
              showHistory && 'text-white bg-white/10'
            )}
            title="Saved Chat Sessions"
          >
            <History className="w-3.5 h-3.5 sm:w-4 sm:h-4" />
            {hostSessionCount > 0 && (
              <span className="absolute top-1 right-1 flex h-1.5 w-1.5 rounded-full bg-cyan-400" />
            )}
          </button>
          {showHistory && (
            <div
              style={{ background: theme?.xterm?.background ?? '#0d1117' }}
              className="absolute right-0 top-full mt-1.5 z-50 w-80 max-w-[calc(100vw-2rem)] rounded-xl border border-white/15 p-2.5 shadow-2xl backdrop-blur-md text-left flex flex-col gap-2"
            >
              <div className="flex items-center justify-between border-b border-white/10 pb-2 px-1">
                <div className="flex items-center gap-1.5">
                  <History className="w-3.5 h-3.5 text-cyan-400" />
                  <span className="text-[11px] font-semibold uppercase tracking-wider text-slate-200">
                    Chat Sessions
                  </span>
                </div>
                {displaySessions.length > 0 && (
                  <button
                    onClick={handleClearSessions}
                    className="text-[10px] text-rose-400 hover:text-rose-300 px-1.5 py-0.5 rounded hover:bg-rose-500/10 transition flex items-center gap-1"
                    title={
                      sessionFilter === 'host'
                        ? `Clear sessions for ${currentHostLabel}`
                        : 'Clear all sessions'
                    }
                  >
                    <Trash2 className="w-2.5 h-2.5" />
                    Clear {sessionFilter === 'host' ? 'Host' : 'All'}
                  </button>
                )}
              </div>

              {/* Host filter & indicator */}
              <div className="flex items-center justify-between gap-1 px-1">
                <div className="flex items-center gap-1 bg-white/5 p-0.5 rounded-lg text-[10px]">
                  <button
                    onClick={() => setSessionFilter('host')}
                    className={cn(
                      'px-2 py-0.5 rounded-md transition font-medium',
                      sessionFilter === 'host'
                        ? 'bg-cyan-500/20 text-cyan-300 shadow-sm'
                        : 'text-slate-400 hover:text-white'
                    )}
                  >
                    This Host ({hostSessionCount})
                  </button>
                  <button
                    onClick={() => setSessionFilter('all')}
                    className={cn(
                      'px-2 py-0.5 rounded-md transition font-medium',
                      sessionFilter === 'all'
                        ? 'bg-cyan-500/20 text-cyan-300 shadow-sm'
                        : 'text-slate-400 hover:text-white'
                    )}
                  >
                    All Hosts ({allSessionCount})
                  </button>
                </div>
                <span
                  className="text-[9px] text-slate-400 truncate max-w-[110px] font-mono text-right"
                  title={currentHostLabel}
                >
                  {currentHostLabel}
                </span>
              </div>

              {/* Session list */}
              <div className="max-h-60 space-y-1 overflow-y-auto pr-0.5">
                {displaySessions.map((s) => (
                  <div
                    key={s.id}
                    onClick={() => handleSelectSession(s)}
                    className={cn(
                      'group relative flex flex-col gap-1 p-2 rounded-lg border text-left cursor-pointer transition select-none',
                      s.id === currentSessionId && msgs.length > 0
                        ? 'bg-cyan-500/15 border-cyan-500/40 text-cyan-200'
                        : 'bg-white/[0.03] hover:bg-white/[0.08] border-white/5 hover:border-white/10 text-slate-300'
                    )}
                  >
                    <div className="flex items-start justify-between gap-2">
                      <span className="text-xs font-medium text-slate-200 group-hover:text-white truncate">
                        {s.title || 'Untitled Session'}
                      </span>
                      <button
                        onClick={(e) => {
                          e.stopPropagation();
                          handleDeleteSession(s.id);
                        }}
                        className="opacity-0 group-hover:opacity-100 p-1 rounded hover:bg-rose-500/20 text-slate-400 hover:text-rose-400 transition shrink-0"
                        title="Delete session"
                      >
                        <Trash2 className="w-3 h-3" />
                      </button>
                    </div>
                    <div className="flex items-center gap-2 text-[10px] text-slate-400">
                      <span className="truncate max-w-[120px] font-mono px-1 py-0.5 rounded bg-white/5 text-slate-300 border border-white/5">
                        {s.hostLabel || s.hostId}
                      </span>
                      <span>
                        {s.messages.length} msg{s.messages.length === 1 ? '' : 's'}
                      </span>
                      <span className="ml-auto text-slate-500">
                        {formatRelativeTime(s.updatedAt || s.createdAt)}
                      </span>
                    </div>
                  </div>
                ))}

                {displaySessions.length === 0 && (
                  <div className="py-6 text-center text-xs text-slate-500 flex flex-col items-center justify-center gap-1">
                    <History className="w-5 h-5 text-slate-600 mb-0.5 opacity-60" />
                    <span className="text-slate-400 font-medium">No saved sessions</span>
                    <span className="text-[10px] text-slate-500">
                      {sessionFilter === 'host'
                        ? `No chats saved for ${currentHostLabel}`
                        : 'No chat history across any hosts'}
                    </span>
                  </div>
                )}
              </div>

              {/* Footer */}
              <div className="pt-1.5 border-t border-white/10 flex items-center justify-between text-[9px] text-slate-500 px-1">
                <span>Cleaned if inactive &gt; 7 days</span>
                <button
                  onClick={startNewChat}
                  className="text-cyan-400 hover:text-cyan-300 flex items-center gap-1 font-medium"
                >
                  <Plus className="w-2.5 h-2.5" />
                  New Chat
                </button>
              </div>
            </div>
          )}
        </div>

        <button
          onClick={() => setShowCfg(!showCfg)}
          className={cn(
            'p-1.5 sm:p-2 hover:text-white rounded-lg hover:bg-white/5 transition',
            showCfg && 'text-cyan-400 bg-white/10'
          )}
          title="AI Routing, Keys & Proxy Settings"
        >
          <MoreHorizontal className="w-3.5 h-3.5 sm:w-4 sm:h-4" />
        </button>

        {onClose && (
          <button
            onClick={onClose}
            className="p-1.5 sm:p-2 hover:text-white rounded-lg hover:bg-white/5 transition"
            title="Close AI Panel"
          >
            <X className="w-3.5 h-3.5 sm:w-4 sm:h-4" />
          </button>
        )}
      </div>
    </div>
  );
}

export interface AiSettingsViewProps {
  theme?: DrexiusTheme;
  activeConfig: AiProviderConfig;
  activeSpec?: ProviderSpec;
  activeProviderId: string;
  opencodeInstalled: boolean | null;
  hostOpencodeStatus: OpencodeHostStatus | null;
  probingHostOpencode: boolean;
  probing: boolean;
  availableModels: string[];
  hosts: Host[];
  activeSshHostId: string | null;
  effectiveSshHostId: string | null | undefined;
  effectiveSshHost?: Host;
  sshTunnelPort: number | null;
  sshTunneling: boolean;
  sshTunnelError: string | null;
  contextLines: number;
  setContextLines: React.Dispatch<React.SetStateAction<number>>;
  scrubSecrets: boolean;
  toggleScrubSecrets: () => void;
  setShowCfg: React.Dispatch<React.SetStateAction<boolean>>;
  switchProvider: (providerId: string) => void;
  probe: (cfgToProbe?: AiProviderConfig, isUserAction?: boolean) => Promise<void>;
  probeHostOpencode: (force?: boolean) => Promise<void>;
  installOnRemoteHost: () => void;
  handleSelectModel: (modelName: string) => void;
  saveConfig: (updated: AiProviderConfig) => Promise<void>;
  getEffectiveConfig: (cfg?: AiProviderConfig) => AiProviderConfig;
  runListOp: (op: () => Promise<AiProviderConfig>) => Promise<AiProviderConfig | null>;
  toast: (m: string) => void;
}

export function AiSettingsView({
  theme,
  activeConfig,
  activeSpec,
  activeProviderId,
  opencodeInstalled,
  hostOpencodeStatus,
  probingHostOpencode,
  probing,
  availableModels,
  hosts,
  activeSshHostId,
  effectiveSshHostId,
  effectiveSshHost,
  sshTunnelPort,
  sshTunneling,
  sshTunnelError,
  contextLines,
  setContextLines,
  scrubSecrets,
  toggleScrubSecrets,
  setShowCfg,
  switchProvider,
  probe,
  probeHostOpencode,
  installOnRemoteHost,
  handleSelectModel,
  saveConfig,
  getEffectiveConfig,
  runListOp,
  toast,
}: AiSettingsViewProps) {
  const [keyInputMode, setKeyInputMode] = useState<'single' | 'batch'>('single');
  const [singleKeyInput, setSingleKeyInput] = useState('');
  const [batchKeyInput, setBatchKeyInput] = useState('');
  const [showKeySecret, setShowKeySecret] = useState(false);

  const [proxyInputMode, setProxyInputMode] = useState<'single' | 'batch'>('single');
  const [singleProxyInput, setSingleProxyInput] = useState('');
  const [batchProxyInput, setBatchProxyInput] = useState('');

  const handleAddSingleKey = async () => {
    const key = singleKeyInput.trim();
    if (!key) return;
    const before = activeConfig.apiKeys.length;
    const updated = await runListOp(() => bridge.addAiKeys(activeConfig, [key]));
    if (!updated) return;
    if (updated.apiKeys.length === before) {
      toast('Key already in pool');
      return;
    }
    setSingleKeyInput('');
    toast(`Added key to ${activeConfig.name} pool`);
    probe(updated);
  };

  const handleAddBatchKeys = async () => {
    const parsed = parseKeyBatch(batchKeyInput);
    if (parsed.length === 0) {
      toast('No valid keys found in input');
      return;
    }
    const before = activeConfig.apiKeys.length;
    const updated = await runListOp(() => bridge.addAiKeys(activeConfig, parsed));
    if (!updated) return;
    const added = updated.apiKeys.length - before;
    if (added <= 0) {
      toast('All entered keys are already in pool');
      return;
    }
    setBatchKeyInput('');
    toast(`Added ${added} new keys to pool (total: ${updated.apiKeys.length})`);
    probe(updated);
  };

  const handleRemoveKey = async (index: number) => {
    const updated = await runListOp(() => bridge.removeAiKey(activeConfig.providerId, index));
    if (updated) toast('Key removed from pool');
  };

  const handleClearAllKeys = async () => {
    if (
      await confirmDialog({
        title: `Clear all ${activeConfig.apiKeys.length} keys for ${activeConfig.name}?`,
        confirmLabel: 'Clear keys',
        danger: true,
      })
    ) {
      const updated = await runListOp(() => bridge.clearAiKeys(activeConfig.providerId));
      if (updated) toast('All keys cleared');
    }
  };

  const handleStrategyChange = (strategy: AiBalanceStrategy) => {
    const updated: AiProviderConfig = { ...activeConfig, balanceStrategy: strategy };
    saveConfig(updated);
    toast(`Load balancing strategy set to ${strategy.toUpperCase()}`);
  };

  const handleToggleUseProxies = (enabled: boolean) => {
    const updated: AiProviderConfig = { ...activeConfig, useProxies: enabled };
    saveConfig(updated);
    toast(
      enabled
        ? `Proxy routing enabled for ${activeConfig.name}`
        : `Proxy routing disabled for ${activeConfig.name}`
    );
    probe(updated);
  };

  const handleProxyStrategyChange = (strategy: AiBalanceStrategy) => {
    const updated: AiProviderConfig = { ...activeConfig, proxyStrategy: strategy };
    saveConfig(updated);
    toast(`Proxy balancing strategy set to ${strategy.toUpperCase()}`);
  };

  const handleAddSingleProxy = async () => {
    const raw = singleProxyInput.trim();
    if (!raw) return;
    const normalized = normalizeProxyUrl(raw);
    if (!normalized) {
      toast('Invalid proxy. Enter host:port, host:port:user:pass, or http://... / socks5://...');
      return;
    }
    const before = (activeConfig.proxyUrls ?? []).length;
    const updated = await runListOp(() => bridge.addAiProxies(activeConfig, [normalized]));
    if (!updated) return;
    if ((updated.proxyUrls ?? []).length === before) {
      toast('Proxy already in pool');
      return;
    }
    setSingleProxyInput('');
    toast(`Added proxy to ${activeConfig.name} pool`);
    if (updated.useProxies) probe(updated);
  };

  const handleAddBatchProxies = async () => {
    const parsed = parseProxyBatch(batchProxyInput);
    if (parsed.length === 0) {
      toast('No valid proxy URLs found (formats: host:port, host:port:user:pass, or http/socks5://...)');
      return;
    }
    const before = (activeConfig.proxyUrls ?? []).length;
    const updated = await runListOp(() => bridge.addAiProxies(activeConfig, parsed));
    if (!updated) return;
    const added = (updated.proxyUrls ?? []).length - before;
    if (added <= 0) {
      toast('All entered proxies are already in pool');
      return;
    }
    setBatchProxyInput('');
    toast(`Added ${added} proxies to pool (total: ${updated.proxyUrls?.length})`);
    if (updated.useProxies) probe(updated);
  };

  const handleRemoveProxy = async (index: number) => {
    const updated = await runListOp(() => bridge.removeAiProxy(activeConfig.providerId, index));
    if (updated) toast('Proxy removed from pool');
  };

  const handleClearAllProxies = async () => {
    const count = (activeConfig.proxyUrls ?? []).length;
    if (
      await confirmDialog({
        title: `Clear all ${count} proxies for ${activeConfig.name}?`,
        confirmLabel: 'Clear proxies',
        danger: true,
      })
    ) {
      const updated = await runListOp(() => bridge.clearAiProxies(activeConfig.providerId));
      if (updated) toast('All proxies cleared');
    }
  };

  const handleToggleAutoSshProxy = (enabled: boolean) => {
    const updated: AiProviderConfig = { ...activeConfig, autoSshProxy: enabled };
    saveConfig(updated);
    toast(enabled ? 'Auto SSH Dynamic Proxy enabled' : 'Auto SSH Dynamic Proxy disabled');
    if (enabled) {
      probe(getEffectiveConfig(updated));
    }
  };

  const handleSelectAutoSshHost = (hostId: string | undefined) => {
    const updated: AiProviderConfig = { ...activeConfig, autoSshHostId: hostId || undefined };
    saveConfig(updated);
    toast(hostId ? 'SSH AI proxy target host updated' : 'SSH AI proxy set to follow active terminal');
    if (activeConfig.autoSshProxy) {
      probe(getEffectiveConfig(updated));
    }
  };

  return (
    <div
      style={{ background: theme?.xterm?.background ?? '#0a0d14' }}
      className="max-h-96 space-y-3.5 overflow-y-auto border-b border-white/10 p-4 shadow-xl"
    >
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-1.5 text-xs font-semibold text-white">
          <Settings2 className="h-4 w-4 text-cyan-400" />
          <span>{activeConfig.name} Configuration & Key Pooling</span>
        </div>
        <button
          onClick={() => setShowCfg(false)}
          className="rounded p-1 text-slate-400 hover:bg-white/10 hover:text-white"
        >
          <X className="h-3.5 w-3.5" />
        </button>
      </div>

      {/* AI Provider Switcher */}
      <div className="space-y-1.5">
        <label className="text-[10px] uppercase tracking-wider text-slate-400">AI Provider</label>
        <div className="grid grid-cols-2 sm:grid-cols-3 gap-1.5">
          {KNOWN_PROVIDERS.map((p) => {
            const isSelected = p.id === activeProviderId;
            const isOpencode = p.id === 'opencode';
            return (
              <button
                key={p.id}
                type="button"
                onClick={() => switchProvider(p.id)}
                className={cn(
                  'flex items-center justify-between rounded-lg border px-2.5 py-1.5 text-xs text-left transition cursor-pointer',
                  isSelected
                    ? 'border-cyan-500/50 bg-cyan-500/20 text-cyan-200 font-semibold'
                    : 'border-white/10 bg-white/[0.02] text-slate-300 hover:border-white/20 hover:bg-white/5'
                )}
              >
                <span className="truncate">{p.name.replace(/ \(.*\)/, '')}</span>
                {isOpencode && opencodeInstalled && (
                  <span className="shrink-0 rounded bg-emerald-500/20 px-1 py-0.5 text-[9px] font-semibold text-emerald-300 border border-emerald-500/30">
                    Free
                  </span>
                )}
              </button>
            );
          })}
        </div>
      </div>

      {/* Model Switcher */}
      <div className="space-y-1.5">
        <div className="flex items-center justify-between">
          <label className="text-[10px] uppercase tracking-wider text-slate-400">Selected Model</label>
          <button
            type="button"
            onClick={() => probe(activeConfig, true)}
            disabled={probing}
            className="flex items-center gap-1 text-[10px] text-cyan-400 hover:text-cyan-300 disabled:opacity-50 cursor-pointer"
            title="Refresh models from provider"
          >
            <RefreshCw className={cn('h-2.5 w-2.5', probing && 'animate-spin')} />
            {probing ? 'Probing…' : 'Fetch live'}
          </button>
        </div>
        <CustomSelect
          value={activeConfig.selectedModel}
          onChange={(val) => handleSelectModel(val)}
          options={availableModels.map((m) => {
            const isOpencode = activeConfig.providerId === 'opencode';
            const isFree =
              isOpencode &&
              (m.startsWith('opencode/') ||
                m.endsWith('-free') ||
                m.includes(':free') ||
                m.includes('/free') ||
                m === 'opencode/big-pickle');
            return {
              value: m,
              label: isFree ? `⚡ [Free] ${m}` : m,
            };
          })}
          theme={theme}
        />
      </div>

      {/* OpenCode Free Information Banner */}
      {activeConfig.providerId === 'opencode' &&
        (() => {
          const isRemoteActive = hostOpencodeStatus?.isRemote && hostOpencodeStatus.installed;
          const isLocalActive = opencodeInstalled;

          if (isRemoteActive) {
            return (
              <div className="space-y-2 rounded-lg border border-emerald-500/20 bg-emerald-500/10 p-3 text-xs">
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2 font-medium text-emerald-300">
                    <CheckCircle2 className="h-4 w-4 text-emerald-400 shrink-0" />
                    <span>Remote OpenCode Active on {hostOpencodeStatus.hostLabel}</span>
                  </div>
                  <button
                    type="button"
                    onClick={() => probeHostOpencode(true)}
                    className="p-1 rounded hover:bg-white/10 text-emerald-300 hover:text-white transition cursor-pointer flex items-center gap-1 text-[10px]"
                    title="Re-check host"
                  >
                    <RefreshCw className={cn('h-3 w-3', probingHostOpencode && 'animate-spin')} />
                    <span>Re-check</span>
                  </button>
                </div>
                <p className="text-[11px] leading-relaxed text-emerald-200/80">
                  OpenCode CLI is detected and running natively on remote host{' '}
                  <strong className="text-white">{hostOpencodeStatus.hostLabel}</strong>. DrexiusTerminal routes AI
                  queries and tool execution directly through the remote OpenCode runtime with zero configuration and no
                  API keys required.
                </p>
              </div>
            );
          }

          if (isLocalActive) {
            return (
              <div className="space-y-2 rounded-lg border border-emerald-500/20 bg-emerald-500/10 p-3 text-xs">
                <div className="flex items-center gap-2 font-medium text-emerald-300">
                  <CheckCircle2 className="h-4 w-4 text-emerald-400 shrink-0" />
                  <span>OpenCode Free Frontier Models (Local Runtime)</span>
                </div>
                <p className="text-[11px] leading-relaxed text-emerald-200/80">
                  OpenCode CLI is detected on your local system. DrexiusTerminal routes directly through your local
                  OpenCode runtime to access zero-cost hosted models (Nemotron-3 Ultra, Muse Spark, Ling 3.1 Flash,
                  etc.) with no API keys or subscription needed.
                </p>
              </div>
            );
          }

          return (
            <div className="space-y-2 rounded-lg border border-amber-500/25 bg-amber-500/10 p-3 text-xs">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2 font-medium text-amber-300">
                  <AlertCircle className="h-4 w-4 text-amber-400 shrink-0" />
                  <span>
                    {hostOpencodeStatus?.isRemote
                      ? `OpenCode not on ${hostOpencodeStatus.hostLabel}`
                      : 'OpenCode CLI Not Detected'}
                  </span>
                </div>
                {hostOpencodeStatus?.isRemote && (
                  <button
                    type="button"
                    onClick={installOnRemoteHost}
                    className="px-2 py-0.5 rounded bg-amber-500/20 hover:bg-amber-500/30 text-amber-300 hover:text-white font-medium text-[10px] transition cursor-pointer flex items-center gap-1 shrink-0"
                    title="Run curl installer on remote host terminal"
                  >
                    <Sparkles className="h-3 w-3" />
                    Install on Host
                  </button>
                )}
              </div>
              <p className="text-[11px] leading-relaxed text-amber-200/80">
                {hostOpencodeStatus?.isRemote
                  ? `OpenCode CLI was not detected on remote host "${hostOpencodeStatus.hostLabel}". Run the command below in your host terminal to install OpenCode and unlock free frontier models:`
                  : 'OpenCode CLI was not detected on your system. Run the command below in your terminal to install OpenCode and unlock free frontier models:'}
              </p>
              <div className="mt-2 rounded bg-black/40 p-2 font-mono text-[11px] text-cyan-300 select-all border border-white/5">
                curl -fsSL https://opencode.ai/install.sh | bash
              </div>
            </div>
          );
        })()}

      {/* Endpoint Base URL */}
      {activeConfig.providerId !== 'opencode' && (
        <div className="space-y-1">
          <div className="flex items-center justify-between">
            <label className="text-[10px] uppercase tracking-wider text-slate-400">Endpoint Base URL</label>
            {activeSpec && activeConfig.baseUrl !== activeSpec.defaultBaseUrl && (
              <button
                onClick={() => saveConfig({ ...activeConfig, baseUrl: activeSpec.defaultBaseUrl })}
                className="text-[10px] text-cyan-400 hover:underline"
              >
                Reset to default
              </button>
            )}
          </div>
          <input
            value={activeConfig.baseUrl}
            onChange={(e) => saveConfig({ ...activeConfig, baseUrl: e.target.value })}
            className="w-full rounded border border-white/10 bg-white/[0.04] px-2.5 py-1.5 font-mono text-[11px] text-slate-200 focus:border-cyan-400/40 focus:outline-none"
          />
        </div>
      )}

      {/* Key Management (for providers supporting keys) */}
      {activeSpec?.supportsKeyPool && (
        <div className="space-y-2.5 rounded-lg border border-white/10 bg-white/[0.03] p-3">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-1.5 text-xs font-medium text-slate-200">
              <Key className="h-3.5 w-3.5 text-amber-400" />
              <span>API Key Pool ({activeConfig.apiKeys.length} configured)</span>
            </div>
            {activeConfig.apiKeys.length > 0 && (
              <button onClick={handleClearAllKeys} className="text-[10.5px] text-rose-400 hover:text-rose-300">
                Clear all
              </button>
            )}
          </div>

          {/* Load Balancing Strategy Selector */}
          <div className="space-y-1">
            <label className="flex items-center gap-1 text-[10px] uppercase tracking-wider text-slate-400">
              <Scale className="h-3 w-3 text-cyan-400" />
              Load Balancing Strategy
            </label>
            <div className="grid grid-cols-3 gap-1.5">
              {(['p2c', 'round_robin', 'random'] as AiBalanceStrategy[]).map((strat) => (
                <button
                  key={strat}
                  onClick={() => handleStrategyChange(strat)}
                  className={cn(
                    'rounded border px-2 py-1 text-center text-[10.5px] font-medium transition',
                    activeConfig.balanceStrategy === strat
                      ? 'border-cyan-400/50 bg-cyan-400/15 text-cyan-200'
                      : 'border-white/5 bg-white/[0.02] text-slate-400 hover:bg-white/5 hover:text-slate-200'
                  )}
                >
                  {strat === 'p2c' ? 'P2C (Smart)' : strat === 'round_robin' ? 'Round Robin' : 'Random'}
                </button>
              ))}
            </div>
            <p className="text-[10px] text-slate-500">
              {activeConfig.balanceStrategy === 'p2c' &&
                'P2C (Power of Two Choices) dynamically chooses the key with lowest active load and least rate-limit pressure.'}
              {activeConfig.balanceStrategy === 'round_robin' &&
                'Sequentially rotates requests evenly across all pooled keys.'}
              {activeConfig.balanceStrategy === 'random' &&
                'Selects a random key from the active pool for each request.'}
            </p>
          </div>

          {/* List of Current Pooled Keys */}
          {activeConfig.apiKeys.length > 0 && (
            <div className="max-h-28 space-y-1 overflow-y-auto pr-1">
              {activeConfig.apiKeys.map((k, i) => (
                <div
                  key={i}
                  className="flex items-center justify-between rounded border border-white/5 bg-white/[0.02] px-2.5 py-1 text-xs"
                >
                  <div className="flex items-center gap-2">
                    <span className="rounded bg-white/10 px-1 py-0.2 font-mono text-[9px] text-slate-400">
                      #{i + 1}
                    </span>
                    <span className="font-mono text-[11px] text-slate-300">{maskKey(k)}</span>
                  </div>
                  <button
                    onClick={() => handleRemoveKey(i)}
                    title="Remove key"
                    className="rounded p-1 text-slate-500 hover:bg-rose-500/20 hover:text-rose-300"
                  >
                    <Trash2 className="h-3 w-3" />
                  </button>
                </div>
              ))}
            </div>
          )}

          {/* Add Key Input (Single vs Batch Tabs) */}
          <div className="border-t border-white/10 pt-2">
            <div className="mb-2 flex gap-2">
              <button
                onClick={() => setKeyInputMode('single')}
                className={cn(
                  'text-[11px] font-medium transition',
                  keyInputMode === 'single'
                    ? 'text-cyan-300 underline underline-offset-4'
                    : 'text-slate-500 hover:text-slate-300'
                )}
              >
                Add Single Key
              </button>
              <span className="text-slate-600">·</span>
              <button
                onClick={() => setKeyInputMode('batch')}
                className={cn(
                  'text-[11px] font-medium transition',
                  keyInputMode === 'batch'
                    ? 'text-cyan-300 underline underline-offset-4'
                    : 'text-slate-500 hover:text-slate-300'
                )}
              >
                Batch Add Multiple Keys
              </button>
            </div>

            {keyInputMode === 'single' ? (
              <div className="flex gap-1.5">
                <div className="relative flex-1">
                  <input
                    type={showKeySecret ? 'text' : 'password'}
                    value={singleKeyInput}
                    onChange={(e) => setSingleKeyInput(e.target.value)}
                    onKeyDown={(e) => e.key === 'Enter' && handleAddSingleKey()}
                    placeholder={`Paste ${activeConfig.name} API key…`}
                    className="w-full rounded border border-white/10 bg-white/[0.04] px-2.5 py-1.5 pr-8 font-mono text-[11px] text-slate-200 placeholder:text-slate-600 focus:outline-none"
                  />
                  <button
                    type="button"
                    onClick={() => setShowKeySecret((v) => !v)}
                    className="absolute right-2 top-2 text-slate-500 hover:text-slate-300"
                  >
                    {showKeySecret ? <EyeOff className="h-3 w-3" /> : <Eye className="h-3 w-3" />}
                  </button>
                </div>
                <button
                  onClick={handleAddSingleKey}
                  disabled={!singleKeyInput.trim()}
                  className="flex items-center gap-1 rounded bg-cyan-500/20 px-3 py-1.5 text-xs font-semibold text-cyan-300 hover:bg-cyan-500/30 disabled:opacity-40"
                >
                  <Plus className="h-3 w-3" /> Add
                </button>
              </div>
            ) : (
              <div className="space-y-1.5">
                <textarea
                  rows={3}
                  value={batchKeyInput}
                  onChange={(e) => setBatchKeyInput(e.target.value)}
                  placeholder="Paste multiple keys here (one key per line or separated by commas)..."
                  className="w-full resize-none rounded border border-white/10 bg-white/[0.04] px-2.5 py-1.5 font-mono text-[11px] text-slate-200 placeholder:text-slate-600 focus:outline-none"
                />
                <div className="flex justify-end">
                  <button
                    onClick={handleAddBatchKeys}
                    disabled={!batchKeyInput.trim()}
                    className="flex items-center gap-1 rounded bg-gradient-to-r from-fuchsia-500/30 to-cyan-500/30 px-3 py-1.5 text-xs font-semibold text-white ring-1 ring-white/20 hover:from-fuchsia-500/40 hover:to-cyan-500/40 disabled:opacity-40"
                  >
                    <Layers className="h-3 w-3" /> Import Key Batch
                  </button>
                </div>
              </div>
            )}
          </div>
        </div>
      )}

      {/* Proxy Pool & Multi-Proxy Routing */}
      <div className="space-y-2.5 rounded-lg border border-white/10 bg-white/[0.03] p-3">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-1.5 text-xs font-medium text-slate-200">
            <Globe className="h-3.5 w-3.5 text-cyan-400" />
            <span>Proxy Pool & Routing ({(activeConfig.proxyUrls ?? []).length} configured)</span>
          </div>
          <div className="flex items-center gap-2">
            {(activeConfig.proxyUrls ?? []).length > 0 && (
              <button onClick={handleClearAllProxies} className="text-[10.5px] text-rose-400 hover:text-rose-300">
                Clear all
              </button>
            )}
            <button
              type="button"
              onClick={() => handleToggleUseProxies(!activeConfig.useProxies)}
              className={cn(
                'relative inline-flex h-5 w-9 shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors duration-200 ease-in-out focus:outline-none',
                activeConfig.useProxies ? 'bg-cyan-500' : 'bg-white/10'
              )}
              title="Toggle proxy routing for this provider"
            >
              <span
                className={cn(
                  'pointer-events-none inline-block h-4 w-4 transform rounded-full bg-white shadow-lg ring-0 transition duration-200 ease-in-out',
                  activeConfig.useProxies ? 'translate-x-4' : 'translate-x-0'
                )}
              />
            </button>
          </div>
        </div>

        <p className="text-[10.5px] text-slate-400">
          {activeConfig.useProxies
            ? 'Proxy routing active: Requests are distributed across the proxy pool using load balancing strategies with automatic failover.'
            : 'Proxy routing disabled: Requests connect directly to the provider endpoint.'}
        </p>

        {activeConfig.useProxies && (
          <>
            {/* Proxy Load Balancing Strategy Selector */}
            <div className="space-y-1">
              <label className="flex items-center gap-1 text-[10px] uppercase tracking-wider text-slate-400">
                <Scale className="h-3 w-3 text-cyan-400" />
                Proxy Balancing Strategy
              </label>
              <div className="grid grid-cols-3 gap-1.5">
                {(['p2c', 'round_robin', 'random'] as AiBalanceStrategy[]).map((strat) => (
                  <button
                    key={strat}
                    onClick={() => handleProxyStrategyChange(strat)}
                    className={cn(
                      'rounded border px-2 py-1 text-center text-[10.5px] font-medium transition',
                      (activeConfig.proxyStrategy ?? 'p2c') === strat
                        ? 'border-cyan-400/50 bg-cyan-400/15 text-cyan-200'
                        : 'border-white/5 bg-white/[0.02] text-slate-400 hover:bg-white/5 hover:text-slate-200'
                    )}
                  >
                    {strat === 'p2c' ? 'P2C (Smart)' : strat === 'round_robin' ? 'Round Robin' : 'Random'}
                  </button>
                ))}
              </div>
              <p className="text-[10px] text-slate-500">
                {(activeConfig.proxyStrategy ?? 'p2c') === 'p2c' &&
                  'P2C evaluates two random candidate proxies and routes to the one with lower active in-flight load.'}
                {(activeConfig.proxyStrategy ?? 'p2c') === 'round_robin' &&
                  'Sequentially rotates requests evenly across all pooled proxies.'}
                {(activeConfig.proxyStrategy ?? 'p2c') === 'random' &&
                  'Uniformly distributes queries across the active proxy pool.'}
              </p>
            </div>

            {/* List of Current Pooled Proxies */}
            {(activeConfig.proxyUrls ?? []).length > 0 && (
              <div className="max-h-28 space-y-1 overflow-y-auto pr-1">
                {(activeConfig.proxyUrls ?? []).map((p, i) => (
                  <div
                    key={i}
                    className="flex items-center justify-between rounded border border-white/5 bg-white/[0.02] px-2.5 py-1 text-xs"
                  >
                    <div className="flex items-center gap-2 min-w-0">
                      <span className="rounded bg-white/10 px-1 py-0.2 font-mono text-[9px] text-slate-400 shrink-0">
                        #{i + 1}
                      </span>
                      <span className="font-mono text-[11px] text-slate-300 truncate" title={p}>
                        {maskProxyUrl(p)}
                      </span>
                    </div>
                    <button
                      onClick={() => handleRemoveProxy(i)}
                      title="Remove proxy"
                      className="rounded p-1 text-slate-500 hover:bg-rose-500/20 hover:text-rose-300 shrink-0"
                    >
                      <Trash2 className="h-3 w-3" />
                    </button>
                  </div>
                ))}
              </div>
            )}

            {/* Add Proxy Input (Single vs Batch Tabs) */}
            <div className="border-t border-white/10 pt-2">
              <div className="mb-2 flex gap-2">
                <button
                  onClick={() => setProxyInputMode('single')}
                  className={cn(
                    'text-[11px] font-medium transition',
                    proxyInputMode === 'single'
                      ? 'text-cyan-300 underline underline-offset-4'
                      : 'text-slate-500 hover:text-slate-300'
                  )}
                >
                  Add Single Proxy
                </button>
                <span className="text-slate-600">·</span>
                <button
                  onClick={() => setProxyInputMode('batch')}
                  className={cn(
                    'text-[11px] font-medium transition',
                    proxyInputMode === 'batch'
                      ? 'text-cyan-300 underline underline-offset-4'
                      : 'text-slate-500 hover:text-slate-300'
                  )}
                >
                  Batch Add Multiple Proxies
                </button>
              </div>

              {proxyInputMode === 'single' ? (
                <div className="flex gap-1.5">
                  <input
                    type="text"
                    value={singleProxyInput}
                    onChange={(e) => setSingleProxyInput(e.target.value)}
                    onKeyDown={(e) => e.key === 'Enter' && handleAddSingleProxy()}
                    placeholder="e.g. 31.58.9.4:6077:user:pass or http://127.0.0.1:7890"
                    className="flex-1 rounded border border-white/10 bg-white/[0.04] px-2.5 py-1.5 font-mono text-[11px] text-slate-200 placeholder:text-slate-600 focus:outline-none"
                  />
                  <button
                    onClick={handleAddSingleProxy}
                    disabled={!singleProxyInput.trim()}
                    className="flex items-center gap-1 rounded bg-cyan-500/20 px-3 py-1.5 text-xs font-semibold text-cyan-300 hover:bg-cyan-500/30 disabled:opacity-40"
                  >
                    <Plus className="h-3 w-3" /> Add
                  </button>
                </div>
              ) : (
                <div className="space-y-1.5">
                  <textarea
                    rows={3}
                    value={batchProxyInput}
                    onChange={(e) => setBatchProxyInput(e.target.value)}
                    placeholder="Paste multiple proxies (one per line: host:port:user:pass, user:pass@host:port, or http://...)..."
                    className="w-full resize-none rounded border border-white/10 bg-white/[0.04] px-2.5 py-1.5 font-mono text-[11px] text-slate-200 placeholder:text-slate-600 focus:outline-none"
                  />
                  <div className="flex justify-end">
                    <button
                      onClick={handleAddBatchProxies}
                      disabled={!batchProxyInput.trim()}
                      className="flex items-center gap-1 rounded bg-gradient-to-r from-cyan-500/30 to-blue-500/30 px-3 py-1.5 text-xs font-semibold text-white ring-1 ring-white/20 hover:from-cyan-500/40 hover:to-blue-500/40 disabled:opacity-40"
                    >
                      <Layers className="h-3 w-3" /> Import Proxy Batch
                    </button>
                  </div>
                </div>
              )}
            </div>
          </>
        )}
      </div>

      {/* SSH Dynamic SOCKS5 Proxy (Auto Local Forwarder) */}
      <div className="space-y-2.5 rounded-lg border border-white/10 bg-white/[0.03] p-3">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-1.5 text-xs font-medium text-slate-200">
            <Network className="h-3.5 w-3.5 text-cyan-400" />
            <span>Auto SSH SOCKS5 Forwarder</span>
            {sshTunnelPort ? (
              <span className="flex items-center gap-1 rounded bg-emerald-500/20 px-1.5 py-0.5 font-mono text-[9px] font-semibold text-emerald-300">
                <span className="h-1.5 w-1.5 rounded-full bg-emerald-400 animate-pulse" />
                127.0.0.1:{sshTunnelPort}
              </span>
            ) : sshTunneling ? (
              <span className="flex items-center gap-1 rounded bg-cyan-500/20 px-1.5 py-0.5 text-[9px] font-medium text-cyan-300">
                <RefreshCw className="h-2.5 w-2.5 animate-spin" />
                Connecting…
              </span>
            ) : null}
          </div>
          <button
            type="button"
            onClick={() => handleToggleAutoSshProxy(!activeConfig.autoSshProxy)}
            className={cn(
              'relative inline-flex h-5 w-9 shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors duration-200 ease-in-out focus:outline-none',
              activeConfig.autoSshProxy ? 'bg-cyan-500' : 'bg-white/10'
            )}
            title="Toggle automatic local SOCKS5 proxy via SSH"
          >
            <span
              className={cn(
                'pointer-events-none inline-block h-4 w-4 transform rounded-full bg-white shadow-lg ring-0 transition duration-200 ease-in-out',
                activeConfig.autoSshProxy ? 'translate-x-4' : 'translate-x-0'
              )}
            />
          </button>
        </div>

        <p className="text-[10.5px] text-slate-400">
          Spawns an isolated local SOCKS5 listener (e.g. <code className="text-cyan-300">127.0.0.1:10885</code>) whenever
          an SSH connection is active. All AI inference queries automatically route through your remote server&apos;s
          network interface, seamlessly bypassing ISP routing quotas and regional blocks (such as Gemini europe-west1
          rate limits).
        </p>

        {activeConfig.autoSshProxy && (
          <div className="space-y-2 border-t border-white/10 pt-2">
            <div className="space-y-1">
              <label className="text-[10px] uppercase tracking-wider text-slate-400">Target SSH Host</label>
              <CustomSelect
                value={activeConfig.autoSshHostId || ''}
                onChange={(val) => handleSelectAutoSshHost(val || undefined)}
                options={[
                  {
                    value: '',
                    label: `⚡ Auto-follow active terminal pane (${
                      activeSshHostId
                        ? hosts.find((h) => h.id === activeSshHostId)?.label || 'Connected host'
                        : 'No SSH active'
                    })`,
                  },
                  ...hosts.map((h) => ({
                    value: h.id,
                    label: `${h.label || h.hostname} (${h.username}@${h.hostname}:${h.port})`,
                  })),
                ]}
                theme={theme}
              />
            </div>

            {sshTunnelPort ? (
              <div className="flex items-center gap-2 rounded border border-emerald-500/20 bg-emerald-500/10 px-2.5 py-1.5 text-xs text-emerald-300">
                <Check className="h-3.5 w-3.5 shrink-0 text-emerald-400" />
                <span>
                  Dynamic tunnel active on <strong>127.0.0.1:{sshTunnelPort}</strong>. AI requests exit from{' '}
                  {effectiveSshHost?.label || effectiveSshHost?.hostname || 'remote SSH host'}.
                </span>
              </div>
            ) : sshTunnelError ? (
              <div className="flex items-center gap-2 rounded border border-rose-500/20 bg-rose-500/10 px-2.5 py-1.5 text-xs text-rose-300">
                <AlertCircle className="h-3.5 w-3.5 shrink-0 text-rose-400" />
                <span className="truncate">Tunnel failed: {sshTunnelError}</span>
              </div>
            ) : (
              <div className="rounded border border-amber-500/20 bg-amber-500/5 px-2.5 py-1.5 text-[11px] text-amber-300/80">
                {effectiveSshHostId ? (
                  <span>Establishing local SOCKS5 proxy to host...</span>
                ) : (
                  <span>
                    Waiting for an SSH session. Connect to any remote server in the terminal to activate this local
                    proxy.
                  </span>
                )}
              </div>
            )}
          </div>
        )}
      </div>

      {/* Terminal Context Depth */}
      <div className="space-y-1.5 rounded-lg border border-white/5 bg-black/20 p-2.5">
        <div className="flex items-center justify-between">
          <label className="text-[11px] font-semibold text-white">Terminal Scrollback Context Depth</label>
          <span className="font-mono text-[10px] text-cyan-400 font-medium">
            {contextLines} lines (~{Math.round((contextLines * 64) / 1024)} KB)
          </span>
        </div>
        <div className="grid grid-cols-4 gap-1.5">
          {[
            { lines: 250, label: '250 lines', desc: '16 KB' },
            { lines: 500, label: '500 lines', desc: '32 KB' },
            { lines: 1000, label: '1,000 lines', desc: '64 KB' },
            { lines: 2000, label: '2,000 lines', desc: '128 KB' },
          ].map((opt) => (
            <button
              key={opt.lines}
              type="button"
              onClick={() => {
                setContextLines(opt.lines);
                localStorage.setItem('drx.ai.context_lines', String(opt.lines));
                toast(`Terminal context set to ${opt.label} (~${opt.desc})`);
              }}
              className={cn(
                'rounded border px-2 py-1.5 text-center text-[10.5px] font-medium transition cursor-pointer',
                contextLines === opt.lines
                  ? 'border-cyan-400/50 bg-cyan-400/15 text-cyan-200 font-semibold'
                  : 'border-white/5 bg-white/[0.02] text-slate-400 hover:bg-white/5 hover:text-slate-200'
              )}
            >
              <div>{opt.label}</div>
              <div className="text-[9px] text-slate-500 font-mono mt-0.5">{opt.desc}</div>
            </button>
          ))}
        </div>
        <p className="text-[10px] text-slate-500">
          Higher line counts capture long stack traces, build logs, and compiler errors. Default is 1,000 lines (~64 KB).
        </p>
      </div>

      {/* Privacy & Secret Redaction */}
      <div className="flex items-start gap-2.5 rounded-lg border border-white/5 bg-black/20 p-2.5">
        <input
          type="checkbox"
          id="scrub-toggle"
          checked={scrubSecrets}
          onChange={toggleScrubSecrets}
          className="mt-0.5 rounded border-white/20 bg-black/40 text-cyan-500 focus:ring-0"
        />
        <label htmlFor="scrub-toggle" className="cursor-pointer text-[11px] text-slate-300">
          <span className="font-semibold text-white">Redact terminal secrets before cloud inference</span>
          <p className="mt-0.5 text-[10px] text-slate-500">
            Strips SSH keys, passwords, Bearer tokens, and cloud credentials from terminal context before sending to
            external APIs.
          </p>
        </label>
      </div>

      <div className="flex items-center justify-between text-[10.5px] text-slate-500">
        <span className="flex items-center gap-1">
          <ShieldCheck className="h-3 w-3 text-cyan-400" />
          Keys & proxies saved in encrypted SQLCipher vault & synced via LAN pairing
        </span>
        {activeSpec?.docUrl && (
          <a
            href={activeSpec.docUrl}
            target="_blank"
            rel="noreferrer"
            className="flex items-center gap-0.5 text-cyan-400 hover:underline"
          >
            API Docs <ExternalLink className="h-2.5 w-2.5" />
          </a>
        )}
      </div>
    </div>
  );
}

export interface AiModelSelectorProps {
  mobile: boolean;
  theme?: DrexiusTheme;
  activeConfig: AiProviderConfig;
  activeProviderId: string;
  opencodeInstalled: boolean | null;
  probing: boolean;
  filteredModels: string[];
  modelSearch: string;
  setModelSearch: React.Dispatch<React.SetStateAction<string>>;
  customModelText: string;
  setCustomModelText: React.Dispatch<React.SetStateAction<string>>;
  showModelDropdown: boolean;
  setShowModelDropdown: React.Dispatch<React.SetStateAction<boolean>>;
  showProviderMenu: boolean;
  setShowProviderMenu: React.Dispatch<React.SetStateAction<boolean>>;
  modelDropdownRef: React.RefObject<HTMLDivElement | null>;
  providerMenuRef: React.RefObject<HTMLDivElement | null>;
  switchProvider: (providerId: string) => void;
  probe: (cfgToProbe?: AiProviderConfig, isUserAction?: boolean) => Promise<void>;
  handleSelectModel: (modelName: string) => void;
  handleAddCustomModel: () => void;
}

export function AiModelSelectorButtonAndPopover({
  mobile,
  theme,
  activeConfig,
  activeProviderId,
  opencodeInstalled,
  probing,
  filteredModels,
  modelSearch,
  setModelSearch,
  customModelText,
  setCustomModelText,
  showModelDropdown,
  setShowModelDropdown,
  showProviderMenu,
  setShowProviderMenu,
  modelDropdownRef,
  providerMenuRef,
  switchProvider,
  probe,
  handleSelectModel,
  handleAddCustomModel,
}: AiModelSelectorProps) {
  return (
    <div className="min-w-0 flex-1 max-w-fit shrink" ref={modelDropdownRef}>
      <button
        type="button"
        onClick={(e) => {
          e.stopPropagation();
          setShowModelDropdown((prev) => !prev);
        }}
        className={cn(
          'flex items-center gap-1.5 rounded-full bg-white/5 hover:bg-white/10 px-2.5 py-1 text-[11px] font-medium text-slate-300 transition cursor-pointer max-w-full min-w-0 shrink',
          showModelDropdown && 'bg-white/10 ring-1 ring-white/20'
        )}
        title="Click to switch Provider or Model"
      >
        <Sparkles className="h-3 w-3 text-cyan-400 shrink-0" />
        <span className="truncate block min-w-0 max-w-[130px] sm:max-w-[200px] md:max-w-[260px]">
          {(activeConfig.selectedModel || activeConfig.name).replace(/^opencode\//, '')}
        </span>
        <ChevronDown
          className={cn('h-3 w-3 text-slate-500 transition-transform shrink-0', showModelDropdown && 'rotate-180')}
        />
      </button>

      {!mobile && showModelDropdown && (
        <div
          style={{ background: theme?.xterm?.background ?? '#0a0d14' }}
          className="absolute bottom-full right-1 mb-2 z-[60] w-[310px] max-w-[calc(100%-0.5rem)] rounded-xl border border-white/15 p-2.5 shadow-2xl backdrop-blur-md"
        >
          {/* Provider selector header */}
          <div className="mb-2 flex items-center justify-between border-b border-white/10 pb-2">
            <div className="relative" ref={providerMenuRef}>
              <button
                type="button"
                onClick={(e) => {
                  e.stopPropagation();
                  setShowProviderMenu((prev) => !prev);
                }}
                className="flex items-center gap-1.5 rounded border border-white/10 bg-white/5 py-1 px-2.5 text-xs font-semibold text-slate-200 hover:bg-white/10 focus:outline-none transition cursor-pointer"
              >
                <span className="max-w-[130px] truncate">{activeConfig.name}</span>
                <ChevronDown
                  className={cn('h-3 w-3 text-slate-400 transition-transform', showProviderMenu && 'rotate-180')}
                />
              </button>

              {showProviderMenu && (
                <div
                  style={{ background: theme?.xterm?.background ?? '#0a0d14' }}
                  className="absolute left-0 top-full mt-1.5 z-[70] w-56 max-h-64 overflow-y-auto rounded-xl border border-white/15 p-1.5 shadow-2xl backdrop-blur-md space-y-0.5"
                >
                  <div className="px-2 py-1 text-[10px] font-semibold uppercase tracking-wider text-slate-400 border-b border-white/10 mb-1">
                    Select Provider
                  </div>
                  {KNOWN_PROVIDERS.map((p) => {
                    const isSelected = p.id === activeProviderId;
                    const isOpencode = p.id === 'opencode';
                    return (
                      <button
                        key={p.id}
                        type="button"
                        onClick={(e) => {
                          e.stopPropagation();
                          switchProvider(p.id);
                          setShowProviderMenu(false);
                        }}
                        className={cn(
                          'flex w-full items-center justify-between rounded px-2.5 py-1.5 text-left text-xs transition cursor-pointer',
                          isSelected
                            ? 'bg-cyan-500/20 text-cyan-200 font-medium'
                            : 'text-slate-300 hover:bg-white/5 hover:text-white'
                        )}
                      >
                        <div className="flex items-center gap-1.5 min-w-0">
                          <span className="truncate">{p.name}</span>
                          {isOpencode && opencodeInstalled && (
                            <span className="shrink-0 rounded bg-emerald-500/20 px-1 py-0.5 text-[9px] font-semibold text-emerald-300 border border-emerald-500/30">
                              Free
                            </span>
                          )}
                        </div>
                        {isSelected && <Check className="h-3 w-3 text-cyan-400 shrink-0" />}
                      </button>
                    );
                  })}
                </div>
              )}
            </div>
            <button
              onClick={() => probe(activeConfig, true)}
              disabled={probing}
              className="flex items-center gap-1 text-[10px] text-cyan-400 hover:text-cyan-300 disabled:opacity-50 cursor-pointer"
              title="Fetch live models from provider endpoint"
            >
              <RefreshCw className={cn('h-2.5 w-2.5', probing && 'animate-spin')} />
              {probing ? 'Probing…' : 'Fetch live'}
            </button>
          </div>

          {/* Search Filter */}
          <input
            type="text"
            placeholder="Search models…"
            value={modelSearch}
            onChange={(e) => setModelSearch(e.target.value)}
            className="mb-2 w-full rounded border border-white/10 bg-white/[0.04] px-2 py-1 text-xs text-slate-200 placeholder:text-slate-500 focus:border-cyan-400/50 focus:outline-none"
          />

          {/* Models List */}
          <div className="max-h-48 space-y-0.5 overflow-y-auto pr-1">
            {filteredModels.map((m) => {
              const isSelected = m === activeConfig.selectedModel;
              const isOpencode = activeConfig.providerId === 'opencode';
              const isFree =
                isOpencode &&
                (m.startsWith('opencode/') ||
                  m.endsWith('-free') ||
                  m.includes(':free') ||
                  m.includes('/free') ||
                  m === 'opencode/big-pickle');
              const providerPrefix = m.includes('/') ? m.split('/')[0] : null;

              return (
                <button
                  key={m}
                  onClick={(e) => {
                    e.stopPropagation();
                    handleSelectModel(m);
                    setShowModelDropdown(false);
                  }}
                  className={cn(
                    'flex w-full items-center justify-between rounded px-2 py-1.5 text-left font-mono text-xs transition cursor-pointer',
                    isSelected ? 'bg-cyan-500/20 text-cyan-200' : 'text-slate-300 hover:bg-white/5 hover:text-white'
                  )}
                >
                  <div className="flex items-center gap-1.5 min-w-0 flex-1">
                    <span className="truncate">{m}</span>
                    {isFree && (
                      <span className="shrink-0 rounded bg-emerald-500/15 px-1 py-0.2 text-[9px] font-semibold text-emerald-400 border border-emerald-500/30">
                        FREE
                      </span>
                    )}
                    {!isFree && isOpencode && providerPrefix && (
                      <span className="shrink-0 rounded bg-slate-800/80 px-1 py-0.2 text-[9px] font-mono text-slate-400 border border-white/10">
                        {providerPrefix}
                      </span>
                    )}
                  </div>
                  {isSelected && <Check className="h-3 w-3 shrink-0 text-cyan-400" />}
                </button>
              );
            })}
            {filteredModels.length === 0 && (
              <div className="py-2 text-center text-xs text-slate-500">No matching models found</div>
            )}
          </div>

          {/* Custom Model Input */}
          <div className="mt-2 border-t border-white/10 pt-2">
            <div className="flex gap-1">
              <input
                type="text"
                placeholder="Enter custom model ID…"
                value={customModelText}
                onChange={(e) => setCustomModelText(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    handleAddCustomModel();
                    setShowModelDropdown(false);
                  }
                }}
                className="flex-1 rounded border border-white/10 bg-white/[0.04] px-2 py-1 text-xs text-slate-200 placeholder:text-slate-500 focus:outline-none"
              />
              <button
                onClick={() => {
                  handleAddCustomModel();
                  setShowModelDropdown(false);
                }}
                className="rounded bg-cyan-500/20 px-2 text-xs font-medium text-cyan-300 hover:bg-cyan-500/30 cursor-pointer"
              >
                Add
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

export function AiMobileModelSheet({
  mobile,
  showModelDropdown,
  setShowModelDropdown,
  theme,
  activeConfig,
  activeProviderId,
  opencodeInstalled,
  probing,
  filteredModels,
  modelSearch,
  setModelSearch,
  customModelText,
  setCustomModelText,
  switchProvider,
  probe,
  handleSelectModel,
  handleAddCustomModel,
}: Omit<AiModelSelectorProps, 'showProviderMenu' | 'setShowProviderMenu' | 'modelDropdownRef' | 'providerMenuRef'>) {
  if (!mobile || !showModelDropdown) return null;
  return (
    <MobileSheet
      title="Select Model"
      kicker={activeConfig.name}
      subtitle={`Current: ${activeConfig.selectedModel || activeConfig.name}`}
      icon={Sparkles}
      theme={theme}
      onClose={() => setShowModelDropdown(false)}
    >
      <div className="space-y-3 pb-2 text-left">
        {/* Provider Selector horizontal pill scroll */}
        <div>
          <div className="flex items-center justify-between mb-1.5 px-0.5">
            <span className="text-[11px] font-semibold uppercase tracking-wider text-slate-400">Provider</span>
            <button
              type="button"
              onClick={() => probe(activeConfig, true)}
              disabled={probing}
              className="flex items-center gap-1 text-xs text-cyan-400 active:text-cyan-300 disabled:opacity-50 py-1 px-2 rounded-lg bg-white/5 cursor-pointer"
              title="Fetch live models from provider endpoint"
            >
              <RefreshCw className={cn('h-3 w-3', probing && 'animate-spin')} />
              {probing ? 'Probing…' : 'Fetch live'}
            </button>
          </div>
          <div className="flex gap-1.5 overflow-x-auto pb-1 scrollbar-none">
            {KNOWN_PROVIDERS.map((p) => {
              const isSelected = p.id === activeProviderId;
              const isOpencode = p.id === 'opencode';
              return (
                <button
                  key={p.id}
                  type="button"
                  onClick={() => switchProvider(p.id)}
                  className={cn(
                    'flex items-center gap-1.5 shrink-0 rounded-xl px-3 py-2 text-xs font-medium transition cursor-pointer active:scale-95',
                    isSelected
                      ? 'bg-cyan-500/25 border border-cyan-500/50 text-cyan-200 shadow-sm'
                      : 'bg-white/[0.04] border border-white/10 text-slate-300 hover:bg-white/10'
                  )}
                >
                  <span>{p.name.replace(/ \(.*\)/, '')}</span>
                  {isOpencode && opencodeInstalled && (
                    <span className="rounded bg-emerald-500/20 px-1 py-0.2 text-[9px] font-semibold text-emerald-300 border border-emerald-500/30">
                      Free
                    </span>
                  )}
                </button>
              );
            })}
          </div>
        </div>

        {/* Search Filter */}
        <input
          type="text"
          placeholder="Search models…"
          value={modelSearch}
          onChange={(e) => setModelSearch(e.target.value)}
          className="w-full rounded-xl border border-white/10 bg-white/[0.04] px-3 py-2 text-sm text-slate-200 placeholder:text-slate-500 focus:border-cyan-400/50 focus:outline-none"
        />

        {/* Models List */}
        <div className="max-h-[35vh] space-y-1 overflow-y-auto pr-1">
          {filteredModels.map((m) => {
            const isSelected = m === activeConfig.selectedModel;
            const isOpencode = activeConfig.providerId === 'opencode';
            const isFree =
              isOpencode &&
              (m.startsWith('opencode/') ||
                m.endsWith('-free') ||
                m.includes(':free') ||
                m.includes('/free') ||
                m === 'opencode/big-pickle');
            const providerPrefix = m.includes('/') ? m.split('/')[0] : null;

            return (
              <button
                key={m}
                type="button"
                onClick={() => {
                  handleSelectModel(m);
                  setShowModelDropdown(false);
                }}
                className={cn(
                  'flex w-full items-center justify-between rounded-xl px-3 py-2.5 text-left font-mono text-xs transition cursor-pointer active:scale-[0.99]',
                  isSelected
                    ? 'bg-cyan-500/20 border border-cyan-500/40 text-cyan-200'
                    : 'bg-white/[0.02] border border-white/5 text-slate-300 active:bg-white/10'
                )}
              >
                <div className="flex items-center gap-2 min-w-0 flex-1">
                  <span className="truncate">{m}</span>
                  {isFree && (
                    <span className="shrink-0 rounded bg-emerald-500/15 px-1.5 py-0.5 text-[9px] font-semibold text-emerald-400 border border-emerald-500/30">
                      FREE
                    </span>
                  )}
                  {!isFree && isOpencode && providerPrefix && (
                    <span className="shrink-0 rounded bg-slate-800/80 px-1.5 py-0.5 text-[9px] font-mono text-slate-400 border border-white/10">
                      {providerPrefix}
                    </span>
                  )}
                </div>
                {isSelected && <Check className="h-4 w-4 shrink-0 text-cyan-400 ml-2" />}
              </button>
            );
          })}
          {filteredModels.length === 0 && (
            <div className="py-6 text-center text-xs text-slate-500">No matching models found</div>
          )}
        </div>

        {/* Custom Model Input */}
        <div className="pt-2 border-t border-white/10">
          <div className="flex gap-2">
            <input
              type="text"
              placeholder="Enter custom model ID…"
              value={customModelText}
              onChange={(e) => setCustomModelText(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  handleAddCustomModel();
                  setShowModelDropdown(false);
                }
              }}
              className="flex-1 rounded-xl border border-white/10 bg-white/[0.04] px-3 py-2 text-xs text-slate-200 placeholder:text-slate-500 focus:outline-none"
            />
            <button
              type="button"
              onClick={() => {
                handleAddCustomModel();
                setShowModelDropdown(false);
              }}
              className="rounded-xl bg-cyan-500/20 border border-cyan-500/30 px-3 py-2 text-xs font-semibold text-cyan-300 active:bg-cyan-500/30 transition cursor-pointer"
            >
              Add
            </button>
          </div>
        </div>
      </div>
    </MobileSheet>
  );
}
