package com.laststream.app.player

import android.content.Context
import android.media.AudioManager
import android.net.Uri
import android.os.Handler
import android.os.Looper
import com.getcapacitor.JSObject
import org.json.JSONArray
import org.json.JSONObject
import org.videolan.libvlc.LibVLC
import org.videolan.libvlc.Media
import org.videolan.libvlc.MediaPlayer
import org.videolan.libvlc.interfaces.IMedia
import org.videolan.libvlc.util.VLCVideoLayout
import kotlin.concurrent.thread

/**
 * Lecture libVLC sans interface : instance, média, pistes, position et évènements vers le JS.
 * Elle vit plus longtemps qu'une activité : le plein écran (PlayerActivity) et la vignette flottante (MiniPlayer) s'en
 * servent tour à tour et lui rattachent leur surface vidéo, sans recréer le média (la lecture ne coupe pas).
 */
class PlaybackCore private constructor(private val appContext: Context, val vlc: LibVLC, val player: MediaPlayer) {
    /** Réactions de l'interface en cours (plein écran ou vignette) ; toutes sur le fil principal. */
    interface Ui {
        fun busy(show: Boolean, msg: String = "")
        fun playing(playing: Boolean)
        fun paused()
        fun tracksChanged()
        fun durationChanged()
        fun tick()
        fun toast(msg: String)
    }

    @Volatile var ui: Ui? = null
    @Volatile var released = false
        private set
    private val handler = Handler(Looper.getMainLooper())
    private var attached: VLCVideoLayout? = null

    var req: OpenRequest? = null
    var segments: List<SkipSegment> = emptyList()
    var nextEpisode: NextEpisodeInfo? = null
    var sources: List<SourceItem> = emptyList()
    var episodes: EpisodesData? = null
    var externalSubs: List<SubtitleSource> = emptyList()
    var extMeta = ArrayList<SubtitleSource>()
    var embeddedSpuIds: Set<Int>? = null
    var aspect = AspectMode.BEST
        private set
    var rate = 1.0
        private set
    var subDelayMs = 0L
    var defaultsApplied = false
    var userPickedSub = false
    var endedSent = false
    var startSeekDone = true
    var wantedStart = 0.0
    var lastState = 0L
    var lastProgress = 0L
    var lastTrackSig = ""
    var audioTracks: List<TrackInfo> = emptyList()
    var subTracks: List<TrackInfo> = emptyList()
    var buffering = false
    var errored = false
    var lastPos = 0.0
    var lastDur = 0.0
    private var audioFocusHeld = false

    companion object {
        /** Libération libVLC de l'instance précédente : la suivante l'attend avant de créer la sienne (décodeur matériel, sortie audio). */
        @Volatile private var releasing: Thread? = null

        fun create(ctx: Context): PlaybackCore {
            val args = arrayListOf("--audio-time-stretch", "--no-sub-autodetect-file", "--network-caching=3000", "--file-caching=3000", "--avcodec-skiploopfilter=0")
            try { releasing?.join(3000) } catch (_: InterruptedException) { }
            val app = ctx.applicationContext
            val vlc = LibVLC(app, args)
            return PlaybackCore(app, vlc, MediaPlayer(vlc))
        }
    }

    // ---------- Surface ----------

    /** Rattache la vidéo à une vue ; l'ancienne surface est d'abord libérée. */
    fun attach(layout: VLCVideoLayout, textureView: Boolean = false) {
        if (released) return
        detach()
        player.attachViews(layout, null, true, textureView)
        attached = layout
    }

    fun detach() {
        if (attached == null) return
        try { player.detachViews() } catch (_: Exception) { }
        attached = null
    }

    fun release() {
        if (released) return
        released = true
        ui = null
        handler.removeCallbacksAndMessages(null)
        abandonAudioFocus()
        val p = player
        val v = vlc
        try { p.setEventListener(null); p.detachViews() } catch (_: Exception) { }
        attached = null
        releasing = thread(name = "vlc-release") {
            try { p.stop(); p.release(); v.release() } catch (_: Exception) { }
        }
    }

    // ---------- Chargement ----------

    /** Requête courante avec la position et les données annexes à jour (reprise après recréation de l'activité). */
    fun snapshot(): OpenRequest? = req?.copy(startPosition = lastPos, skipSegments = segments, nextEpisode = nextEpisode, sources = sources, episodes = episodes)

    /** Réinitialise l'état de session et lance le média. Renvoie faux si libVLC refuse l'ouverture. */
    fun begin(r: OpenRequest): Boolean {
        req = r
        segments = r.skipSegments
        nextEpisode = r.nextEpisode
        sources = r.sources
        episodes = r.episodes
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
        return startMedia(r)
    }

    fun startMedia(r: OpenRequest): Boolean {
        ui?.busy(true)
        requestAudioFocus()
        return try {
            val m = Media(vlc, Uri.parse(r.url))
            m.setHWDecoderEnabled(true, false)
            m.addOption(":network-caching=${r.networkCachingMs}")
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
            true
        } catch (e: Exception) {
            fail("open")
            false
        }
    }

    // ---------- Évènements libVLC ----------

    private fun onPlayerEvent(e: MediaPlayer.Event) {
        if (released) return
        when (e.type) {
            MediaPlayer.Event.Opening -> ui?.busy(true)
            MediaPlayer.Event.Buffering -> {
                buffering = e.buffering < 100f
                if (buffering && !errored) ui?.busy(true) else if (!buffering) hideBusy()
            }
            MediaPlayer.Event.Playing -> {
                buffering = false
                errored = false // la lecture a repris : le spinner et la carte suivante redeviennent normaux
                hideBusy()
                ui?.playing(true)
                handler.postDelayed({ afterStart() }, 600)
            }
            MediaPlayer.Event.Paused -> { ui?.playing(false); ui?.paused(); emitState(true); emitProgress(true) }
            MediaPlayer.Event.EndReached -> {
                if (!endedSent) { endedSent = true; emit("ended", JSObject().put("position", lastPos).put("duration", lastDur)) }
                ui?.busy(true)
            }
            MediaPlayer.Event.EncounteredError -> fail("decode")
            MediaPlayer.Event.ESAdded, MediaPlayer.Event.ESDeleted, MediaPlayer.Event.ESSelected -> refreshTracks()
        }
    }

    private fun hideBusy() { if (!errored) ui?.busy(false) }

    private fun afterStart() {
        if (released) return
        if (!startSeekDone) {
            startSeekDone = true
            // `start-time` est ignoré par certains serveurs : on rattrape la position à la main.
            if (player.time / 1000.0 < wantedStart - 5) player.time = (wantedStart * 1000).toLong()
        }
        refreshTracks()
        if (!defaultsApplied && (audioTracks.isNotEmpty() || subTracks.isNotEmpty())) applyDefaults()
        applyExternalSubs()
    }

    fun fail(code: String) {
        if (errored) return
        errored = true
        ui?.busy(true, "Lecture impossible, recherche d’une autre source…")
        emit("error", JSObject().put("code", code).put("position", lastPos))
    }

    // ---------- Pistes et sous-titres ----------

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

    fun refreshTracks() {
        if (released) return
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
            emit("tracks", JSObject().put("audio", tracksJson(audioTracks)).put("subs", tracksJson(subTracks)))
            ui?.tracksChanged()
        }
    }

    private fun tracksJson(l: List<TrackInfo>): JSONArray = JSONArray().apply {
        l.forEach { put(JSONObject().put("id", it.id).put("label", it.name).put("lang", it.lang).put("selected", it.selected)) }
    }

    fun selectAudio(id: Int, fromUser: Boolean = true) {
        player.audioTrack = id
        refreshTracks()
        val t = audioTracks.firstOrNull { it.id == id }
        if (fromUser) { ui?.toast("Audio : " + (t?.name ?: "")); emit("trackChanged", JSObject().put("kind", "audio").put("id", id).put("lang", t?.lang ?: "").put("label", t?.name ?: "")) }
    }

    fun selectSubtitle(id: Int, fromUser: Boolean = true) {
        if (fromUser) userPickedSub = true
        player.spuTrack = id
        refreshTracks()
        val t = subTracks.firstOrNull { it.id == id }
        if (fromUser) {
            ui?.toast(if (id < 0) "Sous-titres désactivés" else "Sous-titres : " + (t?.name ?: ""))
            emit("trackChanged", JSObject().put("kind", "sub").put("id", id).put("lang", if (id < 0) "off" else t?.lang ?: "").put("label", t?.name ?: ""))
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

    fun setAspect(a: AspectMode) {
        aspect = a
        try {
            when (a) {
                AspectMode.BEST -> { player.setAspectRatio(null); player.videoScale = MediaPlayer.ScaleType.SURFACE_BEST_FIT }
                AspectMode.FILL -> { player.setAspectRatio(null); player.videoScale = MediaPlayer.ScaleType.SURFACE_FILL }
                else -> { player.setAspectRatio(a.vlc); player.videoScale = MediaPlayer.ScaleType.SURFACE_BEST_FIT }
            }
        } catch (_: Exception) { }
    }

    // ---------- Lecture ----------

    /**
     * Pause posée par le système et non par l'utilisateur : lecteur en arrière-plan (activité arrêtée) ou focus audio perdu
     * (appel, autre application). Transmis au JS dans l'état : une watch party ne diffuse pas cette pause au salon et ne relance
     * pas la lecture d'un téléphone verrouillé.
     */
    private var systemSuspended = false
    private var focusLost = false

    /** Lecteur mis en arrière-plan (vrai) ou revenu au premier plan (faux, la perte de focus est alors oubliée aussi). */
    fun setSystemSuspended(on: Boolean) {
        systemSuspended = on
        if (!on) focusLost = false
    }

    fun setPlaying(play: Boolean) {
        if (play) { focusLost = false; requestAudioFocus(); player.play() } else player.pause()
    }

    fun seekTo(sec: Double) {
        if (lastDur > 0) player.time = (PlayerLogic.seekTarget(sec, 0.0, lastDur) * 1000).toLong() else player.time = (sec * 1000).toLong()
        lastPos = sec
        emitState(true)
    }

    // ---------- Boucle périodique et évènements vers le JS ----------

    private val ticker = object : Runnable {
        override fun run() {
            if (released) return
            try { tick() } catch (_: Exception) { }
            handler.postDelayed(this, 250)
        }
    }

    private fun tick() {
        val t = player.time
        val l = player.length
        if (t >= 0) lastPos = t / 1000.0
        if (l > 0 && lastDur != l / 1000.0) { lastDur = l / 1000.0; ui?.durationChanged() }
        ui?.tick()
        emitState(false)
        emitProgress(false)
    }

    fun stateJson(): JSObject = JSObject()
        .put("position", lastPos).put("duration", lastDur).put("paused", !player.isPlaying).put("buffering", buffering)
        .put("rate", rate).put("ended", endedSent).put("suspended", systemSuspended || focusLost)

    fun emitState(force: Boolean) {
        val now = System.currentTimeMillis()
        if (!force && !PlayerLogic.shouldEmit(now, lastState, 1000)) return
        lastState = now
        emit("state", stateJson())
    }

    fun emitProgress(force: Boolean) {
        val now = System.currentTimeMillis()
        if (!force && (!player.isPlaying || !PlayerLogic.shouldEmit(now, lastProgress, 5000))) return
        if (lastDur <= 0) return
        lastProgress = now
        emit("progress", JSObject().put("position", lastPos).put("duration", lastDur))
    }

    fun emit(name: String, data: JSObject) = PlayerHub.emit(name, data)

    fun emitClosed() = emit("closed", JSObject().put("position", lastPos).put("duration", lastDur))

    init {
        player.setEventListener(::onPlayerEvent)
        handler.post(ticker)
    }

    // ---------- Focus audio ----------

    private val focusListener = AudioManager.OnAudioFocusChangeListener { change ->
        // Perte définitive : le système a repris le focus, la prochaine lecture doit le redemander.
        if (change == AudioManager.AUDIOFOCUS_LOSS) audioFocusHeld = false
        if ((change == AudioManager.AUDIOFOCUS_LOSS || change == AudioManager.AUDIOFOCUS_LOSS_TRANSIENT) && !released && player.isPlaying) {
            focusLost = true // posé avant la pause : l'état émis à l'évènement Paused le porte déjà
            player.pause()
        }
        // Focus rendu (fin d'appel) : la pause n'est plus celle du système ; le JS décide de la reprise (watch party).
        if (change == AudioManager.AUDIOFOCUS_GAIN && focusLost && !released) { focusLost = false; emitState(true) }
    }

    @Suppress("DEPRECATION")
    fun requestAudioFocus() {
        if (audioFocusHeld) return
        val am = appContext.getSystemService(Context.AUDIO_SERVICE) as AudioManager
        audioFocusHeld = am.requestAudioFocus(focusListener, AudioManager.STREAM_MUSIC, AudioManager.AUDIOFOCUS_GAIN) == AudioManager.AUDIOFOCUS_REQUEST_GRANTED
    }

    @Suppress("DEPRECATION")
    fun abandonAudioFocus() {
        if (!audioFocusHeld) return
        (appContext.getSystemService(Context.AUDIO_SERVICE) as AudioManager).abandonAudioFocus(focusListener)
        audioFocusHeld = false
    }
}
