import { useEffect, useState } from 'react';
import { Lock, Loader2, ShieldCheck, Cpu, Cloud, Eye, EyeOff } from 'lucide-react';
import { bridge, isTauri, isBridgeError } from '../lib/bridge';

export function LockScreen({ onUnlocked }: { onUnlocked: () => void }) {
  const [initialized, setInitialized] = useState<boolean | null>(null);
  const [pw, setPw] = useState('');
  const [pw2, setPw2] = useState('');
  const [show, setShow] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => { bridge.vaultStatus().then((s) => setInitialized(s.initialized)); }, []);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!initialized && pw !== pw2) { setErr('Passwords do not match'); return; }
    if (pw.length < 4) { setErr('Use at least 4 characters (12+ recommended)'); return; }
    setBusy(true); setErr(null);
    try { await bridge.unlock(pw); onUnlocked(); }
    catch (er) { setErr(isBridgeError(er) ? er.message : String(er)); }
    finally { setBusy(false); }
  };

  const features = [
    { icon: ShieldCheck, t: 'SQLCipher AES-256 vault', d: 'Argon2id-derived key, zero plaintext on disk' },
    { icon: Cpu, t: 'On-device AI copilot', d: 'Ollama-compatible, nothing leaves your machine' },
    { icon: Cloud, t: 'Zero-knowledge sync', d: 'XChaCha20-Poly1305 E2EE, bring your own relay' },
  ];

  return (
    <div className="relative grid min-h-screen place-items-center overflow-hidden bg-[#06080d] px-4 text-slate-200">
      <div className="pointer-events-none absolute inset-0 bg-[linear-gradient(rgba(255,255,255,0.025)_1px,transparent_1px),linear-gradient(90deg,rgba(255,255,255,0.025)_1px,transparent_1px)] bg-[size:48px_48px] [mask-image:radial-gradient(ellipse_at_center,black_30%,transparent_75%)]" />
      <div className="nx-blob pointer-events-none absolute -left-32 top-1/4 h-[420px] w-[420px] rounded-full bg-cyan-500/20 blur-[120px]" />
      <div className="nx-blob-2 pointer-events-none absolute -right-32 bottom-1/4 h-[420px] w-[420px] rounded-full bg-fuchsia-600/20 blur-[120px]" />

      <div className="relative grid w-full max-w-5xl items-center gap-12 md:grid-cols-2">
        <div className="hidden md:block">
          <img src="/nexus-logo.png" alt="" className="h-20 w-20 rounded-2xl shadow-[0_0_60px_-10px_rgba(34,211,238,0.6)]" />
          <h1 className="mt-6 text-5xl font-bold tracking-tight text-white">Nexus<span className="bg-gradient-to-r from-cyan-300 to-fuchsia-400 bg-clip-text text-transparent">Terminal</span></h1>
          <p className="mt-3 max-w-md text-slate-400">The open-source, local-first SSH workspace. Terminals, SFTP, snippets and an on-device AI — secured by a vault only you can open.</p>
          <div className="mt-8 space-y-4">
            {features.map((f) => (
              <div key={f.t} className="flex items-start gap-3">
                <div className="grid h-9 w-9 shrink-0 place-items-center rounded-lg bg-white/5 ring-1 ring-white/10"><f.icon className="h-4 w-4 text-cyan-300" /></div>
                <div><div className="text-sm font-medium text-white">{f.t}</div><div className="text-xs text-slate-500">{f.d}</div></div>
              </div>
            ))}
          </div>
        </div>

        <form onSubmit={submit} className="nx-rise rounded-3xl border border-white/10 bg-white/[0.03] p-8 shadow-2xl backdrop-blur-xl">
          <img src="/nexus-logo.png" alt="" className="mx-auto h-14 w-14 rounded-xl md:hidden" />
          <div className="mx-auto grid h-12 w-12 place-items-center rounded-2xl bg-gradient-to-br from-cyan-400/20 to-fuchsia-500/20 ring-1 ring-white/10 max-md:hidden"><Lock className="h-5 w-5 text-white" /></div>
          <h2 className="mt-4 text-center text-xl font-semibold text-white">{initialized === false ? 'Create your vault' : 'Unlock vault'}</h2>
          <p className="mt-1 text-center text-xs text-slate-500">{initialized === false ? 'Choose a master password. It cannot be recovered.' : 'Enter your master password to decrypt your hosts.'}</p>

          <div className="mt-6 space-y-3">
            <div className="relative">
              <input autoFocus type={show ? 'text' : 'password'} value={pw} onChange={(e) => setPw(e.target.value)} placeholder="Master password"
                className="w-full rounded-xl border border-white/10 bg-black/40 px-4 py-3 pr-10 text-sm text-white placeholder:text-slate-600 focus:border-cyan-400/50 focus:outline-none focus:ring-4 focus:ring-cyan-400/10" />
              <button type="button" onClick={() => setShow((s) => !s)} className="absolute right-3 top-1/2 -translate-y-1/2 text-slate-500 hover:text-white">{show ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}</button>
            </div>
            {initialized === false && (
              <input type={show ? 'text' : 'password'} value={pw2} onChange={(e) => setPw2(e.target.value)} placeholder="Confirm master password"
                className="w-full rounded-xl border border-white/10 bg-black/40 px-4 py-3 text-sm text-white placeholder:text-slate-600 focus:border-cyan-400/50 focus:outline-none focus:ring-4 focus:ring-cyan-400/10" />
            )}
            {err && <p className="text-xs text-rose-400">{err}</p>}
            <button disabled={busy || initialized === null} className="flex w-full items-center justify-center gap-2 rounded-xl bg-gradient-to-r from-cyan-400 via-sky-400 to-fuchsia-400 py-3 text-sm font-semibold text-black shadow-[0_10px_40px_-10px_rgba(34,211,238,0.6)] transition hover:brightness-110 disabled:opacity-50">
              {busy ? <><Loader2 className="h-4 w-4 animate-spin" />Deriving key (Argon2id)…</> : initialized === false ? 'Create vault' : 'Unlock'}
            </button>
          </div>

          <div className="mt-6 rounded-xl border border-white/5 bg-black/20 p-3 text-[11px] leading-relaxed text-slate-500">
            {isTauri
              ? <>Desktop mode · SQLCipher vault at app-data/nexus.vault · real SSH via libssh2.</>
              : <>Browser preview · vault encrypted with WebCrypto AES-256-GCM in localStorage · SSH sessions run in a local sandbox. Build with Tauri for real connections.
                {initialized && <button type="button" onClick={async () => { if (confirm('Erase the sandbox vault?')) { await bridge.resetDemoVault(); setInitialized(false); } }} className="ml-1 text-cyan-400 hover:underline">Reset sandbox vault</button>}</>}
          </div>
        </form>
      </div>
    </div>
  );
}
