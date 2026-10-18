package com.laststream.app.player

import android.content.Intent
import com.getcapacitor.JSObject
import com.getcapacitor.Plugin
import com.getcapacitor.PluginCall
import com.getcapacitor.PluginMethod
import com.getcapacitor.annotation.CapacitorPlugin

/**
 * Pont JS : `LaststreamPlayer.open({...})` ouvre le lecteur natif (libVLC) ; les évènements `progress`, `state`, `tracks`,
 * `ended`, `closed`, `error`, `nextEpisode` et `trackChanged` reviennent par `addListener`.
 * Le reste (play, pause, seek, setRate, pistes, décalage, update…) pilote l'activité en cours.
 */
@CapacitorPlugin(name = "LaststreamPlayer")
class LaststreamPlayerPlugin : Plugin() {
    override fun load() {
        PlayerHub.plugin = this
    }

    override fun handleOnDestroy() {
        if (PlayerHub.plugin === this) PlayerHub.plugin = null
    }

    fun emit(event: String, data: JSObject) {
        notifyListeners(event, data, true)
    }

    private fun ui(call: PluginCall, block: (PlayerActivity) -> Unit) {
        val a = PlayerHub.activity
        if (a == null) { call.reject("Aucun lecteur ouvert", "no_player"); return }
        a.runOnUiThread {
            try { block(a); call.resolve() } catch (e: Exception) { call.reject(e.message ?: "erreur", "player_error") }
        }
    }

    @PluginMethod
    fun isAvailable(call: PluginCall) {
        call.resolve(JSObject().put("available", true))
    }

    @PluginMethod
    fun open(call: PluginCall) {
        val req = OpenRequest.fromJson(call.data)
        if (req == null) { call.reject("L'adresse de lecture (url) est obligatoire", "bad_request"); return }
        PlayerHub.pending = req
        val running = PlayerHub.activity
        if (running != null && !running.isFinishing) {
            running.runOnUiThread { running.load(req) }
        } else {
            val i = Intent(context, PlayerActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_SINGLE_TOP)
            context.startActivity(i)
        }
        call.resolve()
    }

    /** Met à jour les données annexes arrivées après l'ouverture : segments, épisode suivant, titre. */
    @PluginMethod
    fun update(call: PluginCall) {
        val d = call.data
        ui(call) { a ->
            if (d.has("skipSegments")) a.setSegments(OpenRequest.parseSegments(d.optJSONArray("skipSegments")))
            if (d.has("nextEpisode")) a.setNextEpisode(OpenRequest.parseNext(d.optJSONObject("nextEpisode")))
            if (d.has("title") || d.has("subtitle")) a.setHeading(d.optString("title", ""), d.optString("subtitle", ""))
        }
    }

    @PluginMethod
    fun addSubtitles(call: PluginCall) {
        val list = OpenRequest.parseSubtitles(call.data.optJSONArray("subtitles"))
        ui(call) { it.addSubtitles(list) }
    }

    @PluginMethod fun play(call: PluginCall) = ui(call) { it.setPlaying(true) }

    @PluginMethod fun pause(call: PluginCall) = ui(call) { it.setPlaying(false) }

    @PluginMethod
    fun seek(call: PluginCall) {
        val pos = call.getDouble("position") ?: run { call.reject("position manquante"); return }
        ui(call) { it.seekTo(pos) }
    }

    @PluginMethod
    fun setRate(call: PluginCall) {
        val r = call.getDouble("rate") ?: run { call.reject("rate manquant"); return }
        ui(call) { it.setRate(r) }
    }

    @PluginMethod
    fun setAudioTrack(call: PluginCall) {
        val id = call.getInt("id") ?: run { call.reject("id manquant"); return }
        ui(call) { it.selectAudio(id) }
    }

    /** `id` absent ou -1 : désactive les sous-titres. */
    @PluginMethod
    fun setSubtitleTrack(call: PluginCall) {
        val id = call.getInt("id") ?: -1
        ui(call) { it.selectSubtitle(id) }
    }

    @PluginMethod
    fun setSubtitleDelay(call: PluginCall) {
        val ms = call.getLong("ms") ?: 0L
        ui(call) { it.setSubtitleDelay(ms) }
    }

    @PluginMethod
    fun getState(call: PluginCall) {
        val a = PlayerHub.activity
        if (a == null) { call.resolve(JSObject().put("open", false)); return }
        a.runOnUiThread { call.resolve(a.stateJson().put("open", true)) }
    }

    @PluginMethod
    fun close(call: PluginCall) {
        val a = PlayerHub.activity
        if (a == null) { call.resolve(); return }
        a.runOnUiThread { a.closeSilently(); call.resolve() }
    }
}
