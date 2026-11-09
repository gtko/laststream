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
import android.graphics.drawable.GradientDrawable
import android.media.AudioManager
import android.os.Build
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.provider.Settings
import android.text.TextUtils
import android.util.Rational
import android.view.GestureDetector
import android.view.Gravity
import android.view.KeyEvent
import android.view.MotionEvent
import android.view.View
import android.view.ViewConfiguration
import android.view.ViewGroup
import android.view.WindowManager
import android.widget.FrameLayout
import android.widget.HorizontalScrollView
import android.widget.ImageView
import android.widget.LinearLayout
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
import org.videolan.libvlc.MediaPlayer
import org.videolan.libvlc.util.VLCVideoLayout
import java.net.HttpURLConnection
import java.net.URL
import kotlin.concurrent.thread

/**
 * Lecteur plein écran natif (libVLC) : décodage matériel, toutes les pistes audio et sous-titres, image dans l'image.
 * L'habillage suit la maquette validée de LAST-1628, alignée sur le lecteur web : barre haute (retour, titre, réduire, PiP,
 * réglages), trio central −10 s / lecture / +10 s, barre basse (progression puis pilules), panneaux à droite, salon,
 * fin d'épisode, gestes (luminosité, volume, double-tap, verrou). La logique de session (progression enregistrée,
 * segments, épisode suivant) reste côté JS : l'activité n'émet que des évènements.
 */
class PlayerActivity : AppCompatActivity(), PlayerControl, PlaybackCore.Ui {
    private lateinit var kit: UiKit
    private lateinit var core: PlaybackCore
    private val player: MediaPlayer get() = core.player
    private lateinit var videoLayout: VLCVideoLayout
    private lateinit var root: FrameLayout
    private lateinit var ui: FrameLayout
    private lateinit var controls: FrameLayout
    private lateinit var spinner: LinearLayout
    private lateinit var spinnerRing: RingView
    private lateinit var spinnerMsg: TextView
    private lateinit var errorActions: LinearLayout
    private lateinit var errorSources: View
    private lateinit var titleView: TextView
    private lateinit var subtitleView: TextView
    private lateinit var scrubber: ScrubberView
    private var social: SocialOverlay? = null
    private lateinit var timeView: TextView
    private lateinit var centerRow: LinearLayout
    private lateinit var bigPlay: FrameLayout
    private lateinit var skipButton: LinearLayout
    private lateinit var skipLabel: TextView
    private lateinit var endLayer: LinearLayout
    private lateinit var nextCard: LinearLayout
    private lateinit var nextTitle: TextView
    private lateinit var nextStillBox: FrameLayout
    private lateinit var creditsSkip: View
    /** Mention de salon pour un invité (LAST-1632) : « seul l'hôte lance l'épisode suivant ». */
    private lateinit var hostNote: TextView
    /** Largeur disponible pour laquelle la carte « épisode suivant » a été calée (-1 : pas encore). */
    private var nextCardFor = -1
    private lateinit var nextStill: ImageView
    private lateinit var nextRing: RingView
    private lateinit var panel: FrameLayout
    private lateinit var panelBody: LinearLayout
    private lateinit var toast: TextView
    private lateinit var pipButton: FrameLayout
    private val pillViews = LinkedHashMap<Pill, View>()
    private lateinit var lockedLayer: FrameLayout
    private lateinit var unlockPill: LinearLayout
    private lateinit var lockButton: View
    private lateinit var brightnessGauge: LevelGauge
    private lateinit var volumeGauge: LevelGauge
    private lateinit var rippleBack: TextView
    private lateinit var rippleFwd: TextView
    private lateinit var gestures: GestureDetector

    private val handler = Handler(Looper.getMainLooper())
    private var nextDismissed = false
    /** Demande d'épisode suivant en cours : le JS n'a pas encore chargé le média suivant. */
    private var nextRequested = false
    private var controlsVisible = false
    private var panelName: String? = null
    private var closedSent = false
    private var silentClose = false
    /** Dernière requête écrite dans `PlayerHub.pending` par cette activité : seule celle-là lui appartient. */
    private var ownPending: OpenRequest? = null
    private var resumeOnStart = false
    /** La lecture a été confiée à la vignette flottante : l'activité se ferme sans la toucher. */
    private var handedOff = false
    private var panelSeason = 0
    private val images = ImageLoader()
    /** Écran verrouillé : seul le bouton « appui long pour déverrouiller » répond au toucher. */
    private var locked = false

    // Glisser vertical (luminosité / volume).
    private var dragX = 0f
    private var dragY = 0f
    private var dragKind = DragKind.NONE
    private var dragActive = false
    private var dragStart = 0f
    private var brightness = -1f
    /** Volume maximal lu au début du glisser, et dernier cran / niveau appliqués (pas d'appel système redondant). */
    private var dragMaxVolume = 0
    private var dragLastVolume = -1
    private var dragLastBrightness = -1f

    // L'état de lecture vit dans PlaybackCore (partagé avec la vignette) ; l'activité n'en garde qu'une vue.
    private var req: OpenRequest?
        get() = core.req
        set(v) { core.req = v }
    private val segments: List<SkipSegment> get() = core.segments
    private val nextEpisode: NextEpisodeInfo? get() = core.nextEpisode
    private val sources: List<SourceItem> get() = core.sources
    private val episodes: EpisodesData? get() = core.episodes
    private val aspect: AspectMode get() = core.aspect
    private val rate: Double get() = core.rate
    private val subDelayMs: Long get() = core.subDelayMs
    // Lus dès la construction de l'interface (SocialOverlay lit la durée à sa création) : `core` n'existe pas encore alors.
    private val errored: Boolean get() = ::core.isInitialized && core.errored
    private val lastPos: Double get() = if (::core.isInitialized) core.lastPos else 0.0
    private val lastDur: Double get() = if (::core.isInitialized) core.lastDur else 0.0
    private val audioTracks: List<TrackInfo> get() = core.audioTracks
    private val subTracks: List<TrackInfo> get() = core.subTracks

    private val pipReceiver = object : BroadcastReceiver() {
        override fun onReceive(c: Context, i: Intent) {
            if (i.action == PIP_ACTION && ::core.isInitialized) { setPlaying(!player.isPlaying); updatePipActions() }
        }
    }

    companion object {
        const val PIP_ACTION = "com.laststream.app.PIP_TOGGLE"
    }

    // ---------- Cycle de vie ----------

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        PlayerHub.activity = this
        kit = UiKit(this)
        window.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
        WindowCompat.setDecorFitsSystemWindows(window, false)
        buildUi()
        enterImmersive()
        // La lecture d'une vignette qu'on agrandit est reprise telle quelle ; sinon une nouvelle instance libVLC.
        val shared = PlayerHub.core?.takeIf { !it.released && it.req != null && PlayerHub.adopt }
        PlayerHub.adopt = false
        core = shared ?: PlaybackCore.create(this).also { PlayerHub.core = it }
        core.ui = this
        core.attach(videoLayout)
        val pend = PlayerHub.pending
        ownPending = pend // aussi sur le chemin `adopt` (agrandissement de la vignette) : sans lui, `pending` ne serait jamais effacé
        if (shared != null) adopt(shared)
        else if (pend != null) load(pend) else { silentClose = true; finish() }
        PlayerHub.machine.open()
        ContextCompat.registerReceiver(this, pipReceiver, IntentFilter(PIP_ACTION), ContextCompat.RECEIVER_NOT_EXPORTED)
        if (shared != null && PlayerHub.enterPipOnStart) {
            PlayerHub.enterPipOnStart = false
            handler.post { if (!isFinishing) enterPip() }
        }
    }

    override fun onNewIntent(intent: android.content.Intent) {
        super.onNewIntent(intent)
        PlayerHub.pending?.let { load(it) }
    }

    override fun onStart() {
        super.onStart()
        if (resumeOnStart && ::core.isInitialized) { resumeOnStart = false; setPlaying(true) }
        if (stalledPending) handler.post(stalledRunnable) // retour d'arrière-plan avec un « suivant » resté sans réponse
    }

    override fun onStop() {
        super.onStop()
        if (!isInPictureInPictureMode && !handedOff && ::core.isInitialized) {
            resumeOnStart = player.isPlaying
            if (player.isPlaying) player.pause()
            if (!isFinishing) rememberPosition() // fermée (épisode suivant) : `pending` appartient déjà au prochain média
            emitState(true)
            emitProgress(true)
        }
    }

    /** Position courante gardée dans la requête en attente : une activité recréée reprend là où elle était. */
    private fun rememberPosition() {
        if (!::core.isInitialized) return
        val snap = core.snapshot()
        ownPending = snap
        PlayerHub.pending = snap
    }

    override fun onDestroy() {
        handler.removeCallbacksAndMessages(null)
        try { unregisterReceiver(pipReceiver) } catch (_: Exception) { }
        if (PlayerHub.activity === this) PlayerHub.activity = null
        // Fermeture définitive : l'état social (désactivé par défaut) ne doit pas fuiter vers le prochain lecteur ; la réduction en vignette le garde.
        if (SocialLogic.shouldResetOnDestroy(isFinishing, handedOff, PlayerHub.socialOverlay === social)) PlayerHub.social = SocialState()
        if (PlayerHub.socialOverlay === social) PlayerHub.socialOverlay = null
        social?.destroy()
        images.shutdown()
        if (::core.isInitialized && !handedOff) {
            if (!closedSent && !silentClose && isFinishing) emitClosed()
            // `pending` n'est effacé que s'il est encore le nôtre : après un épisode suivant, il appartient au prochain média.
            if (isFinishing) { if (PlayerLogic.shouldClearPending(PlayerHub.pending, ownPending)) PlayerHub.pending = null } else rememberPosition()
            if (core.ui === this) core.ui = null
            if (PlayerHub.core === core) PlayerHub.core = null
            PlayerHub.machine.close()
            // Plus d'évènements ni de surface ; seule la libération (bloquante) passe en arrière-plan.
            core.release()
        }
        super.onDestroy()
    }

    override fun finish() {
        if (PlayerHub.activity === this) PlayerHub.activity = null
        super.finish()
    }

    override fun onUserLeaveHint() {
        super.onUserLeaveHint()
        if (!handedOff && ::core.isInitialized && player.isPlaying && pipSupported()) enterPip()
    }

    override fun onPictureInPictureModeChanged(isInPictureInPictureMode: Boolean, newConfig: android.content.res.Configuration) {
        super.onPictureInPictureModeChanged(isInPictureInPictureMode, newConfig)
        ui.visibility = if (isInPictureInPictureMode) View.GONE else View.VISIBLE
        // La luminosité choisie au glisser ne s'applique qu'au plein écran : en PiP, celle du système reprend.
        if (brightness >= 0f) applyWindowBrightness(if (isInPictureInPictureMode) WindowManager.LayoutParams.BRIGHTNESS_OVERRIDE_NONE else PlayerUiLogic.windowBrightness(brightness))
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

    // ---------- Réduction en vignette ----------

    /** Confie la lecture à la vignette flottante au-dessus de l'interface web ; faux si impossible (pas d'hôte, télévision). */
    override fun minimize(): Boolean {
        if (handedOff || isFinishing || !::core.isInitialized) return false
        val host = PlayerHub.plugin?.activity ?: return false
        if (!MiniPlayer.supported(host)) return false
        rememberPosition()
        handedOff = true
        PlayerHub.pending = null
        core.ui = null
        core.detach()
        if (!MiniPlayer.show(host, core)) {
            // Échec de la mise en place : on reprend le plein écran tel quel.
            handedOff = false
            core.ui = this
            core.attach(videoLayout)
            return false
        }
        finish()
        return true
    }

    /** Reprise d'une lecture déjà en cours (agrandissement de la vignette) : interface remise à jour, média intact. */
    private fun adopt(c: PlaybackCore) {
        val r = c.req ?: return
        setHeading(r.title, r.subtitle)
        setNextEpisode(c.nextEpisode)
        setSources(c.sources)
        setEpisodes(c.episodes)
        hideEnd()
        skipButton.visibility = View.GONE
        closePanel()
        if (player.isPlaying) { hideSpinner(); updatePlayIcons(true) } else if (c.errored) showSpinner("") else { hideSpinner(); updatePlayIcons(false) }
        updateMarks()
        c.refreshTracks()
        showControls()
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

        controls = FrameLayout(this)
        ui.addView(controls, FrameLayout.LayoutParams(-1, -1))
        controls.addView(gradientView(true), FrameLayout.LayoutParams(-1, kit.dp(130), Gravity.TOP))
        controls.addView(gradientView(false), FrameLayout.LayoutParams(-1, kit.dp(190), Gravity.BOTTOM))
        buildTop()
        buildCenter()
        buildBottom()
        lockButton = kit.iconButton(R.drawable.ic_lock, "Verrouiller l’écran", 44, 22, Tokens.GLASS) { lock() }
        controls.addView(
            lockButton,
            FrameLayout.LayoutParams(kit.dp(44), kit.dp(44), Gravity.START or Gravity.CENTER_VERTICAL).apply { leftMargin = kit.dp(24) },
        )

        // Au-dessus des contrôles, centré et à sa taille : les touchers autour continuent d'atteindre la vidéo.
        buildSpinner()
        buildGestureFeedback()

        skipLabel = kit.text("", 14f, Tokens.TEXT, 700, sora = true)
        skipButton = skipStyleButton(R.drawable.ic_skip, skipLabel) { doSkip() }
        ui.addView(skipButton, FrameLayout.LayoutParams(-2, -2, Gravity.END or Gravity.BOTTOM).apply { rightMargin = kit.dp(24); bottomMargin = kit.dp(24) })

        social = SocialOverlay(
            this, kit, ui, controls, scrubber,
            position = { lastPos }, duration = { lastDur },
            seek = { seekTo(it) },
            interact = { scheduleHide() },
            onChanged = { updatePills(); updateHostNote() },
        )
        PlayerHub.socialOverlay = social
        updatePills()

        buildEndLayer()
        buildPanel()

        toast = kit.text("", 14f, Tokens.TEXT, 700).apply {
            visibility = View.GONE
            setPadding(kit.dp(16), kit.dp(9), kit.dp(16), kit.dp(9))
            background = kit.round(Tokens.CARD, 999f, Tokens.BORDER, 1)
        }
        ui.addView(toast, FrameLayout.LayoutParams(-2, -2, Gravity.CENTER_HORIZONTAL or Gravity.BOTTOM).apply { bottomMargin = kit.dp(140) })

        buildLockedLayer()

        gestures = GestureDetector(this, object : GestureDetector.SimpleOnGestureListener() {
            override fun onDown(e: MotionEvent) = true
            override fun onSingleTapConfirmed(e: MotionEvent): Boolean {
                if (panelName != null) closePanel() else if (controlsVisible) hideControls() else showControls()
                return true
            }
            override fun onFling(e1: MotionEvent?, e2: MotionEvent, velocityX: Float, velocityY: Float): Boolean {
                if (e1 == null || panelName != null || dragActive || root.height <= 0) return false
                // Réduire en vignette : glisser vers le bas depuis le haut de l'écran (le reste sert à la luminosité / au volume).
                if (PlayerUiLogic.dragKind(e1.x / root.width, e1.y / root.height) != DragKind.MINIMIZE) return false
                if (MiniLogic.isMinimizeSwipe(e2.x - e1.x, e2.y - e1.y, velocityY, resources.displayMetrics.density)) return minimize()
                return false
            }
            override fun onDoubleTap(e: MotionEvent): Boolean {
                when (PlayerUiLogic.doubleTapDirection(e.x / root.width)) {
                    -1 -> { seekBy(-PlayerLogic.SEEK_STEP_S, gesture = true); ripple(rippleBack) }
                    1 -> { seekBy(PlayerLogic.SEEK_STEP_S, gesture = true); ripple(rippleFwd) }
                    else -> togglePlay()
                }
                return true
            }
        })
        videoLayout.setOnTouchListener { _, e -> onSurfaceTouch(e) }
        controls.setOnTouchListener { _, e -> onSurfaceTouch(e) }
        setContentView(root)
        controls.visibility = View.GONE
    }

    private fun gradientView(top: Boolean) = View(this).apply {
        background = GradientDrawable(
            GradientDrawable.Orientation.TOP_BOTTOM,
            if (top) intArrayOf(0xB8000000.toInt(), 0x00000000) else intArrayOf(0x00000000, 0xD9000000.toInt()),
        )
        importantForAccessibility = View.IMPORTANT_FOR_ACCESSIBILITY_NO
    }

    private fun buildTop() {
        val bar = LinearLayout(this).apply {
            orientation = LinearLayout.HORIZONTAL
            gravity = Gravity.CENTER_VERTICAL
            setPadding(kit.dp(20), kit.dp(14), kit.dp(20), 0)
        }
        bar.addView(kit.iconButton(R.drawable.ic_back, "Retour", 44, 22) { if (!minimize()) finishWithClosed() })
        val heading = LinearLayout(this).apply { orientation = LinearLayout.VERTICAL; setPadding(kit.dp(10), 0, kit.dp(10), 0) }
        titleView = kit.text("", 18f, Tokens.TEXT, 800, sora = true).apply { maxLines = 1; ellipsize = TextUtils.TruncateAt.END }
        subtitleView = kit.text("", 13f, Tokens.SECONDARY, 500).apply { maxLines = 1; ellipsize = TextUtils.TruncateAt.END; setPadding(0, kit.dp(3), 0, 0) }
        heading.addView(titleView)
        heading.addView(subtitleView)
        bar.addView(heading, LinearLayout.LayoutParams(0, -2, 1f))
        if (MiniPlayer.supported(this)) bar.addView(kit.iconButton(R.drawable.ic_minimize, "Réduire en vignette", 44, 22) { minimize() })
        pipButton = kit.iconButton(R.drawable.ic_pip, "Image dans l’image", 44, 22) { enterPip() }
        pipButton.visibility = if (pipSupported()) View.VISIBLE else View.GONE
        bar.addView(pipButton)
        bar.addView(kit.iconButton(R.drawable.ic_gear, "Réglages (vitesse, format)", 44, 22) { openPanel("settings") })
        controls.addView(bar, FrameLayout.LayoutParams(-1, -2, Gravity.TOP))
    }

    private fun buildCenter() {
        centerRow = LinearLayout(this).apply { orientation = LinearLayout.HORIZONTAL; gravity = Gravity.CENTER }
        centerRow.addView(kit.iconButton(R.drawable.ic_back10, "Reculer de 10 secondes", 56, 26, Tokens.GLASS) { seekBy(-PlayerLogic.SEEK_STEP_S) })
        centerRow.addView(kit.spacer(36))
        bigPlay = kit.iconButton(R.drawable.ic_play, "Lecture", 76, 34, Tokens.GLASS) { togglePlay() }
        centerRow.addView(bigPlay)
        centerRow.addView(kit.spacer(36))
        centerRow.addView(kit.iconButton(R.drawable.ic_fwd10, "Avancer de 10 secondes", 56, 26, Tokens.GLASS) { seekBy(PlayerLogic.SEEK_STEP_S) })
        controls.addView(centerRow, FrameLayout.LayoutParams(-2, -2, Gravity.CENTER))
    }

    private fun buildBottom() {
        val box = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(kit.dp(16), 0, kit.dp(24), kit.dp(10))
        }
        scrubber = ScrubberView(this).apply {
            onScrub = { f, final ->
                val dur = lastDur
                if (dur > 0) {
                    val target = f * dur
                    timeView.text = PlayerUiLogic.timeLabel(target, dur)
                    if (final) seekTo(target)
                    scheduleHide()
                }
            }
            onStep = { delta -> seekBy(delta) }
            onScrubCancel = { scheduleHide() } // glissé annulé : pas de saut, mais le masquage automatique reprend
        }
        box.addView(scrubber, LinearLayout.LayoutParams(-1, -2))
        val row = LinearLayout(this).apply { orientation = LinearLayout.HORIZONTAL; gravity = Gravity.CENTER_VERTICAL; setPadding(kit.dp(12), kit.dp(2), 0, 0) }
        timeView = kit.tabular(kit.text("0:00 / 0:00", 14f, Tokens.TEXT, 700))
        row.addView(timeView)
        val pills = LinearLayout(this).apply { orientation = LinearLayout.HORIZONTAL; gravity = Gravity.CENTER_VERTICAL or Gravity.END }
        pillViews[Pill.REACT] = kit.pill(R.drawable.ic_smile, "Réagir", "Réagir avec un emoji", accent = true) { social?.toggleFan() }
        pillViews[Pill.EPISODES] = kit.pill(R.drawable.ic_list, "Épisodes") { openPanel("episodes") }
        pillViews[Pill.TRACKS] = kit.pill(R.drawable.ic_tracks, "Audio et sous-titres") { openPanel("tracks") }
        pillViews[Pill.SOURCES] = kit.pill(R.drawable.ic_sources, "Sources") { openPanel("sources") }
        pillViews[Pill.NEXT] = kit.pill(R.drawable.ic_next, "Suivant", "Épisode suivant") { requestNextEpisode() }
        pillViews.values.forEach { pills.addView(it) }
        // Petits écrans : les pilules défilent plutôt que de se chevaucher ; alignées à droite quand elles tiennent.
        val scroller = HorizontalScrollView(this).apply { isHorizontalScrollBarEnabled = false; isFillViewport = true; addView(pills, FrameLayout.LayoutParams(-1, -2)) }
        row.addView(scroller, LinearLayout.LayoutParams(0, -2, 1f).apply { marginStart = kit.dp(8) })
        box.addView(row, LinearLayout.LayoutParams(-1, -2))
        controls.addView(box, FrameLayout.LayoutParams(-1, -2, Gravity.BOTTOM))
    }

    /** Pilules visibles selon le contexte (social, épisodes, sources, épisode suivant). */
    private fun updatePills() {
        if (pillViews.isEmpty()) return
        val ready = ::core.isInitialized
        val visible = PlayerUiLogic.pills(
            react = social?.reactAvailable == true,
            hasEpisodes = ready && episodes != null,
            hasSources = ready && sources.isNotEmpty(),
            hasNext = ready && nextEpisode != null,
        )
        pillViews.forEach { (p, v) -> v.visibility = if (p in visible) View.VISIBLE else View.GONE }
    }

    private fun buildSpinner() {
        spinner = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            gravity = Gravity.CENTER_HORIZONTAL
            visibility = View.GONE
        }
        spinnerRing = RingView(this, 4f, 0x26FFFFFF, Tokens.ACCENT).apply { contentDescription = "Chargement" }
        spinner.addView(spinnerRing, LinearLayout.LayoutParams(kit.dp(54), kit.dp(54)))
        spinnerMsg = kit.text("", 13f, Tokens.TEXT, 600).apply {
            gravity = Gravity.CENTER
            setPadding(kit.dp(12), kit.dp(6), kit.dp(12), kit.dp(6))
            background = kit.round(0x990C0B11.toInt(), 999f)
        }
        spinner.addView(spinnerMsg, LinearLayout.LayoutParams(-2, -2).apply { topMargin = kit.dp(12) })
        // Erreur : la recherche d'une autre source continue, mais on peut choisir soi-même ou quitter.
        errorActions = LinearLayout(this).apply { orientation = LinearLayout.HORIZONTAL; gravity = Gravity.CENTER; visibility = View.GONE }
        errorSources = kit.pill(R.drawable.ic_sources, "Choisir une source") { openPanel("sources") }
        errorActions.addView(errorSources)
        errorActions.addView(kit.pill(R.drawable.ic_close, "Fermer", "Fermer le lecteur") { finishWithClosed() })
        spinner.addView(errorActions, LinearLayout.LayoutParams(-2, -2).apply { topMargin = kit.dp(10) })
        ui.addView(spinner, FrameLayout.LayoutParams(-2, -2, Gravity.CENTER))
    }

    private fun buildGestureFeedback() {
        brightnessGauge = LevelGauge(this, kit, R.drawable.ic_sun, "Luminosité")
        volumeGauge = LevelGauge(this, kit, R.drawable.ic_volume, "Volume")
        ui.addView(brightnessGauge, FrameLayout.LayoutParams(kit.dp(52), kit.dp(200), Gravity.START or Gravity.CENTER_VERTICAL).apply { leftMargin = kit.dp(40) })
        ui.addView(volumeGauge, FrameLayout.LayoutParams(kit.dp(52), kit.dp(200), Gravity.END or Gravity.CENTER_VERTICAL).apply { rightMargin = kit.dp(40) })
        fun rippleView(label: String) = kit.text(label, 18f, Tokens.TEXT, 800, sora = true).apply {
            gravity = Gravity.CENTER
            visibility = View.GONE
            importantForAccessibility = View.IMPORTANT_FOR_ACCESSIBILITY_NO
            background = GradientDrawable().apply { shape = GradientDrawable.OVAL; setColor(0x1FFFFFFF) }
        }
        rippleBack = rippleView("−10 s")
        rippleFwd = rippleView("+10 s")
        ui.addView(rippleBack, FrameLayout.LayoutParams(kit.dp(120), kit.dp(120), Gravity.START or Gravity.CENTER_VERTICAL).apply { leftMargin = kit.dp(110) })
        ui.addView(rippleFwd, FrameLayout.LayoutParams(kit.dp(120), kit.dp(120), Gravity.END or Gravity.CENTER_VERTICAL).apply { rightMargin = kit.dp(110) })
    }

    /** Onde du double-tap : apparaît, grossit légèrement puis s'efface. */
    private fun ripple(v: TextView) {
        v.animate().cancel()
        v.animate().setStartDelay(0) // un double-tap répété ne doit pas hériter du délai de fondu
        v.visibility = View.VISIBLE
        v.alpha = 1f
        v.scaleX = 0.85f
        v.scaleY = 0.85f
        v.animate().scaleX(1.05f).scaleY(1.05f).setDuration(220).withEndAction {
            v.animate().alpha(0f).setStartDelay(250).setDuration(300).withEndAction { v.visibility = View.GONE }.start()
        }.start()
    }

    /** Bouton de saut (intro, générique) : liseré blanc, coins presque droits, comme le lecteur web. */
    private fun skipStyleButton(icon: Int, label: TextView, onClick: () -> Unit) = LinearLayout(this).apply {
        orientation = LinearLayout.HORIZONTAL
        gravity = Gravity.CENTER_VERTICAL
        isFocusable = true
        isClickable = true
        visibility = View.GONE
        minimumHeight = kit.dp(44)
        setPadding(kit.dp(18), 0, kit.dp(18), 0)
        background = kit.focusBackground(4f, Tokens.GLASS, Tokens.TEXT, false)
        foreground = kit.round(Color.TRANSPARENT, 4f, 0xB3FFFFFF.toInt(), 1)
        addView(kit.icon(icon, 18).apply { (layoutParams as LinearLayout.LayoutParams).marginEnd = kit.dp(8) })
        addView(label)
        setOnClickListener { onClick() }
        setOnFocusChangeListener { _, f -> label.setTextColor(if (f) Tokens.BG else Tokens.TEXT); (getChildAt(0) as ImageView).setColorFilter(if (f) Tokens.BG else Color.WHITE) }
    }

    private fun buildEndLayer() {
        // Une seule ligne en bas : « Passer le générique » à gauche, carte de l'épisode suivant à droite.
        endLayer = LinearLayout(this).apply { orientation = LinearLayout.HORIZONTAL; gravity = Gravity.BOTTOM; visibility = View.GONE; setPadding(kit.dp(24), 0, kit.dp(24), 0) }
        val creditsLabel = kit.text("Passer le générique", 14f, Tokens.TEXT, 700, sora = true)
        creditsSkip = skipStyleButton(R.drawable.ic_skip_credits, creditsLabel) { skipCredits() }.apply {
            visibility = View.VISIBLE
            contentDescription = "Passer le générique"
        }
        // Colonne de gauche : « Passer le générique », puis la mention de salon pour un invité (maquette « Fin d'épisode »).
        hostNote = kit.text("", 13f, Tokens.SECONDARY, 500).apply {
            text = android.text.SpannableStringBuilder().apply {
                append("Salon : ", android.text.style.ForegroundColorSpan(Tokens.AMBER), android.text.Spanned.SPAN_EXCLUSIVE_EXCLUSIVE)
                append("seul l'hôte lance l'épisode suivant, les invités suivent automatiquement.")
            }
            visibility = View.GONE
            maxWidth = kit.dp(260)
            setLineSpacing(0f, 1.25f)
            setPadding(kit.dp(12), kit.dp(10), kit.dp(12), kit.dp(10))
            background = kit.round(Tokens.CARD_SOFT, 12f, Tokens.BORDER, 1)
        }
        val left = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            addView(creditsSkip, LinearLayout.LayoutParams(-2, -2))
            addView(hostNote, LinearLayout.LayoutParams(-2, -2).apply { topMargin = kit.dp(12) })
        }
        endLayer.addView(left, LinearLayout.LayoutParams(-2, -2))
        endLayer.addView(View(this), LinearLayout.LayoutParams(0, 1, 1f).apply { marginStart = kit.dp(12) })

        nextStill = ImageView(this).apply { scaleType = ImageView.ScaleType.CENTER_CROP; importantForAccessibility = View.IMPORTANT_FOR_ACCESSIBILITY_NO }
        val still = FrameLayout(this).apply { background = kit.round(0xFF3A3647.toInt(), 10f); clipToOutline = true; addView(nextStill, FrameLayout.LayoutParams(-1, -1)) }
        nextStillBox = still
        nextTitle = kit.text("", 16f, Tokens.TEXT, 800, sora = true).apply { maxLines = 1; ellipsize = TextUtils.TruncateAt.END; setPadding(0, kit.dp(6), 0, kit.dp(10)) }
        val body = LinearLayout(this).apply { orientation = LinearLayout.VERTICAL; gravity = Gravity.CENTER_VERTICAL; setPadding(kit.dp(14), 0, 0, 0) }
        body.addView(kit.text("ÉPISODE SUIVANT", 11f, Tokens.ACCENT, 800, sora = true).apply { letterSpacing = 0.08f })
        body.addView(nextTitle)
        val actions = LinearLayout(this).apply { orientation = LinearLayout.HORIZONTAL; gravity = Gravity.CENTER_VERTICAL }
        nextRing = RingView(this, 3f, 0x400C0B11, Tokens.BG).apply { spinning = false; showPlay = true; importantForAccessibility = View.IMPORTANT_FOR_ACCESSIBILITY_NO }
        val go = LinearLayout(this).apply {
            orientation = LinearLayout.HORIZONTAL
            gravity = Gravity.CENTER_VERTICAL
            isFocusable = true
            isClickable = true
            contentDescription = "Lire maintenant l’épisode suivant"
            minimumHeight = kit.dp(44)
            setPadding(kit.dp(6), 0, kit.dp(14), 0)
            background = android.graphics.drawable.InsetDrawable(kit.focusBackground(999f, Tokens.ACCENT, Tokens.ACCENT, true), 0, kit.dp(2), 0, kit.dp(2))
            addView(nextRing, LinearLayout.LayoutParams(kit.dp(30), kit.dp(30)).apply { marginEnd = kit.dp(8) })
            addView(kit.text("Lire maintenant", 14f, Tokens.BG, 700, sora = true))
            setOnClickListener { requestNextEpisode() }
        }
        actions.addView(go)
        actions.addView(LinearLayout(this).apply {
            orientation = LinearLayout.HORIZONTAL
            gravity = Gravity.CENTER_VERTICAL
            isFocusable = true
            isClickable = true
            minimumHeight = kit.dp(44)
            setPadding(kit.dp(14), 0, kit.dp(14), 0)
            background = android.graphics.drawable.InsetDrawable(kit.focusBackground(999f), 0, kit.dp(2), 0, kit.dp(2))
            foreground = android.graphics.drawable.InsetDrawable(kit.round(Color.TRANSPARENT, 999f, Tokens.BORDER, 1), 0, kit.dp(2), 0, kit.dp(2))
            addView(kit.text("Voir le générique", 14f, Tokens.SOFT, 600))
            setOnClickListener { nextDismissed = true; hideEnd() }
        }, LinearLayout.LayoutParams(-2, -2).apply { marginStart = kit.dp(8) })
        body.addView(actions)
        nextCard = LinearLayout(this).apply {
            orientation = LinearLayout.HORIZONTAL
            gravity = Gravity.CENTER_VERTICAL
            setPadding(kit.dp(12), kit.dp(12), kit.dp(12), kit.dp(12))
            background = kit.round(Tokens.CARD, 16f, Tokens.BORDER, 1)
            elevation = kit.dp(18).toFloat()
            addView(still, LinearLayout.LayoutParams(kit.dp(176), kit.dp(99)))
            addView(body, LinearLayout.LayoutParams(0, -2, 1f))
        }
        endLayer.addView(nextCard, LinearLayout.LayoutParams(kit.dp(520), -2))
        ui.addView(endLayer, FrameLayout.LayoutParams(-1, -2, Gravity.BOTTOM).apply { bottomMargin = kit.dp(24) })
        // Largeur de la carte calée sur la place réelle de `ui` (marges d'encoche et barres système comprises), à chaque mise en page.
        ui.addOnLayoutChangeListener { _, _, _, _, _, _, _, _, _ -> fitNextCard() }
        updateHostNote()
    }

    /** Carte « épisode suivant » : largeur bornée par la place laissée à « Passer le générique », vignette réduite si étroite. */
    private fun fitNextCard() {
        val available = ui.width - ui.paddingLeft - ui.paddingRight - endLayer.paddingLeft - endLayer.paddingRight
        if (available <= 0 || available == nextCardFor) return
        nextCardFor = available
        creditsSkip.measure(View.MeasureSpec.UNSPECIFIED, View.MeasureSpec.UNSPECIFIED)
        val cardW = PlayerUiLogic.nextCardWidth(available, creditsSkip.measuredWidth + kit.dp(12), kit.dp(520), kit.dp(240))
        val compact = cardW < kit.dp(500)
        ui.post {
            (nextStillBox.layoutParams as LinearLayout.LayoutParams).apply { width = kit.dp(if (compact) 120 else 176); height = kit.dp(if (compact) 68 else 99) }
            (nextCard.layoutParams as LinearLayout.LayoutParams).width = cardW
            nextCard.requestLayout()
        }
    }

    /** Mention de salon sur la carte de fin : un invité la voit, l'hôte et hors salon non (LAST-1632). */
    private fun updateHostNote() {
        if (!::hostNote.isInitialized) return
        val s = PlayerHub.social
        hostNote.visibility = if (SocialLogic.showHostNote(s.enabled, s.room)) View.VISIBLE else View.GONE
    }

    private fun hideEnd() { endLayer.visibility = View.GONE; updateCenter() }

    /** Trio central masqué (sans perdre sa place) quand l'anneau de chargement ou la carte de fin occupe l'écran. */
    private fun updateCenter() {
        val covered = spinner.visibility == View.VISIBLE || endLayer.visibility == View.VISIBLE
        centerRow.visibility = if (covered) View.INVISIBLE else View.VISIBLE
        // « Passer le générique » occupe la gauche en fin d'épisode : le verrou s'efface pour ne pas le chevaucher.
        lockButton.visibility = if (endLayer.visibility == View.VISIBLE) View.INVISIBLE else View.VISIBLE
    }

    /** « Passer le générique » : scène post-générique s'il y en a une plus loin, sinon épisode suivant. */
    private fun skipCredits() {
        val target = PlayerUiLogic.creditsSkipTarget(segments, lastPos)
        if (target == null) { requestNextEpisode(); return }
        nextDismissed = true
        hideEnd()
        seekTo(target)
    }

    private fun buildPanel() {
        panel = FrameLayout(this).apply {
            visibility = View.GONE
            setBackgroundColor(0x8C000000.toInt())
            isClickable = true
            setOnClickListener { closePanel() }
        }
        panelBody = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(kit.dp(22), kit.dp(18), kit.dp(18), kit.dp(18))
            // Fond du panneau et liseré gauche de 1 dp (blanc 10 %).
            background = android.graphics.drawable.LayerDrawable(arrayOf(
                android.graphics.drawable.ColorDrawable(Tokens.SHEET),
                android.graphics.drawable.ColorDrawable(0x1AFFFFFF),
            )).apply { setLayerWidth(1, kit.dp(1)); setLayerGravity(1, Gravity.START or Gravity.FILL_VERTICAL) }
            elevation = kit.dp(24).toFloat()
            isClickable = true
        }
        panel.addView(panelBody, FrameLayout.LayoutParams(kit.dp(460), -1, Gravity.END))
        ui.addView(panel, FrameLayout.LayoutParams(-1, -1))
    }

    // ---------- Écran verrouillé ----------

    private fun buildLockedLayer() {
        lockedLayer = FrameLayout(this).apply {
            visibility = View.GONE
            isClickable = true
            contentDescription = "Écran verrouillé"
            setOnClickListener { flashUnlock() }
        }
        unlockPill = LinearLayout(this).apply {
            orientation = LinearLayout.HORIZONTAL
            gravity = Gravity.CENTER_VERTICAL
            isFocusable = true
            isClickable = true
            isLongClickable = true
            contentDescription = "Écran verrouillé. Appui long pour déverrouiller"
            minimumHeight = kit.dp(44)
            setPadding(kit.dp(16), 0, kit.dp(16), 0)
            background = kit.focusBackground(999f, 0xB30C0B11.toInt())
            foreground = kit.round(Color.TRANSPARENT, 999f, 0x33FFFFFF, 1)
            addView(kit.icon(R.drawable.ic_lock, 18).apply { (layoutParams as LinearLayout.LayoutParams).marginEnd = kit.dp(8) })
            addView(kit.text("Écran verrouillé · appui long pour déverrouiller", 13f, Tokens.TEXT, 700, sora = true))
            setOnClickListener { flashUnlock() }
            setOnLongClickListener { unlock(); true }
        }
        ViewCompat.replaceAccessibilityAction(unlockPill, androidx.core.view.accessibility.AccessibilityNodeInfoCompat.AccessibilityActionCompat.ACTION_LONG_CLICK, "Déverrouiller", null)
        lockedLayer.addView(unlockPill, FrameLayout.LayoutParams(-2, -2, Gravity.BOTTOM or Gravity.CENTER_HORIZONTAL).apply { bottomMargin = kit.dp(20) })
        ui.addView(lockedLayer, FrameLayout.LayoutParams(-1, -1))
    }

    private val unlockHide = Runnable { unlockPill.animate().alpha(0f).setDuration(250).start() }

    /** Montre le bouton de déverrouillage quelques secondes. */
    private fun flashUnlock() {
        unlockPill.animate().cancel()
        unlockPill.alpha = 1f
        handler.removeCallbacks(unlockHide)
        handler.postDelayed(unlockHide, 2500)
    }

    private fun lock() {
        if (locked) return
        closePanel()
        social?.closeFan()
        hideControls()
        locked = true
        skipButton.visibility = View.GONE
        hideEnd()
        social?.setSuppressed(true)
        lockedLayer.visibility = View.VISIBLE
        flashUnlock()
        unlockPill.requestFocus()
    }

    private fun unlock() {
        if (!locked) return
        locked = false
        handler.removeCallbacks(unlockHide)
        lockedLayer.visibility = View.GONE
        social?.setSuppressed(false)
        showControls()
    }

    // ---------- Gestes sur la vidéo ----------

    private val audio: AudioManager? by lazy { getSystemService(Context.AUDIO_SERVICE) as? AudioManager }
    private val dragSlop: Float by lazy { ViewConfiguration.get(this).scaledTouchSlop * 1.5f }

    private fun onSurfaceTouch(e: MotionEvent): Boolean {
        if (locked) return true
        gestures.onTouchEvent(e)
        when (e.actionMasked) {
            MotionEvent.ACTION_DOWN -> {
                dragX = e.rawX
                dragY = e.rawY
                dragActive = false
                dragKind = if (root.width > 0 && root.height > 0) PlayerUiLogic.dragKind(e.rawX / root.width, e.rawY / root.height) else DragKind.NONE
            }
            MotionEvent.ACTION_MOVE -> {
                if (!dragActive && panelName == null && (dragKind == DragKind.BRIGHTNESS || dragKind == DragKind.VOLUME) &&
                    PlayerUiLogic.isVerticalDrag(e.rawX - dragX, e.rawY - dragY, dragSlop)
                ) {
                    dragActive = true
                    dragY = e.rawY // départ au point où le geste est reconnu : pas de saut
                    dragStart = if (dragKind == DragKind.VOLUME) currentVolume() else currentBrightness()
                    dragMaxVolume = audio?.getStreamMaxVolume(AudioManager.STREAM_MUSIC) ?: 0
                    dragLastVolume = -1
                    dragLastBrightness = -1f
                    handler.removeCallbacks(gaugeHide)
                }
                if (dragActive) applyDrag(PlayerUiLogic.dragLevel(dragStart, e.rawY - dragY, root.height.toFloat()))
            }
            MotionEvent.ACTION_UP, MotionEvent.ACTION_CANCEL -> if (dragActive) {
                dragActive = false
                handler.postDelayed(gaugeHide, 700)
            }
        }
        return true
    }

    private val gaugeHide = Runnable {
        listOf(brightnessGauge, volumeGauge).forEach { g -> g.animate().alpha(0f).setDuration(200).withEndAction { g.visibility = View.GONE }.start() }
    }

    private fun currentVolume(): Float {
        val a = audio ?: return 0f
        return PlayerUiLogic.volumeLevel(a.getStreamVolume(AudioManager.STREAM_MUSIC), a.getStreamMaxVolume(AudioManager.STREAM_MUSIC))
    }

    private fun currentBrightness(): Float {
        if (brightness >= 0f) return brightness
        val system = try { Settings.System.getInt(contentResolver, Settings.System.SCREEN_BRIGHTNESS) } catch (_: Exception) { null }
        return PlayerUiLogic.startBrightness(window.attributes.screenBrightness, system)
    }

    private fun applyWindowBrightness(value: Float) {
        val lp = window.attributes
        if (lp.screenBrightness == value) return
        lp.screenBrightness = value
        window.attributes = lp
    }

    private fun applyDrag(level: Float) {
        val gauge = if (dragKind == DragKind.VOLUME) volumeGauge else brightnessGauge
        val shown = if (dragKind == DragKind.VOLUME) {
            val a = audio ?: return
            val idx = PlayerUiLogic.volumeIndex(level, dragMaxVolume)
            if (idx != dragLastVolume) {
                dragLastVolume = idx
                try { a.setStreamVolume(AudioManager.STREAM_MUSIC, idx, 0) } catch (_: Exception) { } // « Ne pas déranger » peut refuser
            }
            PlayerUiLogic.volumeLevel(idx, dragMaxVolume)
        } else {
            brightness = level
            val applied = PlayerUiLogic.windowBrightness(level)
            if (applied != dragLastBrightness) { dragLastBrightness = applied; applyWindowBrightness(applied) }
            level
        }
        gauge.set(shown)
        if (gauge.visibility != View.VISIBLE || gauge.alpha < 1f) { gauge.animate().cancel(); gauge.alpha = 1f; gauge.visibility = View.VISIBLE }
    }

    // ---------- Panneaux (audio, sous-titres, réglages, sources, épisodes) ----------

    private class Row(val label: String, val selected: Boolean, val tag: String = "", val onClick: () -> Unit)

    private fun optionRow(r: Row): LinearLayout = LinearLayout(this).apply {
        orientation = LinearLayout.HORIZONTAL
        gravity = Gravity.CENTER_VERTICAL
        isFocusable = true
        isClickable = true
        minimumHeight = kit.dp(44)
        setPadding(kit.dp(12), kit.dp(6), kit.dp(12), kit.dp(6))
        background = kit.focusBackground(12f, if (r.selected) 0x24FF5A36 else Color.TRANSPARENT)
        tag = if (r.selected) "selected" else null
        contentDescription = r.label + (if (r.tag.isNotEmpty()) ", " + r.tag else "") + if (r.selected) ", sélectionné" else ""
        if (r.selected) addView(kit.icon(R.drawable.ic_check, 18, Tokens.ACCENT)) else addView(kit.spacer(18, 18))
        addView(kit.text(r.label, 14f, if (r.selected) Tokens.TEXT else Tokens.SOFT, 600).apply { maxLines = 2; ellipsize = TextUtils.TruncateAt.END }, LinearLayout.LayoutParams(0, -2, 1f).apply { marginStart = kit.dp(10) })
        if (r.tag.isNotEmpty()) addView(kit.text(r.tag, 11f, Tokens.DIM, 700), LinearLayout.LayoutParams(-2, -2).apply { marginStart = kit.dp(8) })
        setOnClickListener { r.onClick() }
    }

    private fun heading(title: String) = kit.text(title.uppercase(), 12f, Tokens.DIM, 800, sora = true).apply {
        letterSpacing = 0.08f
        setPadding(kit.dp(12), kit.dp(4), kit.dp(12), kit.dp(8))
    }

    private fun column(title: String, rows: List<Row>): LinearLayout {
        val col = LinearLayout(this).apply { orientation = LinearLayout.VERTICAL }
        col.addView(heading(title))
        rows.forEach { r -> col.addView(optionRow(r), LinearLayout.LayoutParams(-1, -2).apply { bottomMargin = kit.dp(2) }) }
        return col
    }

    /** Décalage des sous-titres par pas de 0,1 s (libVLC `setSpuDelay`, via PlaybackCore). */
    private fun delayControls(): View {
        val box = LinearLayout(this).apply {
            orientation = LinearLayout.HORIZONTAL
            gravity = Gravity.CENTER_VERTICAL
            setPadding(kit.dp(12), kit.dp(4), kit.dp(12), kit.dp(4))
            background = kit.round(0x0DFFFFFF, 14f)
        }
        box.addView(kit.text("Décalage des sous-titres", 13f, Tokens.SECONDARY, 500), LinearLayout.LayoutParams(0, -2, 1f))
        val value = kit.tabular(kit.text(PlayerLogic.formatDelay(subDelayMs), 14f, Tokens.TEXT, 700)).apply { gravity = Gravity.CENTER }
        fun step(by: Long) { setSubtitleDelay(subDelayMs + by); value.text = PlayerLogic.formatDelay(subDelayMs) }
        fun stepButton(label: String, desc: String, by: Long) = kit.text(label, 16f, Tokens.TEXT, 700, sora = true).apply {
            gravity = Gravity.CENTER
            isFocusable = true
            isClickable = true
            contentDescription = desc
            background = android.graphics.drawable.InsetDrawable(kit.focusBackground(10f), 0, kit.dp(4), 0, kit.dp(4))
            foreground = android.graphics.drawable.InsetDrawable(kit.round(Color.TRANSPARENT, 10f, Tokens.BORDER, 1), 0, kit.dp(4), 0, kit.dp(4))
            setOnClickListener { step(by) }
        }
        box.addView(stepButton("−", "Avancer les sous-titres de 0,1 seconde", -PlayerUiLogic.SUB_DELAY_STEP_MS), LinearLayout.LayoutParams(kit.dp(44), kit.dp(44)))
        box.addView(value, LinearLayout.LayoutParams(kit.dp(64), -2))
        box.addView(stepButton("+", "Retarder les sous-titres de 0,1 seconde", PlayerUiLogic.SUB_DELAY_STEP_MS), LinearLayout.LayoutParams(kit.dp(44), kit.dp(44)))
        return box
    }

    fun openPanel(name: String) {
        if (locked) return
        social?.closeFan()
        panelName = name
        showControls()
        val avail = (ui.width - ui.paddingLeft - ui.paddingRight).takeIf { it > 0 } ?: resources.displayMetrics.widthPixels
        (panelBody.layoutParams as FrameLayout.LayoutParams).width = PlayerUiLogic.panelWidth(avail, kit.dp(460))
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
        val title = when (name) { "tracks" -> "Audio et sous-titres"; "sources" -> "Sources"; "episodes" -> "Épisodes"; else -> "Réglages" }
        panelBody.contentDescription = title
        val head = LinearLayout(this).apply { orientation = LinearLayout.HORIZONTAL; gravity = Gravity.CENTER_VERTICAL; setPadding(0, 0, 0, kit.dp(14)) }
        head.addView(kit.text(title, 18f, Tokens.TEXT, 800, sora = true), LinearLayout.LayoutParams(0, -2, 1f))
        head.addView(kit.iconButton(R.drawable.ic_close, "Fermer", 44, 20, 0x0FFFFFFF) { closePanel() })
        panelBody.addView(head)
        if (name == "sources") { buildSourcesPanel(); return }
        if (name == "episodes") { buildEpisodesPanel(); return }
        val cols = LinearLayout(this).apply { orientation = LinearLayout.HORIZONTAL }
        val divider = { View(this).apply { setBackgroundColor(0x14FFFFFF) } }
        if (name == "tracks") {
            val audioRows = if (audioTracks.isEmpty()) listOf(Row("Une seule piste", true) {}) else audioTracks.map { t -> Row(t.name, t.selected) { selectAudio(t.id) } }
            val subRows = ArrayList<Row>()
            subRows.add(Row("Désactivés", subTracks.none { it.selected && it.id >= 0 }) { selectSubtitle(-1) })
            subTracks.filter { it.id >= 0 }.forEach { t -> subRows.add(Row(t.name, t.selected) { selectSubtitle(t.id) }) }
            cols.addView(scroll(column("Audio", audioRows)), LinearLayout.LayoutParams(0, -1, 1f).apply { marginEnd = kit.dp(10) })
            cols.addView(divider(), LinearLayout.LayoutParams(kit.dp(1), -1))
            cols.addView(scroll(column("Sous-titres", subRows)), LinearLayout.LayoutParams(0, -1, 1f).apply { marginStart = kit.dp(14) })
            panelBody.addView(cols, LinearLayout.LayoutParams(-1, 0, 1f))
            panelBody.addView(delayControls(), LinearLayout.LayoutParams(-1, -2).apply { topMargin = kit.dp(14) })
            return
        }
        val speedRows = PlayerLogic.RATES.map { r -> Row(PlayerLogic.rateLabel(r), kotlin.math.abs(r - rate) < 0.01) { setRate(r); refreshPanel() } }
        val aspectRows = AspectMode.values().map { a -> Row(a.label, a == aspect) { setAspect(a); refreshPanel() } }
        cols.addView(scroll(column("Vitesse", speedRows)), LinearLayout.LayoutParams(0, -1, 1f).apply { marginEnd = kit.dp(10) })
        cols.addView(divider(), LinearLayout.LayoutParams(kit.dp(1), -1))
        cols.addView(scroll(column("Format de l’image", aspectRows)), LinearLayout.LayoutParams(0, -1, 1f).apply { marginStart = kit.dp(14) })
        panelBody.addView(cols, LinearLayout.LayoutParams(-1, 0, 1f))
    }

    override fun setSources(list: List<SourceItem>) {
        core.sources = list
        updatePills()
        errorSources.visibility = if (list.isNotEmpty()) View.VISIBLE else View.GONE
        if (panelName == "sources") refreshPanel()
    }

    override fun setEpisodes(d: EpisodesData?) {
        val changedCurrent = d?.currentSeason != episodes?.currentSeason
        core.episodes = d
        updatePills()
        if (d != null && (panelSeason == 0 || changedCurrent)) panelSeason = d.currentSeason
        if (panelName == "episodes") refreshPanel()
    }

    private fun switching(msg: String) {
        closePanel()
        showSpinner(msg)
        if (::core.isInitialized) player.pause()
        armStallFallback() // pas de réponse du JS : le spinner ne reste pas et la lecture reprend
    }

    private fun listRow(selected: Boolean, enabled: Boolean = true): LinearLayout = LinearLayout(this).apply {
        orientation = LinearLayout.HORIZONTAL
        gravity = Gravity.CENTER_VERTICAL
        isFocusable = enabled
        isClickable = enabled
        alpha = if (enabled) 1f else 0.5f
        minimumHeight = kit.dp(52)
        setPadding(kit.dp(12), kit.dp(8), kit.dp(12), kit.dp(8))
        background = kit.focusBackground(12f, if (selected) 0x24FF5A36 else Color.TRANSPARENT)
        tag = if (selected) "selected" else null
    }

    private fun buildSourcesPanel() {
        val col = LinearLayout(this).apply { orientation = LinearLayout.VERTICAL; setPadding(0, 0, 0, kit.dp(8)) }
        if (sources.isEmpty()) col.addView(kit.text("Recherche des sources…", 14f, Tokens.DIM, 600).apply { setPadding(kit.dp(12), kit.dp(8), kit.dp(12), 0) })
        PlayerLogic.groupSources(sources).forEach { (group, items) ->
            col.addView(heading(group).apply { setPadding(kit.dp(12), kit.dp(10), kit.dp(12), kit.dp(6)) })
            items.forEach { s ->
                val row = listRow(s.current).apply {
                    contentDescription = s.label + (if (s.detail.isNotEmpty()) ", " + s.detail else "") + if (s.current) ", source actuelle" else ""
                    setOnClickListener {
                        if (s.current) { closePanel(); return@setOnClickListener }
                        switching("Changement de source…")
                        emitEvent("selectSource", JSObject().put("id", s.id).put("position", lastPos))
                    }
                }
                if (s.current) row.addView(kit.icon(R.drawable.ic_check, 18, Tokens.ACCENT)) else row.addView(kit.spacer(18, 18))
                val texts = LinearLayout(this).apply { orientation = LinearLayout.VERTICAL; setPadding(kit.dp(10), 0, 0, 0) }
                texts.addView(kit.text(s.label, 14f, if (s.current) Tokens.TEXT else Tokens.SOFT, if (s.current) 700 else 600))
                if (s.detail.isNotEmpty()) texts.addView(kit.text(s.detail, 12f, Tokens.DIM, 600).apply { setPadding(0, kit.dp(3), 0, 0) })
                row.addView(texts, LinearLayout.LayoutParams(0, -2, 1f))
                col.addView(row, LinearLayout.LayoutParams(-1, -2).apply { bottomMargin = kit.dp(2) })
            }
        }
        panelBody.addView(scroll(col), LinearLayout.LayoutParams(-1, 0, 1f))
    }

    private fun buildEpisodesPanel() {
        val d = episodes
        if (d == null) return
        val tabs = LinearLayout(this).apply { orientation = LinearLayout.HORIZONTAL; setPadding(0, 0, 0, kit.dp(10)) }
        d.seasons.forEach { s ->
            val on = s.number == panelSeason
            val b = kit.text(s.name, 13f, if (on) Tokens.BG else Tokens.TEXT, if (on) 700 else 600).apply {
                gravity = Gravity.CENTER
                isFocusable = true
                isClickable = true
                minHeight = kit.dp(44)
                setPadding(kit.dp(14), 0, kit.dp(14), 0)
                background = android.graphics.drawable.InsetDrawable(kit.focusBackground(999f, if (on) Tokens.TEXT else 0x0FFFFFFF), 0, kit.dp(4), 0, kit.dp(4))
                contentDescription = s.name + if (on) ", saison affichée" else ""
                setOnClickListener {
                    panelSeason = s.number
                    if (PlayerLogic.episodesOf(d, s.number).isEmpty()) emitEvent("loadSeason", JSObject().put("season", s.number))
                    refreshPanel()
                }
            }
            if (on) b.tag = "season"
            tabs.addView(b, LinearLayout.LayoutParams(-2, -2).apply { marginEnd = kit.dp(6) })
        }
        if (d.seasons.size > 1) panelBody.addView(HorizontalScrollView(this).apply { isHorizontalScrollBarEnabled = false; addView(tabs) })
        val list = LinearLayout(this).apply { orientation = LinearLayout.VERTICAL; setPadding(0, 0, 0, kit.dp(8)) }
        val eps = PlayerLogic.episodesOf(d, panelSeason)
        if (eps.isEmpty()) list.addView(kit.text("Chargement…", 14f, Tokens.DIM, 600).apply { setPadding(kit.dp(12), kit.dp(8), kit.dp(12), 0) })
        eps.forEach { e ->
            val row = listRow(e.current, e.aired).apply {
                setOnClickListener {
                    if (e.current) { closePanel(); return@setOnClickListener }
                    switching("Changement d’épisode…")
                    emitEvent("selectEpisode", JSObject().put("season", e.season).put("episode", e.episode))
                }
            }
            val still = FrameLayout(this).apply { background = kit.round(0xFF3A3647.toInt(), 8f); clipToOutline = true }
            val img = ImageView(this).apply { scaleType = ImageView.ScaleType.CENTER_CROP }
            still.addView(img, FrameLayout.LayoutParams(-1, -1))
            e.still?.let { images.load(it, img) }
            if (e.progress > 0 && !e.watched) {
                still.addView(View(this).apply { setBackgroundColor(Tokens.ACCENT) }, FrameLayout.LayoutParams((kit.dp(112) * e.progress).toInt().coerceAtLeast(kit.dp(2)), kit.dp(3), Gravity.BOTTOM or Gravity.START))
            }
            row.addView(still, LinearLayout.LayoutParams(kit.dp(112), kit.dp(63)))
            val texts = LinearLayout(this).apply { orientation = LinearLayout.VERTICAL; setPadding(kit.dp(12), 0, kit.dp(8), 0) }
            texts.addView(kit.text(PlayerLogic.episodeTitle(e), 14f, if (e.current) Tokens.ACCENT else Tokens.TEXT, if (e.current) 800 else 700).apply { maxLines = 2; ellipsize = TextUtils.TruncateAt.END })
            val meta = listOf(PlayerLogic.episodeMeta(e), if (e.current) "En cours" else if (!e.aired) "Bientôt" else "").filter { it.isNotEmpty() }.joinToString(" · ")
            if (meta.isNotEmpty()) texts.addView(kit.text(meta, 12f, Tokens.DIM, 600).apply { setPadding(0, kit.dp(3), 0, 0) })
            row.addView(texts, LinearLayout.LayoutParams(0, -2, 1f))
            if (e.watched) row.addView(kit.icon(R.drawable.ic_check, 18, Tokens.ACCENT).apply { contentDescription = "Vu" })
            row.contentDescription = PlayerLogic.episodeTitle(e) + (if (meta.isNotEmpty()) ", $meta" else "") + if (e.watched) ", vu" else ""
            list.addView(row, LinearLayout.LayoutParams(-1, -2).apply { bottomMargin = kit.dp(2) })
        }
        panelBody.addView(scroll(list), LinearLayout.LayoutParams(-1, 0, 1f))
    }

    private fun scroll(v: View) = ScrollView(this).apply { isFillViewport = true; isVerticalScrollBarEnabled = false; addView(v) }

    // ---------- Chargement d'un média ----------

    override fun load(r: OpenRequest) {
        handler.removeCallbacks(stalledRunnable)
        stalledPending = false
        ownPending = r
        nextDismissed = false
        nextRequested = false
        setHeading(r.title, r.subtitle)
        setNextEpisode(r.nextEpisode)
        setSources(r.sources)
        setEpisodes(r.episodes)
        hideEnd()
        skipButton.visibility = View.GONE
        showSpinner("")
        closePanel()
        core.begin(r)
        updateMarks()
        showControls()
    }

    override fun setHeading(title: String?, subtitle: String?) {
        if (!title.isNullOrEmpty()) titleView.text = title
        if (subtitle != null) {
            subtitleView.text = subtitle
            subtitleView.visibility = if (subtitle.isEmpty()) View.GONE else View.VISIBLE
        }
    }

    override fun setSegments(list: List<SkipSegment>) {
        core.segments = list
        updateMarks()
    }

    override fun setNextEpisode(n: NextEpisodeInfo?) {
        core.nextEpisode = n
        updatePills()
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
        social?.refreshMarkers()
        val d = lastDur
        if (d <= 0) { scrubber.setMarks(emptyList()); return }
        scrubber.setMarks(segments.filter { it.kind != "postcredits" }.map { (it.start / d).coerceIn(0.0, 1.0) to (it.end / d).coerceIn(0.0, 1.0) })
    }

    // ---------- Lecture ----------

    private fun togglePlay() {
        setPlaying(!player.isPlaying)
        showControls()
    }

    /** Saut relatif ; `gesture` (double-tap) : l'onde remplace le message et les contrôles restent tels quels. */
    private fun seekBy(delta: Double, gesture: Boolean = false) {
        val cur = player.time / 1000.0
        val target = PlayerLogic.seekTarget(cur, delta, lastDur)
        seekTo(target)
        if (gesture) { scheduleHide(); return }
        toast((if (delta > 0) "+" else "−") + kotlin.math.abs(delta).toInt() + " s")
        showControls()
    }

    private fun doSkip() {
        val seg = PlayerLogic.activeSkip(segments, lastPos) ?: return
        seekTo(seg.end)
        skipButton.visibility = View.GONE
    }

    private fun requestNextEpisode() {
        if (!PlayerLogic.nextRequestAllowed(nextRequested)) return
        nextRequested = true
        nextDismissed = true // la carte ne revient pas au tick suivant pendant que la demande est en cours
        hideEnd()
        showSpinner("Épisode suivant…")
        player.pause()
        emitEvent("nextEpisode", JSObject().put("position", lastPos).put("duration", lastDur))
        armStallFallback()
    }

    /** Si le JS ne répond pas (invité de salon, aucun épisode suivant, source ou épisode introuvable), le spinner ne reste pas indéfiniment. */
    private fun armStallFallback() {
        handler.removeCallbacks(stalledRunnable)
        handler.postDelayed(stalledRunnable, PlayerLogic.NEXT_REQUEST_TIMEOUT_MS)
    }

    private var stalledPending = false

    private val stalledRunnable = Runnable {
        if (isFinishing || !::core.isInitialized) return@Runnable
        if (!lifecycle.currentState.isAtLeast(androidx.lifecycle.Lifecycle.State.STARTED) && !isInPictureInPictureMode) { stalledPending = true; return@Runnable }
        stalledPending = false
        // Demande abandonnée : la carte peut être proposée de nouveau, et la lecture reprend.
        nextRequested = false
        nextDismissed = false
        hideSpinner()
        setPlaying(true)
    }

    // ---------- Boucle périodique : position, boutons de saut, évènements ----------

    private fun onTickUi() {
        scrubber.setProgress(if (lastDur > 0) lastPos / lastDur else 0.0)
        if (controlsVisible) {
            timeView.text = PlayerUiLogic.timeLabel(lastPos, lastDur)
            scrubber.contentDescription = "Position : " + PlayerLogic.formatClock(lastPos) + " sur " + PlayerLogic.formatClock(lastDur)
        }
        val seg = PlayerLogic.activeSkip(segments, lastPos)
        if (seg != null && !isInPictureInPictureMode && !locked) {
            skipLabel.text = PlayerLogic.skipLabel(seg)
            skipButton.visibility = View.VISIBLE
        } else skipButton.visibility = View.GONE
        val showNext = nextEpisode != null && !errored && !locked && PlayerLogic.showNextCard(segments, lastPos, lastDur, true, nextDismissed) && !isInPictureInPictureMode
        val endVis = if (showNext) View.VISIBLE else View.GONE
        if (endLayer.visibility != endVis) { endLayer.visibility = endVis; updateCenter() }
        if (showNext) {
            nextRing.progress = PlayerUiLogic.countdownFraction(lastPos, PlayerLogic.creditsStart(segments, lastDur), lastDur)
            if (skipButton.visibility == View.VISIBLE) skipButton.visibility = View.GONE
        }
    }

    // ---------- Rappels de PlaybackCore (interface du plein écran) ----------

    override fun busy(show: Boolean, msg: String) { if (show) showSpinner(msg) else hideSpinner() }
    override fun playing(playing: Boolean) { updatePlayIcons(playing); if (playing) scheduleHide() }
    override fun paused() { showControls() }
    override fun tracksChanged() { if (panelName != null) refreshPanel() }
    override fun durationChanged() { updateMarks() }
    override fun tick() { onTickUi() }

    private fun emitState(force: Boolean) = core.emitState(force)
    private fun emitProgress(force: Boolean) = core.emitProgress(force)
    private fun emitEvent(name: String, data: JSObject) = core.emit(name, data)
    private fun refreshTracks() = core.refreshTracks()
    private fun setAspect(a: AspectMode) = core.setAspect(a)

    private fun emitClosed() {
        closedSent = true
        core.emitClosed()
    }

    // Commandes du pont JS (PlayerControl) : la lecture elle-même est dans PlaybackCore.
    override fun addSubtitles(list: List<SubtitleSource>) = core.addSubtitles(list)
    override fun selectAudio(id: Int) = core.selectAudio(id)
    override fun selectSubtitle(id: Int) = core.selectSubtitle(id)
    override fun setSubtitleDelay(ms: Long) = core.setSubtitleDelay(ms)
    override fun setRate(r: Double) = core.setRate(r)
    override fun setPlaying(play: Boolean) = core.setPlaying(play)
    override fun seekTo(sec: Double) = core.seekTo(sec)
    override fun stateJson(): JSObject = core.stateJson()

    /** Fermeture à l'initiative de l'utilisateur : `closed` part vers le JS, qui enregistre la progression. */
    private fun finishWithClosed() {
        if (!closedSent) emitClosed()
        PlayerHub.activity = null
        finish()
    }

    /** Fermeture demandée par le JS : pas d'évènement en retour. */
    override fun closeSilently() {
        silentClose = true
        finish()
    }

    // ---------- Contrôles : affichage, masquage automatique, clavier / télécommande ----------

    private val hideRunnable = Runnable { hideControls() }

    private fun scheduleHide() {
        handler.removeCallbacks(hideRunnable)
        val playing = ::core.isInitialized && player.isPlaying
        if (PlayerUiLogic.shouldAutoHide(controlsVisible, playing, panelName != null, scrubberBusy(), social?.fanOpen == true)) handler.postDelayed(hideRunnable, PlayerUiLogic.AUTO_HIDE_MS)
    }

    /** Au-dessus de la barre basse quand les contrôles sont visibles, près du bord sinon. */
    private fun moveOverlays() {
        val m = kit.dp(if (controlsVisible) 144 else 24)
        listOf(skipButton, endLayer).forEach { v -> (v.layoutParams as FrameLayout.LayoutParams).bottomMargin = m; v.requestLayout() }
        social?.setControlsVisible(controlsVisible)
    }

    private fun showControls() {
        if (locked) return
        if (!controlsVisible) {
            controlsVisible = true
            moveOverlays()
            controls.visibility = View.VISIBLE
            controls.alpha = 0f
            controls.animate().alpha(1f).setDuration(180).start()
            if (currentFocus == null) bigPlay.requestFocus()
            if (::core.isInitialized) onTickUi()
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

    private fun scrubberBusy() = ::scrubber.isInitialized && scrubber.isScrubbing

    private fun updatePlayIcons(playing: Boolean) {
        updatePipActions()
        val res = if (playing) R.drawable.ic_pause else R.drawable.ic_play
        (bigPlay.getChildAt(0) as ImageView).setImageDrawable(ContextCompat.getDrawable(this, res)?.mutate())
        bigPlay.contentDescription = if (playing) "Pause" else "Lecture"
    }

    private fun showSpinner(msg: String) {
        spinnerMsg.text = msg.ifEmpty { "Chargement…" }
        spinnerMsg.visibility = View.VISIBLE
        errorActions.visibility = if (errored) View.VISIBLE else View.GONE
        spinner.visibility = View.VISIBLE
        spinnerRing.invalidate()
        updateCenter() // l'anneau prend la place du trio central
    }

    private fun hideSpinner() {
        if (errored) return
        spinner.visibility = View.GONE
        errorActions.visibility = View.GONE
        updateCenter()
    }

    private val toastHide = Runnable { toast.visibility = View.GONE }

    override fun toast(msg: String) {
        toast.text = msg
        toast.visibility = View.VISIBLE
        handler.removeCallbacks(toastHide)
        handler.postDelayed(toastHide, 1600)
    }

    override fun dispatchKeyEvent(e: KeyEvent): Boolean {
        if (e.action != KeyEvent.ACTION_DOWN) return super.dispatchKeyEvent(e)
        val k = e.keyCode
        if (locked && (k == KeyEvent.KEYCODE_BACK || k == KeyEvent.KEYCODE_ESCAPE)) {
            // Écran verrouillé : un retour accidentel ne ferme pas le lecteur, il rappelle comment déverrouiller.
            flashUnlock()
            unlockPill.requestFocus()
            return true
        }
        when (k) {
            KeyEvent.KEYCODE_BACK, KeyEvent.KEYCODE_ESCAPE -> {
                if (panelName != null) closePanel()
                else if (social?.fanOpen == true) social?.closeFan()
                else if (!minimize()) finishWithClosed()
                return true
            }
            KeyEvent.KEYCODE_MEDIA_PLAY_PAUSE, KeyEvent.KEYCODE_SPACE -> { togglePlay(); return true }
            KeyEvent.KEYCODE_MEDIA_PLAY -> { setPlaying(true); return true }
            KeyEvent.KEYCODE_MEDIA_PAUSE -> { setPlaying(false); return true }
            KeyEvent.KEYCODE_MEDIA_FAST_FORWARD -> { seekBy(PlayerLogic.SEEK_STEP_S); return true }
            KeyEvent.KEYCODE_MEDIA_REWIND -> { seekBy(-PlayerLogic.SEEK_STEP_S); return true }
            KeyEvent.KEYCODE_MEDIA_NEXT -> if (nextEpisode != null) { requestNextEpisode(); return true }
        }
        if (locked) { flashUnlock(); return super.dispatchKeyEvent(e) }
        if (panelName != null) return super.dispatchKeyEvent(e)
        scheduleHide()
        if (!controlsVisible) {
            when (k) {
                KeyEvent.KEYCODE_DPAD_CENTER, KeyEvent.KEYCODE_ENTER -> {
                    if (skipButton.visibility == View.VISIBLE) doSkip()
                    else if (endLayer.visibility == View.VISIBLE) requestNextEpisode()
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
        val playing = ::core.isInitialized && player.isPlaying
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
}
