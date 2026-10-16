package dev.nexusterminal.app

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.content.ServiceConnection
import android.content.pm.ServiceInfo
import android.net.wifi.WifiManager
import android.os.Binder
import android.os.Build
import android.os.Handler
import android.os.IBinder
import android.os.Looper
import android.os.PowerManager
import androidx.core.app.NotificationCompat
import androidx.core.content.ContextCompat
import java.util.concurrent.atomic.AtomicBoolean
import java.util.concurrent.atomic.AtomicInteger

/**
 * Keeps active SSH, SFTP, Local PTY, and Port-Forwarding sessions alive on Android
 * when the screen is locked, the multi-app overview (Recents) is opened, or the user
 * switches to another app (matching Termius / ConnectBot / Termux behaviour).
 *
 * Combines:
 *  1. Foreground Service (`startForegroundService` + `startForeground` with `START_STICKY`)
 *  2. Bound Service (`bindService` with `BIND_AUTO_CREATE | BIND_IMPORTANT`)
 *  3. CPU WakeLock (`PowerManager.PARTIAL_WAKE_LOCK`)
 *  4. Wi-Fi Lock (`WifiManager.WIFI_MODE_FULL_LOW_LATENCY` / `WIFI_MODE_FULL_HIGH_PERF`)
 */
class SessionForegroundService : Service() {
  inner class LocalBinder : Binder() {
    fun getService(): SessionForegroundService = this@SessionForegroundService
  }

  private val binder = LocalBinder()

  companion object {
    const val CHANNEL_ID = "nexus_active_sessions"
    const val NOTIFICATION_ID = 48201
    const val EXTRA_SESSION_COUNT = "extra_session_count"
    const val ACTION_STOP = "dev.nexusterminal.app.STOP_SESSION_SERVICE"
    private const val BACKGROUND_STOP_GRACE_MS = 120_000L
    private const val FOREGROUND_STOP_DEBOUNCE_MS = 3_000L

    private val lockMonitor = Any()
    private var wakeLock: PowerManager.WakeLock? = null
    private var wifiLock: WifiManager.WifiLock? = null

    private val activeSessionCount = AtomicInteger(0)
    private val serviceBound = AtomicBoolean(false)
    private val mainHandler = Handler(Looper.getMainLooper())
    private var pendingStopRunnable: Runnable? = null

    private val serviceConnection = object : ServiceConnection {
      override fun onServiceConnected(name: ComponentName?, service: IBinder?) {
        serviceBound.set(true)
      }

      override fun onServiceDisconnected(name: ComponentName?) {
        serviceBound.set(false)
      }
    }

    @JvmStatic
    fun getActiveSessionCount(): Int = activeSessionCount.get()

    /**
     * Entrypoint invoked directly from Rust via JNI using `ndk_context`'s Application
     * `Context` (`context.getClassLoader().loadClass("dev.nexusterminal.app.SessionForegroundService")`).
     */
    @JvmStatic
    fun updateActiveSessions(context: Context, count: Int) {
      val normalized = count.coerceAtLeast(0)
      activeSessionCount.set(normalized)
      val appCtx = context.applicationContext ?: context

      if (normalized > 0) {
        // Acquire WakeLock + WifiLock synchronously on the calling thread so the CPU
        // and Wi-Fi radio are protected immediately before any main-thread hop.
        acquireLocks(appCtx)
        mainHandler.post {
          pendingStopRunnable?.let { mainHandler.removeCallbacks(it) }
          pendingStopRunnable = null
          startAndBind(appCtx, normalized)
          MainActivity.instance?.keepWebViewActive()
        }
      } else {
        mainHandler.post {
          pendingStopRunnable?.let { mainHandler.removeCallbacks(it) }
          pendingStopRunnable = null
          val delay = if (MainActivity.isActivityVisible) {
            FOREGROUND_STOP_DEBOUNCE_MS
          } else {
            // Keep ForegroundService + locks alive during the background auto-resume window.
            BACKGROUND_STOP_GRACE_MS
          }
          val runnable = Runnable {
            pendingStopRunnable = null
            if (activeSessionCount.get() <= 0) {
              stopAndUnbindNow(appCtx)
            }
          }
          pendingStopRunnable = runnable
          mainHandler.postDelayed(runnable, delay)
        }
      }
    }

    @JvmStatic
    fun keepAliveForBackgroundTransition(context: Context) {
      val appCtx = context.applicationContext ?: context
      acquireLocks(appCtx)
      mainHandler.post {
        pendingStopRunnable?.let { mainHandler.removeCallbacks(it) }
        pendingStopRunnable = null
        val count = activeSessionCount.get()
        startAndBind(appCtx, count.coerceAtLeast(1))
        if (count <= 0) {
          val runnable = Runnable {
            pendingStopRunnable = null
            if (activeSessionCount.get() <= 0 && !MainActivity.isActivityVisible) {
              stopAndUnbindNow(appCtx)
            }
          }
          pendingStopRunnable = runnable
          mainHandler.postDelayed(runnable, BACKGROUND_STOP_GRACE_MS)
        }
      }
    }

    @JvmStatic
    fun onActivityResumed(context: Context) {
      val appCtx = context.applicationContext ?: context
      mainHandler.post {
        if (activeSessionCount.get() <= 0) {
          pendingStopRunnable?.let { mainHandler.removeCallbacks(it) }
          val runnable = Runnable {
            pendingStopRunnable = null
            if (activeSessionCount.get() <= 0) {
              stopAndUnbindNow(appCtx)
            }
          }
          pendingStopRunnable = runnable
          mainHandler.postDelayed(runnable, FOREGROUND_STOP_DEBOUNCE_MS)
        }
      }
    }

    @JvmStatic
    fun startAndBind(context: Context, count: Int) {
      val appCtx = context.applicationContext ?: context
      acquireLocks(appCtx)
      val intent = Intent(appCtx, SessionForegroundService::class.java).apply {
        putExtra(EXTRA_SESSION_COUNT, count.coerceAtLeast(1))
      }
      try {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
          ContextCompat.startForegroundService(appCtx, intent)
        } else {
          appCtx.startService(intent)
        }
      } catch (_: Exception) {}

      if (!serviceBound.get()) {
        try {
          val bindFlags = Context.BIND_AUTO_CREATE or Context.BIND_IMPORTANT
          if (appCtx.bindService(intent, serviceConnection, bindFlags)) {
            serviceBound.set(true)
          }
        } catch (_: Exception) {}
      }
    }

    @JvmStatic
    fun stopAndUnbindNow(context: Context) {
      val appCtx = context.applicationContext ?: context
      pendingStopRunnable?.let { mainHandler.removeCallbacks(it) }
      pendingStopRunnable = null
      if (serviceBound.getAndSet(false)) {
        try {
          appCtx.unbindService(serviceConnection)
        } catch (_: Exception) {}
      }
      releaseLocks()
      try {
        appCtx.stopService(Intent(appCtx, SessionForegroundService::class.java))
      } catch (_: Exception) {}
    }

    @JvmStatic
    fun acquireLocks(context: Context) {
      synchronized(lockMonitor) {
        val appCtx = context.applicationContext ?: context
        try {
          if (wakeLock == null) {
            val pm = appCtx.getSystemService(Context.POWER_SERVICE) as? PowerManager
            wakeLock = pm?.newWakeLock(
              PowerManager.PARTIAL_WAKE_LOCK,
              "NexusTerminal::SessionWakeLock"
            )?.apply {
              setReferenceCounted(false)
            }
          }
          if (wakeLock?.isHeld == false) {
            wakeLock?.acquire()
          }
        } catch (_: Exception) {}

        try {
          if (wifiLock == null) {
            val wm = appCtx.getSystemService(Context.WIFI_SERVICE) as? WifiManager
            @Suppress("DEPRECATION")
            val lockMode = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
              WifiManager.WIFI_MODE_FULL_LOW_LATENCY
            } else {
              WifiManager.WIFI_MODE_FULL_HIGH_PERF
            }
            wifiLock = wm?.createWifiLock(lockMode, "NexusTerminal::SessionWifiLock")?.apply {
              setReferenceCounted(false)
            }
          }
          if (wifiLock?.isHeld == false) {
            wifiLock?.acquire()
          }
        } catch (_: Exception) {}
      }
    }

    @JvmStatic
    fun releaseLocks() {
      synchronized(lockMonitor) {
        try {
          if (wakeLock?.isHeld == true) {
            wakeLock?.release()
          }
        } catch (_: Exception) {}
        try {
          if (wifiLock?.isHeld == true) {
            wifiLock?.release()
          }
        } catch (_: Exception) {}
      }
    }
  }

  override fun onCreate() {
    super.onCreate()
    ensureNotificationChannel()
    acquireLocks(this)
  }

  override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
    if (intent?.action == ACTION_STOP) {
      stopForegroundCompat()
      releaseLocks()
      stopSelf()
      return START_NOT_STICKY
    }

    val count = (intent?.getIntExtra(EXTRA_SESSION_COUNT, activeSessionCount.get().coerceAtLeast(1)) ?: 1)
      .coerceAtLeast(1)
    ensureNotificationChannel()
    acquireLocks(this)
    val notification = buildNotification(count)

    try {
      if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.UPSIDE_DOWN_CAKE) {
        startForeground(
          NOTIFICATION_ID,
          notification,
          ServiceInfo.FOREGROUND_SERVICE_TYPE_SPECIAL_USE
        )
      } else {
        startForeground(NOTIFICATION_ID, notification)
      }
    } catch (_: Exception) {}

    return START_STICKY
  }

  override fun onBind(intent: Intent?): IBinder = binder

  override fun onTaskRemoved(rootIntent: Intent?) {
    // If the user explicitly swipes the app away from Recents AND no sessions are active,
    // stop immediately. If sessions ARE active, keep them alive unless the process exits.
    if (activeSessionCount.get() <= 0) {
      stopForegroundCompat()
      releaseLocks()
      stopSelf()
    }
    super.onTaskRemoved(rootIntent)
  }

  override fun onDestroy() {
    if (activeSessionCount.get() <= 0) {
      releaseLocks()
    }
    super.onDestroy()
  }

  private fun stopForegroundCompat() {
    try {
      if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.N) {
        stopForeground(STOP_FOREGROUND_REMOVE)
      } else {
        @Suppress("DEPRECATION")
        stopForeground(true)
      }
    } catch (_: Exception) {}
  }

  private fun ensureNotificationChannel() {
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
      val nm = getSystemService(Context.NOTIFICATION_SERVICE) as? NotificationManager ?: return
      if (nm.getNotificationChannel(CHANNEL_ID) == null) {
        val channel = NotificationChannel(
          CHANNEL_ID,
          "Active Terminal Sessions",
          NotificationManager.IMPORTANCE_LOW
        ).apply {
          description = "Keeps SSH, SFTP, and tunnel connections alive in the background"
          setShowBadge(false)
          enableVibration(false)
          setSound(null, null)
        }
        nm.createNotificationChannel(channel)
      }
    }
  }

  private fun buildNotification(count: Int): Notification {
    val openIntent = Intent(this, MainActivity::class.java).apply {
      flags = Intent.FLAG_ACTIVITY_SINGLE_TOP or Intent.FLAG_ACTIVITY_CLEAR_TOP
    }
    val pendingFlags = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) {
      PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
    } else {
      PendingIntent.FLAG_UPDATE_CURRENT
    }
    val pendingOpen = PendingIntent.getActivity(this, 0, openIntent, pendingFlags)

    val summary = if (count == 1) {
      "1 active connection — running in background"
    } else {
      "$count active connections — running in background"
    }

    return NotificationCompat.Builder(this, CHANNEL_ID)
      .setSmallIcon(R.mipmap.ic_launcher)
      .setContentTitle("NexusTerminal")
      .setContentText(summary)
      .setContentIntent(pendingOpen)
      .setOngoing(true)
      .setOnlyAlertOnce(true)
      .setSilent(true)
      .setPriority(NotificationCompat.PRIORITY_LOW)
      .setCategory(NotificationCompat.CATEGORY_SERVICE)
      .setForegroundServiceBehavior(NotificationCompat.FOREGROUND_SERVICE_IMMEDIATE)
      .build()
  }
}
