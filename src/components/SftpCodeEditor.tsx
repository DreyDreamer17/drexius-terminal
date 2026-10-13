import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  FileCode,
  Save,
  X,
  ChevronLeft,
  Search,
  Loader2,
  WrapText,
  ChevronUp,
  ChevronDown,
} from 'lucide-react';
import { cn } from '../utils/cn';
import { THEMES, type NexusTheme } from '../lib/themes';

export interface EditorFile {
  path: string;
  name: string;
  content: string;
  isRemote: boolean;
}

interface SftpCodeEditorProps {
  file: EditorFile;
  hostLabel?: string;
  onSave: (newContent: string) => Promise<void>;
  onClose: () => void;
  toast: (msg: string) => void;
  theme?: NexusTheme;
}

// ── Language Detection ──
function detectLanguage(filename: string): { id: string; name: string } {
  const ext = filename.split('.').pop()?.toLowerCase() || '';
  switch (ext) {
    case 'py':
    case 'pyw':
      return { id: 'python', name: 'Python' };
    case 'sh':
    case 'bash':
    case 'zsh':
      return { id: 'shell', name: 'Shell Script' };
    case 'js':
    case 'mjs':
    case 'cjs':
      return { id: 'javascript', name: 'JavaScript' };
    case 'ts':
    case 'mts':
      return { id: 'typescript', name: 'TypeScript' };
    case 'tsx':
    case 'jsx':
      return { id: 'react', name: 'React (TSX/JSX)' };
    case 'json':
      return { id: 'json', name: 'JSON' };
    case 'yaml':
    case 'yml':
      return { id: 'yaml', name: 'YAML' };
    case 'toml':
      return { id: 'toml', name: 'TOML' };
    case 'rs':
      return { id: 'rust', name: 'Rust' };
    case 'go':
      return { id: 'go', name: 'Go' };
    case 'c':
    case 'h':
      return { id: 'c', name: 'C' };
    case 'cpp':
    case 'hpp':
    case 'cc':
      return { id: 'cpp', name: 'C++' };
    case 'sql':
      return { id: 'sql', name: 'SQL' };
    case 'html':
    case 'htm':
      return { id: 'html', name: 'HTML' };
    case 'css':
      return { id: 'css', name: 'CSS' };
    case 'md':
    case 'markdown':
      return { id: 'markdown', name: 'Markdown' };
    case 'conf':
    case 'cfg':
    case 'ini':
      return { id: 'config', name: 'Config' };
    default:
      return { id: 'plaintext', name: 'Plain Text' };
  }
}

// ── Lightweight High-Performance Syntax Highlighter ──
function highlightCode(code: string, langId: string): string {
  // Escape HTML entities first
  let html = code
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');

  if (langId === 'python') {
    // Comments
    html = html.replace(/(#.*$)/gm, '<span class="text-slate-500 italic">$1</span>');
    // Triple strings (docstrings)
    html = html.replace(/("""[\s\S]*?"""|'''[\s\S]*?''')/g, '<span class="text-emerald-400/90">$1</span>');
    // Double/single strings
    html = html.replace(/(&quot;.*?&quot;|&#39;.*?&#39;|"[^"\n]*"|'[^'\n]*')/g, '<span class="text-emerald-300">$1</span>');
    // Decorators
    html = html.replace(/(@\w+)/g, '<span class="text-amber-400">$1</span>');
    // Numbers
    html = html.replace(/\b(\d+(?:\.\d+)?)\b/g, '<span class="text-orange-400">$1</span>');
    // Keywords
    const pyKw = /\b(def|class|import|from|as|return|if|elif|else|for|while|try|except|finally|with|async|await|lambda|yield|pass|raise|break|continue|in|is|not|and|or|None|True|False|self)\b/g;
    html = html.replace(pyKw, '<span class="text-fuchsia-400 font-semibold">$1</span>');
    // Builtin functions
    const pyBuiltins = /\b(print|len|range|enumerate|zip|map|filter|int|str|float|list|dict|set|tuple|open|type|isinstance)\b(?=\()/g;
    html = html.replace(pyBuiltins, '<span class="text-cyan-400">$1</span>');
  } else if (['javascript', 'typescript', 'react'].includes(langId)) {
    // Comments
    html = html.replace(/(\/\/.*$)/gm, '<span class="text-slate-500 italic">$1</span>');
    html = html.replace(/(\/\*[\s\S]*?\*\/)/g, '<span class="text-slate-500 italic">$1</span>');
    // Strings
    html = html.replace(/(&quot;.*?&quot;|&#39;.*?&#39;|"[^"\n]*"|'[^'\n]*'|`[^`]*`)/g, '<span class="text-emerald-300">$1</span>');
    // Numbers
    html = html.replace(/\b(\d+(?:\.\d+)?)\b/g, '<span class="text-orange-400">$1</span>');
    // Keywords
    const jsKw = /\b(function|const|let|var|return|if|else|switch|case|break|continue|try|catch|finally|async|await|class|interface|type|extends|implements|import|export|from|default|new|this|typeof|instanceof|void|null|undefined|true|false)\b/g;
    html = html.replace(jsKw, '<span class="text-fuchsia-400 font-semibold">$1</span>');
    // Functions
    html = html.replace(/\b([a-zA-Z_$]\w*)\s*(?=\()/g, '<span class="text-cyan-400">$1</span>');
  } else if (langId === 'shell') {
    // Comments
    html = html.replace(/(#.*$)/gm, '<span class="text-slate-500 italic">$1</span>');
    // Strings
    html = html.replace(/(&quot;.*?&quot;|"[^"\n]*"|'[^'\n]*')/g, '<span class="text-emerald-300">$1</span>');
    // Variables
    html = html.replace(/(\$\w+|\$\{[^}]+\})/g, '<span class="text-amber-300 font-mono">$1</span>');
    // Numbers
    html = html.replace(/\b(\d+)\b/g, '<span class="text-orange-400">$1</span>');
    // Keywords
    const shKw = /\b(if|then|else|elif|fi|for|in|do|done|case|esac|while|until|function|return|exit|local|export|source|alias)\b/g;
    html = html.replace(shKw, '<span class="text-fuchsia-400 font-semibold">$1</span>');
    // Common commands
    const shCmds = /\b(echo|cd|ls|mkdir|rm|cp|mv|cat|grep|sed|awk|curl|wget|chmod|chown|sudo|systemctl|ssh)\b/g;
    html = html.replace(shCmds, '<span class="text-cyan-400">$1</span>');
  } else if (langId === 'json') {
    // Keys
    html = html.replace(/"([^"]+)":/g, '<span class="text-cyan-400 font-medium">"$1"</span>:');
    // Strings
    html = html.replace(/:\s*("([^"]*)")/g, ': <span class="text-emerald-300">$1</span>');
    // Numbers & Booleans
    html = html.replace(/:\s*(\b\d+(?:\.\d+)?\b)/g, ': <span class="text-orange-400">$1</span>');
    html = html.replace(/:\s*\b(true|false|null)\b/g, ': <span class="text-fuchsia-400">$1</span>');
  } else if (langId === 'rust') {
    // Comments
    html = html.replace(/(\/\/.*$)/gm, '<span class="text-slate-500 italic">$1</span>');
    // Strings
    html = html.replace(/(&quot;.*?&quot;|"[^"\n]*")/g, '<span class="text-emerald-300">$1</span>');
    // Numbers
    html = html.replace(/\b(\d+(?:_\d+)*(?:\.\d+)?)\b/g, '<span class="text-orange-400">$1</span>');
    // Keywords
    const rsKw = /\b(fn|let|mut|struct|enum|impl|trait|pub|use|mod|match|if|else|while|for|loop|return|break|continue|async|await|move|ref|where|type|const|static|true|false|None|Some|Ok|Err)\b/g;
    html = html.replace(rsKw, '<span class="text-fuchsia-400 font-semibold">$1</span>');
    // Types
    const rsTypes = /\b(u8|u16|u32|u64|u128|usize|i8|i16|i32|i64|i128|isize|f32|f64|bool|char|str|String|Vec|Option|Result)\b/g;
    html = html.replace(rsTypes, '<span class="text-amber-300">$1</span>');
  }

  return html;
}

export function SftpCodeEditor({
  file,
  hostLabel,
  onSave,
  onClose,
  toast,
  theme,
}: SftpCodeEditorProps) {
  const activeTheme = theme || THEMES.find((t) => t.id === (localStorage.getItem('nx.theme') ?? 'nexus')) || THEMES[0];
  const accentColor = activeTheme.accent || '#22d3ee';
  const bgColor = activeTheme.xterm.background || '#090d16';

  const [content, setContent] = useState<string>(file.content);
  const [originalContent, setOriginalContent] = useState<string>(file.content);
  const [saving, setSaving] = useState<boolean>(false);
  const [wordWrap, setWordWrap] = useState<boolean>(false);

  // Cursor & selection tracking
  const [cursorLine, setCursorLine] = useState<number>(1);
  const [cursorCol, setCursorCol] = useState<number>(1);

  // Search in file
  const [showSearch, setShowSearch] = useState<boolean>(false);
  const [searchQuery, setSearchQuery] = useState<string>('');
  const [matchCount, setMatchCount] = useState<number>(0);
  const [currentMatch, setCurrentMatch] = useState<number>(0);

  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const gutterRef = useRef<HTMLDivElement>(null);
  const preRef = useRef<HTMLPreElement>(null);
  const searchInputRef = useRef<HTMLInputElement>(null);

  const lang = useMemo(() => detectLanguage(file.name), [file.name]);
  const lines = useMemo(() => content.split('\n'), [content]);
  const isDirty = content !== originalContent;

  // Sync scrolling between line numbers, syntax pre, and textarea
  const handleScroll = useCallback(() => {
    if (!textareaRef.current) return;
    const { scrollTop, scrollLeft } = textareaRef.current;
    if (gutterRef.current) {
      gutterRef.current.scrollTop = scrollTop;
    }
    if (preRef.current) {
      preRef.current.scrollTop = scrollTop;
      preRef.current.scrollLeft = scrollLeft;
    }
  }, []);

  // Update cursor position line & col
  const updateCursorPos = useCallback(() => {
    if (!textareaRef.current) return;
    const pos = textareaRef.current.selectionStart || 0;
    const textBefore = content.substring(0, pos);
    const lineArr = textBefore.split('\n');
    setCursorLine(lineArr.length);
    setCursorCol(lineArr[lineArr.length - 1].length + 1);
  }, [content]);

  // Handle Save
  const handleSave = useCallback(async () => {
    if (saving) return;
    setSaving(true);
    try {
      await onSave(content);
      setOriginalContent(content);
      toast(`Saved ${file.name}`);
    } catch (err) {
      toast(`Save error: ${err}`);
    } finally {
      setSaving(false);
    }
  }, [saving, onSave, content, file.name, toast]);

  // Confirm close if unsaved
  const handleClose = useCallback(() => {
    if (isDirty) {
      if (!confirm(`You have unsaved changes in "${file.name}". Discard changes?`)) {
        return;
      }
    }
    onClose();
  }, [isDirty, file.name, onClose]);

  // Handle Tab key insertion (4 spaces)
  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
      // ⌘S or Ctrl+S to save
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 's') {
        e.preventDefault();
        handleSave();
        return;
      }

      // ⌘F or Ctrl+F to find
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'f') {
        e.preventDefault();
        setShowSearch(true);
        setTimeout(() => searchInputRef.current?.focus(), 50);
        return;
      }

      // Tab key
      if (e.key === 'Tab') {
        e.preventDefault();
        const textarea = textareaRef.current;
        if (!textarea) return;

        const start = textarea.selectionStart;
        const end = textarea.selectionEnd;
        const tabStr = '    '; // 4 spaces

        if (!e.shiftKey) {
          // Insert 4 spaces
          const nextVal = content.substring(0, start) + tabStr + content.substring(end);
          setContent(nextVal);
          setTimeout(() => {
            textarea.selectionStart = textarea.selectionEnd = start + tabStr.length;
            updateCursorPos();
          }, 0);
        } else {
          // Shift+Tab: Dedent
          const linesBefore = content.substring(0, start).split('\n');
          const currentLineIdx = linesBefore.length - 1;
          const allLines = content.split('\n');
          const currentLine = allLines[currentLineIdx];

          if (currentLine.startsWith('    ')) {
            allLines[currentLineIdx] = currentLine.substring(4);
            const nextVal = allLines.join('\n');
            setContent(nextVal);
            setTimeout(() => {
              textarea.selectionStart = textarea.selectionEnd = Math.max(0, start - 4);
              updateCursorPos();
            }, 0);
          } else if (currentLine.startsWith('  ')) {
            allLines[currentLineIdx] = currentLine.substring(2);
            const nextVal = allLines.join('\n');
            setContent(nextVal);
            setTimeout(() => {
              textarea.selectionStart = textarea.selectionEnd = Math.max(0, start - 2);
              updateCursorPos();
            }, 0);
          }
        }
      }

      // Esc closes search or editor
      if (e.key === 'Escape') {
        if (showSearch) {
          e.preventDefault();
          setShowSearch(false);
        }
      }
    },
    [handleSave, content, updateCursorPos, showSearch]
  );

  // Search matching in content
  useEffect(() => {
    if (!searchQuery.trim()) {
      setMatchCount(0);
      setCurrentMatch(0);
      return;
    }
    const escaped = searchQuery.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const regex = new RegExp(escaped, 'gi');
    const matches = content.match(regex);
    setMatchCount(matches ? matches.length : 0);
    setCurrentMatch(matches ? 1 : 0);
  }, [searchQuery, content]);

  const findNext = () => {
    if (!searchQuery.trim() || !textareaRef.current) return;
    const textarea = textareaRef.current;
    const startPos = textarea.selectionEnd;
    const index = content.toLowerCase().indexOf(searchQuery.toLowerCase(), startPos);
    if (index !== -1) {
      textarea.focus();
      textarea.setSelectionRange(index, index + searchQuery.length);
      setCurrentMatch((prev) => (prev < matchCount ? prev + 1 : 1));
    } else {
      // Wrap to beginning
      const wrapIndex = content.toLowerCase().indexOf(searchQuery.toLowerCase(), 0);
      if (wrapIndex !== -1) {
        textarea.focus();
        textarea.setSelectionRange(wrapIndex, wrapIndex + searchQuery.length);
        setCurrentMatch(1);
      }
    }
    updateCursorPos();
  };

  const findPrev = () => {
    if (!searchQuery.trim() || !textareaRef.current) return;
    const textarea = textareaRef.current;
    const startPos = textarea.selectionStart;
    const lastIndex = content.toLowerCase().lastIndexOf(searchQuery.toLowerCase(), Math.max(0, startPos - 1));
    if (lastIndex !== -1) {
      textarea.focus();
      textarea.setSelectionRange(lastIndex, lastIndex + searchQuery.length);
      setCurrentMatch((prev) => (prev > 1 ? prev - 1 : matchCount));
    }
    updateCursorPos();
  };

  // Syntax highlighted HTML
  const highlightedHtml = useMemo(() => {
    return highlightCode(content, lang.id);
  }, [content, lang.id]);

  return (
    <div
      className="absolute inset-0 z-40 flex flex-col overflow-hidden text-slate-200 select-none animate-in fade-in duration-100"
      style={{ backgroundColor: bgColor }}
    >
      {/* ── Editor Top Header Bar (Clean VS Code style, no distracting gradients) ── */}
      <div className="relative flex h-11 shrink-0 items-center justify-between border-b border-white/[0.08] px-3 bg-black/30 z-20">
        <div className="flex items-center gap-2 min-w-0">
          {/* Back button */}
          <button
            onClick={handleClose}
            title="Back to file explorer (Esc)"
            className="flex items-center gap-1 rounded-lg px-2 py-1 text-xs font-medium text-slate-300 hover:bg-white/[0.08] hover:text-white transition"
          >
            <ChevronLeft className="h-4 w-4" />
            <span className="hidden sm:inline">Files</span>
          </button>

          <div className="h-4 w-[1px] bg-white/10 mx-1 shrink-0" />

          {/* Active File Tab Pill */}
          <div
            className="flex items-center gap-2 rounded-xl bg-white/[0.05] border px-3 py-1 shadow-sm shrink-0"
            style={{
              borderColor: `${accentColor}35`,
            }}
          >
            <FileCode className="h-3.5 w-3.5 shrink-0" style={{ color: accentColor }} />
            <span className="text-xs font-semibold text-slate-100">{file.name}</span>
            {isDirty && (
              <span
                title="Unsaved changes"
                className="h-2 w-2 rounded-full bg-amber-400 ring-2 ring-amber-400/30 animate-pulse"
              />
            )}
          </div>

          {/* Path Crumb */}
          <div className="hidden md:flex items-center gap-1.5 text-xs text-slate-400 min-w-0 font-mono truncate pl-2">
            <span className="truncate opacity-70">
              {file.isRemote ? (hostLabel ? `${hostLabel}:` : 'remote:') : 'local:'}{file.path}
            </span>
          </div>
        </div>

        {/* Right Action Buttons */}
        <div className="flex items-center gap-2 shrink-0">
          {/* Search Toggle */}
          <button
            onClick={() => {
              setShowSearch((v) => !v);
              if (!showSearch) setTimeout(() => searchInputRef.current?.focus(), 50);
            }}
            title="Find in file (⌘F)"
            className={cn(
              'flex h-7 items-center gap-1 rounded-lg px-2 text-xs transition border',
              showSearch
                ? 'bg-cyan-500/20 text-cyan-300 border-cyan-400/40'
                : 'text-slate-400 hover:bg-white/[0.08] hover:text-white border-transparent'
            )}
          >
            <Search className="h-3.5 w-3.5" />
            <span className="hidden sm:inline">Find</span>
          </button>

          {/* Word Wrap Toggle */}
          <button
            onClick={() => setWordWrap((v) => !v)}
            title={wordWrap ? 'Disable word wrap' : 'Enable word wrap'}
            className={cn(
              'flex h-7 items-center gap-1 rounded-lg px-2 text-xs transition border',
              wordWrap
                ? 'bg-cyan-500/20 text-cyan-300 border-cyan-400/40'
                : 'text-slate-400 hover:bg-white/[0.08] hover:text-white border-transparent'
            )}
          >
            <WrapText className="h-3.5 w-3.5" />
          </button>

          {/* Save Button */}
          <button
            disabled={saving || !isDirty}
            onClick={handleSave}
            title="Save file (⌘S)"
            className={cn(
              'flex h-7 items-center gap-1.5 rounded-xl border px-3 text-xs font-semibold transition shadow-sm',
              isDirty
                ? 'bg-emerald-500/25 border-emerald-400/50 text-emerald-300 hover:bg-emerald-500/35 cursor-pointer shadow-[0_0_12px_rgba(16,185,129,0.3)]'
                : 'bg-white/[0.04] border-white/10 text-slate-500 cursor-not-allowed opacity-60'
            )}
          >
            {saving ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : (
              <Save className="h-3.5 w-3.5" />
            )}
            <span>Save</span>
            <span className="text-[10px] opacity-70 font-mono hidden sm:inline">⌘S</span>
          </button>

          {/* Close Editor */}
          <button
            onClick={handleClose}
            title="Close editor (Esc)"
            className="rounded-lg p-1.5 text-slate-400 hover:bg-white/10 hover:text-white transition"
          >
            <X className="h-4 w-4" />
          </button>
        </div>
      </div>

      {/* ── Floating Search Bar (if ⌘F active) ── */}
      {showSearch && (
        <div className="absolute right-6 top-13 z-50 flex items-center gap-2 rounded-2xl border border-white/15 bg-[#0e131d]/95 p-1.5 shadow-2xl backdrop-blur-xl animate-in fade-in slide-in-from-top-2 duration-150">
          <div className="relative flex items-center">
            <Search className="absolute left-2.5 h-3.5 w-3.5 text-slate-400" />
            <input
              ref={searchInputRef}
              type="text"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  if (e.shiftKey) findPrev();
                  else findNext();
                } else if (e.key === 'Escape') {
                  setShowSearch(false);
                }
              }}
              placeholder="Find..."
              className="h-7 w-48 rounded-xl bg-white/[0.06] pl-8 pr-3 text-xs text-slate-200 placeholder-slate-500 border border-white/10 focus:border-cyan-400/50 focus:outline-none focus:ring-1 focus:ring-cyan-400/30"
            />
          </div>

          <span className="text-[11px] font-mono text-slate-400 px-1 min-w-[50px] text-center">
            {matchCount > 0 ? `${currentMatch}/${matchCount}` : searchQuery ? 'No match' : ''}
          </span>

          <button
            onClick={findPrev}
            title="Previous match (Shift+Enter)"
            className="grid h-6 w-6 place-items-center rounded text-slate-400 hover:bg-white/10 hover:text-white"
          >
            <ChevronUp className="h-3.5 w-3.5" />
          </button>
          <button
            onClick={findNext}
            title="Next match (Enter)"
            className="grid h-6 w-6 place-items-center rounded text-slate-400 hover:bg-white/10 hover:text-white"
          >
            <ChevronDown className="h-3.5 w-3.5" />
          </button>
          <button
            onClick={() => setShowSearch(false)}
            title="Close find (Esc)"
            className="grid h-6 w-6 place-items-center rounded text-slate-400 hover:bg-white/10 hover:text-white"
          >
            <X className="h-3.5 w-3.5" />
          </button>
        </div>
      )}

      {/* ── Main Code View: Gutter + Code Editor ── */}
      <div className="relative flex flex-1 min-h-0 min-w-0 bg-black/30">
        {/* Line Numbers Gutter */}
        <div
          ref={gutterRef}
          className="w-14 shrink-0 select-none overflow-hidden border-r border-white/[0.06] bg-black/40 py-3 text-right font-mono text-xs leading-5 text-slate-600"
          style={{ height: '100%' }}
        >
          {lines.map((_, i) => {
            const lineNum = i + 1;
            const isCurrent = lineNum === cursorLine;
            return (
              <div
                key={lineNum}
                className={cn(
                  'pr-3 font-mono text-[11px]',
                  isCurrent ? 'font-bold text-cyan-300 bg-cyan-400/10' : 'text-slate-600'
                )}
              >
                {lineNum}
              </div>
            );
          })}
        </div>

        {/* Code Canvas (Dual-layer: Syntax pre in background + Textarea on top) */}
        <div className="relative flex-1 min-w-0 min-h-0 overflow-hidden">
          {/* Syntax Highlighted Background Pre */}
          <pre
            ref={preRef}
            aria-hidden="true"
            className={cn(
              'pointer-events-none absolute inset-0 m-0 p-3 font-mono text-xs leading-5 overflow-hidden select-none',
              wordWrap ? 'whitespace-pre-wrap break-words' : 'whitespace-pre'
            )}
            style={{ fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace' }}
            dangerouslySetInnerHTML={{ __html: highlightedHtml + '\n' }}
          />

          {/* Transparent Input Textarea on Foreground */}
          <textarea
            ref={textareaRef}
            value={content}
            onChange={(e) => {
              setContent(e.target.value);
              updateCursorPos();
            }}
            onScroll={handleScroll}
            onClick={updateCursorPos}
            onKeyUp={updateCursorPos}
            onSelect={updateCursorPos}
            onKeyDown={handleKeyDown}
            spellCheck={false}
            autoFocus
            className={cn(
              'absolute inset-0 h-full w-full resize-none p-3 font-mono text-xs leading-5 bg-transparent text-transparent caret-cyan-400 selection:bg-cyan-500/35 focus:outline-none [tab-size:4]',
              wordWrap ? 'whitespace-pre-wrap break-words' : 'whitespace-pre'
            )}
            style={{
              fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace',
            }}
          />
        </div>
      </div>

      {/* ── Bottom VS Code / Neovim Style Status Bar ── */}
      <div className="flex h-6 shrink-0 items-center justify-between border-t border-white/[0.08] bg-[#070a10] px-3 text-[11px] text-slate-400 select-none">
        {/* Left Status: Neovim Mode & File target */}
        <div className="flex items-center gap-3">
          <div className="flex items-center gap-1.5 font-bold font-mono text-[10px] tracking-wider text-cyan-300">
            <span className="h-2 w-2 rounded-full bg-cyan-400" />
            <span>-- EDIT --</span>
          </div>
          <span className="text-slate-500">|</span>
          <span className="text-slate-400 truncate max-w-xs font-mono">
            {file.isRemote ? (hostLabel ? `Host: ${hostLabel}` : 'Remote SFTP') : 'Local Filesystem'}
          </span>
        </div>

        {/* Right Status: Line, Col, Indent, Encoding, Language, Modified */}
        <div className="flex items-center gap-4 font-mono text-[10.5px]">
          <span>
            Ln {cursorLine}, Col {cursorCol}
          </span>
          <span className="text-slate-600 hidden sm:inline">|</span>
          <span className="hidden sm:inline">{lines.length} lines</span>
          <span className="text-slate-600 hidden sm:inline">|</span>
          <span className="hidden sm:inline">Spaces: 4</span>
          <span className="text-slate-600 hidden md:inline">|</span>
          <span className="hidden md:inline">UTF-8</span>
          <span className="text-slate-600">|</span>
          <span className="font-semibold text-slate-200">{lang.name}</span>
          <span className="text-slate-600">|</span>
          {isDirty ? (
            <span className="font-semibold text-amber-400 flex items-center gap-1">
              <span className="h-1.5 w-1.5 rounded-full bg-amber-400" />
              Modified
            </span>
          ) : (
            <span className="text-emerald-400 flex items-center gap-1">
              <span className="h-1.5 w-1.5 rounded-full bg-emerald-400" />
              Saved
            </span>
          )}
        </div>
      </div>
    </div>
  );
}
