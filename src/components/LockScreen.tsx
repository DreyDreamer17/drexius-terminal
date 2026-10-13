import { useState, useEffect } from 'react';
import {
  Lock,
  Loader2,
  ShieldCheck,
  Cpu,
  Cloud,
  Eye,
  EyeOff,
  Fingerprint,
  Check,
  KeyRound,
  Copy,
  Download,
  AlertTriangle,
  X,
} from 'lucide-react';
import { bridge, isTauri, isBridgeError } from '../lib/bridge';
import { THEMES, type NexusTheme } from '../lib/themes';
function getPasswordStrength(p: string): { score: number; label: string; color: string } {
  if (!p) return { score: 0, label: '', color: 'transparent' };
  let score = 0;
  if (p.length >= 8) score++;
  if (p.length >= 12) score++;
  if (/[a-z]/.test(p) && /[A-Z]/.test(p)) score++;
  if (/\d/.test(p)) score++;
  if (/[^a-zA-Z0-9]/.test(p)) score++;

  if (score <= 1) return { score: 1, label: 'Weak', color: '#f43f5e' };
  if (score <= 2) return { score: 2, label: 'Fair', color: '#f97316' };
  if (score <= 3) return { score: 3, label: 'Good', color: '#eab308' };
  return { score: 4, label: 'Strong', color: '#10b981' };
}

export function LockScreen({
  onUnlocked,
  theme,
}: {
  onUnlocked: () => void;
  theme?: NexusTheme;
}) {
  const [initialized, setInitialized] = useState<boolean | null>(null);
  const activeTheme = theme || THEMES.find((t) => t.id === (localStorage.getItem('nx.theme') ?? 'nexus')) || THEMES[0];
  const accentColor = activeTheme.accent;
  const bgColor = activeTheme.xterm.background || '#06080d';
  const [pw, setPw] = useState('');
  const [pw2, setPw2] = useState('');
  const [show, setShow] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [hasStored, setHasStored] = useState(false);
  const [bioBusy, setBioBusy] = useState(false);
  // "Remember in OS keychain" — visible on desktop only, defaults to off for
  // fresh vault creation; when unlocking an existing vault we default to
  // whatever the current storage state is (checked if already stored).
  const [remember, setRemember] = useState(false);

  // Emergency Recovery Kit Modal (Shown when a new recovery key is generated)
  const [createdRecoveryKey, setCreatedRecoveryKey] = useState<string | null>(null);
  const [copiedKey, setCopiedKey] = useState(false);

  // Recovery & Reset Modal (Forgot password flow)
  const [showRecoveryModal, setShowRecoveryModal] = useState(false);
  const [recoveryTab, setRecoveryTab] = useState<'recover' | 'reset'>('recover');
  const [recoveryCode, setRecoveryCode] = useState('');
  const [recoveryNewPw, setRecoveryNewPw] = useState('');
  const [recoveryNewPw2, setRecoveryNewPw2] = useState('');
  const [recoveryBusy, setRecoveryBusy] = useState(false);
  const [recoveryErr, setRecoveryErr] = useState<string | null>(null);
  const [resetConfirmText, setResetConfirmText] = useState('');
  const [resetBusy, setResetBusy] = useState(false);

  useEffect(() => {
    (async () => {
      const s = await bridge.vaultStatus();
      setInitialized(s.initialized);
      // On desktop, show the biometric button only if the user has previously
      // opted in (tracked in localStorage). We never probe the OS keychain
      // here — that would trigger a Touch ID/Windows Hello prompt on mount.
      if (isTauri) {
        setHasStored(bridge.osKeychainEnabled());
        setRemember(bridge.osKeychainEnabled());
      }
    })();
  }, []);

  const downloadEmergencyKit = (key: string) => {
    const text = `=====================================================
NEXUSTERMINAL EMERGENCY RECOVERY KIT
=====================================================

Emergency Recovery Key:
${key}

IMPORTANT:
- This key was generated during vault creation or password reset.
- Because NexusTerminal uses zero-knowledge encryption, this key
  is the ONLY way to recover your vault if you forget your master password.
- Store this file in a password manager, encrypted USB drive, or physical safe.
- Do NOT share this key with anyone.

Generated: ${new Date().toISOString()}
=====================================================`;
    const blob = new Blob([text], { type: 'text/plain;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `nexus-emergency-kit-${Date.now()}.txt`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const copyToClipboard = async (text: string) => {
    try {
      await navigator.clipboard.writeText(text);
      setCopiedKey(true);
      setTimeout(() => setCopiedKey(false), 2000);
    } catch (_) {}
  };

  const doUnlock = async (password: string, isNewVault: boolean) => {
    setBusy(true); setErr(null);
    try {
      const generatedCode = await bridge.unlock(password);
      // Post-unlock keychain sync:
      //   - New vault creation → store if the user ticked the box
      //   - Existing vault  → store if ticked, delete if unticked (so the
      //     checkbox faithfully reflects what's in the OS keychain)
      if (isTauri) {
        if (remember) {
          try {
            const stored = await bridge.osKeychainStore(password);
            setHasStored(stored);
          } catch (e) {
            console.warn('OS keychain storage failed', e);
            setHasStored(false);
          }
        } else if (!isNewVault) {
          // Only delete on existing-vault unlocks; on creation, there can't
          // be a previous entry so this is a no-op that we skip to avoid a
          // needless D-Bus / Security-framework round-trip.
          await bridge.osKeychainDelete().catch(() => {});
          setHasStored(false);
        }
      }

      if (generatedCode) {
        setCreatedRecoveryKey(generatedCode);
        return;
      }

      onUnlocked();
    } catch (er) {
      setErr(isBridgeError(er) ? er.message : String(er));
    } finally {
      setBusy(false);
    }
  };

  const handleRecover = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!recoveryCode.trim()) {
      setRecoveryErr('Please enter your emergency recovery key');
      return;
    }
    if (recoveryNewPw.length < 4) {
      setRecoveryErr('New password must be at least 4 characters');
      return;
    }
    if (recoveryNewPw !== recoveryNewPw2) {
      setRecoveryErr('New passwords do not match');
      return;
    }
    setRecoveryBusy(true);
    setRecoveryErr(null);
    try {
      const freshKey = await bridge.vaultRecover(recoveryCode, recoveryNewPw);
      setShowRecoveryModal(false);
      setCreatedRecoveryKey(freshKey);
    } catch (er) {
      setRecoveryErr(isBridgeError(er) ? er.message : String(er));
    } finally {
      setRecoveryBusy(false);
    }
  };

  const handleResetVault = async (e: React.FormEvent) => {
    e.preventDefault();
    if (resetConfirmText.trim().toUpperCase() !== 'RESET') {
      setRecoveryErr('Please type RESET in capital letters to confirm');
      return;
    }
    setResetBusy(true);
    setRecoveryErr(null);
    try {
      await bridge.vaultReset();
      setInitialized(false);
      setPw('');
      setPw2('');
      setHasStored(false);
      setRemember(false);
      setShowRecoveryModal(false);
      setErr(null);
    } catch (er) {
      setRecoveryErr(isBridgeError(er) ? er.message : String(er));
    } finally {
      setResetBusy(false);
    }
  };

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    const isNew = initialized === false;
    if (isNew && pw !== pw2) { setErr('Passwords do not match'); return; }
    if (pw.length < 4) { setErr('Use at least 4 characters (12+ recommended)'); return; }
    await doUnlock(pw, isNew);
  };

  const biometricUnlock = async () => {
    setBioBusy(true); setErr(null);
    try {
      await bridge.osKeychainUnlock();
      onUnlocked();
    } catch (er) {
      const msg = isBridgeError(er) ? er.message : String(er);
      // If the entry is gone (NoEntry) or access was denied permanently,
      // clear the local opt-in flag so the button hides and the user falls
      // back to manual password entry. We don't probe again — that would
      // re-trigger a biometric prompt.
      setErr(msg);
      if (/no master password stored|not found|no entry/i.test(msg)) {
        setHasStored(false);
        setRemember(false);
        localStorage.removeItem('nx.os_keychain');
      }
    } finally {
      setBioBusy(false);
    }
  };

  const features = [
    { icon: ShieldCheck, t: 'SQLCipher AES-256 vault', d: 'Argon2id-derived key, zero plaintext on disk' },
    { icon: Cpu, t: 'On-device AI copilot', d: 'Ollama-compatible, nothing leaves your machine' },
    { icon: Cloud, t: 'Zero-knowledge sync', d: 'XChaCha20-Poly1305 E2EE, bring your own relay' },
  ];

  return (
    <div
      className="relative grid min-h-screen place-items-center overflow-hidden px-4 text-slate-200"
      style={{ backgroundColor: bgColor }}
    >
      <div className="pointer-events-none absolute inset-0 bg-[linear-gradient(rgba(255,255,255,0.025)_1px,transparent_1px),linear-gradient(90deg,rgba(255,255,255,0.025)_1px,transparent_1px)] bg-[size:48px_48px] [mask-image:radial-gradient(ellipse_at_center,black_30%,transparent_75%)]" />
      <div
        className="nx-blob pointer-events-none absolute -left-32 top-1/4 h-[420px] w-[420px] rounded-full blur-[120px]"
        style={{ backgroundColor: `${accentColor}25` }}
      />
      <div
        className="nx-blob-2 pointer-events-none absolute -right-32 bottom-1/4 h-[420px] w-[420px] rounded-full blur-[120px]"
        style={{ backgroundColor: `${accentColor}15` }}
      />

      <div className="relative grid w-full max-w-5xl items-center gap-12 md:grid-cols-2">
        <div className="hidden md:block">
          <img
            src="/nexus-logo.png"
            alt=""
            className="h-20 w-20 rounded-2xl"
            style={{ boxShadow: `0 0 50px -5px ${accentColor}60` }}
          />
          <h1 className="mt-6 text-5xl font-bold tracking-tight text-white">
            Nexus<span style={{ color: accentColor }}>Terminal</span>
          </h1>
          <p className="mt-3 max-w-md text-slate-400">
            The open-source, local-first SSH workspace. Terminals, SFTP, snippets and an on-device AI — secured by a vault only you can open.
          </p>
          <div className="mt-8 space-y-4">
            {features.map((f) => (
              <div key={f.t} className="flex items-start gap-3">
                <div
                  className="grid h-9 w-9 shrink-0 place-items-center rounded-lg border transition"
                  style={{
                    backgroundColor: `${accentColor}12`,
                    borderColor: `${accentColor}30`,
                    color: accentColor,
                  }}
                >
                  <f.icon className="h-4 w-4" />
                </div>
                <div>
                  <div className="text-sm font-medium text-white">{f.t}</div>
                  <div className="text-xs text-slate-500">{f.d}</div>
                </div>
              </div>
            ))}
          </div>
        </div>

        <form
          onSubmit={submit}
          className="nx-rise relative overflow-hidden rounded-3xl border border-white/10 bg-white/[0.03] p-8 shadow-2xl backdrop-blur-xl"
        >
          {/* Top ambient radial glow */}
          <div
            className="pointer-events-none absolute inset-x-0 top-0 h-44 opacity-25"
            style={{ background: `radial-gradient(ellipse at top, ${accentColor} 0%, transparent 70%)` }}
          />

          <img src="/nexus-logo.png" alt="" className="mx-auto h-14 w-14 rounded-xl md:hidden" />
          <div
            className="mx-auto grid h-12 w-12 place-items-center rounded-2xl border transition shadow-lg max-md:hidden"
            style={{
              backgroundColor: `${accentColor}18`,
              borderColor: `${accentColor}35`,
              color: accentColor,
              boxShadow: `0 0 25px ${accentColor}30`,
            }}
          >
            <Lock className="h-5 w-5" />
          </div>
          <h2 className="mt-4 text-center text-xl font-semibold text-white">
            {initialized === false ? 'Create your vault' : 'Unlock vault'}
          </h2>
          <p className="mt-1 text-center text-xs text-slate-500">
            {initialized === false ? 'Choose a master password. An Emergency Recovery Key will be generated.' : 'Enter your master password to decrypt your hosts.'}
          </p>

          {/* Biometric unlock shortcut — only on desktop when a stored password exists */}
          {isTauri && initialized === true && hasStored && (
            <button
              type="button"
              onClick={biometricUnlock}
              disabled={bioBusy || busy}
              className="mt-5 flex w-full items-center justify-center gap-2 rounded-xl border py-2.5 text-sm font-medium transition disabled:opacity-50"
              style={{
                backgroundColor: `${accentColor}15`,
                borderColor: `${accentColor}40`,
                color: accentColor,
              }}
            >
              {bioBusy ? (
                <><Loader2 className="h-4 w-4 animate-spin" />Waiting for biometrics…</>
              ) : (
                <><Fingerprint className="h-4 w-4" />Unlock with Touch ID / Windows Hello</>
              )}
            </button>
          )}

          {isTauri && initialized === true && hasStored && (
            <div className="mt-3 flex items-center gap-2">
              <div className="h-px flex-1 bg-white/10" />
              <span className="text-[10px] uppercase tracking-wider text-slate-600">or enter password</span>
              <div className="h-px flex-1 bg-white/10" />
            </div>
          )}

          <div className="mt-5 space-y-3">
            <div className="relative">
              <input
                autoFocus
                type={show ? 'text' : 'password'}
                value={pw}
                onChange={(e) => setPw(e.target.value)}
                placeholder="Master password"
                className="w-full rounded-xl border border-white/10 bg-black/40 px-4 py-3 pr-10 text-sm text-white placeholder:text-slate-600 focus:outline-none focus:ring-2"
                style={{
                  outlineColor: accentColor,
                }}
              />
              <button
                type="button"
                onClick={() => setShow((s: boolean) => !s)}
                className="absolute right-3 top-1/2 -translate-y-1/2 text-slate-500 hover:text-white"
              >
                {show ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
              </button>
            </div>
            {initialized === false && pw.length > 0 && (() => {
              const strength = getPasswordStrength(pw);
              return (
                <div className="space-y-1.5 px-0.5">
                  <div className="flex items-center justify-between text-[11px]">
                    <span className="text-slate-400">Strength</span>
                    <span className="font-medium" style={{ color: strength.color }}>{strength.label}</span>
                  </div>
                  <div className="grid grid-cols-4 gap-1.5 h-1">
                    {[1, 2, 3, 4].map((step) => (
                      <div
                        key={step}
                        className="h-full rounded-full transition-colors duration-200"
                        style={{
                          backgroundColor: step <= strength.score ? strength.color : 'rgba(255, 255, 255, 0.1)',
                        }}
                      />
                    ))}
                  </div>
                </div>
              );
            })()}
            {initialized === false && (
              <input
                type={show ? 'text' : 'password'}
                value={pw2}
                onChange={(e) => setPw2(e.target.value)}
                placeholder="Confirm master password"
                className="w-full rounded-xl border border-white/10 bg-black/40 px-4 py-3 text-sm text-white placeholder:text-slate-600 focus:outline-none focus:ring-2"
                style={{
                  outlineColor: accentColor,
                }}
              />
            )}

            {/* Remember in OS keychain opt-in (desktop only) */}
            {isTauri && (
              <label className="flex cursor-pointer items-start gap-2.5 rounded-xl border border-white/5 bg-black/20 p-3 transition hover:border-white/10">
                <button
                  type="button"
                  role="checkbox"
                  aria-checked={remember}
                  onClick={() => setRemember((r: boolean) => !r)}
                  className="mt-0.5 grid h-4 w-4 shrink-0 place-items-center rounded border transition"
                  style={
                    remember
                      ? {
                          borderColor: `${accentColor}70`,
                          backgroundColor: `${accentColor}30`,
                          color: accentColor,
                        }
                      : {
                          borderColor: 'rgba(255,255,255,0.2)',
                          backgroundColor: 'rgba(255,255,255,0.05)',
                          color: 'transparent',
                        }
                  }
                >
                  {remember && <Check className="h-3 w-3" strokeWidth={3} />}
                </button>
                <div className="min-w-0">
                  <div className="flex items-center gap-1.5 text-xs font-medium text-slate-200">
                    <Fingerprint className="h-3.5 w-3.5" style={{ color: accentColor }} />
                    Remember in OS keychain
                  </div>
                  <div className="mt-0.5 text-[10.5px] leading-snug text-slate-500">
                    Store an encrypted copy of the master password in macOS Keychain, Windows Credential Manager, or Linux Secret Service. Lets you unlock with Touch ID / Face ID / Windows Hello next time.
                  </div>
                </div>
              </label>
            )}

            {err && <p className="text-xs text-rose-400">{err}</p>}
            <button
              disabled={busy || initialized === null}
              className="flex w-full items-center justify-center gap-2 rounded-xl py-3 text-sm font-semibold text-black transition hover:brightness-110 active:scale-[0.99] disabled:opacity-50"
              style={{
                backgroundColor: accentColor,
                color: '#000000',
                boxShadow: `0 10px 30px -5px ${accentColor}60`,
              }}
            >
              {busy ? (
                <><Loader2 className="h-4 w-4 animate-spin" />Deriving key (Argon2id)…</>
              ) : initialized === false ? (
                'Create vault'
              ) : hasStored ? (
                'Unlock with password'
              ) : (
                'Unlock'
              )}
            </button>

            {initialized === true && (
              <div className="mt-3 text-center">
                <button
                  type="button"
                  onClick={() => {
                    setRecoveryTab('recover');
                    setRecoveryErr(null);
                    setShowRecoveryModal(true);
                  }}
                  className="text-xs text-slate-400 hover:text-white transition underline-offset-4 hover:underline"
                >
                  Forgot master password?
                </button>
              </div>
            )}
          </div>

          <div className="mt-6 rounded-xl border border-white/5 bg-black/20 p-3 text-[11px] leading-relaxed text-slate-500">
            {isTauri
              ? <>Desktop mode · SQLCipher vault at app-data/nexus.vault · real SSH via libssh2{hasStored && <> · biometric unlock available</>}.</>
              : <>Browser preview · vault encrypted with WebCrypto AES-256-GCM in localStorage · SSH sessions run in a local sandbox. Build with Tauri for real connections and OS keychain support.
                {initialized && <button type="button" onClick={async () => { if (confirm('Erase the sandbox vault?')) { await bridge.resetDemoVault(); setInitialized(false); } }} className="ml-1 hover:underline" style={{ color: accentColor }}>Reset sandbox vault</button>}</>}
          </div>
        </form>
      </div>

      {/* Emergency Recovery Kit Modal (Shown on vault creation or after recovery) */}
      {createdRecoveryKey && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 p-4 backdrop-blur-md animate-in fade-in duration-200">
          <div className="relative w-full max-w-lg overflow-hidden rounded-3xl border border-white/10 bg-[#0c1017] p-6 sm:p-8 shadow-2xl">
            {/* Top ambient radial glow */}
            <div
              className="pointer-events-none absolute inset-x-0 top-0 h-40 opacity-30"
              style={{ background: `radial-gradient(ellipse at top, ${accentColor} 0%, transparent 70%)` }}
            />
            {/* Top hairline accent border */}
            <div
              className="absolute inset-x-0 top-0 h-px"
              style={{ background: `linear-gradient(90deg, transparent, ${accentColor}, transparent)` }}
            />

            <div className="relative flex flex-col items-center text-center">
              <div
                className="grid h-14 w-14 place-items-center rounded-2xl border shadow-lg"
                style={{
                  backgroundColor: `${accentColor}18`,
                  borderColor: `${accentColor}35`,
                  color: accentColor,
                  boxShadow: `0 0 25px ${accentColor}30`,
                }}
              >
                <KeyRound className="h-7 w-7" />
              </div>

              <h3 className="mt-4 text-xl font-bold text-white">Your Emergency Recovery Key</h3>
              <p className="mt-2 text-xs leading-relaxed text-slate-400">
                NexusTerminal uses zero-knowledge encryption. If you ever forget your master password,
                <strong className="text-slate-200"> this recovery key is the only way to recover your vault</strong>.
                Save it now in a secure password manager or offline safe.
              </p>

              {/* Key Box */}
              <div className="mt-6 w-full rounded-2xl border border-white/10 bg-black/60 p-4">
                <div className="select-all font-mono text-sm sm:text-base font-bold tracking-wider text-emerald-400 break-all text-center">
                  {createdRecoveryKey}
                </div>
                <div className="mt-4 flex items-center justify-center gap-3">
                  <button
                    type="button"
                    onClick={() => copyToClipboard(createdRecoveryKey)}
                    className="flex items-center gap-1.5 rounded-lg border border-white/10 bg-white/5 px-3 py-1.5 text-xs font-medium text-slate-300 transition hover:bg-white/10 hover:text-white"
                  >
                    {copiedKey ? <Check className="h-3.5 w-3.5 text-emerald-400" /> : <Copy className="h-3.5 w-3.5" />}
                    {copiedKey ? 'Copied to clipboard' : 'Copy Key'}
                  </button>
                  <button
                    type="button"
                    onClick={() => downloadEmergencyKit(createdRecoveryKey)}
                    className="flex items-center gap-1.5 rounded-lg border border-white/10 bg-white/5 px-3 py-1.5 text-xs font-medium text-slate-300 transition hover:bg-white/10 hover:text-white"
                  >
                    <Download className="h-3.5 w-3.5" />
                    Download .txt
                  </button>
                </div>
              </div>

              {/* Warning banner */}
              <div className="mt-5 flex items-start gap-2.5 rounded-xl border border-amber-500/20 bg-amber-500/10 p-3 text-left text-[11px] text-amber-300">
                <AlertTriangle className="h-4 w-4 shrink-0 text-amber-400 mt-0.5" />
                <span>NexusTerminal cannot recover or reset your master password for you. If you lose this key and forget your password, your vault data cannot be recovered.</span>
              </div>

              <button
                type="button"
                onClick={() => {
                  setCreatedRecoveryKey(null);
                  onUnlocked();
                }}
                className="mt-6 flex w-full items-center justify-center gap-2 rounded-xl py-3 text-sm font-semibold text-black transition hover:brightness-110 active:scale-[0.99]"
                style={{
                  backgroundColor: accentColor,
                  color: '#000000',
                  boxShadow: `0 10px 30px -5px ${accentColor}60`,
                }}
              >
                I have saved my recovery key
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Recovery & Reset Modal (Forgot password dialog) */}
      {showRecoveryModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 p-4 backdrop-blur-md animate-in fade-in duration-200">
          <div className="relative w-full max-w-lg overflow-hidden rounded-3xl border border-white/10 bg-[#0c1017] p-6 sm:p-7 shadow-2xl">
            {/* Top ambient radial glow */}
            <div
              className="pointer-events-none absolute inset-x-0 top-0 h-40 opacity-25"
              style={{ background: `radial-gradient(ellipse at top, ${accentColor} 0%, transparent 70%)` }}
            />
            {/* Top hairline accent border */}
            <div
              className="absolute inset-x-0 top-0 h-px"
              style={{ background: `linear-gradient(90deg, transparent, ${accentColor}, transparent)` }}
            />

            <div className="relative">
              <div className="flex items-center justify-between pb-3">
                <h3 className="text-base font-semibold text-white">Vault Recovery & Reset</h3>
                <button
                  type="button"
                  onClick={() => {
                    setShowRecoveryModal(false);
                    setRecoveryErr(null);
                  }}
                  className="rounded-lg p-1 text-slate-400 hover:bg-white/10 hover:text-white"
                >
                  <X className="h-4 w-4" />
                </button>
              </div>

              {/* Tab buttons */}
              <div className="flex rounded-xl bg-black/40 p-1 border border-white/10 mb-4">
                <button
                  type="button"
                  onClick={() => { setRecoveryTab('recover'); setRecoveryErr(null); }}
                  className={`flex-1 rounded-lg py-2 text-xs font-medium transition ${
                    recoveryTab === 'recover'
                      ? 'bg-white/10 text-white shadow-sm'
                      : 'text-slate-400 hover:text-slate-200'
                  }`}
                >
                  Use Emergency Key
                </button>
                <button
                  type="button"
                  onClick={() => { setRecoveryTab('reset'); setRecoveryErr(null); }}
                  className={`flex-1 rounded-lg py-2 text-xs font-medium transition ${
                    recoveryTab === 'reset'
                      ? 'bg-rose-500/20 text-rose-300 shadow-sm'
                      : 'text-slate-400 hover:text-slate-200'
                  }`}
                >
                  Reset Vault
                </button>
              </div>

              {recoveryTab === 'recover' ? (
                <form onSubmit={handleRecover} className="space-y-3.5">
                  <p className="text-xs text-slate-400 leading-relaxed">
                    Enter the 128-bit Emergency Recovery Key generated when your vault was created, then choose a new master password.
                  </p>

                  <div>
                    <label className="block text-[11px] font-medium text-slate-400 mb-1">Emergency Recovery Key</label>
                    <textarea
                      value={recoveryCode}
                      onChange={(e) => setRecoveryCode(e.target.value)}
                      rows={2}
                      placeholder="NX-XXXX-XXXX-XXXX-XXXX-XXXX-XXXX-XXXX-XXXX"
                      className="w-full rounded-xl border border-white/10 bg-black/50 px-3.5 py-2.5 font-mono text-xs text-white placeholder:text-slate-600 focus:outline-none focus:ring-1"
                      style={{ outlineColor: accentColor }}
                    />
                  </div>

                  <div>
                    <label className="block text-[11px] font-medium text-slate-400 mb-1">New Master Password</label>
                    <input
                      type="password"
                      value={recoveryNewPw}
                      onChange={(e) => setRecoveryNewPw(e.target.value)}
                      placeholder="Enter new master password"
                      className="w-full rounded-xl border border-white/10 bg-black/50 px-3.5 py-2.5 text-xs text-white placeholder:text-slate-600 focus:outline-none focus:ring-1"
                      style={{ outlineColor: accentColor }}
                    />
                  </div>

                  <div>
                    <label className="block text-[11px] font-medium text-slate-400 mb-1">Confirm New Master Password</label>
                    <input
                      type="password"
                      value={recoveryNewPw2}
                      onChange={(e) => setRecoveryNewPw2(e.target.value)}
                      placeholder="Confirm new master password"
                      className="w-full rounded-xl border border-white/10 bg-black/50 px-3.5 py-2.5 text-xs text-white placeholder:text-slate-600 focus:outline-none focus:ring-1"
                      style={{ outlineColor: accentColor }}
                    />
                  </div>

                  {recoveryErr && (
                    <div className="rounded-xl border border-rose-500/20 bg-rose-500/10 p-2.5 text-xs text-rose-300">
                      {recoveryErr}
                    </div>
                  )}

                  <div className="pt-2 flex items-center justify-end gap-3">
                    <button
                      type="button"
                      onClick={() => setShowRecoveryModal(false)}
                      className="rounded-xl px-4 py-2.5 text-xs font-medium text-slate-400 hover:bg-white/5 hover:text-white"
                    >
                      Cancel
                    </button>
                    <button
                      type="submit"
                      disabled={recoveryBusy}
                      className="flex items-center gap-2 rounded-xl px-5 py-2.5 text-xs font-semibold text-black transition hover:brightness-110 disabled:opacity-50"
                      style={{
                        backgroundColor: accentColor,
                        color: '#000000',
                        boxShadow: `0 4px 15px -3px ${accentColor}50`,
                      }}
                    >
                      {recoveryBusy && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
                      {recoveryBusy ? 'Rekeying vault…' : 'Recover Vault'}
                    </button>
                  </div>
                </form>
              ) : (
                <form onSubmit={handleResetVault} className="space-y-4">
                  <div className="rounded-xl border border-rose-500/30 bg-rose-500/10 p-3.5 text-xs text-rose-200 leading-relaxed">
                    <div className="flex items-center gap-2 font-semibold text-rose-400 mb-1">
                      <AlertTriangle className="h-4 w-4" />
                      DANGER: Permanent Data Loss
                    </div>
                    Resetting your vault will permanently delete your encrypted database file, all stored SSH hosts, credentials, snippets, and recovery envelope. This action cannot be reversed.
                  </div>

                  <div>
                    <label className="block text-[11px] font-medium text-slate-400 mb-1.5">
                      Type <span className="font-mono font-bold text-rose-400">RESET</span> in capital letters to confirm:
                    </label>
                    <input
                      type="text"
                      value={resetConfirmText}
                      onChange={(e) => setResetConfirmText(e.target.value)}
                      placeholder="RESET"
                      className="w-full rounded-xl border border-rose-500/30 bg-black/50 px-3.5 py-2.5 font-mono text-xs text-white placeholder:text-slate-600 focus:outline-none focus:ring-1 focus:ring-rose-500"
                    />
                  </div>

                  {recoveryErr && (
                    <div className="rounded-xl border border-rose-500/20 bg-rose-500/10 p-2.5 text-xs text-rose-300">
                      {recoveryErr}
                    </div>
                  )}

                  <div className="pt-2 flex items-center justify-end gap-3">
                    <button
                      type="button"
                      onClick={() => setShowRecoveryModal(false)}
                      className="rounded-xl px-4 py-2.5 text-xs font-medium text-slate-400 hover:bg-white/5 hover:text-white"
                    >
                      Cancel
                    </button>
                    <button
                      type="submit"
                      disabled={resetBusy || resetConfirmText.trim().toUpperCase() !== 'RESET'}
                      className="flex items-center gap-2 rounded-xl bg-rose-600 px-5 py-2.5 text-xs font-semibold text-white transition hover:bg-rose-500 disabled:opacity-50 shadow-lg shadow-rose-900/30"
                    >
                      {resetBusy && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
                      {resetBusy ? 'Erasing vault…' : 'Permanently Reset Vault'}
                    </button>
                  </div>
                </form>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
