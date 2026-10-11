import { useEffect, useRef, useState } from 'react';
import {
  Sparkles,
  Send,
  RefreshCw,
  Square,
  Terminal as TermIcon,
  Bug,
  Wand2,
  BookOpen,
  Settings2,
  CornerDownLeft,
  Copy,
  ShieldAlert,
  Cpu,
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
} from 'lucide-react';
import {
  chatStreamMultiProvider,
  classifyRisk,
  createDefaultAiConfigs,
  KNOWN_PROVIDERS,
  listModelsForProvider,
  maskKey,
  maskProxyUrl,
  offlineAnswer,
  parseKeyBatch,
  parseProxyBatch,
  isValidProxyUrl,
  normalizeProxyUrl,
  sanitizeContext,
  SYSTEM_PROMPT,
  type ChatMsg,
  type ProviderSpec,
} from '../lib/ollama';
import { bridge } from '../lib/bridge';
import type { AiBalanceStrategy, AiProviderConfig, Host } from '../lib/types';
import { registry } from '../lib/sessions';
import { cn } from '../utils/cn';

interface Msg {
  role: 'user' | 'assistant';
  content: string;
  offline?: boolean;
  modelUsed?: string;
  keyUsed?: string;
  proxyUsed?: string;
}

const sanitizeConfigsForStorage = (cfgs: AiProviderConfig[]): AiProviderConfig[] => {
  return cfgs.map((c) => ({
    ...c,
    apiKeys: [], // Never store plaintext API keys in unencrypted localStorage
  }));
};

const loadCachedConfigs = (): AiProviderConfig[] => {
  const defaults = createDefaultAiConfigs();
  try {
    const raw = localStorage.getItem('nx.ai.configs');
    if (raw) {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed) && parsed.length > 0) {
        const map = new Map<string, AiProviderConfig>();
        for (const d of defaults) map.set(d.providerId, d);
        for (const p of parsed) {
          if (p && p.providerId) {
            p.proxyUrls = (p.proxyUrls || []).filter(isValidProxyUrl);
            p.apiKeys = []; // Keys must be loaded securely from vault
            map.set(p.providerId, p);
          }
        }
        return Array.from(map.values());
      }
    }
  } catch {}
  return defaults;
};

export function AIPanel({ activePaneId, toast }: { activePaneId: string | null; toast: (m: string) => void }) {
  const [configs, setConfigs] = useState<AiProviderConfig[]>(() => loadCachedConfigs());
  const [activeProviderId, setActiveProviderId] = useState<string>(() => {
    return localStorage.getItem('nx.ai.active_provider') || 'gemini';
  });
  const [online, setOnline] = useState<boolean | null>(null);
  const [probing, setProbing] = useState(false);
  const [showCfg, setShowCfg] = useState(false);
  const [showModelDropdown, setShowModelDropdown] = useState(false);
  const [modelSearch, setModelSearch] = useState('');
  const [customModelText, setCustomModelText] = useState('');

  // Settings view state
  const [keyInputMode, setKeyInputMode] = useState<'single' | 'batch'>('single');
  const [singleKeyInput, setSingleKeyInput] = useState('');
  const [batchKeyInput, setBatchKeyInput] = useState('');
  const [showKeySecret, setShowKeySecret] = useState(false);
  const [scrubSecrets, setScrubSecrets] = useState(() => localStorage.getItem('nx.ai.scrub_secrets') !== 'false');

  // Proxy pool settings state
  const [proxyInputMode, setProxyInputMode] = useState<'single' | 'batch'>('single');
  const [singleProxyInput, setSingleProxyInput] = useState('');
  const [batchProxyInput, setBatchProxyInput] = useState('');
  const [lastUsedProxy, setLastUsedProxy] = useState<string | null>(null);

  // SSH Dynamic SOCKS5 Proxy state
  const [hosts, setHosts] = useState<Host[]>([]);
  const [sshTunnelPort, setSshTunnelPort] = useState<number | null>(null);
  const [sshTunneling, setSshTunneling] = useState(false);
  const [sshTunnelError, setSshTunnelError] = useState<string | null>(null);

  // Chat state
  const [msgs, setMsgs] = useState<Msg[]>([]);
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);
  const [lastUsedKey, setLastUsedKey] = useState<string | null>(null);
  const [failoverAlert, setFailoverAlert] = useState<string | null>(null);

  const abortRef = useRef<AbortController | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const modelDropdownRef = useRef<HTMLDivElement>(null);
  const activeTunnelHostRef = useRef<string | null>(null);

  const getProviderConfig = (providerId: string): AiProviderConfig => {
    const existing = configs.find((c) => c.providerId === providerId);
    if (existing) return existing;
    const spec = KNOWN_PROVIDERS.find((p) => p.id === providerId) || KNOWN_PROVIDERS[0];
    return {
      providerId: spec.id,
      name: spec.name,
      baseUrl: spec.defaultBaseUrl,
      apiKeys: [],
      selectedModel: spec.defaultModel,
      modelsCache: spec.popularModels,
      balanceStrategy: 'p2c',
      enabled: true,
      updatedAt: Math.floor(Date.now() / 1000),
      useProxies: false,
      proxyUrls: [],
      proxyStrategy: 'p2c',
      autoSshProxy: false,
      autoSshHostId: undefined,
    };
  };

  const activeConfig: AiProviderConfig = getProviderConfig(activeProviderId);
  const activeSpec: ProviderSpec | undefined = KNOWN_PROVIDERS.find((p) => p.id === activeProviderId);

  // Active pane detection
  const isHostRemote = (hId?: string | null): boolean => {
    if (!hId) return false;
    return hId !== 'local' && hId !== '__local__' && !hId.startsWith('local');
  };
  const activePane = activePaneId ? registry.get(activePaneId) : undefined;
  const activeSshHostId = isHostRemote(activePane?.hostId) ? activePane!.hostId : null;
  const effectiveSshHostId = isHostRemote(activeConfig.autoSshHostId)
    ? activeConfig.autoSshHostId
    : activeSshHostId;
  const effectiveSshHost = hosts.find((h) => h.id === effectiveSshHostId);

  // Auto SSH Dynamic SOCKS5 Tunnel lifecycle with proper cleanup
  useEffect(() => {
    let cancelled = false;

    if (!activeConfig.autoSshProxy || !effectiveSshHostId) {
      if (activeTunnelHostRef.current) {
        bridge.stopAiSshTunnel(activeTunnelHostRef.current).catch(() => {});
        activeTunnelHostRef.current = null;
      }
      setSshTunnelPort(null);
      setSshTunneling(false);
      setSshTunnelError(null);
      return;
    }

    // If target host changed, terminate the previous tunnel first
    if (activeTunnelHostRef.current && activeTunnelHostRef.current !== effectiveSshHostId) {
      bridge.stopAiSshTunnel(activeTunnelHostRef.current).catch(() => {});
      activeTunnelHostRef.current = null;
    }

    activeTunnelHostRef.current = effectiveSshHostId;
    setSshTunneling(true);
    setSshTunnelError(null);

    bridge.startAiSshTunnel(effectiveSshHostId)
      .then((port) => {
        if (cancelled) {
          bridge.stopAiSshTunnel(effectiveSshHostId).catch(() => {});
          return;
        }
        setSshTunnelPort(port);
        setSshTunneling(false);
      })
      .catch((err) => {
        if (cancelled) return;
        console.error('Failed to start AI SSH tunnel:', err);
        setSshTunnelError(String(err));
        setSshTunneling(false);
      });

    return () => {
      cancelled = true;
      if (activeTunnelHostRef.current) {
        bridge.stopAiSshTunnel(activeTunnelHostRef.current).catch(() => {});
        activeTunnelHostRef.current = null;
      }
    };
  }, [activeConfig.autoSshProxy, effectiveSshHostId]);

  const getEffectiveConfig = (cfg: AiProviderConfig = activeConfig): AiProviderConfig => {
    if (cfg.autoSshProxy && sshTunnelPort) {
      return {
        ...cfg,
        useProxies: true,
        proxyUrls: [`socks5://127.0.0.1:${sshTunnelPort}`],
      };
    }
    const cleanProxies = (cfg.proxyUrls ?? []).filter(isValidProxyUrl);
    return {
      ...cfg,
      proxyUrls: cleanProxies,
    };
  };

  // Load configs, hosts, and active provider from encrypted vault on mount
  useEffect(() => {
    bridge.listHosts().then(setHosts).catch(() => {});
  }, []);

  useEffect(() => {
    let mounted = true;
    (async () => {
      try {
        const defaults = createDefaultAiConfigs();
        const cached = loadCachedConfigs();
        const map = new Map<string, AiProviderConfig>();
        for (const d of defaults) map.set(d.providerId, d);
        for (const c of cached) map.set(c.providerId, c);
        try {
          const loaded = await bridge.listAiConfigs();
          if (loaded && loaded.length > 0) {
            for (const item of loaded) {
              item.proxyUrls = (item.proxyUrls || []).filter(isValidProxyUrl);
              map.set(item.providerId, item);
            }
          }
        } catch (err) {
          console.warn('Could not load AI configs from vault, using cache:', err);
        }
        const merged = Array.from(map.values());
        if (!mounted) return;
        setConfigs(merged);
        try {
          localStorage.setItem('nx.ai.configs', JSON.stringify(sanitizeConfigsForStorage(merged)));
        } catch {}

        const activeId = await bridge.getActiveAiProvider();
        if (activeId && map.has(activeId)) {
          setActiveProviderId(activeId);
          localStorage.setItem('nx.ai.active_provider', activeId);
        }
      } catch (err) {
        console.error('Failed to initialize AI configs:', err);
      }
    })();
    return () => {
      mounted = false;
    };
  }, []);

  // Close model dropdown on click outside
  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (modelDropdownRef.current && !modelDropdownRef.current.contains(e.target as Node)) {
        setShowModelDropdown(false);
      }
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, []);

  // Probe provider health and model availability
  const probe = async (cfgToProbe?: AiProviderConfig) => {
    const rawCfg = cfgToProbe || activeConfig;
    if (!rawCfg) return;
    const effectiveCfg = getEffectiveConfig(rawCfg);
    setProbing(true);
    try {
      const liveModels = await listModelsForProvider(effectiveCfg);
      setOnline(true);
      if (liveModels.length > 0) {
        // Retain user's chosen model if set, otherwise pick the first live model
        const nextModel = rawCfg.selectedModel && rawCfg.selectedModel.trim().length > 0
          ? rawCfg.selectedModel
          : (liveModels[0] || rawCfg.selectedModel);

        const updated: AiProviderConfig = {
          ...rawCfg, // Never save effectiveCfg so ephemeral SSH SOCKS proxy doesn't wipe proxyUrls
          modelsCache: liveModels,
          selectedModel: nextModel,
          updatedAt: Math.floor(Date.now() / 1000),
        };
        saveConfig(updated);
      }
    } catch {
      // If cloud provider has no keys, mark as needing keys
      if (rawCfg.providerId !== 'ollama' && rawCfg.apiKeys.length === 0) {
        setOnline(null);
      } else {
        setOnline(false);
      }
    } finally {
      setProbing(false);
    }
  };

  useEffect(() => {
    if (activeConfig) {
      probe(activeConfig);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeProviderId]);

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight });
  }, [msgs]);

  const saveConfig = async (updated: AiProviderConfig) => {
    setConfigs((prev) => {
      const idx = prev.findIndex((c) => c.providerId === updated.providerId);
      const next = [...prev];
      if (idx >= 0) {
        next[idx] = updated;
      } else {
        next.push(updated);
      }
      try {
        localStorage.setItem('nx.ai.configs', JSON.stringify(sanitizeConfigsForStorage(next)));
      } catch {}
      return next;
    });
    try {
      await bridge.saveAiConfig(updated);
    } catch (e) {
      console.error('Failed to save AI config to vault:', e);
    }
  };

  const switchProvider = async (providerId: string) => {
    setActiveProviderId(providerId);
    localStorage.setItem('nx.ai.active_provider', providerId);
    try {
      await bridge.setActiveAiProvider(providerId);
    } catch (e) {
      console.error('Failed to set active AI provider in vault:', e);
    }
    const target = getProviderConfig(providerId);
    saveConfig(target);
    probe(target);
  };

  const handleSelectModel = (modelName: string) => {
    const updated: AiProviderConfig = { ...activeConfig, selectedModel: modelName };
    saveConfig(updated);
    setShowModelDropdown(false);
    toast(`Model set to ${modelName}`);
  };

  const handleAddCustomModel = () => {
    const trimmed = customModelText.trim();
    if (!trimmed) return;
    const cache = Array.from(new Set([trimmed, ...(activeConfig.modelsCache || [])]));
    const updated: AiProviderConfig = {
      ...activeConfig,
      selectedModel: trimmed,
      modelsCache: cache,
    };
    saveConfig(updated);
    setCustomModelText('');
    setShowModelDropdown(false);
    toast(`Model set to ${trimmed}`);
  };

  const handleAddSingleKey = () => {
    const key = singleKeyInput.trim();
    if (!key) return;
    if (activeConfig.apiKeys.includes(key)) {
      toast('Key already in pool');
      return;
    }
    const updated: AiProviderConfig = {
      ...activeConfig,
      apiKeys: [...activeConfig.apiKeys, key],
    };
    saveConfig(updated);
    setSingleKeyInput('');
    toast(`Added key to ${activeConfig.name} pool`);
    probe(updated);
  };

  const handleAddBatchKeys = () => {
    const parsed = parseKeyBatch(batchKeyInput);
    if (parsed.length === 0) {
      toast('No valid keys found in input');
      return;
    }
    const existing = new Set(activeConfig.apiKeys);
    const newKeys = parsed.filter((k) => !existing.has(k));
    if (newKeys.length === 0) {
      toast('All entered keys are already in pool');
      return;
    }
    const updated: AiProviderConfig = {
      ...activeConfig,
      apiKeys: [...activeConfig.apiKeys, ...newKeys],
    };
    saveConfig(updated);
    setBatchKeyInput('');
    toast(`Added ${newKeys.length} new keys to pool (total: ${updated.apiKeys.length})`);
    probe(updated);
  };

  const handleRemoveKey = (index: number) => {
    const updatedKeys = activeConfig.apiKeys.filter((_, i) => i !== index);
    const updated: AiProviderConfig = {
      ...activeConfig,
      apiKeys: updatedKeys,
    };
    saveConfig(updated);
    toast('Key removed from pool');
  };

  const handleClearAllKeys = () => {
    if (window.confirm(`Clear all ${activeConfig.apiKeys.length} keys for ${activeConfig.name}?`)) {
      const updated: AiProviderConfig = { ...activeConfig, apiKeys: [] };
      saveConfig(updated);
      toast('All keys cleared');
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
    toast(enabled ? `Proxy routing enabled for ${activeConfig.name}` : `Proxy routing disabled for ${activeConfig.name}`);
    probe(updated);
  };

  const handleProxyStrategyChange = (strategy: AiBalanceStrategy) => {
    const updated: AiProviderConfig = { ...activeConfig, proxyStrategy: strategy };
    saveConfig(updated);
    toast(`Proxy balancing strategy set to ${strategy.toUpperCase()}`);
  };

  const handleAddSingleProxy = () => {
    const raw = singleProxyInput.trim();
    if (!raw) return;
    const normalized = normalizeProxyUrl(raw);
    if (!normalized) {
      toast('Invalid proxy. Enter host:port, host:port:user:pass, or http://... / socks5://...');
      return;
    }
    const list = (activeConfig.proxyUrls ?? [])
      .map(normalizeProxyUrl)
      .filter((p): p is string => p !== null);
    if (list.includes(normalized)) {
      toast('Proxy already in pool');
      return;
    }
    const updated: AiProviderConfig = {
      ...activeConfig,
      proxyUrls: [...list, normalized],
    };
    saveConfig(updated);
    setSingleProxyInput('');
    toast(`Added proxy to ${activeConfig.name} pool`);
    if (updated.useProxies) probe(updated);
  };

  const handleAddBatchProxies = () => {
    const parsed = parseProxyBatch(batchProxyInput);
    if (parsed.length === 0) {
      toast('No valid proxy URLs found (formats: host:port, host:port:user:pass, or http/socks5://...)');
      return;
    }
    const existing = new Set((activeConfig.proxyUrls ?? []).filter(isValidProxyUrl));
    const newProxies = parsed.filter((p) => !existing.has(p));
    if (newProxies.length === 0) {
      toast('All entered proxies are already in pool');
      return;
    }
    const updated: AiProviderConfig = {
      ...activeConfig,
      proxyUrls: [...existing, ...newProxies],
    };
    saveConfig(updated);
    setBatchProxyInput('');
    toast(`Added ${newProxies.length} proxies to pool (total: ${updated.proxyUrls?.length})`);
    if (updated.useProxies) probe(updated);
  };

  const handleRemoveProxy = (index: number) => {
    const list = activeConfig.proxyUrls ?? [];
    const updated: AiProviderConfig = {
      ...activeConfig,
      proxyUrls: list.filter((_, i) => i !== index),
    };
    saveConfig(updated);
    toast('Proxy removed from pool');
  };

  const handleClearAllProxies = () => {
    const count = (activeConfig.proxyUrls ?? []).length;
    if (window.confirm(`Clear all ${count} proxies for ${activeConfig.name}?`)) {
      const updated: AiProviderConfig = { ...activeConfig, proxyUrls: [] };
      saveConfig(updated);
      toast('All proxies cleared');
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

  const toggleScrubSecrets = () => {
    const next = !scrubSecrets;
    setScrubSecrets(next);
    localStorage.setItem('nx.ai.scrub_secrets', String(next));
    toast(next ? 'Terminal secret redaction enabled' : 'Terminal secret redaction disabled');
  };

  const ask = async (prompt: string) => {
    if (!prompt.trim() || busy) return;
    const pane = activePaneId ? registry.get(activePaneId) : undefined;
    const rawContext = activePaneId ? registry.context(activePaneId, 80) : '';

    // Apply credential sanitization if enabled
    const context = scrubSecrets ? sanitizeContext(rawContext) : rawContext;

    const ctxBlock = `Current working directory: ${pane?.cwd ?? 'unknown'}\nLast command: ${pane?.lastCommand ?? 'n/a'}\nRecent terminal output:\n\`\`\`\n${context.slice(-4000)}\n\`\`\``;
    const history: Msg[] = [...msgs, { role: 'user', content: prompt }];
    setMsgs([...history, { role: 'assistant', content: '', modelUsed: activeConfig.selectedModel }]);
    setInput('');
    setBusy(true);
    setFailoverAlert(null);

    // If cloud provider and 0 keys, show helpful guidance
    if (activeConfig.providerId !== 'ollama' && activeConfig.apiKeys.length === 0) {
      await new Promise((r) => setTimeout(r, 200));
      setMsgs([
        ...history,
        {
          role: 'assistant',
          content: `⚠️ **No API keys configured for ${activeConfig.name}**.\n\nPlease click the **Settings (⚙️)** button above to add your API key or batch-import multiple keys for pooled load balancing.\n\n` +
            offlineAnswer(prompt, context),
          offline: true,
        },
      ]);
      setBusy(false);
      return;
    }

    // If offline and Ollama
    if (online === false && activeConfig.providerId === 'ollama') {
      await new Promise((r) => setTimeout(r, 250));
      setMsgs([...history, { role: 'assistant', content: offlineAnswer(prompt, context), offline: true }]);
      setBusy(false);
      return;
    }

    const wire: ChatMsg[] = [
      { role: 'system', content: SYSTEM_PROMPT },
      { role: 'system', content: ctxBlock },
      ...history.slice(-10).map((m) => ({ role: m.role, content: m.content })),
    ];

    abortRef.current = new AbortController();
    let acc = '';
    let usedKeyMask = '';
    let usedProxyMask = '';

    const effectiveCfg = getEffectiveConfig(activeConfig);

    try {
      await chatStreamMultiProvider(
        effectiveCfg,
        wire,
        {
          onToken: (t) => {
            acc += t;
            setMsgs([...history, {
              role: 'assistant',
              content: acc,
              modelUsed: effectiveCfg.selectedModel,
              keyUsed: usedKeyMask,
              proxyUsed: usedProxyMask,
            }]);
          },
          onKeyUsed: (masked) => {
            usedKeyMask = masked;
            setLastUsedKey(masked);
          },
          onProxyUsed: (maskedProxy) => {
            usedProxyMask = maskedProxy;
            setLastUsedProxy(maskedProxy);
          },
          onFailover: (reason, nextMask) => {
            setFailoverAlert(reason);
            toast(`Auto-failover: switched to ${nextMask}`);
          },
        },
        abortRef.current.signal
      );
    } catch (e: unknown) {
      const err = e instanceof Error ? e : new Error(typeof e === 'string' ? e : (e as Error)?.message || String(e));
      if (err.name !== 'AbortError') {
        setMsgs([
          ...history,
          {
            role: 'assistant',
            content: `⚠️ ${err.message || 'Request failed'}`,
            offline: false,
          },
        ]);
      }
    } finally {
      setBusy(false);
    }
  };

  const pane = activePaneId ? registry.get(activePaneId) : undefined;
  const quick = [
    { icon: BookOpen, label: 'Explain last command', run: () => ask(`Explain: ${pane?.lastCommand ?? 'the last command shown in the terminal'}`) },
    { icon: Bug, label: 'Troubleshoot output', run: () => ask('Troubleshoot the errors in the recent terminal output. What is the root cause and what should I check next?') },
    { icon: Wand2, label: 'Generate pipeline', run: () => setInput('Generate a safe shell pipeline that ') },
  ];

  const availableModels = activeConfig.modelsCache && activeConfig.modelsCache.length > 0
    ? activeConfig.modelsCache
    : activeSpec?.popularModels || [activeConfig.selectedModel];

  const filteredModels = availableModels.filter((m) => m.toLowerCase().includes(modelSearch.toLowerCase()));

  const strategyLabel = activeConfig.balanceStrategy === 'round_robin'
    ? 'Round Robin'
    : activeConfig.balanceStrategy === 'p2c'
    ? 'P2C Balancer'
    : 'Random';

  return (
    <div className="flex h-full flex-col bg-slate-950 text-slate-100">
      {/* ── Header ── */}
      <div className="flex flex-wrap items-center gap-2 border-b border-white/10 bg-slate-900/60 px-3.5 py-2.5 backdrop-blur-sm">
        <div className="grid h-7 w-7 shrink-0 place-items-center rounded-lg bg-gradient-to-br from-fuchsia-500/30 to-cyan-400/30 ring-1 ring-white/10">
          <Sparkles className="h-3.5 w-3.5 text-fuchsia-200" />
        </div>

        {/* Provider Switcher Dropdown */}
        <div className="relative">
          <select
            value={activeProviderId}
            onChange={(e) => switchProvider(e.target.value)}
            className="cursor-pointer appearance-none rounded-md border border-white/10 bg-white/[0.04] py-1 pl-2.5 pr-7 text-xs font-semibold text-slate-200 hover:border-cyan-400/30 hover:bg-white/[0.08] focus:outline-none"
          >
            {KNOWN_PROVIDERS.map((p) => (
              <option key={p.id} value={p.id} className="bg-slate-900 text-white">
                {p.name}
              </option>
            ))}
          </select>
          <ChevronDown className="pointer-events-none absolute right-2 top-2 h-3 w-3 text-slate-400" />
        </div>

        {/* Quick Model Picker Pill */}
        <div className="relative min-w-0" ref={modelDropdownRef}>
          <button
            onClick={() => setShowModelDropdown((v) => !v)}
            title="Click to switch or search models"
            className="flex max-w-[150px] items-center gap-1.5 truncate rounded-md border border-white/10 bg-white/[0.04] px-2 py-1 text-[11px] font-mono text-cyan-200 hover:border-cyan-400/40 hover:bg-white/[0.08]"
          >
            <Cpu className="h-3 w-3 shrink-0 text-cyan-400" />
            <span className="truncate">{activeConfig.selectedModel || 'Select model'}</span>
            <ChevronDown className="h-2.5 w-2.5 shrink-0 text-slate-400" />
          </button>

          {/* Model Selection Popover */}
          {showModelDropdown && (
            <div className="absolute left-0 top-full z-50 mt-1.5 w-72 rounded-xl border border-white/15 bg-slate-900 p-2.5 shadow-2xl backdrop-blur-md">
              <div className="mb-2 flex items-center justify-between border-b border-white/10 pb-1.5">
                <span className="text-[10.5px] font-semibold uppercase tracking-wider text-slate-400">Select Model</span>
                <button
                  onClick={() => probe(activeConfig)}
                  disabled={probing}
                  className="flex items-center gap-1 text-[10px] text-cyan-400 hover:text-cyan-300 disabled:opacity-50"
                >
                  <RefreshCw className={cn('h-2.5 w-2.5', probing && 'animate-spin')} />
                  Fetch live
                </button>
              </div>

              {/* Search Filter */}
              <input
                type="text"
                placeholder="Search models…"
                value={modelSearch}
                onChange={(e) => setModelSearch(e.target.value)}
                className="mb-2 w-full rounded border border-white/10 bg-black/40 px-2 py-1 text-xs text-slate-200 placeholder:text-slate-500 focus:border-cyan-400/50 focus:outline-none"
              />

              {/* Models List */}
              <div className="max-h-48 space-y-0.5 overflow-y-auto pr-1">
                {filteredModels.map((m) => {
                  const isSelected = m === activeConfig.selectedModel;
                  return (
                    <button
                      key={m}
                      onClick={() => handleSelectModel(m)}
                      className={cn(
                        'flex w-full items-center justify-between rounded px-2 py-1.5 text-left font-mono text-xs transition',
                        isSelected ? 'bg-cyan-500/20 text-cyan-200' : 'text-slate-300 hover:bg-white/5 hover:text-white'
                      )}
                    >
                      <span className="truncate">{m}</span>
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
                    onKeyDown={(e) => e.key === 'Enter' && handleAddCustomModel()}
                    className="flex-1 rounded border border-white/10 bg-black/40 px-2 py-1 text-xs text-slate-200 placeholder:text-slate-500 focus:outline-none"
                  />
                  <button
                    onClick={handleAddCustomModel}
                    disabled={!customModelText.trim()}
                    className="rounded bg-cyan-500/20 px-2 py-1 text-xs font-medium text-cyan-300 hover:bg-cyan-500/30 disabled:opacity-40"
                  >
                    Set
                  </button>
                </div>
              </div>
            </div>
          )}
        </div>

        {/* Status / Key Pool Indicator */}
        <div className="ml-auto flex items-center gap-1.5">
          {/* SSH Dynamic Tunnel Indicator */}
          {activeConfig.autoSshProxy && (
            <button
              onClick={() => setShowCfg(true)}
              title={
                sshTunnelPort
                  ? `Dynamic SSH SOCKS5 proxy active on port ${sshTunnelPort} (AI queries exit through remote host). Click to configure.`
                  : sshTunneling
                  ? 'Connecting dynamic SSH AI proxy...'
                  : sshTunnelError
                  ? `SSH proxy error: ${sshTunnelError}`
                  : 'Auto SSH AI proxy active (waiting for SSH session)...'
              }
              className={cn(
                'flex items-center gap-1.5 rounded-full border px-2 py-0.5 text-[10px] font-medium transition',
                sshTunnelPort
                  ? 'border-emerald-500/30 bg-emerald-500/10 text-emerald-300 hover:bg-emerald-500/20'
                  : sshTunneling
                  ? 'border-cyan-500/30 bg-cyan-500/10 text-cyan-300 animate-pulse'
                  : sshTunnelError
                  ? 'border-rose-500/30 bg-rose-500/10 text-rose-300 hover:bg-rose-500/20'
                  : 'border-white/10 bg-white/[0.02] text-slate-400 hover:bg-white/[0.06]'
              )}
            >
              <Network className="h-2.5 w-2.5" />
              <span>
                {sshTunnelPort
                  ? `SSH SOCKS5 (${sshTunnelPort})`
                  : sshTunneling
                  ? 'Connecting…'
                  : sshTunnelError
                  ? 'Tunnel Err'
                  : 'SSH Proxy (Idle)'}
              </span>
            </button>
          )}

          {/* Proxy Pool Indicator */}
          <button
            onClick={() => setShowCfg(true)}
            title={
              activeConfig.useProxies
                ? `${(activeConfig.proxyUrls ?? []).length} proxies configured · Strategy: ${(activeConfig.proxyStrategy ?? 'p2c').toUpperCase()}. Click to manage proxies.`
                : 'Proxy routing disabled. Click to configure proxies.'
            }
            className={cn(
              'flex items-center gap-1.5 rounded-full border px-2 py-0.5 text-[10px] font-medium transition',
              activeConfig.useProxies
                ? (activeConfig.proxyUrls ?? []).length > 0
                  ? 'border-cyan-500/30 bg-cyan-500/10 text-cyan-300 hover:bg-cyan-500/20'
                  : 'border-amber-500/30 bg-amber-500/10 text-amber-300 hover:bg-amber-500/20'
                : 'border-white/10 bg-white/[0.02] text-slate-400 hover:bg-white/[0.06]'
            )}
          >
            <Globe className="h-2.5 w-2.5" />
            <span>
              {!activeConfig.useProxies
                ? 'Direct'
                : (activeConfig.proxyUrls ?? []).length === 0
                ? 'Proxy (0)'
                : `${(activeConfig.proxyUrls ?? []).length} proxies · ${(activeConfig.proxyStrategy ?? 'p2c').toUpperCase()}`}
            </span>
          </button>

          {activeSpec?.supportsKeyPool && (
            <button
              onClick={() => setShowCfg(true)}
              title={`${activeConfig.apiKeys.length} keys pooled · Strategy: ${strategyLabel}. Click to manage keys.`}
              className={cn(
                'flex items-center gap-1.5 rounded-full border px-2 py-0.5 text-[10px] font-medium transition',
                activeConfig.apiKeys.length > 0
                  ? 'border-emerald-500/30 bg-emerald-500/10 text-emerald-300 hover:bg-emerald-500/20'
                  : 'border-amber-500/30 bg-amber-500/10 text-amber-300 hover:bg-amber-500/20'
              )}
            >
              <Key className="h-2.5 w-2.5" />
              <span>
                {activeConfig.apiKeys.length === 0
                  ? 'No keys'
                  : activeConfig.apiKeys.length === 1
                  ? '1 key'
                  : `${activeConfig.apiKeys.length} keys · ${activeConfig.balanceStrategy.toUpperCase()}`}
              </span>
            </button>
          )}

          <button
            onClick={() => probe(activeConfig)}
            disabled={probing}
            title="Refresh models from provider"
            className="rounded-md p-1.5 text-slate-400 hover:bg-white/5 hover:text-white"
          >
            <RefreshCw className={cn('h-3.5 w-3.5', probing && 'animate-spin')} />
          </button>

          <button
            onClick={() => setShowCfg((v) => !v)}
            title="AI Settings & Key Pool Configuration"
            className={cn(
              'rounded-md p-1.5 transition',
              showCfg ? 'bg-cyan-500/20 text-cyan-300' : 'text-slate-400 hover:bg-white/5 hover:text-white'
            )}
          >
            <Settings2 className="h-3.5 w-3.5" />
          </button>
        </div>
      </div>

      {/* ── Settings & Key Pool Management View ── */}
      {showCfg && (
        <div className="max-h-96 space-y-3.5 overflow-y-auto border-b border-white/10 bg-slate-900/90 p-4 shadow-xl">
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

          {/* Endpoint Base URL */}
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
              className="w-full rounded border border-white/10 bg-black/40 px-2.5 py-1.5 font-mono text-[11px] text-slate-200 focus:border-cyan-400/40 focus:outline-none"
            />
          </div>

          {/* Key Management (for providers supporting keys) */}
          {activeSpec?.supportsKeyPool && (
            <div className="space-y-2.5 rounded-lg border border-white/10 bg-black/30 p-3">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-1.5 text-xs font-medium text-slate-200">
                  <Key className="h-3.5 w-3.5 text-amber-400" />
                  <span>API Key Pool ({activeConfig.apiKeys.length} configured)</span>
                </div>
                {activeConfig.apiKeys.length > 0 && (
                  <button
                    onClick={handleClearAllKeys}
                    className="text-[10.5px] text-rose-400 hover:text-rose-300"
                  >
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
                      keyInputMode === 'single' ? 'text-cyan-300 underline underline-offset-4' : 'text-slate-500 hover:text-slate-300'
                    )}
                  >
                    Add Single Key
                  </button>
                  <span className="text-slate-600">·</span>
                  <button
                    onClick={() => setKeyInputMode('batch')}
                    className={cn(
                      'text-[11px] font-medium transition',
                      keyInputMode === 'batch' ? 'text-cyan-300 underline underline-offset-4' : 'text-slate-500 hover:text-slate-300'
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
                        className="w-full rounded border border-white/10 bg-black/40 px-2.5 py-1.5 pr-8 font-mono text-[11px] text-slate-200 placeholder:text-slate-600 focus:outline-none"
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
                      className="w-full resize-none rounded border border-white/10 bg-black/40 px-2.5 py-1.5 font-mono text-[11px] text-slate-200 placeholder:text-slate-600 focus:outline-none"
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
          <div className="space-y-2.5 rounded-lg border border-white/10 bg-black/30 p-3">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-1.5 text-xs font-medium text-slate-200">
                <Globe className="h-3.5 w-3.5 text-cyan-400" />
                <span>Proxy Pool & Routing ({(activeConfig.proxyUrls ?? []).length} configured)</span>
              </div>
              <div className="flex items-center gap-2">
                {(activeConfig.proxyUrls ?? []).length > 0 && (
                  <button
                    onClick={handleClearAllProxies}
                    className="text-[10.5px] text-rose-400 hover:text-rose-300"
                  >
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
                        className="flex-1 rounded border border-white/10 bg-black/40 px-2.5 py-1.5 font-mono text-[11px] text-slate-200 placeholder:text-slate-600 focus:outline-none"
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
                        className="w-full resize-none rounded border border-white/10 bg-black/40 px-2.5 py-1.5 font-mono text-[11px] text-slate-200 placeholder:text-slate-600 focus:outline-none"
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
          <div className="space-y-2.5 rounded-lg border border-white/10 bg-black/30 p-3">
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
              Spawns an isolated local SOCKS5 listener (e.g. <code className="text-cyan-300">127.0.0.1:10885</code>) whenever an SSH connection is active. All AI inference queries automatically route through your remote server&apos;s network interface, seamlessly bypassing ISP routing quotas and regional blocks (such as Gemini europe-west1 rate limits).
            </p>

            {activeConfig.autoSshProxy && (
              <div className="space-y-2 border-t border-white/10 pt-2">
                <div className="space-y-1">
                  <label className="text-[10px] uppercase tracking-wider text-slate-400">
                    Target SSH Host
                  </label>
                  <select
                    value={activeConfig.autoSshHostId || ''}
                    onChange={(e) => handleSelectAutoSshHost(e.target.value || undefined)}
                    className="w-full rounded border border-white/10 bg-black/40 px-2 py-1.5 text-xs text-slate-200 focus:outline-none"
                  >
                    <option value="">⚡ Auto-follow active terminal pane ({activeSshHostId ? (hosts.find(h => h.id === activeSshHostId)?.label || 'Connected host') : 'No SSH active'})</option>
                    {hosts.map((h) => (
                      <option key={h.id} value={h.id}>
                        {h.label || h.hostname} ({h.username}@{h.hostname}:{h.port})
                      </option>
                    ))}
                  </select>
                </div>

                {sshTunnelPort ? (
                  <div className="flex items-center gap-2 rounded border border-emerald-500/20 bg-emerald-500/10 px-2.5 py-1.5 text-xs text-emerald-300">
                    <Check className="h-3.5 w-3.5 shrink-0 text-emerald-400" />
                    <span>
                      Dynamic tunnel active on <strong>127.0.0.1:{sshTunnelPort}</strong>. AI requests exit from {effectiveSshHost?.label || effectiveSshHost?.hostname || 'remote SSH host'}.
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
                      <span>Waiting for an SSH session. Connect to any remote server in the terminal to activate this local proxy.</span>
                    )}
                  </div>
                )}
              </div>
            )}
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
                Strips SSH keys, passwords, Bearer tokens, and cloud credentials from terminal context before sending to external APIs.
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
      )}

      {/* Failover Alert Banner */}
      {failoverAlert && (
        <div className="flex items-center justify-between bg-amber-500/15 px-3 py-1.5 text-[11px] text-amber-200 ring-1 ring-amber-500/30">
          <div className="flex items-center gap-1.5">
            <AlertCircle className="h-3 w-3 text-amber-400 shrink-0" />
            <span>{failoverAlert}</span>
          </div>
          <button onClick={() => setFailoverAlert(null)} className="text-amber-400 hover:text-white">
            <X className="h-3 w-3" />
          </button>
        </div>
      )}

      {/* ── Messages Stream ── */}
      <div ref={scrollRef} className="min-h-0 flex-1 space-y-3.5 overflow-y-auto px-4 py-4">
        {!msgs.length && (
          <div className="flex flex-col items-center pt-6 text-center">
            <div className="relative">
              <div className="absolute inset-0 animate-pulse rounded-full bg-fuchsia-500/20 blur-2xl" />
              <Cpu className="relative h-10 w-10 text-fuchsia-300/80" />
            </div>
            <p className="mt-4 text-sm font-semibold text-slate-200">
              Nexus AI SRE Copilot
            </p>
            <p className="mt-1 max-w-[260px] text-xs text-slate-400">
              Powered by <span className="font-semibold text-cyan-300">{activeConfig.name}</span> ({activeConfig.selectedModel}).
              Reads active terminal context. Suggested commands are risk-classified and never execute without confirmation.
            </p>

            {activeConfig.providerId !== 'ollama' && activeConfig.apiKeys.length === 0 && (
              <div className="mt-3 flex items-center gap-1.5 rounded-lg border border-amber-500/30 bg-amber-500/10 px-3 py-1.5 text-xs text-amber-300">
                <AlertCircle className="h-3.5 w-3.5" />
                <span>No API keys configured. Click Settings (⚙️) to add keys.</span>
              </div>
            )}

            <div className="mt-5 w-full space-y-1.5">
              {quick.map((q) => (
                <button
                  key={q.label}
                  onClick={q.run}
                  className="flex w-full items-center gap-2.5 rounded-lg border border-white/5 bg-white/[0.02] px-3 py-2 text-left text-xs text-slate-300 transition hover:border-fuchsia-400/30 hover:bg-fuchsia-400/5"
                >
                  <q.icon className="h-3.5 w-3.5 text-fuchsia-300" />
                  {q.label}
                </button>
              ))}
            </div>
          </div>
        )}

        {msgs.map((m, i) => (
          <div
            key={i}
            className={cn(
              'text-[12.5px] leading-relaxed',
              m.role === 'user'
                ? 'ml-6 rounded-xl rounded-tr-sm bg-cyan-400/10 px-3.5 py-2.5 text-cyan-50 ring-1 ring-cyan-400/20'
                : 'text-slate-300'
            )}
          >
            {m.role === 'assistant' ? (
              m.content ? (
                <div>
                  <Rich text={m.content} activePaneId={activePaneId} toast={toast} />
                  <div className="mt-1.5 flex flex-wrap items-center gap-2 text-[10px] text-slate-500">
                    {m.modelUsed && <span>model: {m.modelUsed}</span>}
                    {m.keyUsed && (
                      <span className="flex items-center gap-1 text-emerald-400/80">
                        <Key className="h-2.5 w-2.5" /> {m.keyUsed} ({activeConfig.balanceStrategy})
                      </span>
                    )}
                    {m.proxyUsed && (
                      <span className="flex items-center gap-1">
                        {m.proxyUsed.includes('127.0.0.1:10885') || (sshTunnelPort && m.proxyUsed.includes(`127.0.0.1:${sshTunnelPort}`)) ? (
                          <span className="flex items-center gap-1 text-emerald-400/90 font-mono">
                            <Network className="h-2.5 w-2.5 text-emerald-400" /> ssh-proxy: {m.proxyUsed}
                          </span>
                        ) : (
                          <span className="flex items-center gap-1 text-cyan-400/80 font-mono">
                            <Globe className="h-2.5 w-2.5" /> proxy: {m.proxyUsed}
                          </span>
                        )}
                      </span>
                    )}
                    {m.offline && <span className="text-amber-400/80">offline heuristic</span>}
                  </div>
                </div>
              ) : (
                <Dots />
              )
            ) : (
              m.content
            )}
          </div>
        ))}
      </div>

      {msgs.length > 0 && (
        <div className="flex gap-1 overflow-x-auto px-3 pb-2">
          {quick.map((q) => (
            <button
              key={q.label}
              onClick={q.run}
              className="flex shrink-0 items-center gap-1 rounded-full border border-white/10 px-2 py-1 text-[10.5px] text-slate-400 hover:border-fuchsia-400/30 hover:text-fuchsia-200"
            >
              <q.icon className="h-3 w-3" />
              {q.label}
            </button>
          ))}
        </div>
      )}

      {/* ── Chat Input ── */}
      <div className="border-t border-white/10 bg-slate-900/60 p-3 backdrop-blur-sm">
        <div className="flex items-end gap-2 rounded-xl border border-white/10 bg-black/40 p-2 focus-within:border-cyan-400/50">
          <textarea
            value={input}
            onChange={(e) => setInput(e.target.value)}
            rows={2}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                ask(input);
              }
            }}
            placeholder={`Ask ${activeConfig.name} about this session… (Enter to send)`}
            className="max-h-32 flex-1 resize-none bg-transparent text-xs text-slate-100 placeholder:text-slate-600 focus:outline-none"
          />
          {busy ? (
            <button
              onClick={() => abortRef.current?.abort()}
              title="Stop generation"
              className="grid h-7 w-7 place-items-center rounded-lg bg-rose-500/20 text-rose-300 hover:bg-rose-500/30"
            >
              <Square className="h-3 w-3" />
            </button>
          ) : (
            <button
              onClick={() => ask(input)}
              disabled={!input.trim()}
              title="Send prompt"
              className="grid h-7 w-7 place-items-center rounded-lg bg-gradient-to-br from-fuchsia-400 to-cyan-400 text-black transition disabled:opacity-30"
            >
              <Send className="h-3.5 w-3.5" />
            </button>
          )}
        </div>
        <div className="mt-1.5 flex items-center justify-between text-[10px] text-slate-500">
          <div className="flex items-center gap-1">
            <TermIcon className="h-3 w-3 text-slate-400" />
            <span>context: {pane ? `${pane.cwd} · last 80 lines` : 'no active session'}</span>
            {scrubSecrets && <span className="text-cyan-400/80">(secrets scrubbed)</span>}
          </div>
          <div className="flex items-center gap-2">
            {activeConfig.useProxies && (activeConfig.proxyUrls ?? []).length > 0 && (
              <span className="text-cyan-400/80">
                {lastUsedProxy ? `proxy: ${lastUsedProxy} · ` : ''}pool: {(activeConfig.proxyUrls ?? []).length} proxies · {(activeConfig.proxyStrategy ?? 'p2c').toUpperCase()}
              </span>
            )}
            {activeSpec?.supportsKeyPool && activeConfig.apiKeys.length > 0 && (
              <span className="text-slate-400">
                {lastUsedKey ? `key: ${lastUsedKey} · ` : ''}pool: {activeConfig.apiKeys.length} keys · {strategyLabel}
              </span>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

function Dots() {
  return (
    <span className="inline-flex gap-1 py-1">
      {[0, 1, 2].map((i) => (
        <span
          key={i}
          className="h-1.5 w-1.5 animate-bounce rounded-full bg-cyan-400"
          style={{ animationDelay: `${i * 120}ms` }}
        />
      ))}
    </span>
  );
}

function inline(s: string) {
  return s.split(/(`[^`]+`|\*\*[^*]+\*\*)/g).map((p, i) =>
    p.startsWith('`') ? (
      <code key={i} className="rounded bg-white/10 px-1 font-mono text-[11px] text-cyan-200">
        {p.slice(1, -1)}
      </code>
    ) : p.startsWith('**') ? (
      <strong key={i} className="font-semibold text-white">
        {p.slice(2, -2)}
      </strong>
    ) : (
      p
    )
  );
}

function Rich({
  text,
  activePaneId,
  toast,
}: {
  text: string;
  activePaneId: string | null;
  toast: (m: string) => void;
}) {
  const parts = text.split(/```(?:\w+)?\n?([\s\S]*?)(?:```|$)/g);
  return (
    <div className="space-y-2">
      {parts.map((p, i) =>
        i % 2 === 1 ? (
          <CodeBlock key={i} code={p.trim()} activePaneId={activePaneId} toast={toast} />
        ) : (
          p.trim() && (
            <div key={i} className="whitespace-pre-wrap">
              {p
                .trim()
                .split('\n')
                .map((l, j) => (
                  <div key={j}>{inline(l)}</div>
                ))}
            </div>
          )
        )
      )}
    </div>
  );
}

function CodeBlock({
  code,
  activePaneId,
  toast,
}: {
  code: string;
  activePaneId: string | null;
  toast: (m: string) => void;
}) {
  const risk = classifyRisk(code);
  const [confirm, setConfirm] = useState(false);

  const send = (run: boolean) => {
    const p = activePaneId ? registry.get(activePaneId) : undefined;
    if (!p || p.status !== 'connected') {
      toast('No connected session');
      return;
    }
    if (run && risk.level === 'danger' && !confirm) {
      setConfirm(true);
      return;
    }
    p.send(code + (run ? '\r' : ''));
    setConfirm(false);
    toast(run ? 'Command sent' : 'Inserted into terminal — review & press Enter');
  };

  return (
    <div
      className={cn(
        'overflow-hidden rounded-lg border',
        risk.level === 'danger'
          ? 'border-rose-500/30'
          : risk.level === 'caution'
          ? 'border-amber-400/25'
          : 'border-white/10'
      )}
    >
      <pre className="overflow-x-auto bg-black/50 px-3 py-2 font-mono text-[11px] text-emerald-200">{code}</pre>
      <div className="flex items-center gap-1 border-t border-white/5 bg-black/30 px-2 py-1">
        <span
          className={cn(
            'flex items-center gap-1 text-[10px]',
            risk.level === 'danger'
              ? 'text-rose-300'
              : risk.level === 'caution'
              ? 'text-amber-300'
              : 'text-emerald-400'
          )}
        >
          {risk.level !== 'safe' && <ShieldAlert className="h-3 w-3" />}
          {risk.level}
          {risk.reasons.length ? ` · ${risk.reasons[0]}` : ''}
        </span>
        <div className="ml-auto flex gap-0.5">
          <button
            onClick={() => {
              navigator.clipboard.writeText(code);
              toast('Copied');
            }}
            className="rounded p-1 text-slate-400 hover:bg-white/10 hover:text-white"
          >
            <Copy className="h-3 w-3" />
          </button>
          <button
            onClick={() => send(false)}
            className="flex items-center gap-1 rounded px-1.5 py-0.5 text-[10px] text-slate-300 hover:bg-white/10"
          >
            <CornerDownLeft className="h-3 w-3" />
            Insert
          </button>
          <button
            onClick={() => send(true)}
            className={cn(
              'rounded px-1.5 py-0.5 text-[10px] font-semibold transition',
              confirm
                ? 'bg-rose-500 text-white'
                : 'bg-emerald-400/15 text-emerald-300 hover:bg-emerald-400/25'
            )}
          >
            {confirm ? 'Confirm run' : 'Run'}
          </button>
        </div>
      </div>
    </div>
  );
}
