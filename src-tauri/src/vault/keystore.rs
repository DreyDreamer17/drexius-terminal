//! OS Keychain, Android hardware Keystore JNI bridge, and device screen-lock credentials.

use super::{crypto::MIN_UNLOCK_PASSWORD_CHARS, Vault};
use crate::error::{AppError, AppResult};
use std::path::PathBuf;
use tauri::{Manager, State};
use zeroize::Zeroizing;

#[cfg(target_os = "android")]
use super::crypto::write_atomic;
#[cfg(target_os = "android")]
use chacha20poly1305::{
    aead::{Aead, KeyInit},
    XChaCha20Poly1305, XNonce,
};

/// Service name used when talking to the OS keychain (macOS Keychain, Windows
/// Credential Manager, Linux Secret Service via dbus). Grouped under the
/// DrexiusTerminal app identifier so entries are easy to audit/clean up.
const KEYCHAIN_SERVICE: &str = "dev.drexius.terminal";
/// Username under which the master password is stored. We use a fixed,
/// well-known entry so we can query "is there a stored password?" quickly.
const KEYCHAIN_USER: &str = "vault-master-password";

fn keychain_entry() -> AppResult<keyring::Entry> {
    keyring::Entry::new(KEYCHAIN_SERVICE, KEYCHAIN_USER)
        .map_err(|e| AppError::Other(format!("OS keychain unavailable: {e}")))
}

#[cfg(target_os = "android")]
fn android_keystore_encrypt(plaintext: &[u8]) -> AppResult<Vec<u8>> {
    let ctx = ndk_context::android_context();
    if ctx.vm().is_null() || ctx.context().is_null() {
        return Err(AppError::Other("Android context unavailable".into()));
    }
    let vm = unsafe { jni::JavaVM::from_raw(ctx.vm() as *mut jni::sys::JavaVM) }
        .map_err(|e| AppError::Other(format!("JavaVM error: {e}")))?;
    let mut env = vm.attach_current_thread()
        .map_err(|e| AppError::Other(format!("JNI attach error: {e}")))?;
    let app_ctx = std::mem::ManuallyDrop::new(unsafe {
        jni::objects::JObject::from_raw(ctx.context() as jni::sys::jobject)
    });
    let cls = crate::ssh::load_android_app_class(
        &mut env,
        &*app_ctx,
        "dev.drexius.terminal.MainActivity",
    ).ok_or_else(|| AppError::Other("Failed to load MainActivity class".into()))?;

    let j_bytes = env.byte_array_from_slice(plaintext)
        .map_err(|e| AppError::Other(format!("JNI byte array error: {e}")))?;

    let res = env.call_static_method(
        &cls,
        "keystoreEncrypt",
        "([B)[B",
        &[(&j_bytes).into()],
    ).map_err(|e| AppError::Other(format!("Keystore encrypt JNI call failed: {e}")))?;

    if env.exception_check().unwrap_or(false) {
        let _ = env.exception_clear();
        return Err(AppError::Other("Android Keystore encryption threw an exception".into()));
    }

    let res_obj = res.l().map_err(|e| AppError::Other(format!("JNI object error: {e}")))?;
    if res_obj.as_raw().is_null() {
        return Err(AppError::Other("Android Keystore encryption returned null".into()));
    }
    let res_arr = unsafe { jni::objects::JByteArray::from_raw(res_obj.into_raw()) };
    let out = env.convert_byte_array(&res_arr)
        .map_err(|e| AppError::Other(format!("JNI convert byte array error: {e}")))?;
    Ok(out)
}

#[cfg(target_os = "android")]
fn android_keystore_decrypt(payload: &[u8]) -> AppResult<Vec<u8>> {
    let ctx = ndk_context::android_context();
    if ctx.vm().is_null() || ctx.context().is_null() {
        return Err(AppError::Other("Android context unavailable".into()));
    }
    let vm = unsafe { jni::JavaVM::from_raw(ctx.vm() as *mut jni::sys::JavaVM) }
        .map_err(|e| AppError::Other(format!("JavaVM error: {e}")))?;
    let mut env = vm.attach_current_thread()
        .map_err(|e| AppError::Other(format!("JNI attach error: {e}")))?;
    let app_ctx = std::mem::ManuallyDrop::new(unsafe {
        jni::objects::JObject::from_raw(ctx.context() as jni::sys::jobject)
    });
    let cls = crate::ssh::load_android_app_class(
        &mut env,
        &*app_ctx,
        "dev.drexius.terminal.MainActivity",
    ).ok_or_else(|| AppError::Other("Failed to load MainActivity class".into()))?;

    let j_bytes = env.byte_array_from_slice(payload)
        .map_err(|e| AppError::Other(format!("JNI byte array error: {e}")))?;

    let res = env.call_static_method(
        &cls,
        "keystoreDecrypt",
        "([B)[B",
        &[(&j_bytes).into()],
    ).map_err(|e| AppError::Other(format!("Keystore decrypt JNI call failed: {e}")))?;

    if env.exception_check().unwrap_or(false) {
        let _ = env.exception_clear();
        return Err(AppError::Other("Android Keystore decryption threw an exception (biometric authentication required or expired)".into()));
    }

    let res_obj = res.l().map_err(|e| AppError::Other(format!("JNI object error: {e}")))?;
    if res_obj.as_raw().is_null() {
        return Err(AppError::Other("Android Keystore decryption failed. Confirm your screen lock or biometrics.".into()));
    }
    let res_arr = unsafe { jni::objects::JByteArray::from_raw(res_obj.into_raw()) };
    let out = env.convert_byte_array(&res_arr)
        .map_err(|e| AppError::Other(format!("JNI convert byte array error: {e}")))?;
    Ok(out)
}

#[cfg(target_os = "android")]
fn android_keystore_delete() -> AppResult<()> {
    let ctx = ndk_context::android_context();
    if !ctx.vm().is_null() && !ctx.context().is_null() {
        if let Ok(vm) = unsafe { jni::JavaVM::from_raw(ctx.vm() as *mut jni::sys::JavaVM) } {
            if let Ok(mut env) = vm.attach_current_thread() {
                let app_ctx = std::mem::ManuallyDrop::new(unsafe {
                    jni::objects::JObject::from_raw(ctx.context() as jni::sys::jobject)
                });
                if let Some(cls) = crate::ssh::load_android_app_class(
                    &mut env,
                    &*app_ctx,
                    "dev.drexius.terminal.MainActivity",
                ) {
                    let _ = env.call_static_method(&cls, "keystoreDelete", "()Z", &[]);
                    if env.exception_check().unwrap_or(false) {
                        let _ = env.exception_clear();
                    }
                }
            }
        }
    }
    Ok(())
}

impl Vault {
    /// Machine-isolated credential path for device screen lock & biometrics fallback.
    pub fn device_lock_path(&self) -> PathBuf {
        self.path.with_extension("device_lock")
    }

    #[cfg(target_os = "android")]
    fn legacy_device_lock_key(&self) -> AppResult<[u8; 32]> {
        let salt = std::fs::read(self.salt_path()).unwrap_or_else(|_| b"drexius-terminal-default-salt".to_vec());
        let mut ikm = Vec::new();
        ikm.extend_from_slice(b"drexius-device-lock-master-v1-");
        ikm.extend_from_slice(&salt);
        ikm.extend_from_slice(b"-android-sandbox-uid");

        let hk = hkdf::Hkdf::<sha2::Sha256>::new(Some(b"drx-device-lock-salt-2025"), &ikm);
        let mut okm = [0u8; 32];
        hk.expand(b"drx-device-lock-encryption-key", &mut okm)
            .map_err(|e| AppError::Crypto(e.to_string()))?;
        Ok(okm)
    }

    #[cfg(target_os = "android")]
    pub fn save_device_lock(&self, master_password: &str) -> AppResult<()> {
        let encrypted = android_keystore_encrypt(master_password.as_bytes())?;
        let mut payload = b"DRX_KS_V1".to_vec();
        payload.extend_from_slice(&encrypted);
        let path = self.device_lock_path();
        write_atomic(&path, &payload)?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let _ = std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o600));
        }
        Ok(())
    }

    #[cfg(target_os = "android")]
    pub fn load_device_lock(&self) -> AppResult<Zeroizing<String>> {
        let path = self.device_lock_path();
        if !path.exists() {
            return Err(AppError::Other("No device lock credential found on this device".into()));
        }
        let payload = std::fs::read(&path)?;
        if payload.starts_with(b"DRX_KS_V1") {
            let ks_payload = &payload[9..];
            let plaintext = android_keystore_decrypt(ks_payload)?;
            let pw_str = String::from_utf8(plaintext)
                .map_err(|_| AppError::Other("Invalid device credential encoding".into()))?;
            return Ok(Zeroizing::new(pw_str));
        }

        // Backward compatibility: decrypt legacy software HKDF payload and upgrade to Android Keystore
        if payload.len() <= 24 {
            return Err(AppError::Other("Corrupt device credential payload".into()));
        }
        let (nonce_bytes, ciphertext) = payload.split_at(24);
        let nonce = XNonce::from_slice(nonce_bytes);
        let key_bytes = self.legacy_device_lock_key()?;
        let cipher = XChaCha20Poly1305::new((&key_bytes).into());
        let plaintext = cipher
            .decrypt(nonce, ciphertext)
            .map_err(|e| AppError::Crypto(format!("Failed to decrypt legacy device credential: {e}")))?;
        let pw_str = String::from_utf8(plaintext)
            .map_err(|_| AppError::Other("Invalid device credential encoding".into()))?;

        // Re-encrypt immediately into Android Keystore so future unlocks use hardware protection
        let _ = self.save_device_lock(&pw_str);

        Ok(Zeroizing::new(pw_str))
    }

    pub fn delete_device_lock(&self) -> AppResult<()> {
        #[cfg(target_os = "android")]
        {
            let _ = android_keystore_delete();
        }
        let path = self.device_lock_path();
        if path.exists() {
            let _ = std::fs::remove_file(path);
        }
        Ok(())
    }

    pub fn clear_saved_credentials(&self) {
        if let Ok(entry) = keychain_entry() {
            let _ = entry.delete_credential();
        }
        let _ = self.delete_device_lock();
    }
}

// ── OS Keychain & Device Screen Lock integration ──
//
// Stores the master password in the user's OS-provided credential store
// (macOS Keychain, Windows Credential Manager, Linux Secret Service) or,
// on Android and headless systems, in an AES/ChaCha encrypted file bound to the
// app's private sandbox UID so that subsequent unlocks can happen via biometrics
// (Fingerprint, Touch ID, Face ID, Android screen lock) without retyping.

#[tauri::command]
pub async fn os_keychain_unlock(app: tauri::AppHandle) -> AppResult<Option<String>> {
    tauri::async_runtime::spawn_blocking(move || {
        let vault = app.state::<Vault>();

        #[cfg(target_os = "android")]
        {
            let pw = vault.load_device_lock().map_err(|e| {
                AppError::Other(format!("No master password stored for quick unlock: {e}"))
            })?;
            return vault.unlock(&pw);
        }

        #[cfg(not(target_os = "android"))]
        {
            // Desktop exclusively uses the OS Keychain (macOS Keychain, Windows Credential Manager, Linux Secret Service).
            // Fail closed: if the OS keychain is unavailable, do not fall back to an unbonded disk file.
            let pw = keychain_entry().and_then(|entry| {
                entry.get_password().map_err(|e| match e {
                    keyring::Error::NoEntry => AppError::Other("No master password stored in OS keychain".into()),
                    keyring::Error::NoStorageAccess(msg) => AppError::Other(format!("OS keychain unavailable: {msg}")),
                    keyring::Error::PlatformFailure(msg) => AppError::Other(format!("Biometric prompt failed: {msg}")),
                    other => AppError::Other(format!("OS keychain denied access: {other}")),
                })
            })?;

            vault.unlock(&Zeroizing::new(pw))
        }
    })
    .await
    .map_err(|e| AppError::Other(e.to_string()))?
}

#[tauri::command]
pub fn os_keychain_store(master_password: String, vault: State<'_, Vault>) -> AppResult<()> {
    if !vault.is_unlocked() {
        return Err(AppError::VaultLocked);
    }
    // This stores a password that already exists (it is the one that unlocked
    // the vault), so the permissive floor applies — not the new-password policy.
    if master_password.chars().count() < MIN_UNLOCK_PASSWORD_CHARS {
        return Err(AppError::Other(format!(
            "Master password must be at least {MIN_UNLOCK_PASSWORD_CHARS} characters"
        )));
    }
    let pw = Zeroizing::new(master_password);

    #[cfg(target_os = "android")]
    {
        vault.save_device_lock(&pw)?;
        return Ok(());
    }

    #[cfg(not(target_os = "android"))]
    {
        // Desktop exclusively stores the master password in the OS Keychain
        // (macOS Keychain, Windows Credential Manager, Linux Secret Service).
        let entry = keychain_entry().map_err(|e| AppError::Other(format!("Failed to access OS keychain: {e}")))?;
        entry
            .set_password(&pw)
            .map_err(|e| AppError::Other(format!("Failed to store in OS keychain: {e}")))?;
        // Clean up any legacy software fallback on desktop
        let _ = vault.delete_device_lock();
        Ok(())
    }
}

/// "Is there a stored quick-unlock credential on this device?"
///
/// On Android, the sandboxed private UID storage is checked.
/// On desktop, the OS keyring is checked when probed.
#[tauri::command]
pub fn os_keychain_status(vault: State<'_, Vault>, probe_keyring: Option<bool>) -> bool {
    #[cfg(target_os = "android")]
    {
        let _ = probe_keyring;
        vault.device_lock_path().exists()
    }
    #[cfg(not(target_os = "android"))]
    {
        let _ = vault;
        probe_keyring.unwrap_or(false)
            && keychain_entry()
                .and_then(|e| e.get_password().map_err(|e| AppError::Other(e.to_string())))
                .is_ok()
    }
}

#[tauri::command]
pub fn os_keychain_delete(vault: State<'_, Vault>) -> AppResult<()> {
    #[cfg(not(target_os = "android"))]
    if let Ok(entry) = keychain_entry() {
        let _ = entry.delete_credential();
    }
    let _ = vault.delete_device_lock();
    Ok(())
}

#[tauri::command]
pub fn check_storage_permission() -> AppResult<bool> {
    #[cfg(target_os = "android")]
    {
        let ctx = ndk_context::android_context();
        if !ctx.vm().is_null() && !ctx.context().is_null() {
            if let Ok(vm) = unsafe { jni::JavaVM::from_raw(ctx.vm() as *mut jni::sys::JavaVM) } {
                if let Ok(mut env) = vm.attach_current_thread() {
                    let app_ctx = std::mem::ManuallyDrop::new(unsafe {
                        jni::objects::JObject::from_raw(ctx.context() as jni::sys::jobject)
                    });
                    if let Some(cls) = crate::ssh::load_android_app_class(
                        &mut env,
                        &*app_ctx,
                        "dev.drexius.terminal.MainActivity",
                    ) {
                        if let Ok(val) = env.call_static_method(
                            &cls,
                            "isStoragePermissionGranted",
                            "()Z",
                            &[],
                        ) {
                            if let Ok(b) = val.z() {
                                return Ok(b);
                            }
                        }
                    }
                    if env.exception_check().unwrap_or(false) {
                        let _ = env.exception_clear();
                    }
                }
            }
        }
        return Ok(false);
    }
    #[cfg(not(target_os = "android"))]
    {
        Ok(true)
    }
}

#[tauri::command]
pub fn request_storage_permission() -> AppResult<bool> {
    #[cfg(target_os = "android")]
    {
        let ctx = ndk_context::android_context();
        if !ctx.vm().is_null() && !ctx.context().is_null() {
            if let Ok(vm) = unsafe { jni::JavaVM::from_raw(ctx.vm() as *mut jni::sys::JavaVM) } {
                if let Ok(mut env) = vm.attach_current_thread() {
                    let app_ctx = std::mem::ManuallyDrop::new(unsafe {
                        jni::objects::JObject::from_raw(ctx.context() as jni::sys::jobject)
                    });
                    if let Some(cls) = crate::ssh::load_android_app_class(
                        &mut env,
                        &*app_ctx,
                        "dev.drexius.terminal.MainActivity",
                    ) {
                        let _ = env.call_static_method(
                            &cls,
                            "requestStoragePermissionsStatic",
                            "()V",
                            &[],
                        );
                    }
                    if env.exception_check().unwrap_or(false) {
                        let _ = env.exception_clear();
                    }
                    return Ok(true);
                }
            }
        }
    }
    Ok(true)
}
