package com.laststream.app.player

import android.app.Activity
import android.app.UiModeManager
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.content.res.Configuration
import android.graphics.Color
import android.graphics.Outline
import android.os.Build
import android.os.Handler
import android.os.Looper
import android.view.Gravity
import android.view.MotionEvent
import android.view.View
import android.view.ViewConfiguration
import android.view.ViewGroup
import android.view.ViewOutlineProvider
import android.widget.FrameLayout
import android.widget.ImageView
import android.widget.ProgressBar
import com.getcapacitor.JSObject
import com.laststream.app.R
import org.videolan.libvlc.util.VLCVideoLayout
import kotlin.math.abs

/**
 * Mini-lecteur natif : la lecture continue dans une vignette 16:9 flottante, ajoutée au-dessus de la WebView de l'activité
 * Capacitor (aucune seconde activité), pendant qu'on navigue dans l'application. La vidéo vient de PlaybackCore, qui change
 * seulement de surface : le média n'est pas rechargé, la lecture ne coupe pas.
 * Tap : retour au plein écran. Glisser : déplacement, aimantation aux 4 coins. Boutons : lecture/pause et fermer.
 */
class MiniPlayer private constructor(private val host: Activity, val core: PlaybackCore) : PlayerControl, PlaybackCore.Ui {
    private val kit = UiKit(host)
    private val density = host.resources.displayMetrics.density
    private val prefs = host.getSharedPreferences("laststream_player", Context.MODE_PRIVATE)
    private val main = Handler(Looper.getMainLooper())

    private lateinit var overlay: FrameLayout
    private lateinit var card: FrameLayout
    private lateinit var videoLayout: VLCVideoLayout
    private lateinit var playButton: FrameLayout
    private lateinit var fill: View
    private lateinit var track: FrameLayout
    private lateinit var busyView: ProgressBar
    private var corner = MiniCorner.parse(prefs.getString("miniCorner", null))
    private var box = MiniBox(0, 0, 0, 0)
    private var dragging = false
    private var removed = false
    /** Lecture suspendue parce que l'application est quittée (reprise au retour). */
    private var pausedByHost = false

    companion object {
        /** Vignette possible : écran tactile, hors télévision. */
        fun supported(ctx: Context): Boolean {
            val tv = (ctx.getSystemService(Context.UI_MODE_SERVICE) as? UiModeManager)?.currentModeType == Configuration.UI_MODE_TYPE_TELEVISION
            return !tv && ctx.packageManager.hasSystemFeature(PackageManager.FEATURE_TOUCHSCREEN)
        }

        /** Ajoute la vignette à l'activité hôte et lui confie la lecture. */
        fun show(host: Activity, core: PlaybackCore): Boolean {
            if (PlayerHub.mini != null) return true
            val m = MiniPlayer(host, core)
            return try {
                m.build()
                PlayerHub.mini = m
                core.ui = m
                core.attach(m.videoLayout, true)
                PlayerHub.machine.minimize()
                core.requestAudioFocus()
                PlayerHub.emit("miniChanged", JSObject().put("mini", true))
                true
            } catch (_: Exception) {
                m.detachViews()
                // Échec de la mise en place : la vignette n'est plus enregistrée, et l'état repasse en plein écran.
                if (PlayerHub.mini === m) PlayerHub.mini = null
                PlayerHub.machine.expand()
                false
            }
        }

        /** L'utilisateur quitte l'application (Accueil) pendant la vignette : image dans l'image du système si possible. */
        @JvmStatic fun onHostLeaving(host: Activity) {
            val m = PlayerHub.mini ?: return
            if (!m.core.player.isPlaying) return
            val pip = Build.VERSION.SDK_INT >= 26 && host.packageManager.hasSystemFeature(PackageManager.FEATURE_PICTURE_IN_PICTURE)
            if (pip) {
                PlayerHub.enterPipOnStart = true
                if (!m.expand()) PlayerHub.enterPipOnStart = false
            }
        }

        /** Application passée en arrière-plan avec la vignette encore affichée : pause (reprise au retour). */
        @JvmStatic fun onHostStopped() {
            val m = PlayerHub.mini ?: return
            m.core.setSystemSuspended(true) // pause du système, pas de l'utilisateur (watch party)
            if (m.core.player.isPlaying) { m.pausedByHost = true; m.core.setPlaying(false) }
            m.core.emitState(true)
            m.core.emitProgress(true)
        }

        @JvmStatic fun onHostStarted() {
            val m = PlayerHub.mini ?: return
            m.core.setSystemSuspended(false)
            if (m.pausedByHost) { m.pausedByHost = false; m.core.setPlaying(true) }
            m.core.emitState(true)
        }

        /** L'activité hôte disparaît (processus conservé) : la vignette n'a plus de support, la lecture s'arrête. */
        @JvmStatic fun onHostDestroyed() {
            val m = PlayerHub.mini ?: return
            m.dismiss(emitClosed = true)
        }
    }

    // ---------- Construction ----------

    private fun build() {
        val content = host.findViewById<ViewGroup>(android.R.id.content)
        overlay = FrameLayout(host).apply {
            layoutParams = FrameLayout.LayoutParams(-1, -1)
            clipChildren = false
            clipToPadding = false
        }
        card = FrameLayout(host).apply {
            setBackgroundColor(Color.BLACK)
            elevation = kit.dp(10).toFloat()
            clipToOutline = true
            outlineProvider = object : ViewOutlineProvider() {
                override fun getOutline(view: View, outline: Outline) { outline.setRoundRect(0, 0, view.width, view.height, kit.dp(12).toFloat()) }
            }
            contentDescription = "Mini-lecteur"
        }
        videoLayout = VLCVideoLayout(host)
        card.addView(videoLayout, FrameLayout.LayoutParams(-1, -1))
        busyView = ProgressBar(host).apply {
            isIndeterminate = true
            indeterminateTintList = android.content.res.ColorStateList.valueOf(Tokens.ACCENT)
            visibility = View.GONE
        }
        card.addView(busyView, FrameLayout.LayoutParams(kit.dp(28), kit.dp(28), Gravity.CENTER))

        val dim = 0x99000000.toInt()
        playButton = kit.iconButton(if (core.player.isPlaying) R.drawable.ic_pause else R.drawable.ic_play, "Lecture / pause", 34, 18, dim) { core.setPlaying(!core.player.isPlaying) }
        card.addView(playButton, FrameLayout.LayoutParams(kit.dp(34), kit.dp(34), Gravity.BOTTOM or Gravity.START).apply { leftMargin = kit.dp(6); bottomMargin = kit.dp(8) })
        val close = kit.iconButton(R.drawable.ic_close, "Fermer le lecteur", 30, 16, dim) { closeByUser() }
        card.addView(close, FrameLayout.LayoutParams(kit.dp(30), kit.dp(30), Gravity.TOP or Gravity.END).apply { rightMargin = kit.dp(6); topMargin = kit.dp(6) })

        track = FrameLayout(host).apply { setBackgroundColor(0x55FFFFFF) }
        fill = View(host).apply { setBackgroundColor(Tokens.ACCENT) }
        track.addView(fill, FrameLayout.LayoutParams(0, -1))
        card.addView(track, FrameLayout.LayoutParams(-1, kit.dp(3), Gravity.BOTTOM))

        installTouch()
        overlay.addView(card, FrameLayout.LayoutParams(0, 0, Gravity.TOP or Gravity.START))
        overlay.addOnLayoutChangeListener { _, l, t, r, b, ol, ot, orr, ob ->
            if ((r - l != orr - ol) || (b - t != ob - ot)) place(false)
        }
        content.addView(overlay)
        // Taille connue seulement après la première mise en page.
        overlay.post { place(false) }
    }

    /** Glisser pour déplacer, aimantation aux 4 coins ; un simple tap revient au plein écran. */
    private fun installTouch() {
        val slop = ViewConfiguration.get(host).scaledTouchSlop
        var downX = 0f; var downY = 0f; var startX = 0f; var startY = 0f
        card.setOnTouchListener { v, e ->
            when (e.actionMasked) {
                MotionEvent.ACTION_DOWN -> {
                    downX = e.rawX; downY = e.rawY; startX = v.translationX; startY = v.translationY
                    dragging = false
                    v.animate().cancel()
                    true
                }
                MotionEvent.ACTION_MOVE -> {
                    val dx = e.rawX - downX
                    val dy = e.rawY - downY
                    if (!dragging && (abs(dx) > slop || abs(dy) > slop)) { dragging = true; v.parent?.requestDisallowInterceptTouchEvent(true) }
                    if (dragging) {
                        val (x, y) = MiniLogic.clamp(startX + dx, startY + dy, box.w, box.h, overlay.width, overlay.height)
                        v.translationX = x
                        v.translationY = y
                    }
                    true
                }
                MotionEvent.ACTION_UP -> {
                    if (dragging) {
                        dragging = false
                        corner = MiniLogic.snap(v.translationX + box.w / 2f, v.translationY + box.h / 2f, overlay.width, overlay.height)
                        prefs.edit().putString("miniCorner", corner.key).apply()
                        place(true)
                    } else expand()
                    true
                }
                MotionEvent.ACTION_CANCEL -> { if (dragging) { dragging = false; place(true) }; true }
                else -> false
            }
        }
    }

    /** Taille et position pour le coin choisi (pivotement de l'écran compris). */
    private fun place(animate: Boolean) {
        if (removed || dragging || overlay.width == 0 || overlay.height == 0) return
        box = MiniLogic.box(corner, overlay.width, overlay.height, density)
        val lp = card.layoutParams as FrameLayout.LayoutParams
        if (lp.width != box.w || lp.height != box.h) { lp.width = box.w; lp.height = box.h; card.layoutParams = lp }
        if (animate) card.animate().translationX(box.x.toFloat()).translationY(box.y.toFloat()).setDuration(180).start()
        else { card.animate().cancel(); card.translationX = box.x.toFloat(); card.translationY = box.y.toFloat() }
        updateProgress()
    }

    private fun updateProgress() {
        val w = (box.w * MiniLogic.progress(core.lastPos, core.lastDur)).toInt()
        val lp = fill.layoutParams
        if (lp.width != w) { lp.width = w; fill.layoutParams = lp }
    }

    private fun setPlayIcon(playing: Boolean) {
        (playButton.getChildAt(0) as ImageView).setImageDrawable(androidx.core.content.ContextCompat.getDrawable(host, if (playing) R.drawable.ic_pause else R.drawable.ic_play)?.mutate())
    }

    // ---------- Fin de vie de la vignette ----------

    private fun detachViews() {
        if (removed) return
        removed = true
        main.removeCallbacksAndMessages(null)
        try { card.animate().cancel() } catch (_: Exception) { }
        try { (overlay.parent as? ViewGroup)?.removeView(overlay) } catch (_: Exception) { }
    }

    /** Retire la vignette ; `release` libère aussi la lecture. */
    private fun dismiss(emitClosed: Boolean) {
        if (PlayerHub.mini !== this) return
        PlayerHub.mini = null
        if (emitClosed) core.emitClosed()
        core.ui = null
        core.detach()
        detachViews()
        core.release()
        if (PlayerHub.core === core) PlayerHub.core = null
        PlayerHub.pending = null
        PlayerHub.machine.close()
    }

    /** Croix de la vignette : `closed` part vers le JS, qui enregistre la progression. */
    private fun closeByUser() = dismiss(emitClosed = true)

    /** Fermeture demandée par le JS : pas d'évènement en retour. */
    override fun closeSilently() = dismiss(emitClosed = false)

    // ---------- PlayerControl ----------

    override fun expand(): Boolean {
        if (PlayerHub.mini !== this || !PlayerHub.machine.expand()) return false
        PlayerHub.pending = core.snapshot()
        PlayerHub.adopt = true
        PlayerHub.mini = null
        core.ui = null
        core.detach()
        detachViews()
        val i = Intent(host, PlayerActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_SINGLE_TOP)
        host.startActivity(i)
        PlayerHub.emit("miniChanged", JSObject().put("mini", false))
        return true
    }

    /** Nouveau média (épisode suivant, autre source) : la vignette reste affichée. */
    override fun load(r: OpenRequest) {
        core.begin(r)
        updateProgress()
    }

    override fun setHeading(title: String?, subtitle: String?) {
        val r = core.req ?: return
        core.req = r.copy(title = if (title.isNullOrEmpty()) r.title else title, subtitle = subtitle ?: r.subtitle)
    }

    override fun setSegments(list: List<SkipSegment>) { core.segments = list }
    override fun setSources(list: List<SourceItem>) { core.sources = list }
    override fun setEpisodes(d: EpisodesData?) { core.episodes = d }
    override fun setNextEpisode(n: NextEpisodeInfo?) { core.nextEpisode = n }
    override fun addSubtitles(list: List<SubtitleSource>) = core.addSubtitles(list)
    override fun setPlaying(play: Boolean) = core.setPlaying(play)
    override fun seekTo(sec: Double) = core.seekTo(sec)
    override fun setRate(r: Double) = core.setRate(r)
    override fun selectAudio(id: Int) = core.selectAudio(id)
    override fun selectSubtitle(id: Int) = core.selectSubtitle(id)
    override fun setSubtitleDelay(ms: Long) = core.setSubtitleDelay(ms)
    override fun stateJson(): JSObject = core.stateJson()

    // ---------- PlaybackCore.Ui ----------

    override fun busy(show: Boolean, msg: String) { if (!removed) busyView.visibility = if (show) View.VISIBLE else View.GONE }
    override fun playing(playing: Boolean) { if (!removed) setPlayIcon(playing) }
    override fun paused() { if (!removed) setPlayIcon(false) }
    override fun tracksChanged() {}
    override fun durationChanged() {}
    override fun tick() { if (!removed && !dragging) updateProgress() }
    override fun toast(msg: String) {}
}
