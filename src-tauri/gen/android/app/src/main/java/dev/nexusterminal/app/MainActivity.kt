package dev.nexusterminal.app

import android.Manifest
import android.content.Intent
import android.content.pm.PackageManager
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.os.Environment
import android.provider.Settings
import androidx.activity.enableEdgeToEdge
import androidx.core.app.ActivityCompat
import androidx.core.content.ContextCompat
import androidx.core.splashscreen.SplashScreen.Companion.installSplashScreen

class MainActivity : TauriActivity() {
  companion object {
    private const val STORAGE_PERMISSION_CODE = 1001

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
  }

  override fun onCreate(savedInstanceState: Bundle?) {
    installSplashScreen()
    enableEdgeToEdge()
    super.onCreate(savedInstanceState)
    instance = this
    // Check and prompt on app launch/setup if storage permission has not been granted yet
    promptStoragePermissions(force = false)
  }

  override fun onDestroy() {
    super.onDestroy()
    if (instance == this) {
      instance = null
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
