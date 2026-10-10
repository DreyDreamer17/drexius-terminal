/** OS fingerprint keys shared by Rust detection + banner fallback. */
export type OsId =
  | 'ubuntu' | 'debian' | 'arch' | 'fedora' | 'centos'
  | 'rocky' | 'alpine' | 'amazon' | 'suse'
  | 'linux' | 'windows' | 'macos';

export const OS_OPTIONS: { id: OsId | ''; label: string }[] = [
  { id: '', label: 'Auto-detect' },
  { id: 'ubuntu', label: 'Ubuntu' },
  { id: 'debian', label: 'Debian / Raspbian' },
  { id: 'arch', label: 'Arch / Manjaro' },
  { id: 'fedora', label: 'Fedora' },
  { id: 'centos', label: 'CentOS / RHEL' },
  { id: 'rocky', label: 'Rocky / AlmaLinux' },
  { id: 'alpine', label: 'Alpine' },
  { id: 'amazon', label: 'Amazon Linux' },
  { id: 'suse', label: 'openSUSE' },
  { id: 'linux', label: 'Generic Linux' },
  { id: 'windows', label: 'Windows' },
  { id: 'macos', label: 'macOS' },
];

/** Client-side fallback: parse OpenSSH banner (e.g. "OpenSSH_9.6p1 Ubuntu-5ubuntu1"). */
export function parseOsFromBanner(banner?: string | null): OsId | null {
  if (!banner) return null;
  const s = banner.toLowerCase();
  if (s.includes('ubuntu')) return 'ubuntu';
  if (s.includes('debian') || s.includes('raspbian')) return 'debian';
  if (s.includes('arch') || s.includes('manjaro')) return 'arch';
  if (s.includes('fedora')) return 'fedora';
  if (s.includes('centos') || s.includes('rhel') || s.includes('red hat')) return 'centos';
  if (s.includes('rocky') || s.includes('alma')) return 'rocky';
  if (s.includes('alpine')) return 'alpine';
  if (s.includes('amazon')) return 'amazon';
  if (s.includes('suse')) return 'suse';
  if (s.includes('windows') || s.includes('mingw') || s.includes('msys')) return 'windows';
  if (s.includes('darwin') || s.includes('macos')) return 'macos';
  return null;
}

export function normalizeOs(os?: string | null): OsId | null {
  if (!os) return null;
  const s = os.trim().toLowerCase();
  if (s && (OS_OPTIONS as { id: string }[]).some((o) => o.id === s)) return s as OsId;
  return parseOsFromBanner(os);
}
