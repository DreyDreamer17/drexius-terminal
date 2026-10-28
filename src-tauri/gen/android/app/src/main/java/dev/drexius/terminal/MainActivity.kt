package dev.drexius.terminal

import android.Manifest
import android.content.Context
import android.content.ContextWrapper
import android.content.Intent
import android.content.pm.PackageManager
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.os.Environment
import android.os.Handler
import android.os.Looper
import android.os.Process
import android.os.SystemClock
import android.provider.Settings
import android.util.Log
import android.view.View
import android.view.ViewGroup
import android.webkit.WebView
import androidx.activity.enableEdgeToEdge
import androidx.core.app.ActivityCompat
import androidx.core.content.ContextCompat
import androidx.core.splashscreen.SplashScreen.Companion.installSplashScreen
import androidx.lifecycle.Lifecycle
import java.security.KeyStore
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.spec.GCMParameterSpec
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import android.security.keystore.UserNotAuthenticatedException

class MainActivity : TauriActivity() {
  companion object {
    private const val STORAGE_PERMISSION_CODE = 1001
    private const val NOTIFICATION_PERMISSION_CODE = 1002
    private const val KEYSTORE_ALIAS = "dev.drexius.terminal.vault_quick_unlock"
    private const val ANDROID_KEYSTORE = "AndroidKeyStore"
    private const val GCM_IV_LENGTH = 12
    private const val GCM_TAG_LENGTH_BITS = 128

    @JvmStatic
    fun keystoreEncrypt(plaintext: ByteArray): ByteArray? {
      return try {
        val keyStore = KeyStore.getInstance(ANDROID_KEYSTORE).apply { load(null) }
        if (!keyStore.containsAlias(KEYSTORE_ALIAS)) {
          val keyGenerator = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, ANDROID_KEYSTORE)
          val builder = KeyGenParameterSpec.Builder(
            KEYSTORE_ALIAS,
            KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT
          )
            .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
            .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
            .setKeySize(256)
            .setRandomizedEncryptionRequired(true)

          try {
            // First attempt to enforce user authentication on the hardware key
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
              builder.setUserAuthenticationParameters(
                60,
                KeyProperties.AUTH_BIOMETRIC_STRONG or KeyProperties.AUTH_DEVICE_CREDENTIAL
              )
            } else {
              @Suppress("DEPRECATION")
              builder.setUserAuthenticationValidityDurationSeconds(60)
            }
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.N) {
              builder.setInvalidatedByBiometricEnrollment(true)
            }
            keyGenerator.init(builder.build())
            keyGenerator.generateKey()
          } catch (authReqEx: Exception) {
            // If device has no screen lock/biometrics configured, fall back to standard hardware Keystore
            Log.w("DrexiusKeystore", "Device lock not enrolled; generating hardware key without auth requirement: ${authReqEx.message}")
            val fallbackBuilder = KeyGenParameterSpec.Builder(
              KEYSTORE_ALIAS,
              KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT
            )
              .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
              .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
              .setKeySize(256)
              .setRandomizedEncryptionRequired(true)
            keyGenerator.init(fallbackBuilder.build())
            keyGenerator.generateKey()
          }
        }

        val secretKey = keyStore.getKey(KEYSTORE_ALIAS, null) ?: return null
        val cipher = Cipher.getInstance("AES/GCM/NoPadding")
        cipher.init(Cipher.ENCRYPT_MODE, secretKey)
        val iv = cipher.iv ?: return null
        val ciphertext = cipher.doFinal(plaintext)
        val payload = ByteArray(iv.size + ciphertext.size)
        System.arraycopy(iv, 0, payload, 0, iv.size)
        System.arraycopy(ciphertext, 0, payload, iv.size, ciphertext.size)
        payload
      } catch (e: Exception) {
        Log.e("DrexiusKeystore", "Failed to encrypt with Android Keystore: ${e.message}", e)
        null
      }
    }

    @JvmStatic
    fun keystoreDecrypt(payload: ByteArray): ByteArray? {
      return try {
        if (payload.size <= GCM_IV_LENGTH) {
          Log.e("DrexiusKeystore", "Invalid payload length: ${payload.size}")
          return null
        }
        val keyStore = KeyStore.getInstance(ANDROID_KEYSTORE).apply { load(null) }
        val secretKey = keyStore.getKey(KEYSTORE_ALIAS, null)
        if (secretKey == null) {
          Log.e("DrexiusKeystore", "Keystore alias $KEYSTORE_ALIAS not found")
          return null
        }
        val iv = ByteArray(GCM_IV_LENGTH)
        val ciphertext = ByteArray(payload.size - GCM_IV_LENGTH)
        System.arraycopy(payload, 0, iv, 0, GCM_IV_LENGTH)
        System.arraycopy(payload, GCM_IV_LENGTH, ciphertext, 0, ciphertext.size)

        val cipher = Cipher.getInstance("AES/GCM/NoPadding")
        val spec = GCMParameterSpec(GCM_TAG_LENGTH_BITS, iv)
        cipher.init(Cipher.DECRYPT_MODE, secretKey, spec)
        cipher.doFinal(ciphertext)
      } catch (e: UserNotAuthenticatedException) {
        Log.w("DrexiusKeystore", "Keystore decrypt requires user authentication: ${e.message}")
        null
      } catch (e: Exception) {
        Log.e("DrexiusKeystore", "Failed to decrypt with Android Keystore: ${e.message}", e)
        null
      }
    }

    @JvmStatic
    fun keystoreDelete(): Boolean {
      return try {
        val keyStore = KeyStore.getInstance(ANDROID_KEYSTORE).apply { load(null) }
        if (keyStore.containsAlias(KEYSTORE_ALIAS)) {
          keyStore.deleteEntry(KEYSTORE_ALIAS)
        }
        true
      } catch (e: Exception) {
        Log.e("DrexiusKeystore", "Failed to delete from Android Keystore: ${e.message}", e)
        false
      }
    }

    @Volatile
    var isActivityVisible: Boolean = false

    @JvmStatic
    var instance: MainActivity? = null

    @JvmStatic
    fun requestStoragePermissionsStatic() {
      instance?.runOnUiThread {
        instance?.promptStoragePermissions(force = true)
      }
    }

    @JvmStatic
    fun isStoragePermissionGranted(): Boolean {
      val ctx = instance ?: return false
      return ctx.isStorageGranted()
    }

    @JvmStatic
    fun updateActiveSessionsStatic(count: Int) {
      val ctx = instance?.applicationContext ?: return
      SessionForegroundService.updateActiveSessions(ctx, count)
    }

    private const val RENDERER_LOG_TAG = "DrexiusRenderer"
    private const val RENDERER_CRASH_LOOP_WINDOW_MS = 30_000L

    @Volatile
    private var lastRendererCrashAtMs = 0L

    @Volatile
    private var rendererRecoveryInProgress = false

    @Volatile
    private var rendererRecoveryPending = false

    /**
     * Called from Wry's generated RustWebViewClient (see
     * WRY_RUSTWEBVIEWCLIENT_CLASS_EXTENSION in the repository-root
     * .cargo/config.toml).
     *
     * Returning true tells Android that we handled the renderer exit.
     * Without this claim, Android kills this whole process—including the
     * Rust SSH sessions and foreground service—whenever the separate
     * WebView renderer process is reclaimed under memory pressure.
     */
    @JvmStatic
    fun handleRendererProcessGone(
      webView: WebView,
      didCrash: Boolean,
      rendererPriorityAtExit: Int,
    ): Boolean {
      Log.w(
        RENDERER_LOG_TAG,
        "Renderer gone: pid=${Process.myPid()}, didCrash=$didCrash, " +
          "rendererPriorityAtExit=$rendererPriorityAtExit; claiming it",
      )

      val activity = findMainActivity(webView.context) ?: instance
      if (activity != null && !activity.isFinishing && !activity.isDestroyed) {
        return activity.recoverFromRendererGone(webView, didCrash)
      }

      // Even if there is no usable Activity to recreate, claim the death and
      // discard the dead view. Returning false here would make Android kill
      // the process that this handler exists to preserve.
      Log.w(RENDERER_LOG_TAG, "No active MainActivity available for renderer recovery")
      destroyDeadWebView(webView)
      return true
    }

    private fun findMainActivity(context: Context): MainActivity? {
      var current: Context? = context
      while (current is ContextWrapper) {
        if (current is MainActivity) return current
        val base = current.baseContext
        if (base === current) break
        current = base
      }
      return current as? MainActivity
    }

    private fun destroyDeadWebView(webView: WebView) {
      try {
        (webView.parent as? ViewGroup)?.removeView(webView)
      } catch (_: Exception) {}
      try {
        webView.destroy()
      } catch (_: Exception) {}
    }
  }

  private var appWebView: WebView? = null

  override fun onWebViewCreate(webView: WebView) {
    super.onWebViewCreate(webView)
    appWebView = webView
    rendererRecoveryInProgress = false
    rendererRecoveryPending = false
    Log.i(RENDERER_LOG_TAG, "WebView created: pid=${Process.myPid()}")
    // Prevent Android from lowering the WebView renderer process priority to WAIVED
    // when the user opens the multi-app overview (Recents), switches apps, or locks
    // the screen. Without `waivedWhenNotVisible = false`, Android's lmkd can kill or
    // freeze the WebView child process as soon as the Activity loses visibility.
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
      try {
        webView.setRendererPriorityPolicy(WebView.RENDERER_PRIORITY_IMPORTANT, false)
      } catch (_: Exception) {}
    }

    // Disable Android WebView native scrollbars so they don't flash during CSS animations
    webView.isVerticalScrollBarEnabled = false
    webView.isHorizontalScrollBarEnabled = false
    webView.overScrollMode = View.OVER_SCROLL_NEVER
  }

  private fun recoverFromRendererGone(webView: WebView, didCrash: Boolean): Boolean {
    if (appWebView === webView) {
      // Do not let lifecycle hooks call onResume()/resumeTimers() on a
      // WebView whose renderer is already gone.
      appWebView = null
    }

    if (rendererRecoveryInProgress || rendererRecoveryPending) {
      destroyDeadWebView(webView)
      return true
    }

    if (didCrash) {
      val now = SystemClock.elapsedRealtime()
      val previousCrashAt = lastRendererCrashAtMs
      if (previousCrashAt != 0L && now - previousCrashAt < RENDERER_CRASH_LOOP_WINDOW_MS) {
        // A renderer that crashes again immediately after recovery is
        // likely hitting the same page/content fault. Let Android apply
        // its default crash behaviour instead of recreating forever.
        // System low-memory kills report didCrash=false and always take
        // the recovery path below.
        Log.e(RENDERER_LOG_TAG, "Renderer crashed again within ${now - previousCrashAt}ms; not claiming it")
        return false
      }
      lastRendererCrashAtMs = now
    }

    destroyDeadWebView(webView)

    if (!lifecycle.currentState.isAtLeast(Lifecycle.State.STARTED)) {
      // The usual low-memory path: Home/app-switching has already stopped
      // the Activity. Claim the renderer now, but do not build another
      // memory-heavy WebView in the background for lmkd to reclaim again.
      // onStart() recreates the Activity when the user actually returns;
      // until then only the Rust process/FGS need to stay resident.
      rendererRecoveryPending = true
      Log.i(RENDERER_LOG_TAG, "Activity is stopped; postponing WebView recovery until return")
      return true
    }

    rendererRecoveryInProgress = true

    // Activity.recreate() uses Android's configuration-change relaunch
    // path, which Tao/Wry explicitly preserve: the Rust process and its
    // state stay alive, while a new Activity/WebView is created for the
    // existing Tauri window. The recreated frontend can then reattach
    // to Rust-owned SSH sessions.
    Handler(Looper.getMainLooper()).post {
      if (!isFinishing && !isDestroyed) {
        try {
          Log.i(RENDERER_LOG_TAG, "Recreating Activity in pid=${Process.myPid()}")
          recreate()
        } catch (e: Exception) {
          rendererRecoveryInProgress = false
          Log.e(RENDERER_LOG_TAG, "Activity recreate after renderer loss failed", e)
        }
      } else {
        rendererRecoveryInProgress = false
      }
    }
    return true
  }

  override fun onCreate(savedInstanceState: Bundle?) {
    installSplashScreen()
    enableEdgeToEdge()
    super.onCreate(savedInstanceState)
    instance = this
    isActivityVisible = true
    promptNotificationPermissionIfNeeded()
    if (SessionForegroundService.getActiveSessionCount() > 0) {
      SessionForegroundService.startAndBind(applicationContext, SessionForegroundService.getActiveSessionCount())
    }
  }

  override fun onStart() {
    super.onStart()
    if (rendererRecoveryPending) {
      rendererRecoveryPending = false
      rendererRecoveryInProgress = true
      isActivityVisible = false
      try {
        Log.i(RENDERER_LOG_TAG, "Returning to foreground; recreating Activity in pid=${Process.myPid()}")
        recreate()
      } catch (e: Exception) {
        rendererRecoveryInProgress = false
        rendererRecoveryPending = true
        Log.e(RENDERER_LOG_TAG, "Deferred Activity recreate after renderer loss failed", e)
      }
      return
    }
    isActivityVisible = true
    keepWebViewActive()
  }

  override fun onResume() {
    super.onResume()
    isActivityVisible = true
    keepWebViewActive()
    SessionForegroundService.onActivityResumed(applicationContext)
  }

  override fun onPause() {
    super.onPause()
    // WryActivity.onPause() pauses the WebView. Let that parked state stand
    // while Drexius is not interactive: SSH I/O and scrollback are owned by
    // Rust, so the invisible terminal does not need the WebView resumed.
    // onResume() will unpark the same WebView if its renderer survived.
  }

  override fun onStop() {
    isActivityVisible = false
    super.onStop()
    // Keep the WebView parked while stopped; onStart()/onResume() resume it.
    SessionForegroundService.keepAliveForBackgroundTransition(applicationContext)
  }

  override fun onDestroy() {
    if (!isChangingConfigurations) {
      // A configuration-change destroy is part of renderer recovery and is
      // followed by a new Activity/WebView. Any other destroy means this
      // Activity instance will not perform a deferred recovery.
      rendererRecoveryPending = false
      rendererRecoveryInProgress = false
    }
    appWebView = null
    super.onDestroy()
    if (instance == this) {
      instance = null
    }
  }

  fun keepWebViewActive() {
    try {
      appWebView?.onResume()
      appWebView?.resumeTimers()
    } catch (_: Exception) {}
  }

  fun updateActiveSessions(count: Int) {
    SessionForegroundService.updateActiveSessions(applicationContext, count)
  }

  private fun promptNotificationPermissionIfNeeded() {
    if (Build.VERSION.SDK_INT >= 33) {
      try {
        if (ContextCompat.checkSelfPermission(this, Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED) {
          ActivityCompat.requestPermissions(
            this,
            arrayOf(Manifest.permission.POST_NOTIFICATIONS),
            NOTIFICATION_PERMISSION_CODE
          )
        }
      } catch (_: Exception) {}
    }
  }

  fun requestStoragePermissions() {
    runOnUiThread {
      promptStoragePermissions(force = true)
    }
  }

  fun isStorageGranted(): Boolean {
    return if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
      Environment.isExternalStorageManager()
    } else {
      ContextCompat.checkSelfPermission(this, Manifest.permission.READ_EXTERNAL_STORAGE) == PackageManager.PERMISSION_GRANTED
    }
  }

  fun promptStoragePermissions(force: Boolean = false) {
    if (!force) return
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
      if (!Environment.isExternalStorageManager()) {
        try {
          val intent = Intent(Settings.ACTION_MANAGE_APP_ALL_FILES_ACCESS_PERMISSION).apply {
            data = Uri.parse("package:$packageName")
            addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
          }
          startActivity(intent)
        } catch (_: Exception) {
          try {
            val intent = Intent(Settings.ACTION_MANAGE_ALL_FILES_ACCESS_PERMISSION).apply {
              addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
            }
            startActivity(intent)
          } catch (_: Exception) {
            openAppDetailsSettings()
          }
        }
      }
    } else {
      val perms = mutableListOf<String>()
      if (ContextCompat.checkSelfPermission(this, Manifest.permission.READ_EXTERNAL_STORAGE) != PackageManager.PERMISSION_GRANTED) {
        perms.add(Manifest.permission.READ_EXTERNAL_STORAGE)
      }
      if (ContextCompat.checkSelfPermission(this, Manifest.permission.WRITE_EXTERNAL_STORAGE) != PackageManager.PERMISSION_GRANTED) {
        perms.add(Manifest.permission.WRITE_EXTERNAL_STORAGE)
      }
      if (perms.isNotEmpty()) {
        ActivityCompat.requestPermissions(this, perms.toTypedArray(), STORAGE_PERMISSION_CODE)
      }
    }
  }

  fun openAppDetailsSettings() {
    try {
      val intent = Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS).apply {
        data = Uri.parse("package:$packageName")
        addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
      }
      startActivity(intent)
    } catch (_: Exception) {}
  }
}
