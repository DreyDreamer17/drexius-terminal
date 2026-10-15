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
  CheckCircle2,
  Clipboard,
} from 'lucide-react';
import { bridge, isTauri, isBridgeError } from '../lib/bridge';
import { THEMES, type NexusTheme } from '../lib/themes';
import { useMobile } from '../hooks/useMobile';
import { cn } from '../utils/cn';
import { confirmDialog } from './ConfirmDialog';
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
  onJoinRequested,
  theme,
}: {
  onUnlocked: () => void;
  onJoinRequested?: () => void;
  theme?: NexusTheme;
}) {
  const [initialized, setInitialized] = useState<boolean | null>(null);
  const [joinExisting, setJoinExisting] = useState(false);
  const mobile = useMobile();
  const finishUnlock = () => {
    onUnlocked();
    if (initialized === false && joinExisting) onJoinRequested?.();
  };
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
  const [downloadedPath, setDownloadedPath] = useState<string | null>(null);
  const [downloading, setDownloading] = useState(false);

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
      if (isTauri && !mobile) {
        setHasStored(bridge.osKeychainEnabled());
        setRemember(bridge.osKeychainEnabled());
      }
    })();
  }, [mobile]);

  const downloadEmergencyKit = async (key: string) => {
    setDownloading(true);
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
    try {
      const path = await bridge.vaultSaveEmergencyKit(text);
      setDownloadedPath(path);
    } catch (e) {
      console.error('Failed to save emergency kit', e);
    } finally {
      setDownloading(false);
    }
  };

  const copyToClipboard = async (text: string) => {
    try {
      await navigator.clipboard.writeText(text);
      setCopiedKey(true);
      setTimeout(() => setCopiedKey(false), 2000);
    } catch (_) {}
  };

  const pasteFromClipboard = async (setter: (val: string) => void) => {
    try {
      const text = await navigator.clipboard.readText();
      if (text) setter(text.trim());
    } catch (err) {
      console.warn('Clipboard read failed', err);
    }
  };

  const doUnlock = async (password: string, isNewVault: boolean) => {
    setBusy(true); setErr(null);
    try {
      const generatedCode = await bridge.unlock(password);
      // Post-unlock keychain sync:
      //   - New vault creation → store if the user ticked the box
      //   - Existing vault  → store if ticked, delete if unticked (so the
      //     checkbox faithfully reflects what's in the OS keychain)
      if (isTauri && !mobile) {
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
        setDownloadedPath(null);
        return;
      }

      finishUnlock();
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
    if (recoveryNewPw.length < 8) {
      setRecoveryErr('New password must be at least 8 characters');
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
      setDownloadedPath(null);
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
    // New vaults need a real password; unlocking keeps accepting whatever the
    // vault was created with (older 4-char vaults must not be bricked).
    if (isNew && pw.length < 8) { setErr('Use at least 8 characters (12+ recommended)'); return; }
    await doUnlock(pw, isNew);
  };

  const biometricUnlock = async () => {
    setBioBusy(true); setErr(null);
    try {
      const generatedCode = await bridge.osKeychainUnlock();
      if (generatedCode) {
        setCreatedRecoveryKey(generatedCode);
        setDownloadedPath(null);
        return;
      }
      finishUnlock();
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
      className="nx-lock-screen relative flex min-h-screen flex-col justify-center overflow-y-auto px-4 py-6 md:grid md:place-items-center text-slate-200"
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

      <div className="relative w-full max-w-md mx-auto md:max-w-5xl md:grid md:grid-cols-2 md:gap-12 md:items-center">
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
          className="nx-rise relative w-full overflow-hidden max-md:border-0 max-md:bg-transparent max-md:shadow-none max-md:p-0 md:rounded-3xl md:border md:border-white/10 md:bg-white/[0.03] md:p-8 md:shadow-2xl md:backdrop-blur-xl"
        >
          {/* Top ambient radial glow */}
          <div
            className="pointer-events-none absolute inset-x-0 top-0 h-44 opacity-25"
            style={{ background: `radial-gradient(ellipse at top, ${accentColor} 0%, transparent 70%)` }}
          />

          {/* Logo & Header */}
          <div className="flex flex-col items-center text-center">
            <div
              className="relative grid h-16 w-16 place-items-center rounded-2xl border transition shadow-xl md:h-12 md:w-12"
              style={{
                backgroundColor: `${accentColor}18`,
                borderColor: `${accentColor}35`,
                color: accentColor,
                boxShadow: `0 0 30px ${accentColor}30`,
              }}
            >
              <img src="/nexus-logo.png" alt="Nexus" className="h-10 w-10 rounded-xl md:hidden" />
              <Lock className="hidden md:block h-5 w-5" />
            </div>
            <h1 className="mt-4 text-2xl font-bold tracking-tight text-white md:hidden">
              Nexus<span style={{ color: accentColor }}>Terminal</span>
            </h1>
            <h2 className="mt-1.5 text-base font-semibold text-slate-200 md:mt-3 md:text-2xl md:font-bold md:text-white">
              {initialized === false ? 'Create your master vault' : 'Unlock vault'}
            </h2>
            <p className="mt-1 text-center text-xs text-slate-400 max-w-xs">
              {initialized === false
                ? joinExisting
                  ? 'Choose a password for this device. Then pair over your local network.'
                  : 'Choose a master password. An Emergency Recovery Key will be generated.'
                : 'Enter your master password to decrypt your hosts.'}
            </p>
          </div>

          {isTauri && initialized === false && (
            <div className="mt-5 space-y-2">
              <div className="grid grid-cols-2 gap-1.5 p-1 rounded-xl bg-black/40 border border-white/10 text-xs">
                <button
                  type="button"
                  onClick={() => setJoinExisting(false)}
                  aria-pressed={!joinExisting}
                  className={cn(
                    'nx-tab-btn rounded-lg py-2 px-3 font-medium transition text-center min-h-[36px] flex items-center justify-center',
                    !joinExisting
                      ? 'bg-cyan-500/20 text-cyan-200 border border-cyan-400/40 shadow-sm'
                      : 'text-slate-400 hover:text-white border border-transparent'
                  )}
                >
                  Create new vault
                </button>
                <button
                  type="button"
                  onClick={() => setJoinExisting(true)}
                  aria-pressed={joinExisting}
                  className={cn(
                    'nx-tab-btn rounded-lg py-2 px-3 font-medium transition text-center min-h-[36px] flex items-center justify-center',
                    joinExisting
                      ? 'bg-cyan-500/20 text-cyan-200 border border-cyan-400/40 shadow-sm'
                      : 'text-slate-400 hover:text-white border border-transparent'
                  )}
                >
                  Join existing vault
                </button>
              </div>
              {joinExisting && (
                <p className="text-[11px] text-amber-300/80 leading-relaxed px-1">
                  Use a new local password, then pair on the same LAN. Configure an HTTPS relay on the original device first for ongoing sync. Keep a backup of that device: this recovery kit alone cannot restore the shared sync key.
                </p>
              )}
            </div>
          )}

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
                <><Loader2 className="h-4 w-4 animate-spin" />Unlocking…</>
              ) : (
                <><Fingerprint className="h-4 w-4" />{typeof navigator !== 'undefined' && /macintosh|mac os x/i.test(navigator.userAgent) ? 'Unlock with Touch ID' : typeof navigator !== 'undefined' && /windows/i.test(navigator.userAgent) ? 'Unlock with Windows Hello' : 'Unlock with OS Keyring'}</>
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
                onPaste={(e) => {
                  e.preventDefault();
                  const text = e.clipboardData?.getData('text/plain') ?? '';
                  if (text) setPw(text);
                }}
                onContextMenu={async (e) => {
                  e.preventDefault();
                  await pasteFromClipboard(setPw);
                }}
                spellCheck={false}
                autoComplete="off"
                placeholder="Master password"
                className="w-full rounded-xl border border-white/10 bg-black/40 px-4 py-3 pr-10 text-sm text-white placeholder:text-slate-600 focus:outline-none focus:ring-2"
                style={{
                  outlineColor: accentColor,
                }}
              />
              <button
                type="button"
                onClick={() => setShow((s: boolean) => !s)}
                aria-label={show ? 'Hide password' : 'Show password'}
                className="nx-icon-btn absolute right-3 top-1/2 -translate-y-1/2 text-slate-500 hover:text-white transition p-1.5 rounded-lg min-h-0 min-w-0 flex items-center justify-center"
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
                onPaste={(e) => {
                  e.preventDefault();
                  const text = e.clipboardData?.getData('text/plain') ?? '';
                  if (text) setPw2(text);
                }}
                onContextMenu={async (e) => {
                  e.preventDefault();
                  await pasteFromClipboard(setPw2);
                }}
                spellCheck={false}
                autoComplete="off"
                placeholder="Confirm master password"
                className="w-full rounded-xl border border-white/10 bg-black/40 px-4 py-3 text-sm text-white placeholder:text-slate-600 focus:outline-none focus:ring-2"
                style={{
                  outlineColor: accentColor,
                }}
              />
            )}

            {/* Remember in OS keychain opt-in (desktop only) */}
            {isTauri && !mobile && (
              <label className="flex cursor-pointer items-start gap-2.5 rounded-xl border border-white/5 bg-black/20 p-3 transition hover:border-white/10">
                <button
                  type="button"
                  role="checkbox"
                  aria-checked={remember}
                  onClick={() => setRemember((r: boolean) => !r)}
                  className="nx-icon-btn mt-0.5 grid h-4 w-4 shrink-0 place-items-center rounded border transition min-h-0 min-w-0"
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
              className="nx-lock-submit flex w-full items-center justify-center gap-2 rounded-xl py-3 text-sm font-semibold text-black transition hover:brightness-110 active:scale-[0.99] disabled:opacity-50 min-h-[48px]"
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

          <div className="mt-5 rounded-xl border border-white/5 bg-black/20 p-2.5 text-[11px] leading-relaxed text-slate-500 text-center">
            {isTauri
              ? mobile
                ? <>Native Android · SQLCipher AES-256 vault · libssh2 SSH</>
                : <>Desktop mode · SQLCipher vault at app-data/nexus.vault · real SSH via libssh2{hasStored && <> · biometric unlock available</>}.</>
              : <>Browser preview · vault encrypted with WebCrypto AES-256-GCM in localStorage · SSH sessions run in a local sandbox. Build with Tauri for real connections and OS keychain support.
                {initialized && <button type="button" onClick={async () => { if (await confirmDialog({ title: 'Erase the sandbox vault?', message: 'All hosts, snippets and keys stored in this browser preview will be deleted.', confirmLabel: 'Erase vault', danger: true })) { await bridge.resetDemoVault(); setInitialized(false); } }} className="ml-1 hover:underline" style={{ color: accentColor }}>Reset sandbox vault</button>}</>}
          </div>
        </form>
      </div>

      {/* Emergency Recovery Kit Modal (Shown on vault creation or after recovery) */}
      {createdRecoveryKey && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 backdrop-blur-sm p-4"
          onMouseDown={() => {
            setCreatedRecoveryKey(null);
            finishUnlock();
          }}
        >
          <div
            onMouseDown={(e) => e.stopPropagation()}
            className="relative flex flex-col w-full max-w-lg max-h-[calc(100dvh-2rem)] rounded-2xl border border-white/10 shadow-2xl overflow-hidden animate-in fade-in zoom-in-95 duration-150"
            style={{ backgroundColor: bgColor }}
          >
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

            {/* Standard Header */}
            <div className="relative flex items-center justify-between border-b border-white/10 px-5 py-4 shrink-0 bg-white/[0.02]">
              <div className="flex items-center gap-3">
                <div
                  className="flex h-10 w-10 items-center justify-center rounded-2xl border transition shadow-lg shrink-0"
                  style={{
                    backgroundColor: `${accentColor}18`,
                    borderColor: `${accentColor}35`,
                    color: accentColor,
                    boxShadow: `0 0 20px ${accentColor}25`,
                  }}
                >
                  <KeyRound className="h-5 w-5" />
                </div>
                <div>
                  <h3 className="text-sm font-semibold text-white">Emergency Recovery Kit</h3>
                  <p className="flex items-center gap-1 text-[11px] text-slate-400">
                    <ShieldCheck className="h-3 w-3 text-emerald-400" />
                    Zero-knowledge master vault recovery
                  </p>
                </div>
              </div>
              <button
                type="button"
                onClick={() => {
                  setCreatedRecoveryKey(null);
                  finishUnlock();
                }}
                className="rounded-lg p-1.5 text-slate-400 hover:bg-white/10 hover:text-white transition"
              >
                <X className="h-4 w-4" />
              </button>
            </div>

            {/* Body */}
            <div className="relative flex-1 overflow-y-auto px-6 py-5 space-y-4">
              <p className="text-xs text-slate-400 leading-relaxed">
                NexusTerminal uses zero-knowledge encryption. If you ever forget your master password,{' '}
                <strong className="text-slate-200">this recovery key is the ONLY way to regain access to your vault</strong>.
                Save it now in a secure offline location or password manager.
              </p>

              {/* Themed Key Box */}
              <div
                className="rounded-xl border p-4 space-y-3 shadow-inner"
                style={{
                  backgroundColor: 'rgba(0, 0, 0, 0.45)',
                  borderColor: `${accentColor}30`,
                }}
              >
                <div className="flex items-center justify-between text-[11px] text-slate-400">
                  <span className="font-medium uppercase tracking-wider text-[10px]">128-Bit Emergency Recovery Key</span>
                  <span className="text-[10px] text-slate-500">Keep safe & private</span>
                </div>

                <div
                  className="select-all font-mono text-sm sm:text-base font-bold tracking-wider text-center py-2.5 px-3 rounded-lg bg-black/60 border border-white/5 break-all"
                  style={{ color: accentColor }}
                >
                  {createdRecoveryKey}
                </div>

                <div className="flex flex-wrap items-center justify-center gap-2.5 pt-1">
                  <button
                    type="button"
                    onClick={() => copyToClipboard(createdRecoveryKey)}
                    className="flex items-center gap-1.5 rounded-lg border border-white/10 bg-white/[0.04] px-3.5 py-1.5 text-xs font-medium text-slate-200 transition hover:bg-white/[0.08] hover:text-white"
                  >
                    {copiedKey ? <Check className="h-3.5 w-3.5" style={{ color: accentColor }} /> : <Copy className="h-3.5 w-3.5" />}
                    {copiedKey ? 'Copied key' : 'Copy Key'}
                  </button>

                  <button
                    type="button"
                    onClick={() => downloadEmergencyKit(createdRecoveryKey)}
                    disabled={downloading}
                    className="flex items-center gap-1.5 rounded-lg border border-white/10 bg-white/[0.04] px-3.5 py-1.5 text-xs font-medium text-slate-200 transition hover:bg-white/[0.08] hover:text-white disabled:opacity-50"
                  >
                    {downloading ? (
                      <Loader2 className="h-3.5 w-3.5 animate-spin" />
                    ) : downloadedPath ? (
                      <Check className="h-3.5 w-3.5 text-emerald-400" />
                    ) : (
                      <Download className="h-3.5 w-3.5" />
                    )}
                    {downloading ? 'Saving…' : downloadedPath ? 'Downloaded' : 'Download .txt'}
                  </button>
                </div>

                {/* Where it was saved indicator */}
                {downloadedPath && (
                  <div
                    className="mt-3 flex items-start gap-2.5 rounded-xl border p-3 text-xs animate-in fade-in duration-150"
                    style={{
                      backgroundColor: `${accentColor}12`,
                      borderColor: `${accentColor}35`,
                    }}
                  >
                    <CheckCircle2 className="h-4 w-4 shrink-0 mt-0.5" style={{ color: accentColor }} />
                    <div className="min-w-0 flex-1">
                      <div className="font-semibold text-white flex items-center gap-1.5">
                        <span>Recovery key saved to disk</span>
                      </div>
                      <div className="mt-1 font-mono text-[10.5px] text-slate-200 select-all break-all rounded-lg bg-black/50 p-2 border border-white/5">
                        {downloadedPath}
                      </div>
                    </div>
                    <button
                      type="button"
                      onClick={() => copyToClipboard(downloadedPath)}
                      title="Copy file path"
                      className="shrink-0 rounded p-1 text-slate-400 hover:text-white hover:bg-white/10 transition"
                    >
                      <Copy className="h-3.5 w-3.5" />
                    </button>
                  </div>
                )}
              </div>

              {/* Warning Banner */}
              <div className="flex items-start gap-2.5 rounded-xl border border-amber-500/25 bg-amber-500/10 p-3 text-xs text-amber-200/90 leading-relaxed">
                <AlertTriangle className="h-4 w-4 shrink-0 text-amber-400 mt-0.5" />
                <span>
                  NexusTerminal cannot recover or reset your master password for you. If you lose this key and forget your master password, your vault data cannot be recovered.
                </span>
              </div>
            </div>

            {/* Standard Footer */}
            <div className="border-t border-white/10 px-5 py-4 shrink-0 bg-white/[0.02] flex items-center justify-end">
              <button
                type="button"
                onClick={() => {
                  setCreatedRecoveryKey(null);
                  finishUnlock();
                }}
                className="flex w-full sm:w-auto items-center justify-center gap-2 rounded-xl px-6 py-2.5 text-xs font-semibold text-black transition hover:brightness-110 active:scale-[0.99] shadow-lg"
                style={{
                  backgroundColor: accentColor,
                  color: '#000000',
                  boxShadow: `0 4px 20px -3px ${accentColor}60`,
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
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 backdrop-blur-sm p-4"
          onMouseDown={() => {
            setShowRecoveryModal(false);
            setRecoveryErr(null);
          }}
        >
          <div
            onMouseDown={(e) => e.stopPropagation()}
            className="relative flex flex-col w-full max-w-lg max-h-[calc(100dvh-2rem)] rounded-2xl border border-white/10 shadow-2xl overflow-hidden animate-in fade-in zoom-in-95 duration-150"
            style={{ backgroundColor: bgColor }}
          >
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

            {/* Standard Header */}
            <div className="relative flex items-center justify-between border-b border-white/10 px-5 py-4 shrink-0 bg-white/[0.02]">
              <div className="flex items-center gap-3">
                <div
                  className="flex h-10 w-10 items-center justify-center rounded-2xl border transition shadow-lg shrink-0"
                  style={{
                    backgroundColor: `${accentColor}18`,
                    borderColor: `${accentColor}35`,
                    color: accentColor,
                    boxShadow: `0 0 20px ${accentColor}25`,
                  }}
                >
                  <KeyRound className="h-5 w-5" />
                </div>
                <div>
                  <h3 className="text-sm font-semibold text-white">Vault Recovery & Reset</h3>
                  <p className="flex items-center gap-1 text-[11px] text-slate-400">
                    <ShieldCheck className="h-3 w-3 text-emerald-400" />
                    Regain access or reset your encrypted vault
                  </p>
                </div>
              </div>
              <button
                type="button"
                onClick={() => {
                  setShowRecoveryModal(false);
                  setRecoveryErr(null);
                }}
                className="rounded-lg p-1.5 text-slate-400 hover:bg-white/10 hover:text-white transition"
              >
                <X className="h-4 w-4" />
              </button>
            </div>

            {/* Tab switcher - Matches TeamShareModal style */}
            <div className="relative flex border-b border-white/10 bg-white/[0.02] px-5 pt-2 shrink-0">
              <button
                type="button"
                onClick={() => { setRecoveryTab('recover'); setRecoveryErr(null); }}
                className={cn(
                  'flex items-center gap-2 border-b-2 px-3 py-2 text-xs font-medium transition',
                  recoveryTab !== 'recover' && 'border-transparent text-slate-400 hover:text-slate-200'
                )}
                style={recoveryTab === 'recover' ? {
                  borderColor: accentColor,
                  color: accentColor,
                } : undefined}
              >
                <KeyRound className="h-3.5 w-3.5" />
                <span>Use Emergency Key</span>
              </button>
              <button
                type="button"
                onClick={() => { setRecoveryTab('reset'); setRecoveryErr(null); }}
                className={cn(
                  'flex items-center gap-2 border-b-2 px-3 py-2 text-xs font-medium transition',
                  recoveryTab !== 'reset' && 'border-transparent text-slate-400 hover:text-slate-200'
                )}
                style={recoveryTab === 'reset' ? {
                  borderColor: '#f43f5e',
                  color: '#f43f5e',
                } : undefined}
              >
                <AlertTriangle className="h-3.5 w-3.5" />
                <span>Reset Vault</span>
              </button>
            </div>

            {/* Body */}
            <div className="relative flex-1 overflow-y-auto px-6 py-5 space-y-4">
              {recoveryTab === 'recover' ? (
                <form id="recover-form" onSubmit={handleRecover} className="space-y-4">
                  <p className="text-xs text-slate-400 leading-relaxed">
                    Enter the 128-bit Emergency Recovery Key generated when your vault was created, then choose a new master password.
                  </p>

                  <div>
                    <div className="flex items-center justify-between mb-1.5">
                      <label className="block text-[11px] font-medium uppercase tracking-wider text-slate-400">
                        Emergency Recovery Key
                      </label>
                      <button
                        type="button"
                        onClick={() => pasteFromClipboard(setRecoveryCode)}
                        className="flex items-center gap-1 rounded-lg border border-white/10 bg-white/[0.04] px-2.5 py-1 text-[11px] font-medium text-slate-300 transition hover:bg-white/10 hover:text-white"
                      >
                        <Clipboard className="h-3 w-3" style={{ color: accentColor }} />
                        <span>Paste from clipboard</span>
                      </button>
                    </div>
                    <textarea
                      value={recoveryCode}
                      onChange={(e) => setRecoveryCode(e.target.value)}
                      onPaste={(e) => {
                        e.preventDefault();
                        const text = e.clipboardData?.getData('text/plain') ?? '';
                        setRecoveryCode(text.trim());
                      }}
                      onContextMenu={async (e) => {
                        e.preventDefault();
                        await pasteFromClipboard(setRecoveryCode);
                      }}
                      spellCheck={false}
                      autoComplete="off"
                      autoCorrect="off"
                      autoCapitalize="off"
                      rows={2}
                      placeholder="NX-XXXX-XXXX-XXXX-XXXX-XXXX-XXXX-XXXX-XXXX"
                      className="w-full rounded-xl border border-white/10 bg-black/40 px-3.5 py-2.5 font-mono text-xs text-white placeholder:text-slate-600 focus:outline-none focus:ring-1"
                      style={{ outlineColor: accentColor }}
                    />
                  </div>

                  <div>
                    <label className="block text-[11px] font-medium uppercase tracking-wider text-slate-400 mb-1.5">
                      New Master Password
                    </label>
                    <input
                      type="password"
                      value={recoveryNewPw}
                      onChange={(e) => setRecoveryNewPw(e.target.value)}
                      onPaste={(e) => {
                        e.preventDefault();
                        const text = e.clipboardData?.getData('text/plain') ?? '';
                        setRecoveryNewPw(text);
                      }}
                      onContextMenu={async (e) => {
                        e.preventDefault();
                        await pasteFromClipboard(setRecoveryNewPw);
                      }}
                      spellCheck={false}
                      autoComplete="off"
                      placeholder="Enter new master password"
                      className="w-full rounded-xl border border-white/10 bg-black/40 px-3.5 py-2.5 text-xs text-white placeholder:text-slate-600 focus:outline-none focus:ring-1"
                      style={{ outlineColor: accentColor }}
                    />
                  </div>

                  <div>
                    <label className="block text-[11px] font-medium uppercase tracking-wider text-slate-400 mb-1.5">
                      Confirm New Master Password
                    </label>
                    <input
                      type="password"
                      value={recoveryNewPw2}
                      onChange={(e) => setRecoveryNewPw2(e.target.value)}
                      onPaste={(e) => {
                        e.preventDefault();
                        const text = e.clipboardData?.getData('text/plain') ?? '';
                        setRecoveryNewPw2(text);
                      }}
                      onContextMenu={async (e) => {
                        e.preventDefault();
                        await pasteFromClipboard(setRecoveryNewPw2);
                      }}
                      spellCheck={false}
                      autoComplete="off"
                      placeholder="Confirm new master password"
                      className="w-full rounded-xl border border-white/10 bg-black/40 px-3.5 py-2.5 text-xs text-white placeholder:text-slate-600 focus:outline-none focus:ring-1"
                      style={{ outlineColor: accentColor }}
                    />
                  </div>

                  {recoveryErr && (
                    <div className="rounded-xl border border-rose-500/25 bg-rose-500/10 p-2.5 text-xs text-rose-300">
                      {recoveryErr}
                    </div>
                  )}
                </form>
              ) : (
                <form id="reset-form" onSubmit={handleResetVault} className="space-y-4">
                  <div className="rounded-xl border border-rose-500/30 bg-rose-500/10 p-3.5 text-xs text-rose-200 leading-relaxed">
                    <div className="flex items-center gap-2 font-semibold text-rose-400 mb-1">
                      <AlertTriangle className="h-4 w-4" />
                      DANGER: Permanent Data Loss
                    </div>
                    Resetting your vault will permanently erase your encrypted database file, all stored SSH hosts, credentials, snippets, and recovery envelope. This action cannot be reversed.
                  </div>

                  <div>
                    <label className="block text-[11px] font-medium uppercase tracking-wider text-slate-400 mb-1.5">
                      Type <span className="font-mono font-bold text-rose-400">RESET</span> in capital letters to confirm:
                    </label>
                    <input
                      type="text"
                      value={resetConfirmText}
                      onChange={(e) => setResetConfirmText(e.target.value)}
                      spellCheck={false}
                      autoComplete="off"
                      placeholder="RESET"
                      className="w-full rounded-xl border border-rose-500/30 bg-black/40 px-3.5 py-2.5 font-mono text-xs text-white placeholder:text-slate-600 focus:outline-none focus:ring-1 focus:ring-rose-500"
                    />
                  </div>

                  {recoveryErr && (
                    <div className="rounded-xl border border-rose-500/25 bg-rose-500/10 p-2.5 text-xs text-rose-300">
                      {recoveryErr}
                    </div>
                  )}
                </form>
              )}
            </div>

            {/* Standard Footer */}
            <div className="border-t border-white/10 px-5 py-4 shrink-0 bg-white/[0.02] flex items-center justify-end gap-3">
              <button
                type="button"
                onClick={() => setShowRecoveryModal(false)}
                className="rounded-xl px-4 py-2.5 text-xs font-medium text-slate-400 hover:bg-white/5 hover:text-white transition"
              >
                Cancel
              </button>

              {recoveryTab === 'recover' ? (
                <button
                  type="submit"
                  form="recover-form"
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
              ) : (
                <button
                  type="submit"
                  form="reset-form"
                  disabled={resetBusy || resetConfirmText.trim().toUpperCase() !== 'RESET'}
                  className="flex items-center gap-2 rounded-xl bg-rose-600 px-5 py-2.5 text-xs font-semibold text-white transition hover:bg-rose-500 disabled:opacity-50 shadow-lg shadow-rose-900/30"
                >
                  {resetBusy && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
                  {resetBusy ? 'Erasing vault…' : 'Permanently Reset Vault'}
                </button>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
