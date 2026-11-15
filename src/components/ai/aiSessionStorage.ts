import { createDefaultAiConfigs, isValidProxyUrl } from '../../lib/ollama';
import type { AiProviderConfig, Host } from '../../lib/types';

export interface Msg {
  id?: string;
  role: 'user' | 'assistant' | 'tool';
  content: string;
  offline?: boolean;
  modelUsed?: string;
  keyUsed?: string;
  proxyUsed?: string;
}

export const createMsgId = () => Math.random().toString(36).slice(2, 10) + Date.now().toString(36);

export const sanitizeConfigsForStorage = (cfgs: AiProviderConfig[]): AiProviderConfig[] => {
  return cfgs.map((c) => ({
    ...c,
    apiKeys: [], // Never store API keys in unencrypted localStorage
    proxyUrls: [], // Proxy URLs can embed credentials; never cache them either
  }));
};

export const loadCachedConfigs = (): AiProviderConfig[] => {
  const defaults = createDefaultAiConfigs();
  try {
    const raw = localStorage.getItem('drx.ai.configs');
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

export interface SavedChatSession {
  id: string;
  hostId: string;
  hostLabel: string;
  title: string;
  createdAt: number;
  updatedAt: number;
  messages: Msg[];
}

export const ONE_WEEK_MS = 7 * 24 * 60 * 60 * 1000;

export function normalizeHostId(hostId?: string | null): string {
  if (!hostId || hostId === '__local__' || hostId === 'local' || hostId.startsWith('local')) {
    return 'local';
  }
  return hostId;
}

export function isHostRemote(hId?: string | null): boolean {
  if (!hId) return false;
  return hId !== 'local' && hId !== '__local__' && !hId.startsWith('local');
}

export function getHostLabel(hostId: string, hosts: Host[]): string {
  const norm = normalizeHostId(hostId);
  if (norm === 'local') return 'Local Machine';
  const found = hosts.find((h) => h.id === norm || h.id === hostId);
  if (found) {
    return found.label || found.hostname || found.id;
  }
  return norm;
}

export function generateSessionId(): string {
  return `session_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

export function formatRelativeTime(timestamp: number): string {
  if (!timestamp) return 'Just now';
  const diffSec = Math.max(0, Math.floor((Date.now() - timestamp) / 1000));
  if (diffSec < 60) return 'Just now';
  const diffMin = Math.floor(diffSec / 60);
  if (diffMin < 60) return `${diffMin}m ago`;
  const diffHours = Math.floor(diffMin / 60);
  if (diffHours < 24) return `${diffHours}h ago`;
  const diffDays = Math.floor(diffHours / 24);
  if (diffDays === 1) return 'Yesterday';
  if (diffDays < 7) return `${diffDays}d ago`;
  return `${Math.floor(diffDays / 7)}w ago`;
}

export function loadSavedSessions(): SavedChatSession[] {
  try {
    const raw = localStorage.getItem('drx.ai.saved_sessions');
    let list: SavedChatSession[] = raw ? JSON.parse(raw) : [];
    if (!Array.isArray(list)) list = [];

    // Migrate legacy 'drx.ai.messages' if it exists
    const legacyRaw = localStorage.getItem('drx.ai.messages');
    if (legacyRaw) {
      try {
        const legacyMsgs: Msg[] = JSON.parse(legacyRaw);
        if (Array.isArray(legacyMsgs) && legacyMsgs.length > 0) {
          const firstUser = legacyMsgs.find((m) => m.role === 'user')?.content || 'Previous Chat';
          const title = firstUser.replace(/[\r\n]+/g, ' ').slice(0, 48).trim() || 'Previous Chat';
          const legacySession: SavedChatSession = {
            id: `session_legacy_${Date.now()}`,
            hostId: 'local',
            hostLabel: 'Local Machine',
            title,
            createdAt: Date.now(),
            updatedAt: Date.now(),
            messages: legacyMsgs,
          };
          list.unshift(legacySession);
        }
      } catch {}
      localStorage.removeItem('drx.ai.messages');
    }

    // Prune sessions older than 1 week without reconnection/activity
    const now = Date.now();
    const pruned = list.filter((s) => now - (s.updatedAt || s.createdAt || 0) <= ONE_WEEK_MS);

    if (pruned.length !== list.length || legacyRaw) {
      localStorage.setItem('drx.ai.saved_sessions', JSON.stringify(pruned));
    }
    return pruned;
  } catch {
    return [];
  }
}

export function saveSessionsToStorage(sessions: SavedChatSession[]): void {
  try {
    const now = Date.now();
    const pruned = sessions.filter((s) => now - (s.updatedAt || s.createdAt || 0) <= ONE_WEEK_MS);
    localStorage.setItem('drx.ai.saved_sessions', JSON.stringify(pruned));
  } catch (err) {
    console.warn('Failed to save AI sessions to storage:', err);
  }
}
