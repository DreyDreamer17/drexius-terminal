import { Server } from 'lucide-react';
import type { OsId } from '../lib/os';

const S = (size: number) => ({ width: size * 0.62, height: size * 0.62 });

function UbuntuMark({ size, color }: { size: number; color: string }) {
  const s = S(size);
  return (
    <svg viewBox="0 0 24 24" style={{ ...s, color }} fill="none" stroke="currentColor" strokeWidth={1.9}>
      <circle cx="12" cy="12" r="8.2" />
      <circle cx="12" cy="5.4" r="1.7" fill="currentColor" stroke="none" />
      <circle cx="17.6" cy="15.2" r="1.7" fill="currentColor" stroke="none" />
      <circle cx="6.4" cy="15.2" r="1.7" fill="currentColor" stroke="none" />
    </svg>
  );
}

function DebianMark({ size, color }: { size: number; color: string }) {
  const s = S(size);
  return (
    <svg viewBox="0 0 24 24" style={{ ...s, color }} fill="none" stroke="currentColor" strokeWidth={1.9} strokeLinecap="round">
      <path d="M12 2.5c-5.2 0-9.5 4.3-9.5 9.5s4.3 9.5 9.5 9.5c4.1 0 7.5-3.4 7.5-7.5s-3.4-7.5-7.5-7.5c-3 0-5.5 2.5-5.5 5.5s2.5 5.5 5.5 5.5c2 0 3.5-1.5 3.5-3.5s-1.5-3.5-3.5-3.5" />
      <circle cx="12" cy="14" r="1.1" fill="currentColor" stroke="none" />
    </svg>
  );
}

function ArchMark({ size, color }: { size: number; color: string }) {
  const s = S(size);
  return (
    <svg viewBox="0 0 24 24" style={{ ...s, color }} fill="currentColor">
      <path d="M12 2.5 21.5 22h-4.3L12 9.6 6.8 22H2.5L12 2.5Z" />
      <path d="M12 14.2l2.6 6.1H9.4L12 14.2Z" fillOpacity={0.45} />
    </svg>
  );
}

function FedoraMark({ size, color }: { size: number; color: string }) {
  const s = S(size);
  return (
    <svg viewBox="0 0 24 24" style={{ ...s, color }} fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round">
      <circle cx="12" cy="12" r="8.5" strokeOpacity={0.5} strokeWidth={1.6} />
      <path d="M15.5 7.5c-1-.8-2.2-1.2-3.5-1.2-2.8 0-4.5 1.6-4.5 4.2v7.5h2.6v-6.6h2.7V9H10V8c0-1 .6-1.7 1.7-1.7.7 0 1.3.2 1.8.6l2-1.4Z" fill="currentColor" stroke="none" />
    </svg>
  );
}

function WindowsMark({ size, color }: { size: number; color: string }) {
  const s = S(size);
  return (
    <svg viewBox="0 0 24 24" style={{ ...s, color }} fill="currentColor">
      <path d="M3.5 5.2 11 4.1v7.4H3.5V5.2Z" />
      <path d="M12 4 20.5 2.8v8.7H12V4Z" />
      <path d="M3.5 12.5H11v7.4l-7.5-1.1v-6.3Z" />
      <path d="M12 12.5h8.5v8.7L12 19.9v-7.4Z" />
    </svg>
  );
}

function MacMark({ size, color }: { size: number; color: string }) {
  const s = S(size);
  return (
    <svg viewBox="0 0 24 24" style={{ ...s, color }} fill="currentColor">
      <path d="M16.4 12.9c0-2.4 2-3.6 2.1-3.7-1.1-1.7-2.9-1.9-3.5-1.9-1.5-.2-2.9.9-3.7.9-.8 0-1.9-.9-3.2-.9-1.6 0-3.1 1-4 2.4-1.7 2.9-.4 7.3 1.2 9.7.8 1.2 1.8 2.5 3.1 2.4 1.2-.1 1.7-.8 3.2-.8s1.9.8 3.2.8c1.4 0 2.2-1.2 3-2.4.9-1.4 1.3-2.7 1.3-2.8-.1 0-2.6-1-2.7-3.7ZM14.2 5.4c.7-.8 1.1-1.9 1-3-1 0-2.1.6-2.8 1.4-.6.7-1.2 1.9-1 3 1.1.1 2.1-.6 2.8-1.4Z" />
    </svg>
  );
}

function LinuxMark({ size, color }: { size: number; color: string }) {
  const s = S(size);
  return (
    <svg viewBox="0 0 24 24" style={{ ...s, color }} fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round">
      <ellipse cx="12" cy="13.5" rx="6" ry="7" fill="currentColor" fillOpacity={0.18} />
      <ellipse cx="12" cy="13.5" rx="6" ry="7" />
      <circle cx="9.8" cy="11" r="0.9" fill="currentColor" stroke="none" />
      <circle cx="14.2" cy="11" r="0.9" fill="currentColor" stroke="none" />
      <path d="M10.5 15.5h3l-1.5 1.8-1.5-1.8Z" fill="currentColor" stroke="none" />
    </svg>
  );
}

function AndroidMark({ size, color }: { size: number; color: string }) {
  const s = S(size);
  return (
    <svg viewBox="0 0 24 24" style={{ ...s, color }} fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round">
      <path d="M4.5 16.5a7.5 7.5 0 0 1 15 0H4.5Z" fill="currentColor" fillOpacity={0.18} />
      <path d="M4.5 16.5a7.5 7.5 0 0 1 15 0H4.5Z" />
      <path d="M7.5 6.2 9.4 9.2" />
      <path d="M16.5 6.2 14.6 9.2" />
      <circle cx="9.3" cy="13.2" r="0.9" fill="currentColor" stroke="none" />
      <circle cx="14.7" cy="13.2" r="0.9" fill="currentColor" stroke="none" />
    </svg>
  );
}

function CentMark({ size, color, letter }: { size: number; color: string; letter: string }) {
  return (
    <span style={{ fontSize: size * 0.42, fontWeight: 800, color, lineHeight: 1 }}>{letter}</span>
  );
}

/** Badge chrome per distro + real mark. */
const CHROME: Record<OsId, { bg: string; ring: string; fg: string; title: string }> = {
  ubuntu: { bg: '#e954201f', ring: '#e9542040', fg: '#e95420', title: 'Ubuntu' },
  debian: { bg: '#d70a531f', ring: '#d70a5340', fg: '#ff5c8a', title: 'Debian' },
  arch: { bg: '#1793d11f', ring: '#1793d140', fg: '#38bdf8', title: 'Arch Linux' },
  fedora: { bg: '#51a2da1f', ring: '#51a2da40', fg: '#7cc4f2', title: 'Fedora' },
  centos: { bg: '#9b59b61f', ring: '#9b59b640', fg: '#c084fc', title: 'CentOS / RHEL' },
  rocky: { bg: '#4ade801f', ring: '#4ade8040', fg: '#4ade80', title: 'Rocky / AlmaLinux' },
  alpine: { bg: '#0d597f1f', ring: '#0d597f60', fg: '#60a5fa', title: 'Alpine' },
  amazon: { bg: '#f59e0b1f', ring: '#f59e0b40', fg: '#fbbf24', title: 'Amazon Linux' },
  suse: { bg: '#73ba251f', ring: '#73ba2540', fg: '#a3e635', title: 'openSUSE' },
  android: { bg: '#3ddc841f', ring: '#3ddc8440', fg: '#3ddc84', title: 'Android / Termux' },
  linux: { bg: '#64748b1f', ring: '#64748b40', fg: '#94a3b8', title: 'Linux' },
  windows: { bg: '#0078d41f', ring: '#0078d440', fg: '#60a5fa', title: 'Windows' },
  macos: { bg: '#94a3b81f', ring: '#94a3b840', fg: '#e2e8f0', title: 'macOS' },
};

export function OsIcon({ os, color, size = 32 }: { os?: string | null; color?: string | null; size?: number }) {
  const key = (os?.toLowerCase() ?? '') as OsId;
  const c = CHROME[key];
  if (!c) {
    return (
      <div className="relative grid shrink-0 place-items-center rounded-lg" style={{ width: size, height: size, background: `${color ?? '#64748b'}1f`, boxShadow: `inset 0 0 0 1px ${color ?? '#64748b'}40` }}>
        <Server style={{ color: color ?? '#94a3b8', width: size * 0.5, height: size * 0.5 }} />
      </div>
    );
  }
  return (
    <div title={c.title} className="relative grid shrink-0 place-items-center rounded-lg" style={{ width: size, height: size, background: c.bg, boxShadow: `inset 0 0 0 1px ${c.ring}` }}>
      {key === 'ubuntu' && <UbuntuMark size={size} color={c.fg} />}
      {key === 'debian' && <DebianMark size={size} color={c.fg} />}
      {key === 'arch' && <ArchMark size={size} color={c.fg} />}
      {key === 'fedora' && <FedoraMark size={size} color={c.fg} />}
      {key === 'windows' && <WindowsMark size={size} color={c.fg} />}
      {key === 'macos' && <MacMark size={size} color={c.fg} />}
      {key === 'android' && <AndroidMark size={size} color={c.fg} />}
      {key === 'linux' && <LinuxMark size={size} color={c.fg} />}
      {key === 'centos' && <CentMark size={size} color={c.fg} letter="C" />}
      {key === 'rocky' && <CentMark size={size} color={c.fg} letter="R" />}
      {key === 'alpine' && <CentMark size={size} color={c.fg} letter="A" />}
      {key === 'amazon' && <CentMark size={size} color={c.fg} letter="a" />}
      {key === 'suse' && <CentMark size={size} color={c.fg} letter="S" />}
    </div>
  );
}
