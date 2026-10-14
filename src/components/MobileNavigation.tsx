import { Terminal, Server, Folder, Sparkles, Settings } from 'lucide-react';
export type MobilePage = 'terminals' | 'hosts' | 'sftp' | 'assistant' | 'settings';
const destinations = [
  { id: 'terminals', label: 'Terminals', icon: Terminal },
  { id: 'hosts', label: 'Hosts', icon: Server },
  { id: 'sftp', label: 'SFTP', icon: Folder },
  { id: 'assistant', label: 'AI & Snippets', icon: Sparkles },
  { id: 'settings', label: 'Settings', icon: Settings },
] as const;
export function MobileNavigation({ page, sessions, onChange }: { page: MobilePage; sessions: number; onChange: (page: MobilePage) => void }) {
  return <nav className="nx-bottom-nav md:hidden" aria-label="Main navigation">
    {destinations.map(({ id, label, icon: Icon }) => <button key={id} aria-current={page === id ? 'page' : undefined}
      onClick={() => onChange(id)} className={page === id ? 'nx-nav-active' : ''}>
      <span className="relative"><Icon size={20} strokeWidth={page === id ? 2.3 : 1.7} />
        {id === 'terminals' && sessions > 0 && <span className="nx-session-badge" aria-label={`${sessions} open sessions`}>{sessions}</span>}
      </span><span>{label}</span>
    </button>)}
  </nav>;
}
