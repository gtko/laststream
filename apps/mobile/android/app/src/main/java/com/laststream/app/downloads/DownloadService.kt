package com.laststream.app.downloads

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.net.wifi.WifiManager
import android.os.Build
import android.os.Handler
import android.os.IBinder
import android.os.Looper
import android.os.PowerManager
import androidx.core.app.NotificationCompat
import androidx.core.content.ContextCompat

/**
 * Service de premier plan (`dataSync`) qui garde les téléchargements en vie écran éteint : une notification agrégée avec barre de
 * progression, un WakeLock partiel et un WifiLock tant que des jobs tournent. Quand le runner se vide, le service reste 120 s
 * (délai de grâce, locks tenus) : le gestionnaire JS peut lancer le job suivant ou reprendre après une attente sans qu'il faille
 * rappeler `startForegroundService` depuis l'arrière-plan (interdit depuis l'API 31). Puis il s'arrête.
 * Les liens n'existent qu'en mémoire : si Android coupe le service (limite de 6 h sur API 35, arrêt de la tâche), les jobs sont
 * annulés (les `.part` restent, le gestionnaire JS reprend avec un nouveau lien).
 * Tout l'arrêt et toutes les mises à jour de notification se font sur le thread principal.
 */
class DownloadService : Service() {
    companion object {
        private const val NOTIFICATION_ID = 4120
        private const val UPDATE_INTERVAL_MS = 1_000L
        const val GRACE_MS = 120_000L
        /** 6 h (limite `dataSync`) plus la grâce : le WakeLock couvre toute la vie possible du service. */
        private const val WAKE_TIMEOUT_MS = 6L * 60 * 60 * 1000 + 10 * 60 * 1000
        private val startLock = Any()
        private var started = false
        private var current: DownloadService? = null

        /**
         * Démarre le service s'il ne tourne pas (un seul `startForegroundService` tant qu'il vit). Retourne faux si Android
         * refuse (`ForegroundServiceStartNotAllowedException` ou autre) : le job échoue alors avec `network`.
         */
        fun ensureStarted(context: Context): Boolean = synchronized(startLock) {
            if (started) return true
            try {
                ContextCompat.startForegroundService(context.applicationContext, Intent(context.applicationContext, DownloadService::class.java))
                started = true
                true
            } catch (_: Exception) {
                false
            }
        }
    }

    private val main = Handler(Looper.getMainLooper())
    private val graceStop = Runnable { stopIfIdle() }
    private var graceArmed = false
    private var wakeLock: PowerManager.WakeLock? = null
    private var wifiLock: WifiManager.WifiLock? = null
    private var lastUpdate = 0L
    private var lastCount = -1
    @Volatile private var lastStartId = 0
    /** Arrêt décidé : protégé par `startLock`. */
    private var stopping = false

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onCreate() {
        super.onCreate()
        createChannel()
        synchronized(startLock) { current = this }
        // Appelé depuis les threads des jobs : tout passe par le thread principal.
        DownloadRunner.shared.setListener { jobs -> main.post { handleState(jobs) } }
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        lastStartId = startId
        try {
            val notif = build(DownloadRunner.shared.snapshot())
            if (Build.VERSION.SDK_INT >= 29) startForeground(NOTIFICATION_ID, notif, ServiceInfo.FOREGROUND_SERVICE_TYPE_DATA_SYNC)
            else startForeground(NOTIFICATION_ID, notif)
        } catch (_: Exception) {
            // Android refuse le premier plan : les jobs échouent avec un code transitoire, le gestionnaire JS réessaiera.
            synchronized(startLock) { stopping = true; started = false }
            DownloadRunner.shared.cancelAll(DownloadCode.NETWORK)
            stopSelf()
            return START_NOT_STICKY
        }
        handleState(DownloadRunner.shared.snapshot())
        return START_NOT_STICKY
    }

    /** Thread principal. Jobs en cours : notification (au plus 1 par seconde), locks, grâce annulée. Aucun job : grâce armée. */
    private fun handleState(jobs: List<JobSnapshot>) {
        if (synchronized(startLock) { stopping }) return
        if (jobs.isEmpty()) {
            if (!graceArmed) {
                graceArmed = true
                main.postDelayed(graceStop, GRACE_MS)
                notify(jobs) // « en attente » plutôt qu'un pourcentage périmé
            }
            return
        }
        if (graceArmed) { main.removeCallbacks(graceStop); graceArmed = false }
        acquireLocks()
        val now = System.currentTimeMillis()
        if (jobs.size == lastCount && now - lastUpdate < UPDATE_INTERVAL_MS) return
        lastCount = jobs.size
        lastUpdate = now
        notify(jobs)
    }

    private fun notify(jobs: List<JobSnapshot>) {
        try { getSystemService(NotificationManager::class.java).notify(NOTIFICATION_ID, build(jobs)) } catch (_: Exception) { }
    }

    /**
     * Fin de la grâce (thread principal). `stopSelfResult(dernier startId)` ne s'arrête que si aucun démarrage plus récent n'est
     * arrivé ; sous `startLock`, un job qui arrive en même temps voit `started` faux et redémarre le service proprement.
     */
    private fun stopIfIdle() {
        graceArmed = false
        val stop = synchronized(startLock) {
            if (stopping || DownloadRunner.shared.isActive()) return
            if (stopSelfResult(lastStartId)) { stopping = true; started = false; true } else false
        }
        if (stop) {
            releaseLocks()
            stopForeground(STOP_FOREGROUND_REMOVE)
        }
    }

    /** API 35 : limite de 6 h pour `dataSync` ; il faut s'arrêter tout de suite. */
    override fun onTimeout(startId: Int, fgsType: Int) {
        synchronized(startLock) { stopping = true; started = false }
        DownloadRunner.shared.cancelAll()
        stopSelf()
    }

    override fun onDestroy() {
        main.removeCallbacksAndMessages(null)
        // Arrêt inattendu (le système tue le service) : seulement si aucun arrêt n'était décidé et si un nouveau service ne l'a pas remplacé.
        val unexpected = synchronized(startLock) {
            val mine = current === this
            if (mine) current = null
            val u = mine && !stopping
            if (u) started = false
            u
        }
        if (unexpected && DownloadRunner.shared.isActive()) DownloadRunner.shared.cancelAll()
        releaseLocks()
        super.onDestroy()
    }

    private fun createChannel() {
        if (Build.VERSION.SDK_INT < 26) return
        val ch = NotificationChannel(DownloadLogic.CHANNEL_ID, "Téléchargements", NotificationManager.IMPORTANCE_LOW)
        ch.description = "Progression des téléchargements hors ligne"
        ch.setShowBadge(false)
        getSystemService(NotificationManager::class.java).createNotificationChannel(ch)
    }

    private fun build(jobs: List<JobSnapshot>): Notification {
        val c = DownloadLogic.notification(jobs)
        val open = packageManager.getLaunchIntentForPackage(packageName)?.let {
            PendingIntent.getActivity(this, 0, it, PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT)
        }
        val b = NotificationCompat.Builder(this, DownloadLogic.CHANNEL_ID)
            .setSmallIcon(android.R.drawable.stat_sys_download)
            .setContentTitle(c.title)
            .setContentText(c.text)
            .setOngoing(true)
            .setOnlyAlertOnce(true)
            .setSilent(true)
            .setVisibility(NotificationCompat.VISIBILITY_PRIVATE)
            .setCategory(NotificationCompat.CATEGORY_PROGRESS)
        if (jobs.isNotEmpty()) b.setProgress(100, c.percent.coerceAtLeast(0), c.percent < 0)
        if (open != null) b.setContentIntent(open)
        return b.build()
    }

    @Synchronized private fun acquireLocks() {
        try {
            if (wakeLock == null) {
                val pm = getSystemService(Context.POWER_SERVICE) as PowerManager
                wakeLock = pm.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "laststream:downloads").apply { setReferenceCounted(false) }
            }
            if (wakeLock?.isHeld != true) wakeLock?.acquire(WAKE_TIMEOUT_MS)
            if (wifiLock == null) {
                val wm = applicationContext.getSystemService(Context.WIFI_SERVICE) as WifiManager
                @Suppress("DEPRECATION")
                wifiLock = wm.createWifiLock(WifiManager.WIFI_MODE_FULL_HIGH_PERF, "laststream:downloads").apply { setReferenceCounted(false) }
            }
            if (wifiLock?.isHeld != true) wifiLock?.acquire()
        } catch (_: Exception) { }
    }

    @Synchronized private fun releaseLocks() {
        try { if (wakeLock?.isHeld == true) wakeLock?.release() } catch (_: Exception) { }
        try { if (wifiLock?.isHeld == true) wifiLock?.release() } catch (_: Exception) { }
    }
}
