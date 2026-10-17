/**
 * AI Provider Engine, Multi-Key Pooling & Intelligent Load Balancing for Drexius Terminal.
 *
 * Supports:
 * - Local / VPS Ollama (NDJSON)
 * - OpenAI-compatible endpoints (DeepSeek, OpenAI, Groq, OpenRouter, Custom vLLM/Aphrodite) with SSE streaming
 *   and DeepSeek-R1 thought / reasoning_content extraction
 * - Anthropic Claude Messages API (SSE with direct browser access header)
 * - API Key Pooling across multiple keys for the same provider
 * - Configurable Load Balancing strategies:
 *     • Round Robin (cyclic distribution)
 *     • P2C (Power of Two Random Choices — picks key with lowest active in-flight load)
 *     • Random (uniform random distribution)
 * - Automatic HTTP 429 (Rate Limit) failover retry across pooled keys
 * - Terminal context secret scrub / redaction before cloud API calls
 */

import type { AiBalanceStrategy, AiProviderConfig } from './types';
import { bridge, isTauri, type AiStreamEvents } from './bridge';

export interface ChatMsg {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export const DEFAULT_ENDPOINT = 'http://localhost:11434';

/**
 * In the desktop app, API keys and pooled proxies never leave the Rust backend: a route just
 * names the provider, and the backend selects a key/proxy, injects auth and handles failover.
 */
export interface VaultRoute {
  providerId: string;
  events?: AiStreamEvents;
}

/** Only the local SSH SOCKS tunnel is passed from the UI; pooled proxies are chosen by the backend. */
function sshProxyOverride(config: AiProviderConfig): string | undefined {
  const p = config.proxyUrls?.[0];
  return config.autoSshProxy && p && /^socks5:\/\/127\.0\.0\.1:\d+$/.test(p) ? p : undefined;
}

/** Model ids that providers have retired; saved configs pointing at them are migrated on load. */
export const RETIRED_MODELS = new Set<string>([
  'deepseek-chat',
  'deepseek-reasoner',
  'claude-3-5-sonnet-20241022',
  'claude-3-5-haiku-20241022',
  'claude-3-opus-20240229',
  'gemini-2.0-flash',
  'gemini-2.0-flash-thinking-exp',
  'gemini-1.5-flash',
  'gemini-1.5-pro',
]);

export interface ProviderSpec {
  id: string;
  name: string;
  type: 'ollama' | 'openai' | 'anthropic' | 'gemini' | 'opencode';
  defaultBaseUrl: string;
  defaultModel: string;
  supportsKeyPool: boolean;
  docUrl: string;
  popularModels: string[];
}

export const KNOWN_PROVIDERS: ProviderSpec[] = [
  {
    id: 'opencode',
    name: 'OpenCode (Free Models)',
    type: 'opencode',
    defaultBaseUrl: 'local',
    defaultModel: 'opencode/nemotron-3-ultra-free',
    supportsKeyPool: false,
    docUrl: 'https://opencode.ai',
    popularModels: [
      'opencode/nemotron-3-ultra-free',
      'opencode/nemotron-3.5-lightning-free',
      'opencode/ling-3.1-flash-free',
      'opencode/ling-3.0-flash-fin-free',
      'opencode/big-pickle',
      'opencode/exo-free',
      'opencode/longcat-2.5-preview-free',
      'opencode/mimo-v2.6-flash-free',
      'opencode/muse-spark-1.3-contributor-free',
      'opencode/space-bunny-free',
      'opencode/step-5-preview-free',
    ],
  },
  {
    id: 'ollama',
    name: 'Ollama (Local / VPS)',
    type: 'ollama',
    defaultBaseUrl: 'http://localhost:11434',
    defaultModel: 'qwen2.5-coder:7b',
    supportsKeyPool: false,
    docUrl: 'https://ollama.com',
    popularModels: ['qwen2.5-coder:7b', 'deepseek-r1:8b', 'llama3.1:8b', 'mistral:7b', 'codellama', 'starcoder2:7b'],
  },
  {
    id: 'gemini',
    name: 'Google Gemini',
    type: 'gemini',
    defaultBaseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai',
    defaultModel: 'gemini-3.7-flash',
    supportsKeyPool: true,
    docUrl: 'https://aistudio.google.com/apikey',
    popularModels: [
      'gemini-3.7-flash',
      'gemini-3.8-flash',
      'gemini-3.8-flash-lite',
      'gemini-3.1-pro',
      'gemini-2.5-flash',
      'gemini-2.5-pro',
    ],
  },
  {
    id: 'deepseek',
    name: 'DeepSeek',
    type: 'openai',
    defaultBaseUrl: 'https://api.deepseek.com',
    defaultModel: 'deepseek-v4-flash',
    supportsKeyPool: true,
    docUrl: 'https://platform.deepseek.com',
    popularModels: ['deepseek-v4-flash', 'deepseek-v4-pro'],
  },
  {
    id: 'openai',
    name: 'OpenAI',
    type: 'openai',
    defaultBaseUrl: 'https://api.openai.com/v1',
    defaultModel: 'gpt-5-mini',
    supportsKeyPool: true,
    docUrl: 'https://platform.openai.com',
    popularModels: ['gpt-5', 'gpt-5-mini', 'gpt-4o', 'gpt-4o-mini', 'o3-mini'],
  },
  {
    id: 'anthropic',
    name: 'Anthropic Claude',
    type: 'anthropic',
    defaultBaseUrl: 'https://api.anthropic.com',
    defaultModel: 'claude-sonnet-5-5',
    supportsKeyPool: true,
    docUrl: 'https://console.anthropic.com',
    popularModels: ['claude-sonnet-5-5', 'claude-opus-5-5', 'claude-haiku-5-5', 'claude-fable-5-1'],
  },
  {
    id: 'groq',
    name: 'Groq Cloud',
    type: 'openai',
    defaultBaseUrl: 'https://api.groq.com/openai/v1',
    defaultModel: 'llama-3.3-70b-versatile',
    supportsKeyPool: true,
    docUrl: 'https://console.groq.com',
    popularModels: ['llama-3.3-70b-versatile', 'llama-3.1-8b-instant', 'openai/gpt-oss-120b'],
  },
  {
    id: 'openrouter',
    name: 'OpenRouter',
    type: 'openai',
    defaultBaseUrl: 'https://openrouter.ai/api/v1',
    defaultModel: 'deepseek/deepseek-v4-flash',
    supportsKeyPool: true,
    docUrl: 'https://openrouter.ai',
    popularModels: ['deepseek/deepseek-v4-flash', 'anthropic/claude-sonnet-5-5', 'openai/gpt-5-mini', 'meta-llama/llama-3.3-70b-instruct'],
  },
  {
    id: 'custom',
    name: 'Custom (OpenAI-compatible)',
    type: 'openai',
    defaultBaseUrl: 'http://localhost:8000/v1',
    defaultModel: 'default',
    supportsKeyPool: true,
    docUrl: '',
    popularModels: ['default'],
  },
];

export function createDefaultAiConfigs(): AiProviderConfig[] {
  return KNOWN_PROVIDERS.map((p) => ({
    providerId: p.id,
    name: p.name,
    baseUrl: p.defaultBaseUrl,
    apiKeys: [],
    selectedModel: p.defaultModel,
    modelsCache: p.popularModels,
    balanceStrategy: 'p2c' as AiBalanceStrategy,
    enabled: p.id === 'ollama' || p.id === 'gemini' || p.id === 'deepseek',
    updatedAt: Math.floor(Date.now() / 1000),
    useProxies: false,
    proxyUrls: [],
    proxyStrategy: 'p2c' as AiBalanceStrategy,
    autoSshProxy: false,
    autoSshHostId: undefined,
  }));
}

// ─────────────────────── Key Pool & Load Balancer ───────────────────────

export interface KeyStats {
  inFlight: number;
  totalRequests: number;
  errorCount: number;
  rateLimitCooldownUntil: number; // timestamp in ms
  lastUsedAt: number;
}

const keyStatsMap = new Map<string, KeyStats>();
const roundRobinPointers = new Map<string, number>();

function getKeyStats(key: string): KeyStats {
  let stats = keyStatsMap.get(key);
  if (!stats) {
    stats = {
      inFlight: 0,
      totalRequests: 0,
      errorCount: 0,
      rateLimitCooldownUntil: 0,
      lastUsedAt: 0,
    };
    keyStatsMap.set(key, stats);
  }
  return stats;
}

export function maskKey(key: string): string {
  if (!key) return '';
  const trimmed = key.trim();
  if (trimmed.length <= 8) return '****' + trimmed.slice(-3);
  const prefix = trimmed.slice(0, Math.min(8, Math.floor(trimmed.length / 3)));
  const suffix = trimmed.slice(-4);
  return `${prefix}...${suffix}`;
}

export function parseKeyBatch(input: string): string[] {
  const parts = input
    .split(/[\r\n,;]+/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  // Deduplicate preserving order
  return Array.from(new Set(parts));
}

/** Select an optimal key from the pool based on strategy and rate limit health. */
export function selectKeyFromPool(
  providerId: string,
  keys: string[],
  strategy: AiBalanceStrategy = 'p2c'
): { key: string; index: number } | null {
  if (!keys || keys.length === 0) return null;
  if (keys.length === 1) return { key: keys[0], index: 0 };

  const now = Date.now();
  // Filter out keys currently on 429 cooldown
  const availableIndices = keys
    .map((_, i) => i)
    .filter((i) => getKeyStats(keys[i]).rateLimitCooldownUntil <= now);

  // If all keys are in cooldown, pick the one that expires soonest
  const candidateIndices = availableIndices.length > 0
    ? availableIndices
    : [...keys.keys()].sort((a, b) => getKeyStats(keys[a]).rateLimitCooldownUntil - getKeyStats(keys[b]).rateLimitCooldownUntil);

  if (candidateIndices.length === 1) {
    const idx = candidateIndices[0];
    return { key: keys[idx], index: idx };
  }

  if (strategy === 'round_robin') {
    const currentPtr = roundRobinPointers.get(providerId) ?? 0;
    const chosenIdx = candidateIndices[currentPtr % candidateIndices.length];
    roundRobinPointers.set(providerId, (currentPtr + 1) % candidateIndices.length);
    return { key: keys[chosenIdx], index: chosenIdx };
  }

  if (strategy === 'random') {
    const rnd = Math.floor(Math.random() * candidateIndices.length);
    const chosenIdx = candidateIndices[rnd];
    return { key: keys[chosenIdx], index: chosenIdx };
  }

  // Default: P2C (Power of Two Random Choices)
  // Pick two distinct keys randomly and choose the one with lower active in-flight / total load
  const r1 = Math.floor(Math.random() * candidateIndices.length);
  let r2 = Math.floor(Math.random() * candidateIndices.length);
  if (r2 === r1) {
    r2 = (r1 + 1) % candidateIndices.length;
  }
  const idx1 = candidateIndices[r1];
  const idx2 = candidateIndices[r2];
  const s1 = getKeyStats(keys[idx1]);
  const s2 = getKeyStats(keys[idx2]);

  // Score primarily by in-flight active queries, secondarily by total requests
  const score1 = s1.inFlight * 100_000 + s1.totalRequests;
  const score2 = s2.inFlight * 100_000 + s2.totalRequests;

  const bestIdx = score1 <= score2 ? idx1 : idx2;
  return { key: keys[bestIdx], index: bestIdx };
}

// ─────────────────────── Proxy Pool & Load Balancer ───────────────────────

export interface ProxyStats {
  inFlight: number;
  totalRequests: number;
  errorCount: number;
  cooldownUntil: number; // timestamp in ms
  lastUsedAt: number;
}

const proxyStatsMap = new Map<string, ProxyStats>();
const proxyRoundRobinPointers = new Map<string, number>();

export function getProxyStats(proxyUrl: string): ProxyStats {
  let stats = proxyStatsMap.get(proxyUrl);
  if (!stats) {
    stats = {
      inFlight: 0,
      totalRequests: 0,
      errorCount: 0,
      cooldownUntil: 0,
      lastUsedAt: 0,
    };
    proxyStatsMap.set(proxyUrl, stats);
  }
  return stats;
}

export function maskProxyUrl(proxyUrl: string): string {
  if (!proxyUrl) return '';
  const trimmed = proxyUrl.trim();
  try {
    const parsed = new URL(trimmed);
    if (parsed.username || parsed.password) {
      return `${parsed.protocol}//***:***@${parsed.host}${parsed.pathname === '/' ? '' : parsed.pathname}`;
    }
    return trimmed;
  } catch {
    return trimmed.replace(/\/\/([^:]+):([^@]+)@/, '//@');
  }
}

export function normalizeProxyUrl(raw: string): string | null {
  if (!raw) return null;
  const trimmed = raw.trim();
  if (!trimmed) return null;

  // Reject Google/OpenAI API keys accidentally entered
  if (/^(AIza[0-9A-Za-z-_]{35}|sk-[a-zA-Z0-9_\-]{20,})/i.test(trimmed)) return null;

  // Already has protocol: e.g. http://, https://, socks5://, socks5h://
  if (/^(https?|socks5h?):\/\/[^\s]+$/i.test(trimmed)) {
    return trimmed;
  }

  // Format: host:port:username:password
  // e.g. 31.58.9.4:6077:lgfptlrb:917xg24l498y
  const parts = trimmed.split(':');
  if (parts.length === 4) {
    const [p0, p1, p2, p3] = parts;
    // Check if p0 is IP/host and p1 is numeric port
    if (/^\d+$/.test(p1)) {
      return `http://${encodeURIComponent(p2)}:${encodeURIComponent(p3)}@${p0}:${p1}`;
    }
    // Check if p2 is IP/host and p3 is numeric port (username:password:host:port)
    if (/^\d+$/.test(p3)) {
      return `http://${encodeURIComponent(p0)}:${encodeURIComponent(p1)}@${p2}:${p3}`;
    }
  }

  // Format: username:password@host:port
  if (trimmed.includes('@') && !trimmed.includes('://')) {
    return `http://${trimmed}`;
  }

  // Format: host:port
  if (parts.length === 2 && /^\d+$/.test(parts[1])) {
    return `http://${parts[0]}:${parts[1]}`;
  }

  return null;
}

export function isValidProxyUrl(url: string): boolean {
  if (!url) return false;
  return normalizeProxyUrl(url) !== null;
}

export function parseProxyBatch(input: string): string[] {
  const parts = input
    .split(/[\r\n,;]+/)
    .map((s) => s.trim())
    .map(normalizeProxyUrl)
    .filter((s): s is string => s !== null);
  return Array.from(new Set(parts));
}

/** Select an optimal proxy from the pool based on strategy and health cooldown. */
export function selectProxyFromPool(
  providerId: string,
  rawProxies: string[],
  strategy: AiBalanceStrategy = 'p2c'
): { proxy: string; index: number } | null {
  const proxies = (rawProxies || [])
    .map(normalizeProxyUrl)
    .filter((s): s is string => s !== null);
  if (!proxies || proxies.length === 0) return null;
  if (proxies.length === 1) return { proxy: proxies[0], index: 0 };

  const now = Date.now();
  // Filter out proxies currently on cooldown
  const availableIndices = proxies
    .map((_, i) => i)
    .filter((i) => getProxyStats(proxies[i]).cooldownUntil <= now);

  const candidateIndices =
    availableIndices.length > 0
      ? availableIndices
      : [...proxies.keys()].sort(
          (a, b) => getProxyStats(proxies[a]).cooldownUntil - getProxyStats(proxies[b]).cooldownUntil
        );

  if (candidateIndices.length === 1) {
    const idx = candidateIndices[0];
    return { proxy: proxies[idx], index: idx };
  }

  if (strategy === 'round_robin') {
    const currentPtr = proxyRoundRobinPointers.get(providerId) ?? 0;
    const chosenIdx = candidateIndices[currentPtr % candidateIndices.length];
    proxyRoundRobinPointers.set(providerId, (currentPtr + 1) % candidateIndices.length);
    return { proxy: proxies[chosenIdx], index: chosenIdx };
  }

  if (strategy === 'random') {
    const rnd = Math.floor(Math.random() * candidateIndices.length);
    const chosenIdx = candidateIndices[rnd];
    return { proxy: proxies[chosenIdx], index: chosenIdx };
  }

  // P2C (Power of Two Choices)
  const r1 = Math.floor(Math.random() * candidateIndices.length);
  let r2 = Math.floor(Math.random() * candidateIndices.length);
  if (r2 === r1) {
    r2 = (r1 + 1) % candidateIndices.length;
  }
  const idx1 = candidateIndices[r1];
  const idx2 = candidateIndices[r2];
  const s1 = getProxyStats(proxies[idx1]);
  const s2 = getProxyStats(proxies[idx2]);

  const score1 = s1.inFlight * 100_000 + s1.totalRequests;
  const score2 = s2.inFlight * 100_000 + s2.totalRequests;

  const bestIdx = score1 <= score2 ? idx1 : idx2;
  return { proxy: proxies[bestIdx], index: bestIdx };
}

// ─────────────────────── Secret Redaction Filter ───────────────────────

const SECRET_PATTERNS: RegExp[] = [
  /-----BEGIN [A-Z ]+ PRIVATE KEY-----[\s\S]*?-----END [A-Z ]+ PRIVATE KEY-----/g,
  /\b(sk-[a-zA-Z0-9_\-]{20,})\b/g,
  /\b(AIza[0-9A-Za-z-_]{35})\b/g,
  /\b(ghp_[a-zA-Z0-9]{36,})\b/g,
  /\b(gho_[a-zA-Z0-9]{36,})\b/g,
  /\b(xoxb-[0-9]{11,}-[0-9]{11,}-[a-zA-Z0-9]{24,})\b/g,
  /\b(AKIA[0-9A-Z]{16})\b/g,
  /Bearer\s+([a-zA-Z0-9_\-\.]{20,})/gi,
  /(?:password|passwd|secret|token|api_key|apikey)\s*[:=]\s*["']?([^\s"';]+)["']?/gi,
  /https?:\/\/[^:\s]+:([^@\s]+)@/g,
];

export function sanitizeContext(context: string): string {
  if (!context) return '';
  let sanitized = context;
  for (const pattern of SECRET_PATTERNS) {
    sanitized = sanitized.replace(pattern, (match, capture) => {
      if (typeof capture === 'string' && capture.length > 0) {
        const idx = match.indexOf(capture);
        if (idx >= 0) {
          return match.slice(0, idx) + '[REDACTED_SECRET]' + match.slice(idx + capture.length);
        }
      }
      return '[REDACTED_SECRET]';
    });
  }
  return sanitized;
}

// ─────────────────────── Model Listing ───────────────────────

export async function listModelsForProvider(config: AiProviderConfig, specificKey?: string): Promise<string[]> {
  const providerSpec = KNOWN_PROVIDERS.find((p) => p.id === config.providerId);
  const type = providerSpec?.type ?? 'openai';
  const cleanBase = config.baseUrl.replace(/\/+$/, '');

  // Choose key
  // In Tauri the UI only holds MASKED keys; the backend injects the real pooled key. A key the
  // user is testing right now (specificKey) is still sent explicitly.
  const apiKey =
    specificKey ||
    (!isTauri && config.apiKeys.length > 0 ? selectKeyFromPool(config.providerId, config.apiKeys, 'random')?.key : '') ||
    '';

  // Choose proxy if proxy routing is enabled
  const activeProxy = isTauri
    ? sshProxyOverride(config)
    : config.useProxies && config.proxyUrls && config.proxyUrls.length > 0
      ? selectProxyFromPool(config.providerId, config.proxyUrls, config.proxyStrategy ?? 'random')?.proxy
      : undefined;

  if (type === 'opencode' || config.providerId === 'opencode') {
    try {
      const status = await bridge.detectOpencode();
      if (status.installed && status.models && status.models.length > 0) {
        return status.models;
      }
    } catch {
      // Fallback below
    }
    return config.modelsCache && config.modelsCache.length > 0
      ? config.modelsCache
      : providerSpec?.popularModels ?? [
          'opencode/nemotron-3-ultra-free',
          'opencode/nemotron-3.5-lightning-free',
          'opencode/ling-3.1-flash-free',
          'opencode/ling-3.0-flash-fin-free',
          'opencode/big-pickle',
          'opencode/exo-free',
          'opencode/longcat-2.5-preview-free',
          'opencode/mimo-v2.6-flash-free',
          'opencode/muse-spark-1.3-contributor-free',
          'opencode/space-bunny-free',
          'opencode/step-5-preview-free',
        ];
  }

  if (type === 'ollama') {
    if (isTauri || activeProxy) {
      const resp = await bridge.fetchAiProxy({
        url: `${cleanBase}/api/tags`,
        method: 'GET',
        headers: {},
        proxyUrl: activeProxy,
        providerId: config.providerId,
        auth: 'none',
      });
      if (resp.status !== 200) throw new Error(`Ollama returned HTTP ${resp.status}`);
      const j = JSON.parse(resp.body);
      return (j.models ?? []).map((m: { name: string }) => m.name);
    }
    const r = await fetch(`${cleanBase}/api/tags`, { signal: AbortSignal.timeout(3500) });
    if (!r.ok) throw new Error(`Ollama returned HTTP ${r.status}`);
    const j = await r.json();
    return (j.models ?? []).map((m: { name: string }) => m.name);
  }

  if (type === 'anthropic') {
    try {
      const headers: Record<string, string> = {
        'anthropic-version': '2023-06-01',
        'anthropic-dangerous-direct-browser-access': 'true',
      };
      if (apiKey) headers['x-api-key'] = apiKey;

      if (isTauri || activeProxy) {
        const resp = await bridge.fetchAiProxy({
          url: `${cleanBase}/v1/models`,
          method: 'GET',
          headers,
          proxyUrl: activeProxy,
          providerId: config.providerId,
          auth: 'anthropic',
        });
        if (resp.status === 200) {
          const j = JSON.parse(resp.body);
          if (Array.isArray(j.data)) {
            const list = j.data.map((m: { id: string }) => m.id);
            if (list.length > 0) return list;
          }
        }
      } else {
        const r = await fetch(`${cleanBase}/v1/models`, {
          headers,
          signal: AbortSignal.timeout(4000),
        });
        if (r.ok) {
          const j = await r.json();
          if (Array.isArray(j.data)) {
            const list = j.data.map((m: { id: string }) => m.id);
            if (list.length > 0) return list;
          }
        }
      }
    } catch {
      // Fallback below
    }
    return config.modelsCache && config.modelsCache.length > 0
      ? config.modelsCache
      : providerSpec?.popularModels ?? ['claude-sonnet-5-5', 'claude-haiku-5-5'];
  }

  if (type === 'gemini' || config.providerId === 'gemini') {
    let geminiBase = cleanBase;
    if (!geminiBase.endsWith('/openai')) {
      if (geminiBase.endsWith('/v1beta')) {
        geminiBase = `${geminiBase}/openai`;
      } else if (geminiBase.includes('googleapis.com')) {
        geminiBase = `${geminiBase}/v1beta/openai`;
      }
    }
    const headers: Record<string, string> = {};
    if (apiKey) {
      headers['Authorization'] = `Bearer ${apiKey}`;
      headers['x-goog-api-key'] = apiKey;
    }
    try {
      if (isTauri || activeProxy) {
        const resp = await bridge.fetchAiProxy({
          url: `${geminiBase}/models`,
          method: 'GET',
          headers,
          proxyUrl: activeProxy,
          providerId: config.providerId,
          auth: 'gemini',
        });
        if (resp.status === 200) {
          const j = JSON.parse(resp.body);
          if (Array.isArray(j.data)) {
            const ids = j.data
              .map((m: { id: string }) => m.id)
              .filter((id: string) => id.includes('gemini'));
            if (ids.length > 0) return ids.sort();
          }
        }
      } else {
        const r = await fetch(`${geminiBase}/models`, { headers, signal: AbortSignal.timeout(5000) });
        if (r.ok) {
          const j = await r.json();
          if (Array.isArray(j.data)) {
            const ids = j.data
              .map((m: { id: string }) => m.id)
              .filter((id: string) => id.includes('gemini'));
            if (ids.length > 0) return ids.sort();
          }
        }
      }
    } catch {
      // Fallback below
    }
    return config.modelsCache && config.modelsCache.length > 0
      ? config.modelsCache
      : providerSpec?.popularModels ?? ['gemini-3.7-flash', 'gemini-2.5-flash', 'gemini-2.5-pro'];
  }

  // OpenAI-compatible format (OpenAI, DeepSeek, Groq, OpenRouter, Custom)
  const modelsUrl = cleanBase.endsWith('/v1') ? `${cleanBase}/models` : `${cleanBase}/v1/models`;
  const headers: Record<string, string> = {};
  if (apiKey) headers['Authorization'] = `Bearer ${apiKey}`;
  if (config.providerId === 'openrouter') {
    headers['HTTP-Referer'] = 'https://drexiusterminal.app';
    headers['X-Title'] = 'Drexius Terminal';
  }

  try {
    if (isTauri || activeProxy) {
      const resp = await bridge.fetchAiProxy({
        url: modelsUrl,
        method: 'GET',
        headers,
        proxyUrl: activeProxy,
        providerId: config.providerId,
        auth: 'bearer',
      });
      if (resp.status === 200) {
        const j = JSON.parse(resp.body);
        if (Array.isArray(j.data)) {
          return j.data.map((m: { id: string }) => m.id).sort();
        }
      }
      if (modelsUrl.includes('/v1/models')) {
        const altUrl = `${cleanBase}/models`;
        const resp2 = await bridge.fetchAiProxy({
          url: altUrl,
          method: 'GET',
          headers,
          proxyUrl: activeProxy,
          providerId: config.providerId,
          auth: 'bearer',
        });
        if (resp2.status === 200) {
          const j2 = JSON.parse(resp2.body);
          if (Array.isArray(j2.data)) {
            return j2.data.map((m: { id: string }) => m.id).sort();
          }
        }
      }
      throw new Error(`Provider returned HTTP ${resp.status}`);
    } else {
      const r = await fetch(modelsUrl, { headers, signal: AbortSignal.timeout(5000) });
      if (!r.ok) {
        // Try alternate without /v1 if failed
        if (modelsUrl.includes('/v1/models')) {
          const altUrl = `${cleanBase}/models`;
          const r2 = await fetch(altUrl, { headers, signal: AbortSignal.timeout(3500) });
          if (r2.ok) {
            const j2 = await r2.json();
            if (Array.isArray(j2.data)) {
              return j2.data.map((m: { id: string }) => m.id).sort();
            }
          }
        }
        throw new Error(`Provider returned HTTP ${r.status}`);
      }
      const j = await r.json();
      if (Array.isArray(j.data)) {
        return j.data.map((m: { id: string }) => m.id).sort();
      }
      return config.modelsCache ?? [];
    }
  } catch (err) {
    if (config.modelsCache && config.modelsCache.length > 0) {
      return config.modelsCache;
    }
    throw err;
  }
}

// Backward-compatible listModels for local Ollama
export async function listModels(endpoint: string): Promise<string[]> {
  const r = await fetch(`${endpoint.replace(/\/$/, '')}/api/tags`, { signal: AbortSignal.timeout(2500) });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  const j = await r.json();
  return (j.models ?? []).map((m: { name: string }) => m.name);
}

// ─────────────────────── Streaming Inference ───────────────────────

export interface StreamCallbacks {
  onToken: (token: string) => void;
  onKeyUsed?: (maskedKey: string, providerName: string) => void;
  onProxyUsed?: (maskedProxy: string) => void;
  onFailover?: (reason: string, nextKeyMask: string) => void;
}

export async function chatStreamMultiProvider(
  config: AiProviderConfig,
  messages: ChatMsg[],
  callbacks: StreamCallbacks,
  signal?: AbortSignal,
  cwd?: string,
  sessionId?: string | null,
  hostId?: string | null
): Promise<void> {
  const providerSpec = KNOWN_PROVIDERS.find((p) => p.id === config.providerId);
  const type = providerSpec?.type ?? 'openai';
  const cleanBase = config.baseUrl.replace(/\/+$/, '');
  const keys = config.apiKeys ?? [];
  const proxies = config.proxyUrls ?? [];
  const useProxies = Boolean(config.useProxies && proxies.length > 0);

  if (type !== 'ollama' && type !== 'opencode' && keys.length === 0) {
    throw new Error(`No API keys configured for ${config.name || config.providerId}. Please add an API key in AI Settings.`);
  }

  if (type === 'opencode' || config.providerId === 'opencode') {
    return streamOpencodeRunner(config, messages, callbacks, signal, cwd, sessionId, hostId);
  }

  // Desktop app: the backend owns key/proxy selection, auth injection and failover.
  if (isTauri) {
    return chatStreamViaVault(config, type, cleanBase, messages, callbacks, signal);
  }

  const maxKeyAttempts = keys.length > 1 ? Math.min(keys.length, 3) : 1;
  const maxProxyAttempts = useProxies && proxies.length > 1 ? Math.min(proxies.length, 3) : 1;
  const maxAttempts = Math.max(maxKeyAttempts, maxProxyAttempts);

  let attempt = 0;
  let lastError: Error | null = null;
  const triedKeys = new Set<string>();
  const triedProxies = new Set<string>();

  while (attempt < maxAttempts) {
    attempt++;
    const keyChoice = selectKeyFromPool(config.providerId, keys.filter((k) => !triedKeys.has(k)), config.balanceStrategy);
    const apiKey = keyChoice?.key ?? (keys[0] || '');
    if (apiKey) triedKeys.add(apiKey);

    const stats = apiKey ? getKeyStats(apiKey) : null;
    if (stats) {
      stats.inFlight++;
      stats.totalRequests++;
      stats.lastUsedAt = Date.now();
    }

    if (apiKey && callbacks.onKeyUsed) {
      callbacks.onKeyUsed(maskKey(apiKey), config.name || config.providerId);
    }

    // Select proxy if proxy pool enabled
    let activeProxy: string | undefined;
    let proxyStat: ProxyStats | null = null;
    if (useProxies) {
      const candidateProxies = proxies.filter((p) => !triedProxies.has(p));
      const proxyChoice = selectProxyFromPool(
        config.providerId,
        candidateProxies.length > 0 ? candidateProxies : proxies,
        config.proxyStrategy ?? config.balanceStrategy
      );
      if (proxyChoice) {
        activeProxy = proxyChoice.proxy;
        triedProxies.add(activeProxy);
        proxyStat = getProxyStats(activeProxy);
        proxyStat.inFlight++;
        proxyStat.totalRequests++;
        proxyStat.lastUsedAt = Date.now();
        if (callbacks.onProxyUsed) {
          callbacks.onProxyUsed(maskProxyUrl(activeProxy));
        }
      }
    }

    try {
      if (type === 'ollama') {
        await streamOllama(cleanBase, config.selectedModel, messages, callbacks.onToken, signal, activeProxy);
        return;
      }

      if (type === 'anthropic') {
        await streamAnthropic(cleanBase, config.selectedModel, apiKey, messages, callbacks.onToken, signal, activeProxy);
        return;
      }

      // OpenAI-compatible
      await streamOpenAi(config, cleanBase, apiKey, messages, callbacks.onToken, signal, activeProxy);
      return;
    } catch (err: unknown) {
      const error =
        err instanceof Error
          ? err
          : new Error(typeof err === 'string' ? err : (err as Error)?.message || String(err));
      const errMsg = error.message || '';
      if (stats) stats.errorCount++;
      if (proxyStat) proxyStat.errorCount++;

      // Check if it's a proxy network failure
      const isProxyError =
        activeProxy &&
        (/proxy (connect|error|auth)|proxy connection failed|stream read error|error trying to connect|connectex|econnrefused|connection (reset|refused|closed)|timed? ?out|socks|tunnel/i.test(errMsg) &&
          !HTTP_429_RE.test(errMsg));

      if (isProxyError && proxyStat && activeProxy) {
        proxyStat.cooldownUntil = Date.now() + 60_000;
        const remainingProxies = proxies.filter((p) => !triedProxies.has(p));
        if (remainingProxies.length > 0 && callbacks.onFailover) {
          callbacks.onFailover(
            `Proxy ${maskProxyUrl(activeProxy)} failed. Rotating to next proxy...`,
            maskProxyUrl(remainingProxies[0])
          );
        }
      }

      // Rate limit HTTP 429 handling: failover to another key
      const isRateLimit = HTTP_429_RE.test(errMsg) || /rate limit|quota|too many requests/i.test(errMsg);
      if (isRateLimit) {
        if (stats && apiKey) {
          stats.rateLimitCooldownUntil = Date.now() + 60_000; // 60s cooldown
          const remainingKeys = keys.filter((k) => !triedKeys.has(k));
          if (remainingKeys.length > 0 && callbacks.onFailover) {
            callbacks.onFailover(
              `Rate limit hit on key ${maskKey(apiKey)}. Rotating to next pooled key...`,
              maskKey(remainingKeys[0])
            );
          }
        }
        // If proxies are used, also rotate proxy on 429 because regional quota (like Gemini) is geo-dependent
        if (proxyStat && activeProxy && proxies.length > 1) {
          proxyStat.cooldownUntil = Date.now() + 60_000;
          const remainingProxies = proxies.filter((p) => !triedProxies.has(p));
          if (remainingProxies.length > 0 && callbacks.onFailover) {
            callbacks.onFailover(
              `Quota hit in current region. Rotating to proxy ${maskProxyUrl(remainingProxies[0])}...`,
              maskProxyUrl(remainingProxies[0])
            );
          }
        }
      }

      lastError = error;
      if (signal?.aborted) throw error;

      const canRetryKey = isRateLimit && keys.filter((k) => !triedKeys.has(k)).length > 0;
      const canRetryProxy = Boolean(
        (isProxyError || (isRateLimit && proxies.length > 1)) &&
          proxies.filter((p) => !triedProxies.has(p)).length > 0
      );

      if (!canRetryKey && !canRetryProxy) throw error;
    } finally {
      if (stats) stats.inFlight = Math.max(0, stats.inFlight - 1);
      if (proxyStat) proxyStat.inFlight = Math.max(0, proxyStat.inFlight - 1);
    }
  }

  if (lastError) throw lastError;
}

async function chatStreamViaVault(
  config: AiProviderConfig,
  type: ProviderSpec['type'],
  cleanBase: string,
  messages: ChatMsg[],
  callbacks: StreamCallbacks,
  signal?: AbortSignal
): Promise<void> {
  const route: VaultRoute = {
    providerId: config.providerId,
    events: {
      onMeta: (keyMask, proxyMask) => {
        if (keyMask) callbacks.onKeyUsed?.(keyMask, config.name || config.providerId);
        if (proxyMask) callbacks.onProxyUsed?.(proxyMask);
      },
      onFailover: (reason, next) => callbacks.onFailover?.(reason, next),
    },
  };
  const override = sshProxyOverride(config);

  if (type === 'ollama') {
    return streamOllama(cleanBase, config.selectedModel, messages, callbacks.onToken, signal, override, route);
  }
  if (type === 'anthropic') {
    return streamAnthropic(cleanBase, config.selectedModel, '', messages, callbacks.onToken, signal, override, route);
  }
  return streamOpenAi(config, cleanBase, '', messages, callbacks.onToken, signal, override, route);
}

export function formatMessagesForOpencode(messages: ChatMsg[]): string {
  const parts: string[] = [];
  for (const m of messages) {
    if (m.role === 'system') {
      parts.push(`[System Instructions]\n${m.content}`);
    } else if (m.role === 'user') {
      parts.push(`[User]\n${m.content}`);
    } else if (m.role === 'assistant') {
      parts.push(`[Assistant]\n${m.content}`);
    }
  }
  return parts.join('\n\n');
}

/** Autonomous (`--auto`) OpenCode mode is opt-in and off unless the user enabled it in the AI panel. */
export const OPENCODE_AUTONOMOUS_KEY = 'drx.ai.opencode_autonomous';
export function isOpencodeAutonomous(): boolean {
  try {
    return localStorage.getItem(OPENCODE_AUTONOMOUS_KEY) === 'true';
  } catch {
    return false;
  }
}

async function streamOpencodeRunner(
  config: AiProviderConfig,
  messages: ChatMsg[],
  callbacks: StreamCallbacks,
  signal?: AbortSignal,
  cwd?: string,
  sessionId?: string | null,
  hostId?: string | null
): Promise<void> {
  const prompt = formatMessagesForOpencode(messages);
  const model = config.selectedModel || 'opencode/nemotron-3-ultra-free';
  await bridge.streamOpencode(
    {
      prompt,
      model,
      cwd,
      autonomous: isOpencodeAutonomous(),
      sessionId,
      hostId,
    },
    callbacks.onToken,
    signal,
    {
      onMeta: (keyMask) => {
        callbacks.onKeyUsed?.(keyMask || 'Free (Local OpenCode)', config.name || 'OpenCode');
      },
      onFailover: (reason, next) => {
        callbacks.onFailover?.(reason, next);
      },
    }
  );
}

/** Matches an HTTP 429 status as formatted by this module (not any stray "429" in a message). */
const HTTP_429_RE = /\bHTTP 429\b/;

export function formatApiError(status: number, rawText: string, providerName: string): string {
  try {
    const parsed = JSON.parse(rawText);
    const errObj = Array.isArray(parsed) ? parsed[0]?.error : parsed?.error;
    if (errObj) {
      const msg = errObj.message || rawText;
      if (status === 429) {
        if (rawText.includes('quota_limit_value') && rawText.includes('"0"')) {
          const region = errObj.details?.[0]?.metadata?.quota_location || 'europe-west1';
          const project = errObj.details?.[0]?.metadata?.consumer?.replace('projects/', '') || '';
          return `${providerName} Quota is 0 requests/min in region '${region}' (project ${project}).\n\n💡 Google Cloud requires linking a Cloud Billing Account to your project in Google Cloud Console / AI Studio to enable Gemini inference in Europe. Alternatively, you can enable Proxy Routing (in AI Settings) to route requests through a non-EU proxy, or use DeepSeek / OpenAI without this restriction.`;
        }
        return `${providerName} rate limit (HTTP 429): ${msg}`;
      }
      return `${providerName} error (HTTP ${status}): ${msg}`;
    }
  } catch {
    // not JSON
  }
  return `${providerName} HTTP ${status}: ${rawText.slice(0, 300)}`;
}

async function streamOllama(
  endpoint: string,
  model: string,
  messages: ChatMsg[],
  onToken: (t: string) => void,
  signal?: AbortSignal,
  proxyUrl?: string,
  route?: VaultRoute
) {
  const payload = JSON.stringify({ model, messages, stream: true, options: { temperature: 0.2 } });
  let buf = '';

  const handleChunk = (chunkText: string) => {
    if (signal?.aborted) return;
    buf += chunkText;
    let nl: number;
    while ((nl = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (!line) continue;
      try {
        const j = JSON.parse(line);
        if (j.message?.content) onToken(j.message.content);
        if (j.error) throw new Error(j.error);
      } catch (e) {
        if (e instanceof Error && !(e instanceof SyntaxError)) throw e;
      }
    }
  };

  if (isTauri || proxyUrl) {
    try {
      await bridge.streamAiProxy(
        {
          url: `${endpoint}/api/chat`,
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: payload,
          proxyUrl,
          providerId: route?.providerId,
          auth: 'none',
        },
        handleChunk,
        signal,
        route?.events
      );
      return;
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      const match = msg.match(/^HTTP (\d+): ([\s\S]*)$/);
      if (match) {
        throw new Error(formatApiError(parseInt(match[1], 10), match[2], 'Ollama'));
      }
      throw err instanceof Error ? err : new Error(msg);
    }
  }

  const r = await fetch(`${endpoint}/api/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: payload,
    signal,
  });
  if (!r.ok || !r.body) {
    const raw = await r.text().catch(() => '');
    throw new Error(formatApiError(r.status, raw, 'Ollama'));
  }
  const reader = r.body.getReader();
  const dec = new TextDecoder();
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    handleChunk(dec.decode(value, { stream: true }));
  }
}

async function streamAnthropic(
  baseUrl: string,
  model: string,
  apiKey: string,
  messages: ChatMsg[],
  onToken: (t: string) => void,
  signal?: AbortSignal,
  proxyUrl?: string,
  route?: VaultRoute
) {
  // Separate system prompt from messages for Anthropic
  const systemMsgs = messages.filter((m) => m.role === 'system').map((m) => m.content).join('\n\n');
  const chatMsgs = messages
    .filter((m) => m.role !== 'system')
    .map((m) => ({ role: m.role as 'user' | 'assistant', content: m.content }));

  // Ensure there is at least one user message
  if (chatMsgs.length === 0 || chatMsgs[0].role !== 'user') {
    chatMsgs.unshift({ role: 'user', content: 'Analyze session context.' });
  }

  const endpoint = baseUrl.endsWith('/v1/messages') ? baseUrl : `${baseUrl}/v1/messages`;
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    'x-api-key': apiKey,
    'anthropic-version': '2023-06-01',
    'anthropic-dangerous-direct-browser-access': 'true',
  };
  const payload = JSON.stringify({
    model,
    max_tokens: 4096,
    system: systemMsgs || undefined,
    messages: chatMsgs,
    stream: true,
    temperature: 0.2,
  });

  let buf = '';
  const handleChunk = (chunkText: string) => {
    if (signal?.aborted) return;
    buf += chunkText;
    let nl: number;
    while ((nl = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (!line.startsWith('data:')) continue;
      const dataStr = line.slice(5).trim();
      if (!dataStr || dataStr === '[DONE]') continue;
      try {
        const j = JSON.parse(dataStr);
        if (j.type === 'content_block_delta' && j.delta?.text) {
          onToken(j.delta.text);
        } else if (j.type === 'error') {
          throw new Error(j.error?.message || 'Anthropic stream error');
        }
      } catch (e) {
        if (e instanceof Error && !(e instanceof SyntaxError)) throw e;
      }
    }
  };

  if (isTauri || proxyUrl) {
    try {
      await bridge.streamAiProxy(
        {
          url: endpoint,
          method: 'POST',
          headers,
          body: payload,
          proxyUrl,
          providerId: route?.providerId,
          auth: 'anthropic',
        },
        handleChunk,
        signal,
        route?.events
      );
      return;
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      const match = msg.match(/^HTTP (\d+): ([\s\S]*)$/);
      if (match) {
        throw new Error(formatApiError(parseInt(match[1], 10), match[2], 'Anthropic Claude'));
      }
      throw err instanceof Error ? err : new Error(msg);
    }
  }

  const r = await fetch(endpoint, {
    method: 'POST',
    headers,
    body: payload,
    signal,
  });

  if (!r.ok || !r.body) {
    const raw = await r.text().catch(() => '');
    throw new Error(formatApiError(r.status, raw, 'Anthropic Claude'));
  }

  const reader = r.body.getReader();
  const dec = new TextDecoder();
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    handleChunk(dec.decode(value, { stream: true }));
  }
}

async function streamOpenAi(
  config: AiProviderConfig,
  baseUrl: string,
  apiKey: string,
  messages: ChatMsg[],
  onToken: (t: string) => void,
  signal?: AbortSignal,
  proxyUrl?: string,
  route?: VaultRoute
) {
  let endpoint = baseUrl;
  if (config.providerId === 'gemini') {
    if (!endpoint.includes('/openai')) {
      if (endpoint.endsWith('/v1beta')) {
        endpoint = `${endpoint}/openai`;
      } else if (endpoint.includes('googleapis.com')) {
        endpoint = `${endpoint}/v1beta/openai`;
      }
    }
  }

  if (endpoint.endsWith('/chat/completions')) {
    // already full endpoint
  } else if (endpoint.endsWith('/v1') || endpoint.endsWith('/openai')) {
    endpoint = `${endpoint}/chat/completions`;
  } else {
    // Check if provider needs /chat/completions or /v1/chat/completions
    endpoint = `${endpoint}/chat/completions`;
  }

  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
  };
  if (apiKey) {
    headers['Authorization'] = `Bearer ${apiKey}`;
    if (config.providerId === 'gemini') {
      headers['x-goog-api-key'] = apiKey;
    }
  }
  if (config.providerId === 'openrouter') {
    headers['HTTP-Referer'] = 'https://drexiusterminal.app';
    headers['X-Title'] = 'Drexius Terminal';
  }

  const payload = JSON.stringify({
    model: config.selectedModel,
    messages,
    stream: true,
    temperature: 0.2,
  });

  let buf = '';
  let hadReasoning = false;
  let reasoningDone = false;

  const handleChunk = (chunkText: string) => {
    if (signal?.aborted) return;
    buf += chunkText;
    let nl: number;
    while ((nl = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (!line.startsWith('data:')) continue;
      const dataStr = line.slice(5).trim();
      if (!dataStr || dataStr === '[DONE]') continue;
      try {
        const j = JSON.parse(dataStr);
        const delta = j.choices?.[0]?.delta;
        if (!delta) continue;

        // Support for DeepSeek-R1 / thinking models
        if (delta.reasoning_content) {
          if (!hadReasoning) {
            hadReasoning = true;
            onToken('💭 *Thinking…*\n> ');
          }
          onToken(delta.reasoning_content.replace(/\n/g, '\n> '));
        }

        if (delta.content) {
          if (hadReasoning && !reasoningDone) {
            reasoningDone = true;
            onToken('\n\n---\n\n');
          }
          onToken(delta.content);
        }
      } catch (e) {
        if (e instanceof Error && !(e instanceof SyntaxError)) throw e;
      }
    }
  };

  if (isTauri || proxyUrl) {
    try {
      await bridge.streamAiProxy(
        {
          url: endpoint,
          method: 'POST',
          headers,
          body: payload,
          proxyUrl,
          providerId: route?.providerId,
          auth: config.providerId === 'gemini' ? 'gemini' : 'bearer',
        },
        handleChunk,
        signal,
        route?.events
      );
      return;
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      const match = msg.match(/^HTTP (\d+): ([\s\S]*)$/);
      if (match) {
        throw new Error(formatApiError(parseInt(match[1], 10), match[2], config.name || 'AI'));
      }
      throw err instanceof Error ? err : new Error(msg);
    }
  }

  const r = await fetch(endpoint, {
    method: 'POST',
    headers,
    body: payload,
    signal,
  });

  if (!r.ok || !r.body) {
    const raw = await r.text().catch(() => '');
    throw new Error(formatApiError(r.status, raw, config.name || 'AI'));
  }

  const reader = r.body.getReader();
  const dec = new TextDecoder();
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    handleChunk(dec.decode(value, { stream: true }));
  }
}

// Backward-compatible chatStream for legacy calls
export async function chatStream(
  endpoint: string,
  model: string,
  messages: ChatMsg[],
  onToken: (t: string) => void,
  signal?: AbortSignal
) {
  return streamOllama(endpoint.replace(/\/$/, ''), model, messages, onToken, signal);
}

// ─────────────────────── SRE System Prompt & Risk Scoring ───────────────────────

export const SYSTEM_PROMPT_CHAT = `You are Drexius, a senior SRE assistant embedded inside an SSH terminal client.
Rules:
- Be concise. Prefer bullet points.
- When suggesting commands, put each runnable command in its own \`\`\`bash fenced block.
- Do NOT output raw tool call tokens like <|tool_call_start|> or <tool_call>. Format all runnable commands in \`\`\`bash code blocks.
- Never suggest destructive commands without a clear warning line starting with "⚠️".
- Prefer safe, read-only diagnostics first. Quote paths. Use set -euo pipefail for scripts.
- You are given the recent terminal output and the current working directory as context.`;

export const SYSTEM_PROMPT = SYSTEM_PROMPT_CHAT;

export type Risk = { level: 'safe' | 'caution' | 'danger'; reasons: string[] };

const DANGER: [RegExp, string][] = [
  [/\brm\b(?=[^;&|\n]*\s(?:-[a-zA-Z]*[rR][a-zA-Z]*|--recursive)(?:\s|$))(?=[^;&|\n]*\s(?:-[a-zA-Z]*[fF][a-zA-Z]*|--force)(?:\s|$))/, 'recursive force delete'],
  [/--no-preserve-root/, 'deletes the filesystem root'],
  [/\b(shred|wipefs)\b/, 'irreversibly destroys data'],
  [/\bmkfs(\.\w+)?\b/, 'formats a filesystem'],
  [/\bdd\s+.*of=\/dev\//, 'raw write to block device'],
  [/:\(\)\s*\{\s*:\|:&\s*\};:/, 'fork bomb'],
  [/\bchmod\s+(-R\s+)?777\b/, 'world-writable permissions'],
  [/>\s*\/dev\/sd[a-z]/, 'overwrites a disk'],
  [/\b(shutdown|reboot|halt|poweroff)\b/, 'stops the machine'],
  [/\b(curl|wget)\b[^|\n]*\|\s*(sudo\s+)?(ba|z|da)?sh\b/, 'pipes remote script to shell'],
  [/\b(ba|z|da)?sh\s+<\(\s*(curl|wget)\b/, 'runs a downloaded script'],
  [/\$\(\s*(curl|wget)\b/, 'executes downloaded content'],
  [/\bDROP\s+(TABLE|DATABASE)\b/i, 'drops database objects'],
];

const CAUTION: [RegExp, string][] = [
  [/\bsudo\b/, 'elevated privileges'],
  [/\brm\b/, 'deletes files'],
  [/\b(systemctl|service)\s+(stop|restart|disable)/, 'changes service state'],
  [/\bkill(all)?\b/, 'terminates processes'],
  [/\b(apt|yum|dnf|pacman)\b.*\b(remove|purge|upgrade)\b/, 'modifies packages'],
  [/\bgit\s+(push\s+.*--force|reset\s+--hard)/, 'rewrites git history'],
  [/\bdocker\s+(rm|rmi|system\s+prune)/, 'removes containers/images'],
];

export function classifyRisk(cmd: string): Risk {
  const d = DANGER.filter(([r]) => r.test(cmd)).map(([, s]) => s);
  if (d.length) return { level: 'danger', reasons: d };
  const c = CAUTION.filter(([r]) => r.test(cmd)).map(([, s]) => s);
  if (c.length) return { level: 'caution', reasons: c };
  return { level: 'safe', reasons: [] };
}

// ─────────────────────── Offline Heuristic Fallback ───────────────────────

const EXPLAIN: Record<string, string> = {
  ls: 'lists directory contents', cd: 'changes the working directory', grep: 'filters lines matching a pattern', tail: 'prints the last lines of a file',
  head: 'prints the first lines of a file', du: 'estimates disk usage', df: 'reports filesystem free space', sort: 'sorts lines', docker: 'manages containers',
  systemctl: 'controls systemd services', free: 'shows memory usage', ps: 'lists processes', ss: 'dumps socket statistics', find: 'searches for files', awk: 'pattern-scanning text processor',
  sed: 'stream editor for transforming text', xargs: 'builds commands from stdin', chmod: 'changes file permissions', chown: 'changes file owner', tar: 'archives files', journalctl: 'queries the systemd journal',
};

export function offlineAnswer(prompt: string, context: string): string {
  const lower = prompt.toLowerCase();
  if (/error|fail|troubleshoot|why|refused/.test(lower) || /refused|failed|error/i.test(context.slice(-1500))) {
    const refused = /connection refused|connect\(\) failed/i.test(context);
    const ssl = /SSL_do_handshake|wrong version number/i.test(context);
    const restarting = /Restarting \(1\)/.test(context);
    const lines = ['**Offline heuristic analysis** (configure an AI provider or local model for deeper reasoning):', ''];
    if (refused) lines.push('- Upstream on `127.0.0.1:8080` is refusing connections → the app process is down or not listening.');
    if (restarting) lines.push('- The API container is in a restart loop (exit code 1).');
    if (ssl) lines.push('- `wrong version number` usually means plain HTTP is being sent to an HTTPS port (or vice-versa).');
    if (!refused && !ssl && !restarting) lines.push('- No well-known failure signature found in the last output. Try sharing the full error line.');
    lines.push('', 'Safe next steps:', '```bash\ndocker ps\n```', '```bash\nsystemctl status api\n```', '```bash\ntail -n 50 /var/log/nginx/error.log | grep -i error\n```');
    return lines.join('\n');
  }
  const cmd = prompt.replace(/^explain\s*:?\s*/i, '').trim();
  const parts = cmd.split('|').map((p) => p.trim().split(/\s+/)[0]).filter(Boolean);
  if (parts.length && parts.some((p) => EXPLAIN[p])) {
    return ['**Offline breakdown:**', '', ...parts.map((p, i) => `${i + 1}. \`${p}\` — ${EXPLAIN[p] ?? 'custom command'}`), '', 'Risk: **' + classifyRisk(cmd).level + '**'].join('\n');
  }
  return "I can't reach an active AI provider right now. You can configure **DeepSeek**, **OpenAI**, **Anthropic Claude**, **Groq**, **OpenRouter**, or a local **Ollama** model via the AI Settings (••• icon) above.\n\nKey features:\n• **Multi-key pooling & load balancing** (Round Robin, P2C, Random)\n• **Automatic failover** on rate limits (HTTP 429)\n• **Encrypted vault sync** across paired devices\n• **Automatic secret redaction** from terminal output.";
}
