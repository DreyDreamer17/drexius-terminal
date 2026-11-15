import { useEffect, useRef, useState } from 'react';
import {
  Activity,
  AlertTriangle,
  Boxes,
  Check,
  ChevronRight,
  Cloud,
  Copy,
  Download,
  Eye,
  EyeOff,
  FolderLock,
  Globe2,
  KeyRound,
  Loader2,
  Lock,
  Network,
  QrCode,
  Shield,
  ShieldCheck,
  X,
  Zap,
} from 'lucide-react';
import { bridge, isBridgeError, isTauri } from '../../lib/bridge';
import type { DrexiusTheme } from '../../lib/themes';
import { CustomSelect } from '../CustomSelect';
import type { SettingsTab } from '../SettingsModal';
import { ToggleSwitch } from '../ToggleSwitch';

export interface SecuritySettingsTabProps {
  activeTheme: DrexiusTheme;
  accentColor: string;
  autoLockMinutes: number;
  onAutoLockChange: (mins: number) => void;
  onClose: () => void;
  onLockVault?: () => void;
  onOpenKeychain?: (tab?: SettingsTab) => void;
  onOpenKnownHosts?: (tab?: SettingsTab) => void;
  onOpenLogs?: (tab?: SettingsTab) => void;
  storageGranted?: boolean | null;
  onRequestStoragePermission?: () => void;
  toast: (msg: string) => void;
}

export function SecuritySettingsTab({
  activeTheme,
  accentColor,
  autoLockMinutes,
  onAutoLockChange,
  onClose,
  onLockVault,
  onOpenKeychain,
  onOpenKnownHosts,
  onOpenLogs,
  storageGranted,
  onRequestStoragePermission,
  toast,
}: SecuritySettingsTabProps) {
  const [recoveryKey, setRecoveryKey] = useState<string | null>(null);
  const [revealRecovery, setRevealRecovery] = useState(false);
  const [copiedRecovery, setCopiedRecovery] = useState(false);
  const [downloadedRecoveryPath, setDownloadedRecoveryPath] = useState<string | null>(null);
  const [showRegenConfirm, setShowRegenConfirm] = useState(false);
  const [regeneratingRecovery, setRegeneratingRecovery] = useState(false);

  useEffect(() => {
    bridge
      .vaultGetRecoveryKey()
      .then(setRecoveryKey)
      .catch(() => {});
  }, []);

  // Direct Launch / Auto-Unlock state & handlers
  const [directUnlockEnabled, setDirectUnlockEnabled] = useState(() => bridge.isDirectUnlockEnabled());
  const [showDirectUnlockModal, setShowDirectUnlockModal] = useState(false);
  const [targetDirectUnlockState, setTargetDirectUnlockState] = useState(false);
  const [directUnlockPw, setDirectUnlockPw] = useState('');
  const [showDirectUnlockPw, setShowDirectUnlockPw] = useState(false);
  const [directUnlockBusy, setDirectUnlockBusy] = useState(false);
  const [directUnlockErr, setDirectUnlockErr] = useState<string | null>(null);
  const directPwInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (showDirectUnlockModal) {
      const timer = setTimeout(() => directPwInputRef.current?.focus(), 50);
      return () => clearTimeout(timer);
    }
  }, [showDirectUnlockModal]);

  const handleToggleDirectUnlock = () => {
    const nextState = !directUnlockEnabled;
    setTargetDirectUnlockState(nextState);
    setDirectUnlockPw('');
    setShowDirectUnlockPw(false);
    setDirectUnlockErr(null);
    setShowDirectUnlockModal(true);
  };

  const handleConfirmDirectUnlock = async (e?: React.FormEvent) => {
    if (e) e.preventDefault();
    if (!directUnlockPw) {
      setDirectUnlockErr('Please enter your master password');
      return;
    }
    setDirectUnlockBusy(true);
    setDirectUnlockErr(null);
    try {
      const isValid = await bridge.vaultVerifyPassword(directUnlockPw);
      if (!isValid) {
        setDirectUnlockErr('Incorrect master password. Please verify and try again.');
        setDirectUnlockBusy(false);
        return;
      }

      if (targetDirectUnlockState) {
        if (isTauri) {
          try {
            await bridge.osKeychainStore(directUnlockPw);
          } catch (storeErr) {
            console.warn('Keychain store warning:', storeErr);
          }
        }
        bridge.setDirectUnlockEnabled(true);
        setDirectUnlockEnabled(true);
        toast('Direct Launch enabled: Drexius will open directly on launch.');
      } else {
        bridge.setDirectUnlockEnabled(false);
        if (isTauri) {
          try {
            await bridge.osKeychainDelete();
          } catch (_) {}
        }
        setDirectUnlockEnabled(false);
        toast('Direct Launch disabled: Master password required on launch.');
      }
      setShowDirectUnlockModal(false);
      setDirectUnlockPw('');
    } catch (err: any) {
      setDirectUnlockErr(isBridgeError(err) ? err.message : err?.message || 'Verification failed');
    } finally {
      setDirectUnlockBusy(false);
    }
  };

  return (
    <div className="space-y-6">
      {/* Vault Status Header */}
      <div
        className="rounded-xl border p-4 sm:p-5 relative overflow-hidden"
        style={{
          backgroundColor: `${accentColor}10`,
          borderColor: `${accentColor}30`,
        }}
      >
        <div className="flex items-center justify-between flex-wrap gap-3">
          <div className="flex items-center gap-3">
            <Shield className="h-6 w-6" style={{ color: accentColor }} />
            <div>
              <h4 className="text-sm font-semibold text-white">AES-256 SQLCipher & Argon2id Vault</h4>
              <p className="text-xs text-slate-400">
                Zero-knowledge local encrypted database protecting SSH credentials and host keys
              </p>
            </div>
          </div>

          {onLockVault && (
            <button
              type="button"
              onClick={() => {
                onClose();
                onLockVault();
              }}
              className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-rose-400/40 bg-rose-500/10 text-rose-300 hover:bg-rose-500/20 text-xs font-semibold transition"
            >
              <Lock className="h-3.5 w-3.5" />
              <span>Lock Vault Now</span>
            </button>
          )}
        </div>
      </div>

      {/* Direct Launch / Auto-Unlock on Startup */}
      <div className="rounded-xl border border-white/10 bg-white/[0.02] p-4 sm:p-5 space-y-4">
        <div className="flex items-start justify-between gap-4">
          <div className="space-y-1">
            <div className="flex items-center gap-2">
              <h3 className="text-sm font-semibold text-white flex items-center gap-2">
                <Zap className="h-4 w-4" style={{ color: accentColor }} />
                <span>Direct Launch (Bypass Master Password)</span>
              </h3>
              {directUnlockEnabled ? (
                <span className="inline-flex items-center px-2 py-0.5 rounded text-[10px] font-semibold bg-emerald-500/15 text-emerald-300 border border-emerald-500/30">
                  Enabled
                </span>
              ) : (
                <span className="inline-flex items-center px-2 py-0.5 rounded text-[10px] font-semibold bg-white/5 text-slate-400 border border-white/10">
                  Disabled
                </span>
              )}
            </div>
            <p className="text-xs text-slate-400 leading-relaxed max-w-xl">
              Automatically unlock your vault and navigate directly into the terminal workspace on application
              startup without prompting for authorization or your master password.
            </p>
            {directUnlockEnabled ? (
              <div className="flex items-center gap-1.5 pt-1 text-[11px] text-amber-400/90">
                <AlertTriangle className="h-3.5 w-3.5 shrink-0" />
                <span>
                  Direct launch is active. Anyone with physical access to your device can launch your sessions.
                </span>
              </div>
            ) : (
              <div className="text-[11px] text-slate-500 pt-1">
                Master password or biometric authorization is required every time the application starts.
              </div>
            )}
          </div>

          <div className="shrink-0 pt-0.5">
            <ToggleSwitch
              checked={directUnlockEnabled}
              onChange={handleToggleDirectUnlock}
              accentColor={accentColor}
              ariaLabel="Toggle Direct Launch on startup"
            />
          </div>
        </div>
      </div>

      {/* Emergency Recovery Kit */}
      <div className="rounded-xl border border-white/10 bg-white/[0.02] p-4 sm:p-5 space-y-4">
        <div className="flex items-start justify-between gap-4">
          <div className="space-y-1">
            <h3 className="text-sm font-semibold text-white flex items-center gap-2">
              <KeyRound className="h-4 w-4" style={{ color: accentColor }} />
              <span>Emergency Recovery Kit</span>
            </h3>
            <p className="text-xs text-slate-400 leading-relaxed max-w-xl">
              If you ever forget your master password, this 128-bit key is the{' '}
              <strong className="text-slate-200">ONLY way to recover your encrypted vault</strong> on the lock
              screen. Store it safely offline.
            </p>
          </div>
        </div>

        {recoveryKey ? (
          <div className="space-y-3 pt-1">
            <div className="flex items-center justify-between gap-3 p-3 rounded-xl border border-white/10 bg-black/50 font-mono text-xs sm:text-sm">
              <span className="select-all break-all tracking-wider font-semibold text-white">
                {revealRecovery ? recoveryKey : '••••••••••••••••••••••••••••••••'}
              </span>
              <button
                type="button"
                onClick={() => setRevealRecovery(!revealRecovery)}
                className="p-1.5 rounded-lg text-slate-400 hover:text-white hover:bg-white/10 transition shrink-0 cursor-pointer"
                title={revealRecovery ? 'Hide Recovery Key' : 'Show Recovery Key'}
              >
                {revealRecovery ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
              </button>
            </div>

            <div className="flex flex-wrap items-center gap-2 pt-1">
              <button
                type="button"
                onClick={async () => {
                  try {
                    await bridge.writeClipboard(recoveryKey);
                    setCopiedRecovery(true);
                    setTimeout(() => setCopiedRecovery(false), 2000);
                  } catch (_) {}
                }}
                className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-white/15 bg-white/5 hover:bg-white/10 text-xs font-medium text-white transition cursor-pointer"
              >
                {copiedRecovery ? (
                  <Check className="h-3.5 w-3.5 text-emerald-400" />
                ) : (
                  <Copy className="h-3.5 w-3.5" />
                )}
                <span>{copiedRecovery ? 'Copied!' : 'Copy Key'}</span>
              </button>

              <button
                type="button"
                onClick={async () => {
                  try {
                    const text = `=====================================================\nDREXIUS EMERGENCY RECOVERY KIT\n=====================================================\n\nEmergency Recovery Key:\n${recoveryKey}\n\nGenerated: ${new Date().toISOString()}\n=====================================================`;
                    const path = await bridge.vaultSaveEmergencyKit(text);
                    setDownloadedRecoveryPath(path);
                  } catch (e) {
                    console.error('Download failed', e);
                  }
                }}
                className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-white/15 bg-white/5 hover:bg-white/10 text-xs font-medium text-white transition cursor-pointer"
              >
                {downloadedRecoveryPath ? (
                  <Check className="h-3.5 w-3.5 text-emerald-400" />
                ) : (
                  <Download className="h-3.5 w-3.5" />
                )}
                <span>{downloadedRecoveryPath ? 'Saved to Downloads' : 'Download .txt Kit'}</span>
              </button>

              {!showRegenConfirm && (
                <button
                  type="button"
                  onClick={() => setShowRegenConfirm(true)}
                  className="text-xs text-slate-400 hover:text-amber-400 transition underline underline-offset-4 ml-auto cursor-pointer"
                >
                  Regenerate Key
                </button>
              )}
            </div>

            {downloadedRecoveryPath && (
              <div className="rounded-lg border border-emerald-500/30 bg-emerald-500/10 p-2.5 text-xs text-emerald-200">
                <span className="font-semibold text-white">Saved: </span>
                <span className="font-mono text-[11px] select-all break-all text-slate-300">
                  {downloadedRecoveryPath}
                </span>
              </div>
            )}

            {showRegenConfirm && (
              <div className="rounded-xl border border-amber-500/30 bg-amber-500/10 p-3.5 text-xs space-y-2.5">
                <div className="flex items-start gap-2 text-amber-200">
                  <AlertTriangle className="h-4 w-4 shrink-0 mt-0.5 text-amber-400" />
                  <p className="leading-relaxed">
                    Generating a new recovery key will immediately replace the active key and invalidate any
                    previously printed, downloaded, or saved emergency kits.
                  </p>
                </div>
                <div className="flex items-center gap-2 pt-1">
                  <button
                    type="button"
                    disabled={regeneratingRecovery}
                    onClick={async () => {
                      setRegeneratingRecovery(true);
                      try {
                        const newKey = await bridge.vaultRegenerateRecoveryKey();
                        setRecoveryKey(newKey);
                        setRevealRecovery(true);
                        setShowRegenConfirm(false);
                        setDownloadedRecoveryPath(null);
                      } catch (err) {
                        console.error('Failed to regenerate recovery key', err);
                      } finally {
                        setRegeneratingRecovery(false);
                      }
                    }}
                    className="rounded-lg bg-amber-500 px-3 py-1.5 text-xs font-semibold text-black hover:bg-amber-400 transition cursor-pointer"
                  >
                    {regeneratingRecovery ? 'Regenerating…' : 'Yes, Replace Active Key'}
                  </button>
                  <button
                    type="button"
                    onClick={() => setShowRegenConfirm(false)}
                    className="rounded-lg border border-white/10 px-3 py-1.5 text-xs text-slate-300 hover:bg-white/5 transition cursor-pointer"
                  >
                    Cancel
                  </button>
                </div>
              </div>
            )}
          </div>
        ) : (
          <div className="rounded-xl border border-white/10 bg-black/40 p-4 text-center space-y-3">
            <p className="text-xs text-slate-300">
              No active recovery key is currently stored in this vault session.
            </p>
            <button
              type="button"
              disabled={regeneratingRecovery}
              onClick={async () => {
                setRegeneratingRecovery(true);
                try {
                  const newKey = await bridge.vaultRegenerateRecoveryKey();
                  setRecoveryKey(newKey);
                  setRevealRecovery(true);
                } catch (err) {
                  console.error('Failed to generate recovery key', err);
                } finally {
                  setRegeneratingRecovery(false);
                }
              }}
              className="rounded-lg border border-cyan-500/40 bg-cyan-500/10 px-4 py-2 text-xs font-medium text-cyan-300 hover:bg-cyan-500/20 transition cursor-pointer"
            >
              {regeneratingRecovery ? 'Generating…' : 'Generate & Store Recovery Key'}
            </button>
          </div>
        )}
      </div>

      {/* Security Preferences */}
      <div className="rounded-xl border border-white/10 bg-white/[0.02] p-4 sm:p-5 space-y-4">
        <h3 className="text-sm font-semibold text-white">Auto-Lock Protection</h3>
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
          <div>
            <div className="text-xs font-medium text-slate-200">Vault Inactivity Timeout</div>
            <div className="text-[11px] text-slate-400">
              Automatically lock the vault and purge decrypted private keys from RAM when idle
            </div>
          </div>

          <div className="w-full sm:w-56 shrink-0">
            <CustomSelect
              value={autoLockMinutes}
              onChange={(val) => onAutoLockChange(Number(val))}
              options={[
                { value: 0, label: 'Never (Manual Lock Only)' },
                { value: 5, label: '5 minutes' },
                { value: 15, label: '15 minutes (Recommended)' },
                { value: 30, label: '30 minutes' },
                { value: 60, label: '1 hour' },
              ]}
              theme={activeTheme}
              accentColor={accentColor}
            />
          </div>
        </div>
      </div>

      {/* Keychain Identities */}
      <div className="rounded-xl border border-white/10 bg-white/[0.02] p-4 sm:p-5 space-y-3">
        <div className="flex items-center justify-between flex-wrap gap-3">
          <div>
            <h3 className="text-sm font-semibold text-white flex items-center gap-2">
              <KeyRound className="h-4 w-4" style={{ color: accentColor }} />
              <span>Keychain Identities</span>
            </h3>
            <p className="text-xs text-slate-400 mt-0.5">
              Reusable SSH keypairs, certificates, and passwords stored in your encrypted vault
            </p>
          </div>

          {onOpenKeychain && (
            <button
              type="button"
              onClick={() => {
                onClose();
                onOpenKeychain?.('security');
              }}
              className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-white/15 bg-white/5 hover:bg-white/10 text-xs font-medium text-white transition cursor-pointer"
            >
              <span>Manage Identities →</span>
            </button>
          )}
        </div>
      </div>

      {/* Known Hosts */}
      {onOpenKnownHosts && (
        <div className="rounded-xl border border-white/10 bg-white/[0.02] p-4 sm:p-5 space-y-3">
          <div className="flex items-center justify-between flex-wrap gap-3">
            <div>
              <h3 className="text-sm font-semibold text-white flex items-center gap-2">
                <ShieldCheck className="h-4 w-4 text-emerald-400" />
                <span>Known Hosts & Fingerprints</span>
              </h3>
              <p className="text-xs text-slate-400 mt-0.5">
                Verified remote server host keys and pinned cryptographic fingerprints
              </p>
            </div>

            <button
              type="button"
              onClick={() => {
                onClose();
                onOpenKnownHosts?.('security');
              }}
              className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-white/15 bg-white/5 hover:bg-white/10 text-xs font-medium text-white transition cursor-pointer"
            >
              <span>Manage Pinned Keys →</span>
            </button>
          </div>
        </div>
      )}

      {/* Audit & Activity Logs */}
      {onOpenLogs && (
        <div className="rounded-xl border border-white/10 bg-white/[0.02] p-4 sm:p-5 space-y-3">
          <div className="flex items-center justify-between flex-wrap gap-3">
            <div>
              <h3 className="text-sm font-semibold text-white flex items-center gap-2">
                <Activity className="h-4 w-4 text-rose-400" />
                <span>Audit & Activity Logs</span>
              </h3>
              <p className="text-xs text-slate-400 mt-0.5">
                Connection session audit logs, executed command history, and security events
              </p>
            </div>

            <button
              type="button"
              onClick={() => {
                onClose();
                onOpenLogs?.('security');
              }}
              className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-white/15 bg-white/5 hover:bg-white/10 text-xs font-medium text-white transition cursor-pointer"
            >
              <span>View Logs →</span>
            </button>
          </div>
        </div>
      )}

      {/* Storage Permissions */}
      <div className="rounded-xl border border-white/10 bg-white/[0.02] p-4 sm:p-5 space-y-3">
        <div className="flex items-center justify-between flex-wrap gap-3">
          <div>
            <h3 className="text-sm font-semibold text-white flex items-center gap-2">
              <FolderLock className="h-4 w-4 text-cyan-400" />
              <span>Shared Storage & Permissions</span>
            </h3>
            <p className="text-xs text-slate-400 mt-0.5">
              Required for SFTP downloads to device storage and file transfers
            </p>
          </div>

          {onRequestStoragePermission && (
            <button
              type="button"
              onClick={onRequestStoragePermission}
              className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-white/15 bg-white/5 hover:bg-white/10 text-xs font-medium text-white transition"
            >
              <span>{storageGranted === true ? 'Permissions Granted ✔' : 'Manage Permissions'}</span>
            </button>
          )}
        </div>
      </div>

      {/* Master Password Verification Modal for Direct Launch */}
      {showDirectUnlockModal && (
        <div
          className="fixed inset-0 z-[70] flex items-center justify-center bg-black/80 backdrop-blur-sm p-4 animate-in fade-in duration-150"
          onClick={() => !directUnlockBusy && setShowDirectUnlockModal(false)}
        >
          <div
            onClick={(e) => e.stopPropagation()}
            className="relative w-full max-w-md rounded-2xl border bg-slate-950 p-6 shadow-2xl text-slate-200 space-y-5"
            style={{
              borderColor: `${accentColor}40`,
              boxShadow: `0 20px 50px rgba(0, 0, 0, 0.8), 0 0 30px ${accentColor}15`,
            }}
          >
            <div className="flex items-start justify-between gap-3">
              <div className="flex items-center gap-3">
                <div
                  className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl border"
                  style={{
                    backgroundColor: `${accentColor}15`,
                    borderColor: `${accentColor}30`,
                    color: accentColor,
                  }}
                >
                  <KeyRound className="h-5 w-5" />
                </div>
                <div>
                  <h3 className="text-base font-semibold text-white">
                    {targetDirectUnlockState ? 'Enable Direct Launch' : 'Disable Direct Launch'}
                  </h3>
                  <p className="text-xs text-slate-400">Master password verification required</p>
                </div>
              </div>

              <button
                type="button"
                disabled={directUnlockBusy}
                onClick={() => setShowDirectUnlockModal(false)}
                className="rounded-lg p-1.5 text-slate-400 hover:bg-white/10 hover:text-white transition"
              >
                <X className="h-4 w-4" />
              </button>
            </div>

            <div className="rounded-xl border border-white/10 bg-white/[0.02] p-3 text-xs text-slate-300 leading-relaxed">
              {targetDirectUnlockState ? (
                <span>
                  You are about to enable <strong>Direct Launch</strong>. Drexius will store credentials in this
                  device&apos;s secure vault and open directly into your workspace on startup without
                  authorization.
                </span>
              ) : (
                <span>
                  Disabling <strong>Direct Launch</strong> will remove stored startup credentials from this
                  device. You will be required to enter your master password to unlock Drexius on startup.
                </span>
              )}
            </div>

            <form onSubmit={handleConfirmDirectUnlock} className="space-y-4">
              <div className="space-y-1.5">
                <label className="text-xs font-medium text-slate-300">Confirm Master Password</label>
                <div className="relative">
                  <input
                    ref={directPwInputRef}
                    type={showDirectUnlockPw ? 'text' : 'password'}
                    value={directUnlockPw}
                    onChange={(e) => setDirectUnlockPw(e.target.value)}
                    placeholder="Enter master password"
                    autoFocus
                    disabled={directUnlockBusy}
                    className="w-full rounded-xl border border-white/15 bg-black/60 px-3.5 py-2.5 pr-10 text-xs text-white placeholder:text-slate-500 focus:outline-none transition"
                    style={{
                      borderColor: directUnlockErr ? '#f43f5e' : undefined,
                    }}
                  />
                  <button
                    type="button"
                    tabIndex={-1}
                    onClick={() => setShowDirectUnlockPw((prev) => !prev)}
                    className="absolute right-2.5 top-1/2 -translate-y-1/2 p-1 text-slate-400 hover:text-slate-200 transition"
                  >
                    {showDirectUnlockPw ? <EyeOff className="h-3.5 w-3.5" /> : <Eye className="h-3.5 w-3.5" />}
                  </button>
                </div>

                {directUnlockErr && (
                  <div className="flex items-center gap-1.5 text-xs text-rose-400 pt-1">
                    <AlertTriangle className="h-3.5 w-3.5 shrink-0" />
                    <span>{directUnlockErr}</span>
                  </div>
                )}
              </div>

              <div className="flex items-center justify-end gap-2.5 pt-2">
                <button
                  type="button"
                  disabled={directUnlockBusy}
                  onClick={() => setShowDirectUnlockModal(false)}
                  className="px-4 py-2 rounded-xl border border-white/10 bg-white/5 hover:bg-white/10 text-xs font-medium text-slate-300 transition"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={directUnlockBusy || !directUnlockPw}
                  className="flex items-center gap-2 px-4 py-2 rounded-xl text-xs font-semibold transition disabled:opacity-40 disabled:cursor-not-allowed shadow-md"
                  style={{
                    backgroundColor: targetDirectUnlockState ? accentColor : '#f43f5e',
                    color: targetDirectUnlockState ? '#000000' : '#ffffff',
                  }}
                >
                  {directUnlockBusy ? (
                    <>
                      <Loader2 className="h-3.5 w-3.5 animate-spin" />
                      <span>Verifying...</span>
                    </>
                  ) : (
                    <span>{targetDirectUnlockState ? 'Verify & Enable' : 'Verify & Disable'}</span>
                  )}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}

export interface SyncSettingsTabProps {
  onClose: () => void;
  onOpenPairing?: (tab?: SettingsTab) => void;
  onOpenSync?: (tab?: SettingsTab) => void;
  onOpenTunnels?: (tab?: SettingsTab) => void;
  onOpenTailscale?: (tab?: SettingsTab) => void;
  onOpenNetbird?: (tab?: SettingsTab) => void;
  onOpenCloudSync?: (tab?: SettingsTab) => void;
  onOpenDocker?: (tab?: SettingsTab) => void;
}

export function SyncSettingsTab({
  onClose,
  onOpenPairing,
  onOpenSync,
  onOpenTunnels,
  onOpenTailscale,
  onOpenNetbird,
  onOpenCloudSync,
  onOpenDocker,
}: SyncSettingsTabProps) {
  return (
    <div className="space-y-4">
      <div className="rounded-xl border border-white/10 bg-white/[0.02] p-4 sm:p-5 space-y-4">
        <h3 className="text-sm font-semibold text-white">Synchronization & Mesh Networks</h3>
        <p className="text-xs text-slate-400">
          Connect Drexius across your phone, tablet, and desktops with zero-knowledge encryption
        </p>

        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 pt-2">
          {onOpenPairing && (
            <button
              type="button"
              onClick={() => {
                onClose();
                onOpenPairing?.('sync');
              }}
              className="flex items-center justify-between p-3.5 rounded-xl border border-white/10 bg-white/[0.02] hover:bg-white/[0.05] text-left transition"
            >
              <div className="flex items-center gap-3">
                <QrCode className="h-5 w-5 text-amber-400" />
                <div>
                  <div className="text-xs font-semibold text-white">Direct LAN Device Pairing</div>
                  <div className="text-[11px] text-slate-400">Pair via QR code or PIN</div>
                </div>
              </div>
              <ChevronRight className="h-4 w-4 text-slate-500" />
            </button>
          )}

          {onOpenSync && (
            <button
              type="button"
              onClick={() => {
                onClose();
                onOpenSync?.('sync');
              }}
              className="flex items-center justify-between p-3.5 rounded-xl border border-white/10 bg-white/[0.02] hover:bg-white/[0.05] text-left transition cursor-pointer"
            >
              <div className="flex items-center gap-3">
                <Cloud className="h-5 w-5 text-cyan-400" />
                <div>
                  <div className="text-xs font-semibold text-white">Encrypted Relay Sync</div>
                  <div className="text-[11px] text-slate-400">Self-hosted or hosted relay sync</div>
                </div>
              </div>
              <ChevronRight className="h-4 w-4 text-slate-500" />
            </button>
          )}

          {onOpenTunnels && (
            <button
              type="button"
              onClick={() => {
                onClose();
                onOpenTunnels?.('sync');
              }}
              className="flex items-center justify-between p-3.5 rounded-xl border border-white/10 bg-white/[0.02] hover:bg-white/[0.05] text-left transition cursor-pointer"
            >
              <div className="flex items-center gap-3">
                <Network className="h-5 w-5 text-amber-400" />
                <div>
                  <div className="text-xs font-semibold text-white">Port Forwarding & Tunnels</div>
                  <div className="text-[11px] text-slate-400">Local, remote, and dynamic SOCKS5 tunnels</div>
                </div>
              </div>
              <ChevronRight className="h-4 w-4 text-slate-500" />
            </button>
          )}

          {onOpenTailscale && (
            <button
              type="button"
              onClick={() => {
                onClose();
                onOpenTailscale?.('sync');
              }}
              className="flex items-center justify-between p-3.5 rounded-xl border border-white/10 bg-white/[0.02] hover:bg-white/[0.05] text-left transition"
            >
              <div className="flex items-center gap-3">
                <Network className="h-5 w-5 text-indigo-400" />
                <div>
                  <div className="text-xs font-semibold text-white">Tailscale Mesh Discovery</div>
                  <div className="text-[11px] text-slate-400">Auto-discover tailnet nodes</div>
                </div>
              </div>
              <ChevronRight className="h-4 w-4 text-slate-500" />
            </button>
          )}

          {onOpenNetbird && (
            <button
              type="button"
              onClick={() => {
                onClose();
                onOpenNetbird?.('sync');
              }}
              className="flex items-center justify-between p-3.5 rounded-xl border border-white/10 bg-white/[0.02] hover:bg-white/[0.05] text-left transition"
            >
              <div className="flex items-center gap-3">
                <Globe2 className="h-5 w-5 text-emerald-400" />
                <div>
                  <div className="text-xs font-semibold text-white">NetBird Mesh Network</div>
                  <div className="text-[11px] text-slate-400">Sync peers from NetBird</div>
                </div>
              </div>
              <ChevronRight className="h-4 w-4 text-slate-500" />
            </button>
          )}

          {onOpenCloudSync && (
            <button
              type="button"
              onClick={() => {
                onClose();
                onOpenCloudSync?.('sync');
              }}
              className="flex items-center justify-between p-3.5 rounded-xl border border-white/10 bg-white/[0.02] hover:bg-white/[0.05] text-left transition"
            >
              <div className="flex items-center gap-3">
                <Cloud className="h-5 w-5 text-sky-400" />
                <div>
                  <div className="text-xs font-semibold text-white">Cloud Fleet Sync</div>
                  <div className="text-[11px] text-slate-400">Hetzner, DigitalOcean & Proxmox</div>
                </div>
              </div>
              <ChevronRight className="h-4 w-4 text-slate-500" />
            </button>
          )}

          {onOpenDocker && (
            <button
              type="button"
              onClick={() => {
                onClose();
                onOpenDocker?.('sync');
              }}
              className="flex items-center justify-between p-3.5 rounded-xl border border-white/10 bg-white/[0.02] hover:bg-white/[0.05] text-left transition"
            >
              <div className="flex items-center gap-3">
                <Boxes className="h-5 w-5 text-cyan-400" />
                <div>
                  <div className="text-xs font-semibold text-white">Docker Containers</div>
                  <div className="text-[11px] text-slate-400">Container management & logs</div>
                </div>
              </div>
              <ChevronRight className="h-4 w-4 text-slate-500" />
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
