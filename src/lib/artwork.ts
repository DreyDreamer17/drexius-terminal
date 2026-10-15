export type Appearance = 'signature' | 'midnight' | 'daylight';

export const appearances: Record<Appearance, {
  name: string;
  description: string;
  background: string;
  foreground: string;
  muted: string;
  network: string;
}> = {
  signature: {
    name: 'Signature',
    description: 'The original. Reconnected.',
    background: '#050715',
    foreground: '#f5f6fc',
    muted: '#9baec9',
    network: '#2850c9',
  },
  midnight: {
    name: 'Midnight',
    description: 'Less noise. More focus.',
    background: '#070b11',
    foreground: '#f0f6f9',
    muted: '#91a2ad',
    network: '#145459',
  },
  daylight: {
    name: 'Daylight',
    description: 'A lighter kind of connection.',
    background: '#f0f5f7',
    foreground: '#152c3c',
    muted: '#607a8d',
    network: '#7aafc7',
  },
};

export const markNodes = [
  { x: 84, y: 32, color: '#00eee4' },
  { x: 131, y: 64, color: '#00d6ef' },
  { x: 178, y: 96, color: '#00b8ff' },
  { x: 225, y: 128, color: '#3a60ff' },
  { x: 178, y: 162, color: '#00b9fb' },
  { x: 131, y: 194, color: '#00d7ed' },
  { x: 51, y: 250, color: '#00f1e2' },
  { x: 108, y: 250, color: '#00d5ec' },
  { x: 165, y: 250, color: '#069fff' },
  { x: 222, y: 250, color: '#3e58ff' },
  { x: 279, y: 250, color: '#7a3dff' },
];

export const markPath = 'M84 32L131 64L178 96L225 128L178 162L131 194L51 250H279';

export function hexPoints(x: number, y: number, radius = 15) {
  return Array.from({ length: 6 }, (_, index) => {
    const angle = (Math.PI / 3) * index;
    return `${(x + Math.cos(angle) * radius).toFixed(2)},${(y + Math.sin(angle) * radius).toFixed(2)}`;
  }).join(' ');
}

export function markMarkup(id: string) {
  return `
    <defs>
      <linearGradient id="${id}-line" x1="45" y1="180" x2="290" y2="200" gradientUnits="userSpaceOnUse">
        <stop stop-color="#00f1e4"/><stop offset=".48" stop-color="#00b9ff"/><stop offset="1" stop-color="#7940ff"/>
      </linearGradient>
      <filter id="${id}-glow" x="-70%" y="-70%" width="240%" height="240%" color-interpolation-filters="sRGB">
        <feGaussianBlur stdDeviation="6"/>
      </filter>
      ${markNodes.map((node, index) => `
        <linearGradient id="${id}-node-${index}" x1="0" y1="0" x2="1" y2="1">
          <stop stop-color="#8dfaff"/><stop offset=".2" stop-color="${node.color}"/><stop offset="1" stop-color="${node.color}"/>
        </linearGradient>`).join('')}
    </defs>
    <g filter="url(#${id}-glow)" opacity=".65">
      <path d="${markPath}" fill="none" stroke="url(#${id}-line)" stroke-width="6"/>
      ${markNodes.map(node => `<polygon points="${hexPoints(node.x, node.y)}" fill="${node.color}"/>`).join('')}
    </g>
    <path class="mark-wire" d="${markPath}" fill="none" stroke="url(#${id}-line)" stroke-width="4" stroke-linejoin="round" pathLength="1"/>
    ${markNodes.map((node, index) => `
      <g class="mark-node" style="--node-delay:${index * 85 + 220}ms">
        <polygon points="${hexPoints(node.x, node.y)}" fill="url(#${id}-node-${index})" stroke="#99f3ff" stroke-width="1.5"/>
        <polygon points="${hexPoints(node.x, node.y, 12.6)}" fill="none" stroke="#ffffff" stroke-opacity=".12" stroke-width=".6"/>
      </g>`).join('')}
  `;
}

export function wordmarkMarkup(id: string, color = 'currentColor') {
  return `
    <defs><linearGradient id="${id}-x" x1="155" y1="7" x2="212" y2="57" gradientUnits="userSpaceOnUse"><stop stop-color="#a8fff8"/><stop offset=".45" stop-color="#00d9ef"/><stop offset="1" stop-color="#6e9dff"/></linearGradient></defs>
    <g fill="${color}">
      <path d="M4 56V8H14L56 45V8H66V56H56L14 19V56Z"/>
      <path d="M90 8H143V17H100V28H138V36H100V47H143V56H90Z"/>
      <path d="M240 8H250V39Q250 47 259 47H280Q289 47 289 39V8H299V40Q299 56 282 56H257Q240 56 240 40Z"/>
      <path d="M379 8V17H339Q331 17 331 23Q331 29 339 29H361Q381 29 381 43Q381 56 362 56H322V47H361Q371 47 371 42Q371 37 362 37H339Q321 37 321 23Q321 8 339 8Z"/>
      <path d="M202 8H215L195 29L188 22Z"/>
    </g>
    <g fill="url(#${id}-x)"><path d="M160 8H173L217 56H203Z"/><path d="M181 32L188 40L173 56H159Z"/></g>
  `;
}

export const networkPaths = [
  'M-35 48L39 99L136 12L178-25',
  'M39 99V243L-34 296M39 99L177 185',
  'M267-20L350 72L423 18M350 72V-10M350 72L431 135',
  'M350 72L268 138M423 176L360 226L429 275',
  'M-27 534L65 609L-23 678M65 609V749L-30 817',
  'M65 609L170 540M65 749L166 818M65 749L-25 692',
  'M278 571L349 618L429 547M349 618V751L431 812',
  'M349 618L439 682M349 751L264 823M349 751L428 691',
];

export const networkDots = [
  [39, 99], [39, 243], [350, 72], [360, 226],
  [65, 609], [65, 749], [349, 618], [349, 751],
];

export function splashSvg(appearance: Appearance, width: number, height: number) {
  const theme = appearances[appearance];
  const scale = width / 400;
  const viewHeight = height / scale;
  const markY = viewHeight * 0.23;
  const wordY = markY + 285;
  const loaderY = viewHeight * 0.82;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 400 ${viewHeight}">
    <defs>
      <radialGradient id="ambient"><stop stop-color="${appearance === 'daylight' ? '#b6ecee' : '#07323e'}" stop-opacity=".44"/><stop offset="1" stop-color="${theme.background}" stop-opacity="0"/></radialGradient>
      <linearGradient id="progress"><stop stop-color="#00e9df"/><stop offset=".5" stop-color="#149dff"/><stop offset="1" stop-color="#8246ff"/></linearGradient>
    </defs>
    <rect width="400" height="${viewHeight}" fill="${theme.background}"/>
    <ellipse cx="205" cy="${viewHeight * 0.4}" rx="240" ry="280" fill="url(#ambient)"/>
    <g transform="scale(1 ${viewHeight / 860})" fill="none" stroke="${theme.network}" stroke-width=".6" opacity="${appearance === 'midnight' ? '.2' : '.42'}">
      ${networkPaths.map(d => `<path d="${d}"/>`).join('')}
      ${networkDots.map(([x, y], index) => `<circle cx="${x}" cy="${y}" r="1.7" fill="${index % 2 ? '#6340f3' : '#00b5f0'}" stroke="none"/>`).join('')}
    </g>
    <svg x="62" y="${markY}" width="276" height="251" viewBox="0 0 330 300">${markMarkup('export-mark')}</svg>
    <svg x="57" y="${wordY}" width="286" height="47.5" viewBox="0 0 385 64">${wordmarkMarkup('export-word', theme.foreground)}</svg>
    <text x="200" y="${wordY + 80}" text-anchor="middle" fill="${theme.muted}" font-family="Arial, sans-serif" font-size="12" letter-spacing="1.1">Secure connections. Anywhere.</text>
    <rect x="80" y="${loaderY}" width="240" height="2.8" rx="1.4" fill="${theme.network}" opacity=".25"/>
    <rect x="80" y="${loaderY}" width="180" height="2.8" rx="1.4" fill="url(#progress)"/>
    <text x="200" y="${loaderY + 30}" text-anchor="middle" fill="${theme.muted}" font-family="monospace" font-size="9.5" letter-spacing=".4">Initializing secure session...</text>
    <g transform="translate(130 ${viewHeight * 0.931 - 5})" fill="none" stroke="${theme.muted}" stroke-width=".7" opacity=".6"><path d="M0 0L4-1.8L8 0V4Q8 6.5 4 8.5Q0 6.5 0 4Z"/><path d="M2.2 3.3L3.5 4.6L5.9 2.1"/></g>
    <text x="210" y="${viewHeight * 0.931 + 1}" text-anchor="middle" fill="${theme.muted}" opacity=".6" font-family="Arial, sans-serif" font-size="7.5" letter-spacing="1.6">PRIVATE BY DESIGN</text>
  </svg>`;
}