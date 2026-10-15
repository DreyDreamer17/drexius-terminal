import { useId } from 'react';
import { markMarkup, networkDots, networkPaths, wordmarkMarkup } from '../lib/artwork';

export function NetworkMark({ className = '', animated = false }: { className?: string; animated?: boolean }) {
  const id = `mark-${useId().replace(/[^a-zA-Z0-9]/g, '')}`;
  return (
    <svg
      className={`network-mark ${animated ? 'is-animated' : ''} ${className}`}
      viewBox="0 0 330 300"
      fill="none"
      role="img"
      aria-label="NEXUS connected hexagon symbol"
      dangerouslySetInnerHTML={{ __html: markMarkup(id) }}
    />
  );
}

export function Wordmark({ className = '' }: { className?: string }) {
  const id = `word-${useId().replace(/[^a-zA-Z0-9]/g, '')}`;
  return (
    <svg
      className={`wordmark ${className}`}
      viewBox="0 0 385 64"
      role="img"
      aria-label="NEXUS"
      dangerouslySetInnerHTML={{ __html: wordmarkMarkup(id) }}
    />
  );
}

export function NetworkBackdrop() {
  return (
    <svg className="network-backdrop" viewBox="0 0 400 860" preserveAspectRatio="none" aria-hidden="true">
      <g fill="none" stroke="currentColor" strokeWidth="0.6">
        {networkPaths.map((d, index) => <path key={index} d={d} />)}
      </g>
      {networkDots.map(([x, y], index) => (
        <circle className={`network-dot network-dot-${index % 3}`} key={index} cx={x} cy={y} r="1.6" fill={index % 2 ? '#6d40f4' : '#00b4e8'} />
      ))}
    </svg>
  );
}

export function SmallBrandMark() {
  return (
    <svg viewBox="0 0 26 28" fill="none" aria-hidden="true">
      <path d="M7 3L21 12L4 25H23" stroke="url(#nav-brand)" strokeWidth="1.8" strokeLinejoin="round" />
      <path d="M4 0H9L11.5 4.2L9 8.5H4L1.5 4.2ZM18.5 8H23.5L26 12.2L23.5 16.5H18.5L16 12.2ZM1.5 21H6.5L9 25.2L6.5 29.5H1.5L-1 25.2ZM20 21H25L27.5 25.2L25 29.5H20L17.5 25.2Z" transform="translate(1 -1) scale(.9)" fill="url(#nav-brand)" />
      <defs><linearGradient id="nav-brand" x1="1" y1="3" x2="26" y2="28" gradientUnits="userSpaceOnUse"><stop stopColor="#5af1de" /><stop offset="1" stopColor="#7972ff" /></linearGradient></defs>
    </svg>
  );
}