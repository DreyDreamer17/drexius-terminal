import type { ITheme } from '@xterm/xterm';

export interface DrexiusTheme {
  id: string;
  name: string;
  accent: string;
  isLight?: boolean;
  xterm: ITheme;
}

export const THEMES: DrexiusTheme[] = [
  {
    id: 'drexius', name: 'Drexius Night', accent: '#22d3ee',
    xterm: {
      background: '#0a0d14', foreground: '#d6deeb', cursor: '#22d3ee', cursorAccent: '#0a0d14', selectionBackground: '#22d3ee33',
      black: '#1b2130', red: '#ff5f7e', green: '#4ade80', yellow: '#fbbf24', blue: '#60a5fa', magenta: '#c084fc', cyan: '#22d3ee', white: '#d6deeb',
      brightBlack: '#4b5468', brightRed: '#ff8aa1', brightGreen: '#86efac', brightYellow: '#fde68a', brightBlue: '#93c5fd', brightMagenta: '#d8b4fe', brightCyan: '#67e8f9', brightWhite: '#ffffff',
    },
  },
  {
    id: 'aurora', name: 'Aurora', accent: '#a78bfa',
    xterm: {
      background: '#0d0b1a', foreground: '#e4defc', cursor: '#a78bfa', cursorAccent: '#0d0b1a', selectionBackground: '#a78bfa40',
      black: '#211d36', red: '#f472b6', green: '#5eead4', yellow: '#fcd34d', blue: '#818cf8', magenta: '#c4b5fd', cyan: '#67e8f9', white: '#e4defc',
      brightBlack: '#5b5480', brightRed: '#f9a8d4', brightGreen: '#99f6e4', brightYellow: '#fde68a', brightBlue: '#a5b4fc', brightMagenta: '#ddd6fe', brightCyan: '#a5f3fc', brightWhite: '#ffffff',
    },
  },
  {
    id: 'ember', name: 'Ember', accent: '#fb923c',
    xterm: {
      background: '#120d0b', foreground: '#f1e4d8', cursor: '#fb923c', cursorAccent: '#120d0b', selectionBackground: '#fb923c33',
      black: '#2a201b', red: '#ef4444', green: '#a3e635', yellow: '#facc15', blue: '#38bdf8', magenta: '#f472b6', cyan: '#2dd4bf', white: '#f1e4d8',
      brightBlack: '#6b5a50', brightRed: '#f87171', brightGreen: '#bef264', brightYellow: '#fde047', brightBlue: '#7dd3fc', brightMagenta: '#f9a8d4', brightCyan: '#5eead4', brightWhite: '#ffffff',
    },
  },
  {
    id: 'matrix', name: 'Phosphor', accent: '#4ade80',
    xterm: {
      background: '#050a06', foreground: '#b6f5c6', cursor: '#4ade80', cursorAccent: '#050a06', selectionBackground: '#4ade8033',
      black: '#0f1f13', red: '#f87171', green: '#4ade80', yellow: '#d9f99d', blue: '#34d399', magenta: '#a3e635', cyan: '#6ee7b7', white: '#b6f5c6',
      brightBlack: '#356b44', brightRed: '#fca5a5', brightGreen: '#86efac', brightYellow: '#ecfccb', brightBlue: '#6ee7b7', brightMagenta: '#bef264', brightCyan: '#a7f3d0', brightWhite: '#ecfdf5',
    },
  },
  {
    id: 'dracula', name: 'Dracula', accent: '#bd93f9',
    xterm: {
      background: '#282a36', foreground: '#f8f8f2', cursor: '#f8f8f2', cursorAccent: '#282a36', selectionBackground: '#44475a',
      black: '#21222c', red: '#ff5555', green: '#50fa7b', yellow: '#f1fa8c', blue: '#bd93f9', magenta: '#ff79c6', cyan: '#8be9fd', white: '#f8f8f2',
      brightBlack: '#6272a4', brightRed: '#ff6e6e', brightGreen: '#69ff94', brightYellow: '#ffffa5', brightBlue: '#d6acff', brightMagenta: '#ff92df', brightCyan: '#a4ffff', brightWhite: '#ffffff',
    },
  },
  {
    id: 'nord', name: 'Nord', accent: '#88c0d0',
    xterm: {
      background: '#2e3440', foreground: '#d8dee9', cursor: '#d8dee9', cursorAccent: '#2e3440', selectionBackground: '#434c5e',
      black: '#3b4252', red: '#bf616a', green: '#a3be8c', yellow: '#ebcb8b', blue: '#81a1c1', magenta: '#b48ead', cyan: '#88c0d0', white: '#e5e9f0',
      brightBlack: '#4c566a', brightRed: '#bf616a', brightGreen: '#a3be8c', brightYellow: '#ebcb8b', brightBlue: '#81a1c1', brightMagenta: '#b48ead', brightCyan: '#8fbcbb', brightWhite: '#eceff4',
    },
  },
  {
    id: 'tokyo', name: 'Tokyo Night', accent: '#7aa2f7',
    xterm: {
      background: '#1a1b26', foreground: '#c0caf5', cursor: '#c0caf5', cursorAccent: '#1a1b26', selectionBackground: '#33467c',
      black: '#15161e', red: '#f7768e', green: '#9ece6a', yellow: '#e0af68', blue: '#7aa2f7', magenta: '#bb9af7', cyan: '#7dcfff', white: '#a9b1d6',
      brightBlack: '#414868', brightRed: '#f7768e', brightGreen: '#9ece6a', brightYellow: '#e0af68', brightBlue: '#7aa2f7', brightMagenta: '#bb9af7', brightCyan: '#7dcfff', brightWhite: '#c0caf5',
    },
  },
  {
    id: 'gruvbox', name: 'Gruvbox', accent: '#fabd2f',
    xterm: {
      background: '#282828', foreground: '#ebdbb2', cursor: '#ebdbb2', cursorAccent: '#282828', selectionBackground: '#504945',
      black: '#282828', red: '#cc241d', green: '#98971a', yellow: '#d79921', blue: '#458588', magenta: '#b16286', cyan: '#689d6a', white: '#a89984',
      brightBlack: '#928374', brightRed: '#fb4934', brightGreen: '#b8bb26', brightYellow: '#fabd2f', brightBlue: '#83a598', brightMagenta: '#d3869b', brightCyan: '#8ec07c', brightWhite: '#ebdbb2',
    },
  },
  {
    id: 'solarized', name: 'Solarized Dark', accent: '#268bd2',
    xterm: {
      background: '#002b36', foreground: '#839496', cursor: '#839496', cursorAccent: '#002b36', selectionBackground: '#073642',
      black: '#073642', red: '#dc322f', green: '#859900', yellow: '#b58900', blue: '#268bd2', magenta: '#d33682', cyan: '#2aa198', white: '#eee8d5',
      brightBlack: '#002b36', brightRed: '#cb4b16', brightGreen: '#586e75', brightYellow: '#657b83', brightBlue: '#839496', brightMagenta: '#6c71c4', brightCyan: '#93a1a1', brightWhite: '#fdf6e3',
    },
  },
  {
    id: 'monokai', name: 'Monokai', accent: '#a6e22e',
    xterm: {
      background: '#272822', foreground: '#f8f8f2', cursor: '#f8f8f0', cursorAccent: '#272822', selectionBackground: '#49483e',
      black: '#272822', red: '#f92672', green: '#a6e22e', yellow: '#f4bf75', blue: '#66d9ef', magenta: '#ae81ff', cyan: '#a1efe4', white: '#f8f8f2',
      brightBlack: '#75715e', brightRed: '#f92672', brightGreen: '#a6e22e', brightYellow: '#f4bf75', brightBlue: '#66d9ef', brightMagenta: '#ae81ff', brightCyan: '#a1efe4', brightWhite: '#f9f8f5',
    },
  },
  {
    id: 'catppuccin', name: 'Catppuccin', accent: '#cba6f7',
    xterm: {
      background: '#1e1e2e', foreground: '#cdd6f4', cursor: '#f5e0dc', cursorAccent: '#1e1e2e', selectionBackground: '#45475a',
      black: '#45475a', red: '#f38ba8', green: '#a6e3a1', yellow: '#f9e2af', blue: '#89b4fa', magenta: '#cba6f7', cyan: '#94e2d5', white: '#bac2de',
      brightBlack: '#585b70', brightRed: '#f38ba8', brightGreen: '#a6e3a1', brightYellow: '#f9e2af', brightBlue: '#89b4fa', brightMagenta: '#cba6f7', brightCyan: '#94e2d5', brightWhite: '#a6adc8',
    },
  },
  {
    id: 'onedark', name: 'One Dark', accent: '#61afef',
    xterm: {
      background: '#282c34', foreground: '#abb2bf', cursor: '#528bff', cursorAccent: '#282c34', selectionBackground: '#3e4451',
      black: '#282c34', red: '#e06c75', green: '#98c379', yellow: '#e5c07b', blue: '#61afef', magenta: '#c678dd', cyan: '#56b6c2', white: '#abb2bf',
      brightBlack: '#5c6370', brightRed: '#e06c75', brightGreen: '#98c379', brightYellow: '#e5c07b', brightBlue: '#61afef', brightMagenta: '#c678dd', brightCyan: '#56b6c2', brightWhite: '#ffffff',
    },
  },
  {
    id: 'homebrew', name: 'Homebrew', accent: '#00e676',
    xterm: {
      background: '#000000', foreground: '#33ff33', cursor: '#33ff33', cursorAccent: '#000000', selectionBackground: '#33ff3333',
      black: '#000000', red: '#ff5252', green: '#33ff33', yellow: '#ffd740', blue: '#40c4ff', magenta: '#ff4081', cyan: '#64ffda', white: '#e8f5e9',
      brightBlack: '#3a4a3e', brightRed: '#ff8a80', brightGreen: '#69f0ae', brightYellow: '#ffff8d', brightBlue: '#82b1ff', brightMagenta: '#ff80ab', brightCyan: '#a7ffeb', brightWhite: '#ffffff',
    },
  },
  {
    id: 'rose-pine', name: 'Rosé Pine', accent: '#eb6f92',
    xterm: {
      background: '#191724', foreground: '#e0def4', cursor: '#524f67', cursorAccent: '#e0def4', selectionBackground: '#eb6f9226',
      black: '#26233a', red: '#eb6f92', green: '#31748f', yellow: '#f6c177', blue: '#9ccfd8', magenta: '#c4a7e7', cyan: '#ebbcba', white: '#e0def4',
      brightBlack: '#6e6a86', brightRed: '#eb6f92', brightGreen: '#31748f', brightYellow: '#f6c177', brightBlue: '#9ccfd8', brightMagenta: '#c4a7e7', brightCyan: '#ebbcba', brightWhite: '#ffffff',
    },
  },
  {
    id: 'rose-pine-moon', name: 'Rosé Pine Moon', accent: '#ea9a97',
    xterm: {
      background: '#232136', foreground: '#e0def4', cursor: '#56526e', cursorAccent: '#e0def4', selectionBackground: '#ea9a9726',
      black: '#393552', red: '#eb6f92', green: '#3e8fb0', yellow: '#f6c177', blue: '#9ccfd8', magenta: '#c4a7e7', cyan: '#ea9a97', white: '#e0def4',
      brightBlack: '#6e6a86', brightRed: '#eb6f92', brightGreen: '#3e8fb0', brightYellow: '#f6c177', brightBlue: '#9ccfd8', brightMagenta: '#c4a7e7', brightCyan: '#ea9a97', brightWhite: '#ffffff',
    },
  },
  {
    id: 'kanagawa', name: 'Kanagawa Wave', accent: '#7e9cd8',
    xterm: {
      background: '#1f1f28', foreground: '#dcd7ba', cursor: '#c8c093', cursorAccent: '#1f1f28', selectionBackground: '#2d4f67',
      black: '#090618', red: '#c34043', green: '#76946a', yellow: '#c0a36e', blue: '#7e9cd8', magenta: '#957fb8', cyan: '#6a9589', white: '#c8c093',
      brightBlack: '#727169', brightRed: '#e82424', brightGreen: '#98bb6c', brightYellow: '#e6c384', brightBlue: '#7fb4ca', brightMagenta: '#938aa9', brightCyan: '#7aa89f', brightWhite: '#dcd7ba',
    },
  },
  {
    id: 'cyberpunk', name: 'Cyberpunk', accent: '#fcee0a',
    xterm: {
      background: '#0d0d17', foreground: '#00f0ff', cursor: '#fcee0a', cursorAccent: '#0d0d17', selectionBackground: '#ff003c40',
      black: '#101022', red: '#ff003c', green: '#00ff9f', yellow: '#fcee0a', blue: '#00f0ff', magenta: '#ff007f', cyan: '#05d9e8', white: '#e0f6fc',
      brightBlack: '#30304a', brightRed: '#ff3366', brightGreen: '#33ffb3', brightYellow: '#fff133', brightBlue: '#33f3ff', brightMagenta: '#ff3399', brightCyan: '#33e0ed', brightWhite: '#ffffff',
    },
  },
  {
    id: 'synthwave', name: "Synthwave '84", accent: '#ff7edb',
    xterm: {
      background: '#262335', foreground: '#f92aad', cursor: '#fede5d', cursorAccent: '#262335', selectionBackground: '#34294f',
      black: '#241b2f', red: '#fe4450', green: '#72f1b8', yellow: '#fede5d', blue: '#03edf9', magenta: '#ff7edb', cyan: '#36f9f6', white: '#fede5d',
      brightBlack: '#495495', brightRed: '#fe4450', brightGreen: '#72f1b8', brightYellow: '#fede5d', brightBlue: '#03edf9', brightMagenta: '#ff7edb', brightCyan: '#36f9f6', brightWhite: '#ffffff',
    },
  },
  {
    id: 'github-dark', name: 'GitHub Dark', accent: '#58a6ff',
    xterm: {
      background: '#0d1117', foreground: '#c9d1d9', cursor: '#58a6ff', cursorAccent: '#0d1117', selectionBackground: '#1f6feb44',
      black: '#484f58', red: '#ff7b72', green: '#3fb950', yellow: '#d29922', blue: '#58a6ff', magenta: '#bc8cff', cyan: '#39c5cf', white: '#b1bac4',
      brightBlack: '#6e7681', brightRed: '#ffa198', brightGreen: '#56d364', brightYellow: '#e3b341', brightBlue: '#79c0ff', brightMagenta: '#d2a8ff', brightCyan: '#56d4dd', brightWhite: '#f0f6fc',
    },
  },
  {
    id: 'github-dimmed', name: 'GitHub Dimmed', accent: '#539bf5',
    xterm: {
      background: '#22272e', foreground: '#adbac7', cursor: '#539bf5', cursorAccent: '#22272e', selectionBackground: '#316dca44',
      black: '#545d68', red: '#f47067', green: '#57ab5a', yellow: '#c69026', blue: '#539bf5', magenta: '#b083f0', cyan: '#39c5cf', white: '#909dab',
      brightBlack: '#636e7b', brightRed: '#ff938a', brightGreen: '#6bc46d', brightYellow: '#daaa3f', brightBlue: '#6cb6ff', brightMagenta: '#dcbdfb', brightCyan: '#56d4dd', brightWhite: '#cdd9e5',
    },
  },
  {
    id: 'everforest', name: 'Everforest', accent: '#a7c080',
    xterm: {
      background: '#2d353b', foreground: '#d3c6aa', cursor: '#d3c6aa', cursorAccent: '#2d353b', selectionBackground: '#543a48',
      black: '#475258', red: '#e67e80', green: '#a7c080', yellow: '#dbbc7f', blue: '#7fbbb3', magenta: '#d699b6', cyan: '#83c092', white: '#d3c6aa',
      brightBlack: '#56635f', brightRed: '#e67e80', brightGreen: '#a7c080', brightYellow: '#dbbc7f', brightBlue: '#7fbbb3', brightMagenta: '#d699b6', brightCyan: '#83c092', brightWhite: '#d3c6aa',
    },
  },
  {
    id: 'night-owl', name: 'Night Owl', accent: '#82aaff',
    xterm: {
      background: '#011627', foreground: '#d6deeb', cursor: '#7e57c2', cursorAccent: '#011627', selectionBackground: '#1b3a5b',
      black: '#011627', red: '#ef5350', green: '#22da6e', yellow: '#addb67', blue: '#82aaff', magenta: '#c792ea', cyan: '#21c7a8', white: '#ffffff',
      brightBlack: '#575656', brightRed: '#ef5350', brightGreen: '#22da6e', brightYellow: '#ffeb95', brightBlue: '#82aaff', brightMagenta: '#c792ea', brightCyan: '#7fdbca', brightWhite: '#ffffff',
    },
  },
  {
    id: 'ayu-mirage', name: 'Ayu Mirage', accent: '#ffcc66',
    xterm: {
      background: '#1f2430', foreground: '#cbccc6', cursor: '#ffcc66', cursorAccent: '#1f2430', selectionBackground: '#34455a',
      black: '#191e2a', red: '#ed8274', green: '#a6cc70', yellow: '#fad07b', blue: '#6dcbfa', magenta: '#cfbafa', cyan: '#90e1c6', white: '#c7c7c7',
      brightBlack: '#686868', brightRed: '#f28779', brightGreen: '#bae67e', brightYellow: '#ffd580', brightBlue: '#73d0ff', brightMagenta: '#d4bfff', brightCyan: '#95e6cb', brightWhite: '#ffffff',
    },
  },
  {
    id: 'poimandres', name: 'Poimandres', accent: '#5de4c7',
    xterm: {
      background: '#1b1e28', foreground: '#a6accd', cursor: '#5de4c7', cursorAccent: '#1b1e28', selectionBackground: '#303340',
      black: '#1b1e28', red: '#d0679d', green: '#5de4c7', yellow: '#fffac2', blue: '#89ddff', magenta: '#f087bd', cyan: '#add7ff', white: '#ffffff',
      brightBlack: '#506477', brightRed: '#d0679d', brightGreen: '#5de4c7', brightYellow: '#fffac2', brightBlue: '#89ddff', brightMagenta: '#f087bd', brightCyan: '#add7ff', brightWhite: '#ffffff',
    },
  },
  {
    id: 'catppuccin-latte', name: 'Catppuccin Latte', accent: '#1e66f5', isLight: true,
    xterm: {
      background: '#eff1f5', foreground: '#4c4f69', cursor: '#dc8a78', cursorAccent: '#eff1f5', selectionBackground: '#acb0be66',
      black: '#5c5f77', red: '#d20f39', green: '#40a02b', yellow: '#df8e1d', blue: '#1e66f5', magenta: '#8839ef', cyan: '#179299', white: '#acb0be',
      brightBlack: '#6c6f85', brightRed: '#d20f39', brightGreen: '#40a02b', brightYellow: '#df8e1d', brightBlue: '#1e66f5', brightMagenta: '#8839ef', brightCyan: '#179299', brightWhite: '#bcc0cc',
    },
  },
  {
    id: 'solarized-light', name: 'Solarized Light', accent: '#268bd2', isLight: true,
    xterm: {
      background: '#fdf6e3', foreground: '#657b83', cursor: '#657b83', cursorAccent: '#fdf6e3', selectionBackground: '#eee8d5',
      black: '#073642', red: '#dc322f', green: '#859900', yellow: '#b58900', blue: '#268bd2', magenta: '#d33682', cyan: '#2aa198', white: '#eee8d5',
      brightBlack: '#002b36', brightRed: '#cb4b16', brightGreen: '#586e75', brightYellow: '#657b83', brightBlue: '#839496', brightMagenta: '#6c71c4', brightCyan: '#93a1a1', brightWhite: '#fdf6e3',
    },
  },
];
