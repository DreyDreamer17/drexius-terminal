import type { ITheme } from '@xterm/xterm';

export interface NexusTheme { id: string; name: string; accent: string; xterm: ITheme; }

export const THEMES: NexusTheme[] = [
  {
    id: 'nexus', name: 'Nexus Night', accent: '#22d3ee',
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
];
