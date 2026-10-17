import type { CSSProperties } from 'react';
import { Terminal, Server, Folder, Sparkles, Settings } from 'lucide-react';
import type { DrexiusTheme } from '../lib/themes';
export type MobilePage = 'terminals' | 'hosts' | 'sftp' | 'assistant' | 'settings';
const destinations = [
  { id: 'terminals', label: 'Terminals', icon: Terminal },
  { id: 'hosts', label: 'Hosts', icon: Server },
  { id: 'sftp', label: 'SFTP', icon: Folder },
  { id: 'assistant', label: 'AI', icon: Sparkles },
  { id: 'settings', label: 'Settings', icon: Settings },
] as const;
export function MobileNavigation({ page, sessions, onChange, theme }: { page: MobilePage; sessions: number; onChange: (page: MobilePage) => void; theme?: DrexiusTheme }) {
  // The bar follows the active theme like every other phone surface: terminal background, accent for the current tab.
  const style = { '--nx-accent': theme?.accent || '#22d3ee', '--nx-nav-bg': theme?.xterm.background || '#0e131d' } as CSSProperties;
  return <nav className="nx-bottom-nav md:hidden" aria-label="Main navigation" style={style}>
    {destinations.map(({ id, label, icon: Icon }) => <button key={id} aria-current={page === id ? 'page' : undefined}
      onClick={() => onChange(id)} className={page === id ? 'nx-nav-active' : ''}>
      <span className="relative"><Icon size={20} strokeWidth={page === id ? 2.3 : 1.7} />
        {id === 'terminals' && sessions > 0 && <span className="nx-session-badge" aria-label={`${sessions} open sessions`}>{sessions}</span>}
      </span><span>{label}</span>
    </button>)}
  </nav>;
}
