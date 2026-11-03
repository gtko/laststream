package com.laststream.app.player

import android.content.Intent
import android.os.Handler
import android.os.Looper
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

    private val main = Handler(Looper.getMainLooper())

    /** Commande vers le lecteur en cours : la vignette si elle est affichée, sinon l'activité plein écran. */
    private fun ui(call: PluginCall, block: (PlayerControl) -> Unit) {
        val a = PlayerHub.control()
        if (a == null) { call.reject("Aucun lecteur ouvert", "no_player"); return }
        main.post {
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
        val mini = PlayerHub.mini
        if (mini != null) {
            // Vignette affichée : le nouveau média (épisode suivant, autre source) y reste, sans repasser en plein écran.
            main.post { mini.load(req) }
        } else if (running != null && !running.isFinishing) {
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
            if (d.has("sources")) a.setSources(OpenRequest.parseSources(d.optJSONArray("sources")))
            if (d.has("episodes")) a.setEpisodes(OpenRequest.parseEpisodes(d.optJSONObject("episodes")))
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
        val a = PlayerHub.control()
        if (a == null) { call.resolve(JSObject().put("open", false)); return }
        main.post { call.resolve(a.stateJson().put("open", true).put("mini", PlayerHub.mini != null)) }
    }

    @PluginMethod
    fun close(call: PluginCall) {
        val a = PlayerHub.control()
        if (a == null) {
            // Entre deux écrans (agrandissement en cours) : on annule la reprise et on libère la lecture.
            PlayerHub.pending = null
            PlayerHub.adopt = false
            main.post { PlayerHub.core?.let { c -> c.release(); if (PlayerHub.core === c) PlayerHub.core = null; PlayerHub.machine.close() }; call.resolve() }
            return
        }
        main.post { a.closeSilently(); call.resolve() }
    }

    /** Réduit le lecteur plein écran en vignette flottante ; `mini` indique si la vignette est affichée. */
    @PluginMethod
    fun minimize(call: PluginCall) {
        main.post {
            val ok = PlayerHub.activity?.minimize() ?: false
            call.resolve(JSObject().put("mini", ok || PlayerHub.mini != null))
        }
    }

    /** Agrandit la vignette en plein écran. */
    @PluginMethod
    fun expand(call: PluginCall) {
        main.post {
            PlayerHub.mini?.expand()
            call.resolve(JSObject().put("mini", PlayerHub.mini != null))
        }
    }

    // ---------- Couche sociale (LAST-1612) : le JS fait tout le réseau, le natif n'affiche que ----------

    /** `{ enabled, quick[], more[], viewers[] }` ; `enabled=false` masque tout le social. */
    @PluginMethod
    fun setSocial(call: PluginCall) {
        PlayerHub.social = SocialLogic.parseState(call.data, PlayerHub.social)
        main.post { PlayerHub.socialOverlay?.refresh() }
        call.resolve()
    }

    /** `{ notes[] }` : remplace la liste complète des marqueurs de la barre. */
    @PluginMethod
    fun setNotes(call: PluginCall) {
        PlayerHub.social = PlayerHub.social.copy(notes = SocialLogic.parseNotes(call.data.optJSONArray("notes")))
        main.post { PlayerHub.socialOverlay?.refresh() }
        call.resolve()
    }

    /** `{ id, from, body }` : une bulle en haut à gauche. */
    @PluginMethod
    fun pushMessage(call: PluginCall) {
        val m = SocialLogic.parseMessage(call.data)
        if (m == null) { call.reject("message invalide", "bad_request"); return }
        main.post { PlayerHub.socialOverlay?.pushMessage(m) }
        call.resolve()
    }
}
