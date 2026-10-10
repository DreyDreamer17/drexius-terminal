import { useEffect, useRef, useState } from 'react';
import { Sparkles, Send, RefreshCw, Square, Terminal as TermIcon, Bug, Wand2, BookOpen, Settings2, CornerDownLeft, Copy, ShieldAlert, Cpu } from 'lucide-react';
import { chatStream, classifyRisk, DEFAULT_ENDPOINT, listModels, offlineAnswer, SYSTEM_PROMPT, type ChatMsg } from '../lib/ollama';
import { registry } from '../lib/sessions';
import { cn } from '../utils/cn';

interface Msg { role: 'user' | 'assistant'; content: string; offline?: boolean }

export function AIPanel({ activePaneId, toast }: { activePaneId: string | null; toast: (m: string) => void }) {
  const [endpoint, setEndpoint] = useState(() => localStorage.getItem('nx.ai.endpoint') ?? DEFAULT_ENDPOINT);
  const [models, setModels] = useState<string[]>([]);
  const [model, setModel] = useState(() => localStorage.getItem('nx.ai.model') ?? '');
  const [online, setOnline] = useState<boolean | null>(null);
  const [showCfg, setShowCfg] = useState(false);
  const [msgs, setMsgs] = useState<Msg[]>([]);
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);
  const abortRef = useRef<AbortController | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);

  const probe = async () => {
    setOnline(null);
    try {
      const m = await listModels(endpoint);
      setModels(m); setOnline(true);
      if (!m.includes(model)) setModel(m[0] ?? '');
    } catch { setOnline(false); setModels([]); }
  };
  useEffect(() => { probe(); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [endpoint]);
  useEffect(() => { localStorage.setItem('nx.ai.endpoint', endpoint); }, [endpoint]);
  useEffect(() => { if (model) localStorage.setItem('nx.ai.model', model); }, [model]);
  useEffect(() => { scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight }); }, [msgs]);

  const ask = async (prompt: string) => {
    if (!prompt.trim() || busy) return;
    const pane = activePaneId ? registry.get(activePaneId) : undefined;
    const context = activePaneId ? registry.context(activePaneId, 80) : '';
    const ctxBlock = `Current working directory: ${pane?.cwd ?? 'unknown'}\nLast command: ${pane?.lastCommand ?? 'n/a'}\nRecent terminal output:\n\`\`\`\n${context.slice(-4000)}\n\`\`\``;
    const history: Msg[] = [...msgs, { role: 'user', content: prompt }];
    setMsgs([...history, { role: 'assistant', content: '' }]);
    setInput('');
    setBusy(true);

    if (!online || !model) {
      await new Promise((r) => setTimeout(r, 350));
      setMsgs([...history, { role: 'assistant', content: offlineAnswer(prompt, context), offline: true }]);
      setBusy(false);
      return;
    }
    const wire: ChatMsg[] = [
      { role: 'system', content: SYSTEM_PROMPT },
      { role: 'system', content: ctxBlock },
      ...history.slice(-10).map((m) => ({ role: m.role, content: m.content })),
    ];
    abortRef.current = new AbortController();
    let acc = '';
    try {
      await chatStream(endpoint, model, wire, (t) => {
        acc += t;
        setMsgs([...history, { role: 'assistant', content: acc }]);
      }, abortRef.current.signal);
    } catch (e) {
      if ((e as Error).name !== 'AbortError') setMsgs([...history, { role: 'assistant', content: `⚠️ ${(e as Error).message}\n\n` + offlineAnswer(prompt, context), offline: true }]);
    } finally { setBusy(false); }
  };

  const pane = activePaneId ? registry.get(activePaneId) : undefined;
  const quick = [
    { icon: BookOpen, label: 'Explain last command', run: () => ask(`Explain: ${pane?.lastCommand ?? 'the last command shown in the terminal'}`) },
    { icon: Bug, label: 'Troubleshoot output', run: () => ask('Troubleshoot the errors in the recent terminal output. What is the root cause and what should I check next?') },
    { icon: Wand2, label: 'Generate pipeline', run: () => setInput('Generate a safe shell pipeline that ') },
  ];

  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center gap-2 border-b border-white/5 px-4 py-3">
        <div className="grid h-7 w-7 place-items-center rounded-lg bg-gradient-to-br from-fuchsia-500/30 to-cyan-400/30 ring-1 ring-white/10"><Sparkles className="h-3.5 w-3.5 text-fuchsia-200" /></div>
        <div className="min-w-0 flex-1">
          <div className="text-sm font-semibold text-white">Nexus AI</div>
          <div className="flex items-center gap-1.5 text-[10.5px] text-slate-500">
            <span className={cn('h-1.5 w-1.5 rounded-full', online === null ? 'animate-pulse bg-amber-400' : online ? 'bg-emerald-400' : 'bg-slate-600')} />
            {online === null ? 'probing local runtime…' : online ? `local · ${model || 'no model'}` : 'offline heuristics · no model'}
          </div>
        </div>
        <button onClick={probe} title="Refresh models" className="rounded-md p-1.5 text-slate-500 hover:bg-white/5 hover:text-white"><RefreshCw className="h-3.5 w-3.5" /></button>
        <button onClick={() => setShowCfg((v) => !v)} className={cn('rounded-md p-1.5 hover:bg-white/5', showCfg ? 'text-cyan-300' : 'text-slate-500 hover:text-white')}><Settings2 className="h-3.5 w-3.5" /></button>
      </div>

      {showCfg && (
        <div className="space-y-2 border-b border-white/5 bg-black/20 px-4 py-3">
          <label className="block text-[10px] uppercase tracking-wider text-slate-500">Ollama-compatible endpoint</label>
          <input value={endpoint} onChange={(e) => setEndpoint(e.target.value)} className="w-full rounded-md border border-white/10 bg-black/30 px-2.5 py-1.5 font-mono text-[11px] text-slate-200 focus:outline-none" />
          <label className="block text-[10px] uppercase tracking-wider text-slate-500">Model</label>
          <select value={model} onChange={(e) => setModel(e.target.value)} className="w-full rounded-md border border-white/10 bg-black/30 px-2 py-1.5 text-[11px] text-slate-200 focus:outline-none">
            {models.length ? models.map((m) => <option key={m}>{m}</option>) : <option value="">— none detected —</option>}
          </select>
          <p className="text-[10.5px] leading-relaxed text-slate-500">Inference stays on this machine. In a browser, start Ollama with <code className="text-cyan-300">OLLAMA_ORIGINS=*</code>.</p>
        </div>
      )}

      <div ref={scrollRef} className="min-h-0 flex-1 space-y-3 overflow-y-auto px-4 py-4">
        {!msgs.length && (
          <div className="flex flex-col items-center pt-6 text-center">
            <div className="relative">
              <div className="absolute inset-0 animate-pulse rounded-full bg-fuchsia-500/20 blur-2xl" />
              <Cpu className="relative h-10 w-10 text-fuchsia-300/80" />
            </div>
            <p className="mt-4 text-sm font-medium text-slate-200">Your on-device SRE copilot</p>
            <p className="mt-1 max-w-[240px] text-xs text-slate-500">Reads your active terminal for context. Suggested commands are risk-scored and never run without your click.</p>
            <div className="mt-5 w-full space-y-1.5">
              {quick.map((q) => (
                <button key={q.label} onClick={q.run} className="flex w-full items-center gap-2.5 rounded-lg border border-white/5 bg-white/[0.02] px-3 py-2 text-left text-xs text-slate-300 transition hover:border-fuchsia-400/30 hover:bg-fuchsia-400/5">
                  <q.icon className="h-3.5 w-3.5 text-fuchsia-300" />{q.label}
                </button>
              ))}
            </div>
          </div>
        )}
        {msgs.map((m, i) => (
          <div key={i} className={cn('text-[12.5px] leading-relaxed', m.role === 'user' ? 'ml-6 rounded-xl rounded-tr-sm bg-cyan-400/10 px-3 py-2 text-cyan-50 ring-1 ring-cyan-400/15' : 'text-slate-300')}>
            {m.role === 'assistant' ? (m.content ? <Rich text={m.content} activePaneId={activePaneId} toast={toast} /> : <Dots />) : m.content}
            {m.offline && <div className="mt-1 text-[10px] text-slate-600">offline mode</div>}
          </div>
        ))}
      </div>

      {msgs.length > 0 && (
        <div className="flex gap-1 overflow-x-auto px-3 pb-2">
          {quick.map((q) => <button key={q.label} onClick={q.run} className="flex shrink-0 items-center gap-1 rounded-full border border-white/10 px-2 py-1 text-[10.5px] text-slate-400 hover:border-fuchsia-400/30 hover:text-fuchsia-200"><q.icon className="h-3 w-3" />{q.label}</button>)}
        </div>
      )}

      <div className="border-t border-white/5 p-3">
        <div className="flex items-end gap-2 rounded-xl border border-white/10 bg-black/30 p-2 focus-within:border-fuchsia-400/40">
          <textarea value={input} onChange={(e) => setInput(e.target.value)} rows={2}
            onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); ask(input); } }}
            placeholder="Ask about this session… (Enter to send)" className="max-h-32 flex-1 resize-none bg-transparent text-xs text-slate-100 placeholder:text-slate-600 focus:outline-none" />
          {busy
            ? <button onClick={() => abortRef.current?.abort()} className="grid h-7 w-7 place-items-center rounded-lg bg-rose-500/20 text-rose-300"><Square className="h-3 w-3" /></button>
            : <button onClick={() => ask(input)} disabled={!input.trim()} className="grid h-7 w-7 place-items-center rounded-lg bg-gradient-to-br from-fuchsia-400 to-cyan-400 text-black disabled:opacity-30"><Send className="h-3.5 w-3.5" /></button>}
        </div>
        <div className="mt-1.5 flex items-center gap-1 text-[10px] text-slate-600"><TermIcon className="h-3 w-3" />context: {pane ? `${pane.cwd} · last 80 lines` : 'no active session'}</div>
      </div>
    </div>
  );
}

function Dots() {
  return <span className="inline-flex gap-1">{[0, 1, 2].map((i) => <span key={i} className="h-1.5 w-1.5 animate-bounce rounded-full bg-fuchsia-300" style={{ animationDelay: `${i * 120}ms` }} />)}</span>;
}

function inline(s: string) {
  return s.split(/(`[^`]+`|\*\*[^*]+\*\*)/g).map((p, i) =>
    p.startsWith('`') ? <code key={i} className="rounded bg-white/10 px-1 font-mono text-[11px] text-cyan-200">{p.slice(1, -1)}</code>
      : p.startsWith('**') ? <strong key={i} className="font-semibold text-white">{p.slice(2, -2)}</strong> : p);
}

function Rich({ text, activePaneId, toast }: { text: string; activePaneId: string | null; toast: (m: string) => void }) {
  const parts = text.split(/```(?:\w+)?\n?([\s\S]*?)(?:```|$)/g);
  return (
    <div className="space-y-2">
      {parts.map((p, i) => i % 2 === 1
        ? <CodeBlock key={i} code={p.trim()} activePaneId={activePaneId} toast={toast} />
        : p.trim() && <div key={i} className="whitespace-pre-wrap">{p.trim().split('\n').map((l, j) => <div key={j}>{inline(l)}</div>)}</div>)}
    </div>
  );
}

function CodeBlock({ code, activePaneId, toast }: { code: string; activePaneId: string | null; toast: (m: string) => void }) {
  const risk = classifyRisk(code);
  const [confirm, setConfirm] = useState(false);
  const send = (run: boolean) => {
    const p = activePaneId ? registry.get(activePaneId) : undefined;
    if (!p || p.status !== 'connected') { toast('No connected session'); return; }
    if (run && risk.level === 'danger' && !confirm) { setConfirm(true); return; }
    p.send(code.replace(/\n/g, ' && ') + (run ? '\r' : ''));
    setConfirm(false);
    toast(run ? 'Command sent' : 'Inserted into terminal — review & press Enter');
  };
  return (
    <div className={cn('overflow-hidden rounded-lg border', risk.level === 'danger' ? 'border-rose-500/30' : risk.level === 'caution' ? 'border-amber-400/25' : 'border-white/10')}>
      <pre className="overflow-x-auto bg-black/40 px-3 py-2 font-mono text-[11px] text-emerald-200">{code}</pre>
      <div className="flex items-center gap-1 border-t border-white/5 bg-black/20 px-2 py-1">
        <span className={cn('flex items-center gap-1 text-[10px]', risk.level === 'danger' ? 'text-rose-300' : risk.level === 'caution' ? 'text-amber-300' : 'text-emerald-400')}>
          {risk.level !== 'safe' && <ShieldAlert className="h-3 w-3" />}{risk.level}{risk.reasons.length ? ` · ${risk.reasons[0]}` : ''}
        </span>
        <div className="ml-auto flex gap-0.5">
          <button onClick={() => { navigator.clipboard.writeText(code); toast('Copied'); }} className="rounded p-1 text-slate-500 hover:bg-white/10 hover:text-white"><Copy className="h-3 w-3" /></button>
          <button onClick={() => send(false)} className="flex items-center gap-1 rounded px-1.5 py-0.5 text-[10px] text-slate-300 hover:bg-white/10"><CornerDownLeft className="h-3 w-3" />Insert</button>
          <button onClick={() => send(true)} className={cn('rounded px-1.5 py-0.5 text-[10px] font-semibold', confirm ? 'bg-rose-500 text-white' : 'bg-emerald-400/15 text-emerald-300 hover:bg-emerald-400/25')}>{confirm ? 'Confirm run' : 'Run'}</button>
        </div>
      </div>
    </div>
  );
}
