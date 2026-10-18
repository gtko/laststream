package com.laststream.app.player

import android.app.PendingIntent
import android.app.PictureInPictureParams
import android.app.RemoteAction
import android.content.BroadcastReceiver
import android.content.Intent
import android.content.IntentFilter
import android.graphics.drawable.Icon
import android.content.Context
import android.content.pm.PackageManager
import android.graphics.BitmapFactory
import android.graphics.Color
import android.media.AudioManager
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.util.Rational
import android.view.GestureDetector
import android.view.Gravity
import android.view.KeyEvent
import android.view.MotionEvent
import android.view.View
import android.view.ViewGroup
import android.view.WindowManager
import android.widget.FrameLayout
import android.widget.HorizontalScrollView
import android.widget.ImageView
import android.widget.LinearLayout
import android.widget.ProgressBar
import android.widget.ScrollView
import android.widget.TextView
import androidx.appcompat.app.AppCompatActivity
import androidx.core.content.ContextCompat
import androidx.core.view.ViewCompat
import androidx.core.view.WindowCompat
import androidx.core.view.WindowInsetsCompat
import androidx.core.view.WindowInsetsControllerCompat
import com.getcapacitor.JSObject
import com.laststream.app.R
import org.json.JSONArray
import org.json.JSONObject
import org.videolan.libvlc.LibVLC
import org.videolan.libvlc.Media
import org.videolan.libvlc.MediaPlayer
import org.videolan.libvlc.interfaces.IMedia
import org.videolan.libvlc.util.VLCVideoLayout
import java.net.HttpURLConnection
import java.net.URL
import kotlin.concurrent.thread

/**
 * Lecteur plein écran natif (libVLC) : décodage matériel, toutes les pistes audio et sous-titres, image dans l'image.
 * L'habillage reprend celui du lecteur web (corail, Sora, masquage automatique, ±10 s, barre de position, panneau
 * « Audio et sous-titres », « Passer l'intro », « Épisode suivant »). La logique de session (progression enregistrée, segments,
 * épisode suivant) reste côté JS : l'activité n'émet que des évènements.
 */
class PlayerActivity : AppCompatActivity() {
    private lateinit var kit: UiKit
    private lateinit var vlc: LibVLC
    private lateinit var player: MediaPlayer
    private lateinit var videoLayout: VLCVideoLayout
    private lateinit var root: FrameLayout
    private lateinit var ui: FrameLayout
    private lateinit var controls: FrameLayout
    private lateinit var spinner: LinearLayout
    private lateinit var spinnerMsg: TextView
    private lateinit var titleView: TextView
    private lateinit var subtitleView: TextView
    private lateinit var scrubber: ScrubberView
    private lateinit var timeView: TextView
    private lateinit var playIcon: FrameLayout
    private lateinit var bigPlay: FrameLayout
    private lateinit var nextButton: LinearLayout
    private lateinit var skipButton: LinearLayout
    private lateinit var skipLabel: TextView
    private lateinit var nextCard: LinearLayout
    private lateinit var nextTitle: TextView
    private lateinit var nextStill: ImageView
    private lateinit var panel: FrameLayout
    private lateinit var panelBody: LinearLayout
    private lateinit var toast: TextView
    private lateinit var pipButton: FrameLayout

    private val handler = Handler(Looper.getMainLooper())
    private var req: OpenRequest? = null
    private var segments: List<SkipSegment> = emptyList()
    private var nextEpisode: NextEpisodeInfo? = null
    private var nextDismissed = false
    private var externalSubs: List<SubtitleSource> = emptyList()
    private var extMeta = ArrayList<SubtitleSource>()
    private var embeddedSpuIds: Set<Int>? = null
    private var aspect = AspectMode.BEST
    private var rate = 1.0
    private var subDelayMs = 0L
    private var controlsVisible = false
    private var panelName: String? = null
    private var defaultsApplied = false
    private var userPickedSub = false
    private var endedSent = false
    private var closedSent = false
    private var silentClose = false
    private var startSeekDone = true
    private var wantedStart = 0.0
    private var lastState = 0L
    private var lastProgress = 0L
    private var lastTrackSig = ""
    private var audioTracks: List<TrackInfo> = emptyList()
    private var subTracks: List<TrackInfo> = emptyList()
    private var buffering = false
    private var errored = false
    private var lastPos = 0.0
    private var lastDur = 0.0
    private var audioFocusHeld = false
    private var resumeOnStart = false
    private var sources: List<SourceItem> = emptyList()
    private var episodes: EpisodesData? = null
    private var panelSeason = 0
    private lateinit var sourcesButton: LinearLayout
    private lateinit var episodesButton: LinearLayout
    private val images = ImageLoader()

    private val pipReceiver = object : BroadcastReceiver() {
        override fun onReceive(c: Context, i: Intent) {
            if (i.action == PIP_ACTION && ::player.isInitialized) { setPlaying(!player.isPlaying); updatePipActions() }
        }
    }

    companion object { const val PIP_ACTION = "com.laststream.app.PIP_TOGGLE" }

    // ---------- Cycle de vie ----------

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        PlayerHub.activity = this
        kit = UiKit(this)
        window.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
        WindowCompat.setDecorFitsSystemWindows(window, false)
        buildUi()
        enterImmersive()
        val args = arrayListOf("--audio-time-stretch", "--no-sub-autodetect-file", "--network-caching=3000", "--file-caching=3000", "--avcodec-skiploopfilter=0")
        vlc = LibVLC(this, args)
        player = MediaPlayer(vlc)
        player.attachViews(videoLayout, null, true, false)
        player.setEventListener(::onPlayerEvent)
        handler.post(ticker)
        val pend = PlayerHub.pending
        if (pend != null) load(pend) else { silentClose = true; finish() }
        ContextCompat.registerReceiver(this, pipReceiver, IntentFilter(PIP_ACTION), ContextCompat.RECEIVER_NOT_EXPORTED)
    }

    override fun onNewIntent(intent: android.content.Intent) {
        super.onNewIntent(intent)
        PlayerHub.pending?.let { load(it) }
    }

    override fun onStart() {
        super.onStart()
        if (resumeOnStart && ::player.isInitialized) { resumeOnStart = false; setPlaying(true) }
    }

    override fun onStop() {
        super.onStop()
        if (!isInPictureInPictureMode && ::player.isInitialized) {
            resumeOnStart = player.isPlaying
            if (player.isPlaying) player.pause()
            rememberPosition()
            emitState(true)
            emitProgress(true)
        }
    }

    /** Position courante gardée dans la requête en attente : une activité recréée reprend là où elle était. */
    private fun rememberPosition() {
        val r = req ?: return
        req = r.copy(startPosition = lastPos, skipSegments = segments, nextEpisode = nextEpisode, sources = sources, episodes = episodes)
        PlayerHub.pending = req
    }

    override fun onDestroy() {
        handler.removeCallbacksAndMessages(null)
        try { unregisterReceiver(pipReceiver) } catch (_: Exception) { }
        if (!closedSent && !silentClose && isFinishing) emitClosed()
        abandonAudioFocus()
        if (PlayerHub.activity === this) PlayerHub.activity = null
        if (isFinishing) PlayerHub.pending = null else rememberPosition()
        val p = if (::player.isInitialized) player else null
        val v = if (::vlc.isInitialized) vlc else null
        // Fil principal : plus d'évènements ni de surface. Seule la libération (bloquante) passe en arrière-plan.
        try { p?.setEventListener(null); p?.detachViews() } catch (_: Exception) { }
        thread(name = "vlc-release") {
            try { p?.stop(); p?.release(); v?.release() } catch (_: Exception) { }
        }
        super.onDestroy()
    }

    override fun finish() {
        if (PlayerHub.activity === this) PlayerHub.activity = null
        super.finish()
    }

    override fun onUserLeaveHint() {
        super.onUserLeaveHint()
        if (::player.isInitialized && player.isPlaying && pipSupported()) enterPip()
    }

    override fun onPictureInPictureModeChanged(isInPictureInPictureMode: Boolean, newConfig: android.content.res.Configuration) {
        super.onPictureInPictureModeChanged(isInPictureInPictureMode, newConfig)
        ui.visibility = if (isInPictureInPictureMode) View.GONE else View.VISIBLE
        if (!isInPictureInPictureMode) enterImmersive()
    }

    override fun onWindowFocusChanged(hasFocus: Boolean) {
        super.onWindowFocusChanged(hasFocus)
        if (hasFocus) enterImmersive()
    }

    private fun enterImmersive() {
        val c = WindowInsetsControllerCompat(window, window.decorView)
        c.systemBarsBehavior = WindowInsetsControllerCompat.BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE
        c.hide(WindowInsetsCompat.Type.systemBars())
    }

    // ---------- Construction de l'interface ----------

    private fun buildUi() {
        root = FrameLayout(this).apply { setBackgroundColor(Color.BLACK) }
        videoLayout = VLCVideoLayout(this)
        root.addView(videoLayout, FrameLayout.LayoutParams(-1, -1))
        ui = FrameLayout(this)
        root.addView(ui, FrameLayout.LayoutParams(-1, -1))
        ViewCompat.setOnApplyWindowInsetsListener(ui) { v, insets ->
            val i = insets.getInsets(WindowInsetsCompat.Type.systemBars() or WindowInsetsCompat.Type.displayCutout())
            v.setPadding(i.left, i.top, i.right, i.bottom)
            insets
        }

        spinner = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            gravity = Gravity.CENTER
        }
        spinner.addView(ProgressBar(this).apply {
            isIndeterminate = true
            indeterminateTintList = android.content.res.ColorStateList.valueOf(Tokens.ACCENT)
            layoutParams = LinearLayout.LayoutParams(kit.dp(56), kit.dp(56))
        })
        spinnerMsg = kit.text("", 15f, Tokens.SOFT, 600).apply { gravity = Gravity.CENTER; setPadding(kit.dp(24), kit.dp(14), kit.dp(24), 0) }
        spinner.addView(spinnerMsg)
        ui.addView(spinner, FrameLayout.LayoutParams(-1, -1))

        controls = FrameLayout(this)
        ui.addView(controls, FrameLayout.LayoutParams(-1, -1))
        buildTop()
        buildCenter()
        buildBottom()

        skipLabel = kit.text("", 16f, Tokens.TEXT, 800)
        skipButton = LinearLayout(this).apply {
            orientation = LinearLayout.HORIZONTAL
            gravity = Gravity.CENTER_VERTICAL
            isFocusable = true
            isClickable = true
            visibility = View.GONE
            minimumHeight = kit.dp(52)
            setPadding(kit.dp(22), 0, kit.dp(22), 0)
            background = kit.focusBackground(12f, 0xD10C0B11.toInt(), Tokens.TEXT, false)
            addView(kit.icon(R.drawable.ic_skip, 22).apply { (layoutParams as LinearLayout.LayoutParams).marginEnd = kit.dp(10) })
            addView(skipLabel)
            setOnClickListener { doSkip() }
            setOnFocusChangeListener { _, f -> skipLabel.setTextColor(if (f) Tokens.BG else Tokens.TEXT); (getChildAt(0) as ImageView).setColorFilter(if (f) Tokens.BG else Color.WHITE) }
        }
        ui.addView(skipButton, FrameLayout.LayoutParams(-2, -2, Gravity.END or Gravity.BOTTOM).apply { rightMargin = kit.dp(40); bottomMargin = kit.dp(40) })

        buildNextCard()
        buildPanel()

        toast = kit.text("", 14f, Tokens.TEXT, 700).apply {
            visibility = View.GONE
            setPadding(kit.dp(16), kit.dp(9), kit.dp(16), kit.dp(9))
            background = kit.round(0xE617151F.toInt(), 999f, Tokens.LINE, 1)
        }
        ui.addView(toast, FrameLayout.LayoutParams(-2, -2, Gravity.CENTER_HORIZONTAL or Gravity.BOTTOM).apply { bottomMargin = kit.dp(140) })

        val gd = GestureDetector(this, object : GestureDetector.SimpleOnGestureListener() {
            override fun onDown(e: MotionEvent) = true
            override fun onSingleTapConfirmed(e: MotionEvent): Boolean {
                if (panelName != null) closePanel() else if (controlsVisible) hideControls() else showControls()
                return true
            }
            override fun onDoubleTap(e: MotionEvent): Boolean {
                val f = e.x / root.width
                if (f < 0.35f) seekBy(-PlayerLogic.SEEK_STEP_S) else if (f > 0.65f) seekBy(PlayerLogic.SEEK_STEP_S) else togglePlay()
                return true
            }
        })
        videoLayout.setOnTouchListener { _, e -> gd.onTouchEvent(e) }
        controls.setOnTouchListener { _, e -> gd.onTouchEvent(e) }
        setContentView(root)
        controls.visibility = View.GONE
    }

    private fun gradient(top: Boolean) = android.graphics.drawable.GradientDrawable(
        if (top) android.graphics.drawable.GradientDrawable.Orientation.TOP_BOTTOM else android.graphics.drawable.GradientDrawable.Orientation.BOTTOM_TOP,
        intArrayOf(0xCC000000.toInt(), 0x00000000),
    )

    private fun buildTop() {
        val bar = LinearLayout(this).apply {
            orientation = LinearLayout.HORIZONTAL
            gravity = Gravity.CENTER_VERTICAL
            background = gradient(true)
            setPadding(kit.dp(24), kit.dp(16), kit.dp(24), kit.dp(28))
        }
        bar.addView(kit.iconButton(R.drawable.ic_back, "Retour", 48, 26) { finishWithClosed() })
        val heading = LinearLayout(this).apply { orientation = LinearLayout.VERTICAL; setPadding(kit.dp(10), 0, kit.dp(10), 0) }
        titleView = kit.text("", 19f, Tokens.TEXT, 800, sora = true).apply { maxLines = 1; ellipsize = android.text.TextUtils.TruncateAt.END }
        subtitleView = kit.text("", 14f, Tokens.SOFT, 600).apply { maxLines = 1; ellipsize = android.text.TextUtils.TruncateAt.END; setPadding(0, kit.dp(3), 0, 0) }
        heading.addView(titleView)
        heading.addView(subtitleView)
        bar.addView(heading, LinearLayout.LayoutParams(0, -2, 1f))
        pipButton = kit.iconButton(R.drawable.ic_pip, "Image dans l’image", 48, 24) { enterPip() }
        pipButton.visibility = if (pipSupported()) View.VISIBLE else View.GONE
        bar.addView(pipButton)
        bar.addView(kit.iconButton(R.drawable.ic_gear, "Réglages (vitesse, format)", 48, 24) { openPanel("settings") })
        controls.addView(bar, FrameLayout.LayoutParams(-1, -2, Gravity.TOP))
    }

    private fun buildCenter() {
        val row = LinearLayout(this).apply { orientation = LinearLayout.HORIZONTAL; gravity = Gravity.CENTER }
        val dim = 0x8C0C0B11.toInt()
        row.addView(kit.iconButton(R.drawable.ic_back10, "Reculer de 10 s", 64, 30, dim) { seekBy(-PlayerLogic.SEEK_STEP_S) })
        row.addView(kit.spacer(48))
        bigPlay = kit.iconButton(R.drawable.ic_play, "Lecture / pause", 92, 42, dim) { togglePlay() }
        row.addView(bigPlay)
        row.addView(kit.spacer(48))
        row.addView(kit.iconButton(R.drawable.ic_fwd10, "Avancer de 10 s", 64, 30, dim) { seekBy(PlayerLogic.SEEK_STEP_S) })
        controls.addView(row, FrameLayout.LayoutParams(-2, -2, Gravity.CENTER))
    }

    private fun buildBottom() {
        val box = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            background = gradient(false)
            setPadding(kit.dp(32), kit.dp(36), kit.dp(32), kit.dp(14))
        }
        scrubber = ScrubberView(this).apply {
            onScrub = { f, final ->
                val dur = lastDur
                if (dur > 0) {
                    val target = f * dur
                    timeView.text = PlayerLogic.formatClock(target) + " / " + PlayerLogic.formatClock(dur)
                    if (final) seekTo(target)
                    scheduleHide()
                }
            }
            onStep = { delta -> seekBy(delta) }
        }
        box.addView(scrubber, LinearLayout.LayoutParams(-1, -2))
        val row = LinearLayout(this).apply { orientation = LinearLayout.HORIZONTAL; gravity = Gravity.CENTER_VERTICAL }
        playIcon = kit.iconButton(R.drawable.ic_play, "Lecture / pause", 48, 26) { togglePlay() }
        row.addView(playIcon)
        row.addView(kit.iconButton(R.drawable.ic_back10, "Reculer de 10 s", 48, 26) { seekBy(-PlayerLogic.SEEK_STEP_S) })
        row.addView(kit.iconButton(R.drawable.ic_fwd10, "Avancer de 10 s", 48, 26) { seekBy(PlayerLogic.SEEK_STEP_S) })
        timeView = kit.text("0:00 / 0:00", 14f, Tokens.SOFT, 700).apply { setPadding(kit.dp(12), 0, 0, 0) }
        row.addView(timeView)
        row.addView(View(this), LinearLayout.LayoutParams(0, 1, 1f))
        nextButton = kit.textButton(R.drawable.ic_next, "Épisode suivant") { requestNextEpisode() }.apply { visibility = View.GONE }
        row.addView(nextButton)
        episodesButton = kit.textButton(R.drawable.ic_tracks, "Épisodes") { openPanel("episodes") }.apply { visibility = View.GONE }
        sourcesButton = kit.textButton(R.drawable.ic_skip, "Sources") { openPanel("sources") }.apply { visibility = View.GONE }
        row.addView(episodesButton)
        row.addView(sourcesButton)
        row.addView(kit.textButton(R.drawable.ic_tracks, "Audio et sous-titres") { openPanel("tracks") })
        box.addView(row, LinearLayout.LayoutParams(-1, -2))
        controls.addView(box, FrameLayout.LayoutParams(-1, -2, Gravity.BOTTOM))
    }

    private fun buildNextCard() {
        nextStill = ImageView(this).apply { scaleType = ImageView.ScaleType.CENTER_CROP; setBackgroundColor(0xFF1D1520.toInt()) }
        nextTitle = kit.text("", 17f, Tokens.TEXT, 700, sora = true).apply { maxLines = 2; ellipsize = android.text.TextUtils.TruncateAt.END; setPadding(0, kit.dp(4), 0, kit.dp(10)) }
        val body = LinearLayout(this).apply { orientation = LinearLayout.VERTICAL; setPadding(kit.dp(16), kit.dp(14), kit.dp(16), kit.dp(14)) }
        body.addView(kit.text("ÉPISODE SUIVANT", 12f, Tokens.ACCENT, 800))
        body.addView(nextTitle)
        val actions = LinearLayout(this).apply { orientation = LinearLayout.HORIZONTAL }
        val go = kit.textButton(R.drawable.ic_next, "Lire maintenant") { requestNextEpisode() }.apply {
            background = kit.focusBackground(10f, Tokens.ACCENT, Tokens.ACCENT, true)
            (getChildAt(0) as ImageView).setColorFilter(Tokens.BG)
            (getChildAt(1) as TextView).setTextColor(Tokens.BG)
        }
        actions.addView(go)
        actions.addView(kit.textButton(null, "Ignorer") { nextDismissed = true; nextCard.visibility = View.GONE })
        body.addView(actions)
        nextCard = LinearLayout(this).apply {
            orientation = LinearLayout.HORIZONTAL
            visibility = View.GONE
            background = kit.round(Tokens.SURFACE, 16f, Tokens.LINE, 1)
            clipToOutline = true
            addView(nextStill, LinearLayout.LayoutParams(kit.dp(150), kit.dp(100)))
            addView(body, LinearLayout.LayoutParams(kit.dp(300), -2))
        }
        ui.addView(nextCard, FrameLayout.LayoutParams(-2, -2, Gravity.END or Gravity.BOTTOM).apply { rightMargin = kit.dp(40); bottomMargin = kit.dp(40) })
    }

    private fun buildPanel() {
        panel = FrameLayout(this).apply {
            visibility = View.GONE
            setBackgroundColor(0x99000000.toInt())
            isClickable = true
            setOnClickListener { closePanel() }
        }
        panelBody = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setBackgroundColor(0xF20C0B11.toInt())
            isClickable = true
        }
        val w = (resources.displayMetrics.widthPixels * 0.9f).toInt().coerceAtMost(kit.dp(620))
        panel.addView(panelBody, FrameLayout.LayoutParams(w, -1, Gravity.END))
        ui.addView(panel, FrameLayout.LayoutParams(-1, -1))
    }

    // ---------- Panneaux (audio, sous-titres, réglages) ----------

    private class Row(val label: String, val selected: Boolean, val onClick: () -> Unit)

    private fun column(title: String, rows: List<Row>, extra: View? = null): LinearLayout {
        val col = LinearLayout(this).apply { orientation = LinearLayout.VERTICAL }
        col.addView(kit.text(title.uppercase(), 12f, Tokens.DIM, 800).apply { setPadding(kit.dp(22), kit.dp(8), kit.dp(22), kit.dp(10)) })
        rows.forEach { r ->
            val row = LinearLayout(this).apply {
                orientation = LinearLayout.HORIZONTAL
                gravity = Gravity.CENTER_VERTICAL
                isFocusable = true
                isClickable = true
                minimumHeight = kit.dp(48)
                setPadding(kit.dp(22), kit.dp(6), kit.dp(14), kit.dp(6))
                background = kit.focusBackground(8f)
                tag = if (r.selected) "selected" else null
                setOnClickListener { r.onClick() }
            }
            row.addView(kit.text(r.label, 15f, if (r.selected) Tokens.ACCENT else Tokens.TEXT, if (r.selected) 800 else 600), LinearLayout.LayoutParams(0, -2, 1f))
            if (r.selected) row.addView(kit.icon(R.drawable.ic_check, 20, Tokens.ACCENT))
            col.addView(row, LinearLayout.LayoutParams(-1, -2))
        }
        if (extra != null) col.addView(extra)
        return col
    }

    private fun delayControls(): View {
        val box = LinearLayout(this).apply { orientation = LinearLayout.VERTICAL; setPadding(kit.dp(22), kit.dp(14), kit.dp(14), kit.dp(14)) }
        box.addView(kit.text("DÉCALAGE", 12f, Tokens.DIM, 800).apply { setPadding(0, 0, 0, kit.dp(8)) })
        val row = LinearLayout(this).apply { orientation = LinearLayout.HORIZONTAL; gravity = Gravity.CENTER_VERTICAL }
        val value = kit.text(PlayerLogic.formatDelay(subDelayMs), 15f, Tokens.TEXT, 800).apply { gravity = Gravity.CENTER }
        fun step(by: Long) { setSubtitleDelay(subDelayMs + by); value.text = PlayerLogic.formatDelay(subDelayMs) }
        row.addView(kit.textButton(null, "−0,5 s") { step(-500) })
        row.addView(value, LinearLayout.LayoutParams(kit.dp(72), -2))
        row.addView(kit.textButton(null, "+0,5 s") { step(500) })
        box.addView(row)
        return box
    }

    fun openPanel(name: String) {
        panelName = name
        showControls()
        refreshPanel()
        panel.visibility = View.VISIBLE
        handler.removeCallbacks(hideRunnable)
        panelBody.post { panelBody.findViewWithTag<View>("selected")?.requestFocus() ?: firstFocusable(panelBody)?.requestFocus() }
    }

    private fun firstFocusable(v: View): View? {
        if (v.isFocusable && v !is ScrollView && v !is HorizontalScrollView) return v
        if (v is ViewGroup) for (i in 0 until v.childCount) firstFocusable(v.getChildAt(i))?.let { return it }
        return null
    }

    private fun closePanel() {
        panelName = null
        panel.visibility = View.GONE
        scheduleHide()
    }

    private fun refreshPanel() {
        val name = panelName ?: return
        panelBody.removeAllViews()
        val head = LinearLayout(this).apply { orientation = LinearLayout.HORIZONTAL; gravity = Gravity.CENTER_VERTICAL; setPadding(kit.dp(22), kit.dp(18), kit.dp(10), kit.dp(8)) }
        head.addView(kit.text(when (name) { "tracks" -> "Audio et sous-titres"; "sources" -> "Sources"; "episodes" -> "Épisodes"; else -> "Réglages" }, 21f, Tokens.TEXT, 800, sora = true), LinearLayout.LayoutParams(0, -2, 1f))
        head.addView(kit.iconButton(R.drawable.ic_close, "Fermer", 44, 22) { closePanel() })
        panelBody.addView(head)
        if (name == "sources") { buildSourcesPanel(); return }
        if (name == "episodes") { buildEpisodesPanel(); return }
        val cols = LinearLayout(this).apply { orientation = LinearLayout.HORIZONTAL }
        if (name == "tracks") {
            val audioRows = if (audioTracks.isEmpty()) listOf(Row("Une seule piste", true) {}) else audioTracks.map { t -> Row(t.name, t.selected) { selectAudio(t.id, true) } }
            val subRows = ArrayList<Row>()
            subRows.add(Row("Désactivés", subTracks.none { it.selected && it.id >= 0 }) { selectSubtitle(-1, true) })
            subTracks.filter { it.id >= 0 }.forEach { t -> subRows.add(Row(t.name, t.selected) { selectSubtitle(t.id, true) }) }
            cols.addView(scroll(column("Audio", audioRows)), LinearLayout.LayoutParams(0, -2, 1f))
            cols.addView(scroll(column("Sous-titres", subRows, delayControls())), LinearLayout.LayoutParams(0, -2, 1f))
        } else {
            val speedRows = PlayerLogic.RATES.map { r -> Row(PlayerLogic.rateLabel(r), kotlin.math.abs(r - rate) < 0.01) { setRate(r); refreshPanel() } }
            val aspectRows = AspectMode.values().map { a -> Row(a.label, a == aspect) { setAspect(a); refreshPanel() } }
            cols.addView(scroll(column("Vitesse", speedRows)), LinearLayout.LayoutParams(0, -2, 1f))
            cols.addView(scroll(column("Format de l’image", aspectRows)), LinearLayout.LayoutParams(0, -2, 1f))
        }
        panelBody.addView(cols, LinearLayout.LayoutParams(-1, 0, 1f))
    }

    fun setSources(list: List<SourceItem>) {
        sources = list
        sourcesButton.visibility = if (list.size > 0) View.VISIBLE else View.GONE
        if (panelName == "sources") refreshPanel()
    }

    fun setEpisodes(d: EpisodesData?) {
        val changedCurrent = d?.currentSeason != episodes?.currentSeason
        episodes = d
        episodesButton.visibility = if (d != null) View.VISIBLE else View.GONE
        if (d != null && (panelSeason == 0 || changedCurrent)) panelSeason = d.currentSeason
        if (panelName == "episodes") refreshPanel()
    }

    private fun switching(msg: String) {
        closePanel()
        showSpinner(msg)
        if (::player.isInitialized) player.pause()
    }

    private fun buildSourcesPanel() {
        val col = LinearLayout(this).apply { orientation = LinearLayout.VERTICAL; setPadding(0, 0, 0, kit.dp(16)) }
        if (sources.isEmpty()) col.addView(kit.text("Recherche des sources…", 15f, Tokens.DIM, 600).apply { setPadding(kit.dp(22), kit.dp(14), kit.dp(22), 0) })
        PlayerLogic.groupSources(sources).forEach { (group, items) ->
            col.addView(kit.text(group.uppercase(), 12f, Tokens.DIM, 800).apply { setPadding(kit.dp(22), kit.dp(14), kit.dp(22), kit.dp(8)) })
            items.forEach { s ->
                val row = LinearLayout(this).apply {
                    orientation = LinearLayout.HORIZONTAL
                    gravity = Gravity.CENTER_VERTICAL
                    isFocusable = true
                    isClickable = true
                    minimumHeight = kit.dp(56)
                    setPadding(kit.dp(22), kit.dp(8), kit.dp(14), kit.dp(8))
                    background = kit.focusBackground(8f)
                    tag = if (s.current) "selected" else null
                    setOnClickListener {
                        if (s.current) { closePanel(); return@setOnClickListener }
                        switching("Changement de source…")
                        emitEvent("selectSource", JSObject().put("id", s.id).put("position", lastPos))
                    }
                }
                val texts = LinearLayout(this).apply { orientation = LinearLayout.VERTICAL }
                texts.addView(kit.text(s.label, 15f, if (s.current) Tokens.ACCENT else Tokens.TEXT, if (s.current) 800 else 700))
                if (s.detail.isNotEmpty()) texts.addView(kit.text(s.detail, 13f, Tokens.DIM, 600).apply { setPadding(0, kit.dp(3), 0, 0) })
                row.addView(texts, LinearLayout.LayoutParams(0, -2, 1f))
                if (s.current) row.addView(kit.icon(R.drawable.ic_check, 20, Tokens.ACCENT))
                col.addView(row, LinearLayout.LayoutParams(-1, -2))
            }
        }
        panelBody.addView(scroll(col), LinearLayout.LayoutParams(-1, 0, 1f))
    }

    private fun buildEpisodesPanel() {
        val d = episodes
        val wrap = LinearLayout(this).apply { orientation = LinearLayout.VERTICAL }
        if (d == null) { panelBody.addView(wrap); return }
        val tabs = LinearLayout(this).apply { orientation = LinearLayout.HORIZONTAL; setPadding(kit.dp(14), 0, kit.dp(14), kit.dp(8)) }
        d.seasons.forEach { s ->
            val on = s.number == panelSeason
            val b = kit.textButton(null, s.name) {
                panelSeason = s.number
                if (PlayerLogic.episodesOf(d, s.number).isEmpty()) emitEvent("loadSeason", JSObject().put("season", s.number))
                refreshPanel()
            }
            (b.getChildAt(0) as TextView).setTextColor(if (on) Tokens.ACCENT else Tokens.TEXT)
            (b.getChildAt(0) as TextView).typeface = kit.body(if (on) 800 else 600)
            if (on) b.tag = "season"
            tabs.addView(b)
        }
        if (d.seasons.size > 1) panelBody.addView(HorizontalScrollView(this).apply { isHorizontalScrollBarEnabled = false; addView(tabs) })
        val list = LinearLayout(this).apply { orientation = LinearLayout.VERTICAL; setPadding(0, 0, 0, kit.dp(16)) }
        val eps = PlayerLogic.episodesOf(d, panelSeason)
        if (eps.isEmpty()) list.addView(kit.text("Chargement…", 15f, Tokens.DIM, 600).apply { setPadding(kit.dp(22), kit.dp(14), kit.dp(22), 0) })
        eps.forEach { e ->
            val row = LinearLayout(this).apply {
                orientation = LinearLayout.HORIZONTAL
                gravity = Gravity.CENTER_VERTICAL
                isFocusable = e.aired
                isClickable = e.aired
                alpha = if (e.aired) 1f else 0.5f
                setPadding(kit.dp(22), kit.dp(8), kit.dp(14), kit.dp(8))
                background = kit.focusBackground(8f)
                tag = if (e.current) "selected" else null
                setOnClickListener {
                    if (e.current) { closePanel(); return@setOnClickListener }
                    switching("Changement d’épisode…")
                    emitEvent("selectEpisode", JSObject().put("season", e.season).put("episode", e.episode))
                }
            }
            val still = FrameLayout(this).apply { background = kit.round(0xFF1D1520.toInt(), 8f); clipToOutline = true }
            val img = ImageView(this).apply { scaleType = ImageView.ScaleType.CENTER_CROP }
            still.addView(img, FrameLayout.LayoutParams(-1, -1))
            e.still?.let { images.load(it, img) }
            if (e.progress > 0 && !e.watched) {
                still.addView(View(this).apply { setBackgroundColor(Tokens.ACCENT) }, FrameLayout.LayoutParams((kit.dp(120) * e.progress).toInt().coerceAtLeast(kit.dp(2)), kit.dp(3), Gravity.BOTTOM or Gravity.START))
            }
            row.addView(still, LinearLayout.LayoutParams(kit.dp(120), kit.dp(68)))
            val texts = LinearLayout(this).apply { orientation = LinearLayout.VERTICAL; setPadding(kit.dp(14), 0, kit.dp(8), 0) }
            texts.addView(kit.text(PlayerLogic.episodeTitle(e), 15f, if (e.current) Tokens.ACCENT else Tokens.TEXT, if (e.current) 800 else 700).apply { maxLines = 2; ellipsize = android.text.TextUtils.TruncateAt.END })
            val meta = listOf(PlayerLogic.episodeMeta(e), if (e.current) "En cours" else if (!e.aired) "Bientôt" else "").filter { it.isNotEmpty() }.joinToString(" · ")
            if (meta.isNotEmpty()) texts.addView(kit.text(meta, 13f, Tokens.DIM, 600).apply { setPadding(0, kit.dp(3), 0, 0) })
            row.addView(texts, LinearLayout.LayoutParams(0, -2, 1f))
            if (e.watched) row.addView(kit.icon(R.drawable.ic_check, 20, Tokens.ACCENT))
            list.addView(row, LinearLayout.LayoutParams(-1, -2))
        }
        panelBody.addView(scroll(list), LinearLayout.LayoutParams(-1, 0, 1f))
    }

    private fun scroll(v: View) = ScrollView(this).apply { isFillViewport = true; addView(v) }

    // ---------- Chargement d'un média ----------

    fun load(r: OpenRequest) {
        req = r
        segments = r.skipSegments
        nextEpisode = r.nextEpisode
        nextDismissed = false
        externalSubs = r.subtitles
        extMeta = ArrayList()
        embeddedSpuIds = null
        defaultsApplied = false
        userPickedSub = false
        endedSent = false
        errored = false
        subDelayMs = 0
        lastTrackSig = ""
        audioTracks = emptyList()
        subTracks = emptyList()
        wantedStart = r.startPosition
        startSeekDone = r.startPosition < 1.0
        lastPos = 0.0
        lastDur = 0.0
        setHeading(r.title, r.subtitle)
        setNextEpisode(r.nextEpisode)
        setSources(r.sources)
        setEpisodes(r.episodes)
        nextCard.visibility = View.GONE
        skipButton.visibility = View.GONE
        showSpinner("")
        closePanel()
        requestAudioFocus()
        try {
            val m = Media(vlc, Uri.parse(r.url))
            m.setHWDecoderEnabled(true, false)
            if (r.startPosition >= 1.0) m.addOption(":start-time=${r.startPosition}")
            r.headers.forEach { (k, v) ->
                when (k.lowercase()) {
                    "user-agent" -> m.addOption(":http-user-agent=$v")
                    "referer", "referrer" -> m.addOption(":http-referrer=$v")
                }
            }
            player.media = m
            m.release()
            player.play()
            player.rate = 1f
            rate = 1.0
            setAspect(aspect)
        } catch (e: Exception) {
            fail("open")
        }
        showControls()
    }

    fun setHeading(title: String, subtitle: String) {
        if (title.isNotEmpty()) titleView.text = title
        subtitleView.text = subtitle
        subtitleView.visibility = if (subtitle.isEmpty()) View.GONE else View.VISIBLE
    }

    fun setSegments(list: List<SkipSegment>) {
        segments = list
        updateMarks()
    }

    fun setNextEpisode(n: NextEpisodeInfo?) {
        nextEpisode = n
        nextButton.visibility = if (n != null) View.VISIBLE else View.GONE
        if (n != null) {
            nextTitle.text = n.title
            nextStill.setImageDrawable(null)
            n.still?.let { url -> loadImage(url) { nextStill.setImageBitmap(it) } }
        }
    }

    private fun loadImage(url: String, done: (android.graphics.Bitmap) -> Unit) {
        thread {
            try {
                val c = URL(url).openConnection() as HttpURLConnection
                c.connectTimeout = 6000
                c.readTimeout = 6000
                c.inputStream.use { BitmapFactory.decodeStream(it) }?.let { b -> runOnUiThread { if (!isDestroyed) done(b) } }
            } catch (_: Exception) { }
        }
    }

    private fun updateMarks() {
        val d = lastDur
        if (d <= 0) { scrubber.setMarks(emptyList()); return }
        scrubber.setMarks(segments.filter { it.kind != "postcredits" }.map { (it.start / d).coerceIn(0.0, 1.0) to (it.end / d).coerceIn(0.0, 1.0) })
    }

    // ---------- Lecture ----------

    private fun onPlayerEvent(e: MediaPlayer.Event) {
        when (e.type) {
            MediaPlayer.Event.Opening -> showSpinner("")
            MediaPlayer.Event.Buffering -> {
                buffering = e.buffering < 100f
                if (buffering && !errored) showSpinner("") else if (!buffering) hideSpinner()
            }
            MediaPlayer.Event.Playing -> {
                buffering = false
                hideSpinner()
                updatePlayIcons(true)
                scheduleHide()
                handler.postDelayed({ afterStart() }, 600)
            }
            MediaPlayer.Event.Paused -> { updatePlayIcons(false); showControls(); emitState(true); emitProgress(true) }
            MediaPlayer.Event.EndReached -> {
                if (!endedSent) { endedSent = true; emitEvent("ended", JSObject().put("position", lastPos).put("duration", lastDur)) }
                showSpinner("")
            }
            MediaPlayer.Event.EncounteredError -> fail("decode")
            MediaPlayer.Event.ESAdded, MediaPlayer.Event.ESDeleted, MediaPlayer.Event.ESSelected -> refreshTracks()
        }
    }

    private fun afterStart() {
        if (isDestroyed) return
        if (!startSeekDone) {
            startSeekDone = true
            // `start-time` est ignoré par certains serveurs : on rattrape la position à la main.
            if (player.time / 1000.0 < wantedStart - 5) player.time = (wantedStart * 1000).toLong()
        }
        refreshTracks()
        if (!defaultsApplied && (audioTracks.isNotEmpty() || subTracks.isNotEmpty())) applyDefaults()
        applyExternalSubs()
    }

    private fun applyExternalSubs() {
        if (embeddedSpuIds == null) embeddedSpuIds = subTracks.map { it.id }.toSet()
        val pending = externalSubs.filter { s -> extMeta.none { it.url == s.url } }
        pending.forEach { s ->
            try {
                player.addSlave(IMedia.Slave.Type.Subtitle, Uri.parse(s.url), false)
                extMeta.add(s)
            } catch (_: Exception) { }
        }
        if (pending.isNotEmpty()) handler.postDelayed({ refreshTracks(); maybeSelectExternal() }, 1200)
    }

    fun addSubtitles(list: List<SubtitleSource>) {
        externalSubs = (externalSubs + list).distinctBy { it.url }
        if (embeddedSpuIds != null) applyExternalSubs()
    }

    private fun selectedAudioLang(): String = audioTracks.firstOrNull { it.selected }?.lang ?: ""

    private fun maybeSelectExternal() {
        val r = req ?: return
        if (userPickedSub || subTracks.any { it.selected && it.id >= 0 }) return
        PlayerLogic.defaultSubtitle(subTracks, r.preferredSubLang, selectedAudioLang(), r.subMode)?.let { selectSubtitle(it.id, false) }
    }

    private fun applyDefaults() {
        val r = req ?: return
        defaultsApplied = true
        PlayerLogic.pickAudio(audioTracks, r.preferredAudioLang)?.let { if (!it.selected) selectAudio(it.id, false) }
        if (r.preferredSubLang.isBlank() && r.subMode != "off") return // aucune préférence : choix par défaut de libVLC
        val pick = PlayerLogic.defaultSubtitle(subTracks, r.preferredSubLang, selectedAudioLang(), r.subMode)
        if (pick != null) selectSubtitle(pick.id, false) else if (subTracks.any { it.selected }) selectSubtitle(-1, false)
    }

    private fun mediaTracks(type: Int): List<IMedia.Track> {
        val m = player.media ?: return emptyList()
        val out = ArrayList<IMedia.Track>()
        try { for (i in 0 until m.trackCount) m.getTrack(i)?.let { if (it.type == type) out.add(it) } } catch (_: Exception) { }
        m.release()
        return out
    }

    private fun refreshTracks() {
        if (isDestroyed) return
        val audioDesc = player.audioTracks ?: emptyArray()
        val spuDesc = player.spuTracks ?: emptyArray()
        val mAudio = mediaTracks(IMedia.Track.Type.Audio)
        val mText = mediaTracks(IMedia.Track.Type.Text)
        val curAudio = player.audioTrack
        val curSpu = player.spuTrack
        var ai = 0
        audioTracks = audioDesc.filter { it.id >= 0 }.map { d ->
            val mt = mAudio.getOrNull(ai++)
            val lang = PlayerLogic.langFromTrackName(d.name).ifEmpty { PlayerLogic.normalizeLang(mt?.language) }
            val ch = (mt as? IMedia.AudioTrack)?.channels ?: 0
            TrackInfo(d.id, PlayerLogic.trackLabel(lang, d.name, mt?.codec ?: "", ch), lang, d.id == curAudio)
        }
        var si = 0
        var extIdx = 0
        val embedded = embeddedSpuIds
        subTracks = spuDesc.filter { it.id >= 0 }.map { d ->
            val isExt = embedded != null && d.id !in embedded
            val ext = if (isExt) extMeta.getOrNull(extIdx++) else null
            val mt = if (isExt) null else mText.getOrNull(si++)
            val lang = ext?.lang?.let { PlayerLogic.normalizeLang(it) } ?: PlayerLogic.langFromTrackName(d.name).ifEmpty { PlayerLogic.normalizeLang(mt?.language) }
            val label = if (ext != null) ext.label.ifBlank { PlayerLogic.languageName(lang).ifEmpty { "Sous-titres externes" } } + " · externe"
            else PlayerLogic.trackLabel(lang, d.name, mt?.codec ?: "")
            TrackInfo(d.id, label, lang, d.id == curSpu)
        }
        val sig = audioTracks.joinToString { "${it.id}${it.selected}" } + "|" + subTracks.joinToString { "${it.id}${it.selected}" }
        if (sig != lastTrackSig) {
            lastTrackSig = sig
            emitEvent("tracks", JSObject().put("audio", tracksJson(audioTracks)).put("subs", tracksJson(subTracks)))
            if (panelName != null) refreshPanel()
        }
    }

    private fun tracksJson(l: List<TrackInfo>): JSONArray = JSONArray().apply {
        l.forEach { put(JSONObject().put("id", it.id).put("label", it.name).put("lang", it.lang).put("selected", it.selected)) }
    }

    fun selectAudio(id: Int, fromUser: Boolean = true) {
        player.audioTrack = id
        refreshTracks()
        val t = audioTracks.firstOrNull { it.id == id }
        if (fromUser) { toast("Audio : " + (t?.name ?: "")); emitEvent("trackChanged", JSObject().put("kind", "audio").put("id", id).put("lang", t?.lang ?: "").put("label", t?.name ?: "")) }
    }

    fun selectSubtitle(id: Int, fromUser: Boolean = true) {
        if (fromUser) userPickedSub = true
        player.spuTrack = id
        refreshTracks()
        val t = subTracks.firstOrNull { it.id == id }
        if (fromUser) {
            toast(if (id < 0) "Sous-titres désactivés" else "Sous-titres : " + (t?.name ?: ""))
            emitEvent("trackChanged", JSObject().put("kind", "sub").put("id", id).put("lang", if (id < 0) "off" else t?.lang ?: "").put("label", t?.name ?: ""))
        }
    }

    fun setSubtitleDelay(ms: Long) {
        subDelayMs = PlayerLogic.clampDelayMs(ms)
        player.spuDelay = subDelayMs * 1000
    }

    fun setRate(r: Double) {
        rate = r
        player.rate = r.toFloat()
    }

    private fun setAspect(a: AspectMode) {
        aspect = a
        try {
            when (a) {
                AspectMode.BEST -> { player.setAspectRatio(null); player.videoScale = MediaPlayer.ScaleType.SURFACE_BEST_FIT }
                AspectMode.FILL -> { player.setAspectRatio(null); player.videoScale = MediaPlayer.ScaleType.SURFACE_FILL }
                else -> { player.setAspectRatio(a.vlc); player.videoScale = MediaPlayer.ScaleType.SURFACE_BEST_FIT }
            }
        } catch (_: Exception) { }
    }

    fun setPlaying(play: Boolean) {
        if (play) { requestAudioFocus(); player.play() } else player.pause()
    }

    private fun togglePlay() {
        setPlaying(!player.isPlaying)
        showControls()
    }

    fun seekTo(sec: Double) {
        if (lastDur > 0) player.time = (PlayerLogic.seekTarget(sec, 0.0, lastDur) * 1000).toLong() else player.time = (sec * 1000).toLong()
        lastPos = sec
        emitState(true)
    }

    private fun seekBy(delta: Double) {
        val cur = player.time / 1000.0
        val target = PlayerLogic.seekTarget(cur, delta, lastDur)
        seekTo(target)
        toast((if (delta > 0) "+" else "−") + kotlin.math.abs(delta).toInt() + " s")
        showControls()
    }

    private fun doSkip() {
        val seg = PlayerLogic.activeSkip(segments, lastPos) ?: return
        seekTo(seg.end)
        skipButton.visibility = View.GONE
    }

    private fun requestNextEpisode() {
        nextCard.visibility = View.GONE
        showSpinner("Épisode suivant…")
        player.pause()
        emitEvent("nextEpisode", JSObject().put("position", lastPos).put("duration", lastDur))
    }

    private fun fail(code: String) {
        if (errored) return
        errored = true
        showSpinner("Lecture impossible, recherche d’une autre source…")
        emitEvent("error", JSObject().put("code", code).put("position", lastPos))
    }

    // ---------- Boucle périodique : position, boutons de saut, évènements ----------

    private val ticker = object : Runnable {
        override fun run() {
            if (!isDestroyed && ::player.isInitialized) {
                try { tick() } catch (_: Exception) { }
                handler.postDelayed(this, 250)
            }
        }
    }

    private fun tick() {
        val t = player.time
        val l = player.length
        if (t >= 0) lastPos = t / 1000.0
        if (l > 0) { if (lastDur != l / 1000.0) { lastDur = l / 1000.0; updateMarks() } }
        scrubber.setProgress(if (lastDur > 0) lastPos / lastDur else 0.0)
        if (controlsVisible) timeView.text = PlayerLogic.formatClock(lastPos) + " / " + PlayerLogic.formatClock(lastDur)
        val seg = PlayerLogic.activeSkip(segments, lastPos)
        if (seg != null && !isInPictureInPictureMode) {
            skipLabel.text = PlayerLogic.skipLabel(seg)
            skipButton.visibility = View.VISIBLE
        } else skipButton.visibility = View.GONE
        val showNext = !nextDismissed && nextEpisode != null && !errored && PlayerLogic.showNextCard(segments, lastPos, lastDur, true) && !isInPictureInPictureMode
        nextCard.visibility = if (showNext) View.VISIBLE else View.GONE
        if (nextCard.visibility == View.VISIBLE && skipButton.visibility == View.VISIBLE) skipButton.visibility = View.GONE
        emitState(false)
        emitProgress(false)
    }

    fun stateJson(): JSObject = JSObject()
        .put("position", lastPos).put("duration", lastDur).put("paused", !player.isPlaying).put("buffering", buffering)
        .put("rate", rate).put("ended", endedSent)

    private fun emitState(force: Boolean) {
        val now = System.currentTimeMillis()
        if (!force && !PlayerLogic.shouldEmit(now, lastState, 1000)) return
        lastState = now
        emitEvent("state", stateJson())
    }

    private fun emitProgress(force: Boolean) {
        val now = System.currentTimeMillis()
        if (!force && (!player.isPlaying || !PlayerLogic.shouldEmit(now, lastProgress, 5000))) return
        if (lastDur <= 0) return
        lastProgress = now
        emitEvent("progress", JSObject().put("position", lastPos).put("duration", lastDur))
    }

    private fun emitEvent(name: String, data: JSObject) = PlayerHub.emit(name, data)

    private fun emitClosed() {
        closedSent = true
        emitEvent("closed", JSObject().put("position", lastPos).put("duration", lastDur))
    }

    /** Fermeture à l'initiative de l'utilisateur : `closed` part vers le JS, qui enregistre la progression. */
    private fun finishWithClosed() {
        if (!closedSent) emitClosed()
        PlayerHub.activity = null
        finish()
    }

    /** Fermeture demandée par le JS : pas d'évènement en retour. */
    fun closeSilently() {
        silentClose = true
        finish()
    }

    // ---------- Contrôles : affichage, masquage automatique, clavier / télécommande ----------

    private val hideRunnable = Runnable { hideControls() }

    private fun scheduleHide() {
        handler.removeCallbacks(hideRunnable)
        if (controlsVisible && panelName == null && ::player.isInitialized && player.isPlaying) handler.postDelayed(hideRunnable, 3000)
    }

    /** Au-dessus de la barre basse quand les contrôles sont visibles, près du bord sinon. */
    private fun moveOverlays() {
        val m = kit.dp(if (controlsVisible) 150 else 40)
        listOf(skipButton, nextCard).forEach { v -> (v.layoutParams as FrameLayout.LayoutParams).bottomMargin = m; v.requestLayout() }
    }

    private fun showControls() {
        if (!controlsVisible) {
            controlsVisible = true
            moveOverlays()
            controls.visibility = View.VISIBLE
            controls.alpha = 0f
            controls.animate().alpha(1f).setDuration(180).start()
            if (currentFocus == null) bigPlay.requestFocus()
        }
        scheduleHide()
    }

    private fun hideControls() {
        if (panelName != null || scrubberBusy()) return
        controlsVisible = false
        moveOverlays()
        controls.animate().alpha(0f).setDuration(220).withEndAction { if (!controlsVisible) controls.visibility = View.GONE }.start()
        root.requestFocus()
    }

    private fun scrubberBusy() = ::scrubber.isInitialized && scrubber.isPressed

    private fun updatePlayIcons(playing: Boolean) {
        updatePipActions()
        val res = if (playing) R.drawable.ic_pause else R.drawable.ic_play
        listOf(bigPlay, playIcon).forEach { b ->
            (b.getChildAt(0) as ImageView).setImageDrawable(androidx.core.content.ContextCompat.getDrawable(this, res)?.mutate())
        }
    }

    private fun showSpinner(msg: String) {
        spinnerMsg.text = msg
        spinnerMsg.visibility = if (msg.isEmpty()) View.GONE else View.VISIBLE
        spinner.visibility = View.VISIBLE
    }

    private fun hideSpinner() {
        if (!errored) spinner.visibility = View.GONE
    }

    private val toastHide = Runnable { toast.visibility = View.GONE }

    private fun toast(msg: String) {
        toast.text = msg
        toast.visibility = View.VISIBLE
        handler.removeCallbacks(toastHide)
        handler.postDelayed(toastHide, 1600)
    }

    override fun dispatchKeyEvent(e: KeyEvent): Boolean {
        if (e.action != KeyEvent.ACTION_DOWN) return super.dispatchKeyEvent(e)
        val k = e.keyCode
        when (k) {
            KeyEvent.KEYCODE_BACK, KeyEvent.KEYCODE_ESCAPE -> {
                if (panelName != null) closePanel() else finishWithClosed()
                return true
            }
            KeyEvent.KEYCODE_MEDIA_PLAY_PAUSE, KeyEvent.KEYCODE_SPACE -> { togglePlay(); return true }
            KeyEvent.KEYCODE_MEDIA_PLAY -> { setPlaying(true); return true }
            KeyEvent.KEYCODE_MEDIA_PAUSE -> { setPlaying(false); return true }
            KeyEvent.KEYCODE_MEDIA_FAST_FORWARD -> { seekBy(PlayerLogic.SEEK_STEP_S); return true }
            KeyEvent.KEYCODE_MEDIA_REWIND -> { seekBy(-PlayerLogic.SEEK_STEP_S); return true }
            KeyEvent.KEYCODE_MEDIA_NEXT -> if (nextEpisode != null) { requestNextEpisode(); return true }
        }
        if (panelName != null) return super.dispatchKeyEvent(e)
        scheduleHide()
        if (!controlsVisible) {
            when (k) {
                KeyEvent.KEYCODE_DPAD_CENTER, KeyEvent.KEYCODE_ENTER -> {
                    if (skipButton.visibility == View.VISIBLE) doSkip()
                    else if (nextCard.visibility == View.VISIBLE) requestNextEpisode()
                    else togglePlay()
                    return true
                }
                KeyEvent.KEYCODE_DPAD_LEFT -> { seekBy(-PlayerLogic.SEEK_STEP_S); return true }
                KeyEvent.KEYCODE_DPAD_RIGHT -> { seekBy(PlayerLogic.SEEK_STEP_S); return true }
                KeyEvent.KEYCODE_DPAD_UP, KeyEvent.KEYCODE_DPAD_DOWN -> { showControls(); return true }
            }
        }
        return super.dispatchKeyEvent(e)
    }

    // ---------- Image dans l'image ----------

    private fun pipSupported() = Build.VERSION.SDK_INT >= 26 && packageManager.hasSystemFeature(PackageManager.FEATURE_PICTURE_IN_PICTURE)

    private fun pipActions(): List<RemoteAction> {
        val playing = ::player.isInitialized && player.isPlaying
        val pi = PendingIntent.getBroadcast(this, 0, Intent(PIP_ACTION).setPackage(packageName), PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT)
        val label = if (playing) "Pause" else "Lecture"
        return listOf(RemoteAction(Icon.createWithResource(this, if (playing) R.drawable.ic_pause else R.drawable.ic_play), label, label, pi))
    }

    private fun updatePipActions() {
        if (Build.VERSION.SDK_INT >= 26 && isInPictureInPictureMode) {
            try { setPictureInPictureParams(PictureInPictureParams.Builder().setActions(pipActions()).build()) } catch (_: Exception) { }
        }
    }

    private fun enterPip() {
        if (!pipSupported()) { toast("Image dans l’image indisponible ici"); return }
        try {
            var w = 16
            var h = 9
            try {
                val v = player.currentVideoTrack
                if (v != null && v.width > 0 && v.height > 0) { w = v.width; h = v.height }
            } catch (_: Exception) { }
            val ratio = Rational(w, h).let { if (it.toFloat() > 2.39f) Rational(239, 100) else if (it.toFloat() < 0.42f) Rational(100, 239) else it }
            hideControls()
            enterPictureInPictureMode(PictureInPictureParams.Builder().setAspectRatio(ratio).setActions(pipActions()).build())
        } catch (_: Exception) {
            toast("Image dans l’image refusée")
        }
    }

    // ---------- Focus audio ----------

    private val focusListener = AudioManager.OnAudioFocusChangeListener { change ->
        if (change == AudioManager.AUDIOFOCUS_LOSS || change == AudioManager.AUDIOFOCUS_LOSS_TRANSIENT) {
            if (::player.isInitialized && player.isPlaying) player.pause()
        }
    }

    @Suppress("DEPRECATION")
    private fun requestAudioFocus() {
        if (audioFocusHeld) return
        val am = getSystemService(Context.AUDIO_SERVICE) as AudioManager
        audioFocusHeld = am.requestAudioFocus(focusListener, AudioManager.STREAM_MUSIC, AudioManager.AUDIOFOCUS_GAIN) == AudioManager.AUDIOFOCUS_REQUEST_GRANTED
    }

    @Suppress("DEPRECATION")
    private fun abandonAudioFocus() {
        if (!audioFocusHeld) return
        (getSystemService(Context.AUDIO_SERVICE) as AudioManager).abandonAudioFocus(focusListener)
        audioFocusHeld = false
    }
}
