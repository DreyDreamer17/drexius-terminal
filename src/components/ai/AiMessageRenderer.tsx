import React, { useEffect, useRef, useState } from 'react';
import { Check, ChevronRight, Copy, CornerDownLeft, ShieldAlert, X } from 'lucide-react';
import { bridge } from '../../lib/bridge';
import { classifyRisk } from '../../lib/ollama';
import { registry } from '../../lib/sessions';
import { cn } from '../../utils/cn';

export function Dots() {
  return (
    <span className="inline-flex gap-1 py-1">
      {[0, 1, 2].map((i) => (
        <span
          key={i}
          className="h-1.5 w-1.5 animate-bounce rounded-full bg-cyan-400"
          style={{ animationDelay: `${i * 120}ms` }}
        />
      ))}
    </span>
  );
}

function renderInline(text: string): React.ReactNode {
  if (!text) return null;

  // Split on inline markdown patterns: code, bold, italic, strikethrough, links
  const inlineRegex =
    /(`[^`]+`|\*\*[^*]+\*\*|__[^_]+__|~~[^~]+~~|(?<!\*)\*(?!\*)[^*]+(?<!\*)\*(?!\*)|\[[^\]]+\]\([^)]+\))/g;
  const parts = text.split(inlineRegex);

  return parts.map((part, idx) => {
    if (!part) return null;

    if (part.startsWith('`') && part.endsWith('`') && part.length >= 2) {
      return (
        <code
          key={idx}
          className="rounded bg-white/10 px-1 py-0.5 font-mono text-[11px] text-cyan-200 border border-white/5 break-words [overflow-wrap:anywhere]"
        >
          {part.slice(1, -1)}
        </code>
      );
    }
    if (
      (part.startsWith('**') && part.endsWith('**')) ||
      (part.startsWith('__') && part.endsWith('__'))
    ) {
      return (
        <strong key={idx} className="font-semibold text-white">
          {part.slice(2, -2)}
        </strong>
      );
    }
    if (part.startsWith('~~') && part.endsWith('~~')) {
      return (
        <del key={idx} className="line-through text-slate-500">
          {part.slice(2, -2)}
        </del>
      );
    }
    if (part.startsWith('*') && part.endsWith('*') && part.length >= 2) {
      return (
        <em key={idx} className="italic text-slate-200">
          {part.slice(1, -1)}
        </em>
      );
    }
    const linkMatch = part.match(/^\[([^\]]+)\]\(([^)]+)\)$/);
    if (linkMatch) {
      const rawUrl = linkMatch[2].trim();
      const isSafe = /^https?:\/\//i.test(rawUrl) || /^mailto:/i.test(rawUrl);
      if (isSafe) {
        return (
          <a
            key={idx}
            href={rawUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="text-cyan-400 hover:text-cyan-300 underline underline-offset-2 transition break-all"
          >
            {linkMatch[1]}
          </a>
        );
      }
      return (
        <span key={idx} className="text-slate-300 break-words [overflow-wrap:anywhere]">
          {linkMatch[1]}
        </span>
      );
    }

    return part;
  });
}

function renderMarkdownText(text: string): React.ReactNode {
  const lines = text.split('\n');
  const elements: React.ReactNode[] = [];
  let i = 0;

  // Helper to test if a line is a table delimiter like |---|---| or |:---:|---:|
  const isTableDelimiter = (s: string) => /^\|?\s*:?-+:?\s*(\|:?-+:?\s*)+\|?$/.test(s.trim());

  while (i < lines.length) {
    const line = lines[i];
    const trimmed = line.trim();

    if (!trimmed) {
      i++;
      continue;
    }

    // 1. Table Detection
    if (trimmed.includes('|') && i + 1 < lines.length && isTableDelimiter(lines[i + 1])) {
      const splitRow = (r: string) => {
        const cells = r.trim().split('|');
        if (cells[0] === '') cells.shift();
        if (cells[cells.length - 1] === '') cells.pop();
        return cells.map((c) => c.trim());
      };

      const headers = splitRow(lines[i]);
      const delimCells = splitRow(lines[i + 1]);
      const alignments = delimCells.map((d) => {
        const left = d.startsWith(':');
        const right = d.endsWith(':');
        if (left && right) return 'center';
        if (right) return 'right';
        return 'left';
      });

      const rows: string[][] = [];
      i += 2;
      while (i < lines.length && lines[i].trim().includes('|') && !isTableDelimiter(lines[i])) {
        rows.push(splitRow(lines[i]));
        i++;
      }

      elements.push(
        <div
          key={`table-${i}`}
          className="my-2.5 overflow-x-auto rounded-lg border border-white/10 bg-[#0a0e17]/90 shadow-sm"
        >
          <table className="w-full text-left text-xs border-collapse">
            <thead className="bg-white/5 border-b border-white/10 text-slate-200 font-semibold font-sans">
              <tr>
                {headers.map((h, hi) => (
                  <th
                    key={hi}
                    className={cn(
                      'px-3 py-2 text-xs font-semibold select-none',
                      alignments[hi] === 'center'
                        ? 'text-center'
                        : alignments[hi] === 'right'
                        ? 'text-right'
                        : 'text-left'
                    )}
                  >
                    {renderInline(h)}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody className="divide-y divide-white/5 font-sans">
              {rows.map((row, ri) => (
                <tr key={ri} className="hover:bg-white/[0.02] transition">
                  {row.map((cell, ci) => (
                    <td
                      key={ci}
                      className={cn(
                        'px-3 py-2 text-slate-300 align-top',
                        alignments[ci] === 'center'
                          ? 'text-center'
                          : alignments[ci] === 'right'
                          ? 'text-right'
                          : 'text-left'
                      )}
                    >
                      {renderInline(cell)}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      );
      continue;
    }

    // 2. Headings
    const headingMatch = trimmed.match(/^(#{1,6})\s+(.*)$/);
    if (headingMatch) {
      const level = headingMatch[1].length;
      const hText = headingMatch[2];
      if (level === 1) {
        elements.push(
          <h1 key={`h1-${i}`} className="text-base font-bold text-white mt-3 mb-1.5">
            {renderInline(hText)}
          </h1>
        );
      } else if (level === 2) {
        elements.push(
          <h2 key={`h2-${i}`} className="text-sm font-bold text-white mt-2.5 mb-1">
            {renderInline(hText)}
          </h2>
        );
      } else if (level === 3) {
        elements.push(
          <h3 key={`h3-${i}`} className="text-xs font-semibold text-slate-100 mt-2 mb-0.5">
            {renderInline(hText)}
          </h3>
        );
      } else {
        elements.push(
          <h4 key={`h4-${i}`} className="text-xs font-medium text-slate-200 mt-1.5 mb-0.5">
            {renderInline(hText)}
          </h4>
        );
      }
      i++;
      continue;
    }

    // 3. Horizontal Rule
    if (/^(?:---|\*\*\*|___)\s*$/.test(trimmed)) {
      elements.push(<hr key={`hr-${i}`} className="border-white/10 my-2.5" />);
      i++;
      continue;
    }

    // 4. Chain-of-Thought / Thinking Block (auto-collapsed by default)
    if (trimmed.startsWith('💭') && /thinking/i.test(trimmed)) {
      const startIdx = i;
      i++;
      while (i < lines.length && !lines[i].trim()) {
        i++;
      }
      const quoteLines: string[] = [];
      while (i < lines.length && lines[i].trim().startsWith('>')) {
        quoteLines.push(lines[i].trim().replace(/^>\s*/, ''));
        i++;
      }
      // Consume optional blank lines and the trailing `---` separator emitted when thinking finishes
      let lookahead = i;
      while (lookahead < lines.length && !lines[lookahead].trim()) {
        lookahead++;
      }
      let isDone = false;
      if (lookahead < lines.length && /^(?:---|\*\*\*|___)\s*$/.test(lines[lookahead].trim())) {
        isDone = true;
        i = lookahead + 1;
      } else if (lookahead < lines.length) {
        isDone = true;
      }
      elements.push(<ThinkingBlock key={`think-${startIdx}`} lines={quoteLines} done={isDone} />);
      continue;
    }

    // 5. Blockquote
    if (trimmed.startsWith('>')) {
      const quoteLines: string[] = [];
      while (i < lines.length && lines[i].trim().startsWith('>')) {
        quoteLines.push(lines[i].trim().replace(/^>\s*/, ''));
        i++;
      }
      elements.push(
        <blockquote
          key={`quote-${i}`}
          className="border-l-2 border-cyan-500/60 bg-cyan-500/5 px-3 py-1.5 my-1.5 rounded-r text-slate-300 italic text-xs break-words [overflow-wrap:anywhere] min-w-0 max-w-full"
        >
          {quoteLines.map((ql, qli) => (
            <div key={qli}>{renderInline(ql)}</div>
          ))}
        </blockquote>
      );
      continue;
    }

    // 6. Unordered List
    if (/^[-*+]\s+/.test(trimmed)) {
      const items: string[] = [];
      while (i < lines.length && /^[-*+]\s+/.test(lines[i].trim())) {
        items.push(lines[i].trim().replace(/^[-*+]\s+/, ''));
        i++;
      }
      elements.push(
        <ul
          key={`ul-${i}`}
          className="my-1.5 ml-4 list-disc space-y-1 text-xs text-slate-300 break-words [overflow-wrap:anywhere]"
        >
          {items.map((it, iti) => (
            <li key={iti} className="leading-relaxed">
              {renderInline(it)}
            </li>
          ))}
        </ul>
      );
      continue;
    }

    // 7. Ordered List
    if (/^\d+\.\s+/.test(trimmed)) {
      const items: string[] = [];
      while (i < lines.length && /^\d+\.\s+/.test(lines[i].trim())) {
        items.push(lines[i].trim().replace(/^\d+\.\s+/, ''));
        i++;
      }
      elements.push(
        <ol
          key={`ol-${i}`}
          className="my-1.5 ml-4 list-decimal space-y-1 text-xs text-slate-300 break-words [overflow-wrap:anywhere]"
        >
          {items.map((it, iti) => (
            <li key={iti} className="leading-relaxed">
              {renderInline(it)}
            </li>
          ))}
        </ol>
      );
      continue;
    }

    // 8. Regular Paragraph (gather lines until next block element or blank line)
    const pLines: string[] = [];
    while (
      i < lines.length &&
      lines[i].trim() &&
      !(lines[i].trim().startsWith('💭') && /thinking/i.test(lines[i].trim())) &&
      !lines[i].trim().match(/^#{1,6}\s+/) &&
      !lines[i].trim().match(/^[-*+]\s+/) &&
      !lines[i].trim().match(/^\d+\.\s+/) &&
      !lines[i].trim().startsWith('>') &&
      !/^(?:---|\*\*\*|___)\s*$/.test(lines[i].trim()) &&
      !(lines[i].trim().includes('|') && i + 1 < lines.length && isTableDelimiter(lines[i + 1]))
    ) {
      pLines.push(lines[i]);
      i++;
    }

    if (pLines.length > 0) {
      elements.push(
        <div
          key={`p-${i}`}
          className="my-1 text-xs text-slate-300 leading-relaxed break-words [overflow-wrap:anywhere]"
        >
          {pLines.map((pl, pli) => (
            <React.Fragment key={pli}>
              {renderInline(pl)}
              {pli < pLines.length - 1 ? <br /> : null}
            </React.Fragment>
          ))}
        </div>
      );
    }
  }

  return <>{elements}</>;
}

function ThinkingBlock({ lines, done }: { lines: string[]; done: boolean }) {
  const [expanded, setExpanded] = useState(false);
  const isInitialDone = useRef(done);
  const startTimeRef = useRef<number>(Date.now());
  const [seconds, setSeconds] = useState<number | null>(null);

  useEffect(() => {
    if (isInitialDone.current) return;
    if (!done) {
      const timer = setInterval(() => {
        setSeconds(Math.max(1, Math.round((Date.now() - startTimeRef.current) / 1000)));
      }, 1000);
      return () => clearInterval(timer);
    } else if (seconds === null) {
      setSeconds(Math.max(1, Math.round((Date.now() - startTimeRef.current) / 1000)));
    }
  }, [done, seconds]);

  const label = !done
    ? seconds
      ? `Thinking for ${seconds}s`
      : 'Thinking…'
    : seconds
    ? `Thought for ${seconds}s`
    : 'Thought process';

  const nonEmptyLines = lines.filter((l) => l.trim().length > 0);

  return (
    <div className="my-1 min-w-0 max-w-full">
      <button
        type="button"
        onClick={() => setExpanded((v) => !v)}
        className="group inline-flex items-center gap-1 text-xs text-slate-400 hover:text-slate-200 transition cursor-pointer select-none py-0.5"
        title={expanded ? 'Collapse thoughts' : 'Expand thoughts'}
      >
        <span>{label}</span>
        <ChevronRight
          className={cn(
            'h-3 w-3 text-slate-500 group-hover:text-slate-300 transition-transform duration-150',
            expanded && 'rotate-90'
          )}
        />
      </button>
      {expanded && nonEmptyLines.length > 0 && (
        <div className="mt-1 pl-3 border-l-2 border-slate-700/60 text-slate-400 text-xs leading-relaxed space-y-1 select-text break-words [overflow-wrap:anywhere] min-w-0 max-w-full">
          {lines.map((ql, qli) => (
            <div key={qli}>{ql ? renderInline(ql) : <br />}</div>
          ))}
        </div>
      )}
    </div>
  );
}

interface OpenCodeWorkflowData {
  tool: string;
  target: string;
  status: string;
  exit_code?: number | null;
  duration_ms?: number | null;
  output: string;
  diff?: string | null;
  additions?: number | null;
  deletions?: number | null;
}

function OpenCodeWorkflowCard({
  data,
  toast,
}: {
  data: OpenCodeWorkflowData;
  toast: (m: string) => void;
}) {
  const isBash = data.tool === 'bash';
  const isRead = data.tool === 'read' || data.tool === 'read_file';
  const isEdit =
    data.tool === 'edit' ||
    data.tool === 'edit_file' ||
    data.tool === 'patch' ||
    data.tool === 'apply_patch' ||
    data.tool === 'multiedit';
  const isWrite = data.tool === 'write' || data.tool === 'write_file';
  const isError =
    data.status === 'error' ||
    data.status === 'failed' ||
    (typeof data.exit_code === 'number' && data.exit_code !== 0);

  const hasDiff = Boolean(data.diff && data.diff.trim());
  const [expanded, setExpanded] = useState(false);
  const [copied, setCopied] = useState(false);

  const copy = (e: React.MouseEvent) => {
    e.stopPropagation();
    bridge.writeClipboard(data.diff || data.output || data.target);
    setCopied(true);
    toast(hasDiff ? 'Diff copied to clipboard' : 'Output copied to clipboard');
    setTimeout(() => setCopied(false), 1500);
  };

  const titlePrefix = isBash
    ? 'Executed'
    : isRead
    ? 'Read'
    : isEdit
    ? 'Edited'
    : isWrite
    ? 'Wrote'
    : 'Ran';

  const cleanTarget = (data.target || '').trim();
  const isFileTool = isRead || isEdit || isWrite;
  const pathParts = cleanTarget.split(/[/\\]/);
  const fileName = isFileTool && pathParts.length > 1 ? pathParts[pathParts.length - 1] : cleanTarget;

  const diffLines: string[] = (() => {
    if (!data.diff) return [];
    const raw = data.diff.replace(/\r\n/g, '\n').split('\n');
    const filtered = raw.filter(
      (line) =>
        !line.startsWith('Index: ') &&
        !line.startsWith('===') &&
        !line.startsWith('--- ') &&
        !line.startsWith('+++ ') &&
        !line.startsWith('\\ No newline')
    );
    return filtered.length > 0 ? filtered : raw;
  })();

  const hoverTitle = [
    `${titlePrefix} ${cleanTarget}`,
    typeof data.exit_code === 'number' ? `exit ${data.exit_code}` : null,
    typeof data.duration_ms === 'number' ? `${data.duration_ms}ms` : null,
    expanded ? 'click to collapse' : 'click to expand',
  ]
    .filter(Boolean)
    .join(' • ');

  return (
    <div className="my-1">
      <button
        type="button"
        onClick={() => setExpanded((v) => !v)}
        className="group inline-flex flex-wrap items-center gap-1.5 text-xs text-slate-400 hover:text-slate-200 transition cursor-pointer select-none py-0.5 text-left"
        title={hoverTitle}
      >
        <span className="text-slate-400">{titlePrefix}</span>

        <span className="font-mono text-slate-200 font-medium truncate max-w-[260px] sm:max-w-[400px]">
          {isFileTool ? fileName : cleanTarget}
        </span>

        {(hasDiff || isEdit || isWrite) && (
          <span className="text-[10.5px] font-mono text-amber-300/80">diff</span>
        )}

        {(typeof data.additions === 'number' || typeof data.deletions === 'number') && (
          <span className="text-[10px] font-mono">
            <span className="text-emerald-400">+{data.additions ?? 0}</span>
            <span className="text-slate-600">/</span>
            <span className="text-rose-400">-{data.deletions ?? 0}</span>
          </span>
        )}

        {isError ? (
          <X className="h-3 w-3 text-rose-400 shrink-0" />
        ) : (
          <Check className="h-3 w-3 text-emerald-400 shrink-0" />
        )}

        <ChevronRight
          className={cn(
            'h-3 w-3 text-slate-500 group-hover:text-slate-300 transition-transform duration-150 shrink-0',
            expanded && 'rotate-90'
          )}
        />
      </button>

      {/* Expandable Output / Diff Drawer */}
      {expanded && (
        <div className="mt-1 mb-2 overflow-hidden rounded-lg border border-white/10 bg-[#06080d] shadow-md text-xs">
          <div className="flex items-center justify-between border-b border-white/5 bg-white/[0.02] px-2.5 py-1 text-[10.5px]">
            <span className="font-mono text-slate-400 font-medium uppercase tracking-wider text-[9.5px]">
              {hasDiff ? 'File Diff' : isBash ? 'Terminal Output' : isError ? 'Error Detail' : 'Tool Result'}
            </span>
            <button
              type="button"
              onClick={copy}
              className="flex items-center gap-1 rounded px-1.5 py-0.5 text-[10px] font-medium text-slate-400 hover:bg-white/10 hover:text-white transition cursor-pointer"
            >
              {copied ? <Check className="h-3 w-3 text-emerald-400" /> : <Copy className="h-3 w-3" />}
              <span>{copied ? 'Copied' : hasDiff ? 'Copy Diff' : 'Copy'}</span>
            </button>
          </div>
          {hasDiff ? (
            <div className="max-h-96 overflow-x-auto overflow-y-auto py-1 font-mono text-[11px] leading-relaxed selection:bg-cyan-500/30">
              {diffLines.map((line, idx) => {
                if (line.startsWith('@@')) {
                  return (
                    <div
                      key={idx}
                      className="bg-cyan-500/10 text-cyan-300/80 px-2.5 py-0.5 text-[10px] border-y border-cyan-500/15 select-none whitespace-pre"
                    >
                      {line}
                    </div>
                  );
                }
                if (line.startsWith('+')) {
                  return (
                    <div
                      key={idx}
                      className="bg-emerald-500/15 text-emerald-200 border-l-2 border-emerald-400 px-2 py-0.5 whitespace-pre"
                    >
                      {line}
                    </div>
                  );
                }
                if (line.startsWith('-')) {
                  return (
                    <div
                      key={idx}
                      className="bg-rose-500/15 text-rose-200 border-l-2 border-rose-400 px-2 py-0.5 whitespace-pre"
                    >
                      {line}
                    </div>
                  );
                }
                return (
                  <div key={idx} className="text-slate-400 px-2.5 py-0.5 whitespace-pre">
                    {line || ' '}
                  </div>
                );
              })}
            </div>
          ) : (
            <pre
              className={cn(
                'max-h-80 overflow-x-auto overflow-y-auto p-2.5 font-mono text-[11px] leading-relaxed selection:bg-cyan-500/30',
                isError ? 'text-rose-300 bg-rose-950/20' : 'text-slate-300'
              )}
            >
              {data.output && data.output.trim() ? (
                data.output
              ) : (
                <span className="italic text-slate-500">
                  {isError ? '(operation failed with no error output)' : '(no output produced)'}
                </span>
              )}
            </pre>
          )}
        </div>
      )}
    </div>
  );
}

export function Rich({
  text,
  activePaneId,
  toast,
}: {
  text: string;
  activePaneId: string | null;
  toast: (m: string) => void;
}) {
  const parts = text.split(/```(?:\w+)?\n?([\s\S]*?)(?:```|$)/g);
  return (
    <div className="space-y-2 min-w-0 max-w-full">
      {parts.map((p, i) => {
        if (i % 2 === 1) {
          const trimmed = p.trim();

          // Check if this is an OpenCode workflow card payload
          if (
            trimmed.startsWith('{') &&
            trimmed.includes('"tool"') &&
            trimmed.includes('"status"') &&
            (trimmed.includes('"output"') || trimmed.includes('"target"'))
          ) {
            try {
              const parsed = JSON.parse(trimmed);
              if (
                parsed.tool &&
                parsed.status &&
                (parsed.target !== undefined || parsed.output !== undefined)
              ) {
                return <OpenCodeWorkflowCard key={i} data={parsed} toast={toast} />;
              }
            } catch {
              // fallback to normal codeblock
            }
          }

          // Never render raw agent tool calls as runnable terminal commands
          const isToolCall =
            trimmed.startsWith('{') &&
            (trimmed.includes('"name"') || trimmed.includes('"tool"')) &&
            (trimmed.includes('"arguments"') ||
              trimmed.includes('"path"') ||
              trimmed.includes('"command"') ||
              trimmed.includes('"content"'));

          if (isToolCall) return null;
          return <CodeBlock key={i} code={trimmed} activePaneId={activePaneId} toast={toast} />;
        }
        return p.trim() ? <div key={i}>{renderMarkdownText(p)}</div> : null;
      })}
    </div>
  );
}

function CodeBlock({
  code,
  activePaneId,
  toast,
}: {
  code: string;
  activePaneId: string | null;
  toast: (m: string) => void;
}) {
  const [confirm, setConfirm] = useState(false);

  // Guard against tool call JSON blocks being treated as terminal commands
  if (
    code.startsWith('{') &&
    (code.includes('"name":') || code.includes('"tool":')) &&
    (code.includes('"arguments"') ||
      code.includes('"path"') ||
      code.includes('"command"') ||
      code.includes('"content"'))
  ) {
    return null;
  }

  // Filter out stray standalone language identifier lines like "bash" or "sh" if code blocks were previously corrupted
  const rawLines = code.split('\n');
  const sanitizedLines = rawLines.filter((l) => {
    const trimmed = l.trim().toLowerCase();
    return trimmed !== 'bash' && trimmed !== 'sh' && trimmed !== 'zsh';
  });
  const cleanCode = (sanitizedLines.length > 0 ? sanitizedLines : rawLines).join('\n');

  const risk = classifyRisk(cleanCode);

  const send = (run: boolean) => {
    const p = activePaneId ? registry.get(activePaneId) : undefined;
    if (!p || p.status !== 'connected') {
      toast('No connected session');
      return;
    }
    // Running a multi-line block executes every line immediately, so require a confirm click.
    const multiLine = cleanCode.trim().includes('\n');
    if (run && (risk.level === 'danger' || multiLine) && !confirm) {
      setConfirm(true);
      return;
    }
    p.send(cleanCode + (run ? '\r' : ''));
    setConfirm(false);
    toast(run ? 'Command sent' : 'Inserted into terminal — review & press Enter');
  };

  return (
    <div
      className={cn(
        'overflow-hidden rounded-lg border min-w-0 max-w-full',
        risk.level === 'danger'
          ? 'border-rose-500/30'
          : risk.level === 'caution'
          ? 'border-amber-400/25'
          : 'border-white/10'
      )}
    >
      <pre className="overflow-x-auto bg-black/50 px-3 py-2 font-mono text-[11px] text-emerald-200 scrollbar-thin">
        {cleanCode}
      </pre>
      <div className="flex items-center gap-1 border-t border-white/5 bg-black/30 px-2 py-1">
        <span
          className={cn(
            'flex items-center gap-1 text-[10px]',
            risk.level === 'danger'
              ? 'text-rose-300'
              : risk.level === 'caution'
              ? 'text-amber-300'
              : 'text-emerald-400'
          )}
        >
          {risk.level !== 'safe' && <ShieldAlert className="h-3 w-3" />}
          {risk.level}
          {risk.reasons.length ? ` · ${risk.reasons[0]}` : ''}
        </span>
        <div className="ml-auto flex gap-0.5">
          <button
            onClick={() => {
              bridge.writeClipboard(cleanCode);
              toast('Copied');
            }}
            className="rounded p-1 text-slate-400 hover:bg-white/10 hover:text-white"
          >
            <Copy className="h-3 w-3" />
          </button>
          <button
            onClick={() => send(false)}
            className="flex items-center gap-1 rounded px-1.5 py-0.5 text-[10px] text-slate-300 hover:bg-white/10"
          >
            <CornerDownLeft className="h-3 w-3" />
            Insert
          </button>
          <button
            onClick={() => send(true)}
            className={cn(
              'rounded px-1.5 py-0.5 text-[10px] font-semibold transition',
              confirm
                ? 'bg-rose-500 text-white'
                : 'bg-emerald-400/15 text-emerald-300 hover:bg-emerald-400/25'
            )}
          >
            {confirm ? 'Confirm run' : 'Run'}
          </button>
        </div>
      </div>
    </div>
  );
}
