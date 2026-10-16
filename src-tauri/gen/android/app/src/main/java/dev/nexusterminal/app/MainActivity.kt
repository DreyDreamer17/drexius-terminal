package dev.nexusterminal.app

import android.Manifest
import android.content.Intent
import android.content.pm.PackageManager
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.os.Environment
import android.provider.Settings
import android.webkit.WebView
import androidx.activity.enableEdgeToEdge
import androidx.core.app.ActivityCompat
import androidx.core.content.ContextCompat
import androidx.core.splashscreen.SplashScreen.Companion.installSplashScreen

class MainActivity : TauriActivity() {
  companion object {
    private const val STORAGE_PERMISSION_CODE = 1001
    private const val NOTIFICATION_PERMISSION_CODE = 1002

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
  }

  private var appWebView: WebView? = null

  override fun onWebViewCreate(webView: WebView) {
    super.onWebViewCreate(webView)
    appWebView = webView
    // Prevent Android from lowering the WebView renderer process priority to WAIVED
    // when the user opens the multi-app overview (Recents), switches apps, or locks
    // the screen. Without `waivedWhenNotVisible = false`, Android's lmkd can kill or
    // freeze the WebView child process as soon as the Activity loses visibility.
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
      try {
        webView.setRendererPriorityPolicy(WebView.RENDERER_PRIORITY_IMPORTANT, false)
      } catch (_: Exception) {}
    }
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
    // WryActivity.onPause() calls mWebView.onPause(), which suspends WebView JS
    // timers and IPC callbacks when entering Recents (multi-app view) or locking
    // the screen. Immediately resume WebView processing so live terminal sessions
    // and UI state remain active.
    keepWebViewActive()
  }

  override fun onStop() {
    isActivityVisible = false
    super.onStop()
    keepWebViewActive()
    SessionForegroundService.keepAliveForBackgroundTransition(applicationContext)
  }

  override fun onDestroy() {
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
