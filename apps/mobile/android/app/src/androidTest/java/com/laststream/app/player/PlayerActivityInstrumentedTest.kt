package com.laststream.app.player

import android.content.Intent
import androidx.test.core.app.ActivityScenario
import androidx.test.platform.app.InstrumentationRegistry
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File

/**
 * Preuve de bout en bout du lecteur natif libVLC sur un vrai appareil / émulateur :
 * lecture, durée, pistes audio, choix du français, seek, fin de lecture, recréation, image dans l'image.
 *
 * Média : sample-multiaudio.mkv (20 s, H.264 720p, piste 1 jpn « Japonais », piste 2 fre « VFF »).
 *  - file:// : poussé dans /sdcard/Android/data/com.laststream.app/files/sample-multiaudio.mkv
 *  - http:// : servi par l'hôte (python -m http.server 8765) -> http://localhost:8765/sample-multiaudio.mkv
 */
class PlayerActivityInstrumentedTest {
    private val ctx = InstrumentationRegistry.getInstrumentation().targetContext
    private var scenario: ActivityScenario<PlayerActivity>? = null

    private fun fileUrl(): String {
        val f = File(ctx.getExternalFilesDir(null), "sample-multiaudio.mkv")
        assertTrue("fichier de test absent : ${f.absolutePath}", f.exists() && f.length() > 0)
        return "file://" + f.absolutePath
    }

    private fun httpUrl() = "http://localhost:8765/sample-multiaudio.mkv"

    private fun launch(url: String, start: Double = 0.0): ActivityScenario<PlayerActivity> {
        // Même requête que celle construite par LaststreamPlayerPlugin.open().
        PlayerHub.pending = OpenRequest(url = url, title = "Test multi-audio", subtitle = "S01E01", startPosition = start, preferredAudioLang = "fr")
        val i = Intent(ctx, PlayerActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_SINGLE_TOP)
        return ActivityScenario.launch<PlayerActivity>(i).also { scenario = it }
    }

    @After fun tearDown() { try { scenario?.close() } catch (_: Throwable) { } ; PlayerHub.pending = null }

    private fun <T> ActivityScenario<PlayerActivity>.read(f: (PlayerActivity) -> T): T {
        var out: T? = null
        onActivity { out = f(it) }
        @Suppress("UNCHECKED_CAST") return out as T
    }

    private fun waitFor(what: String, timeoutMs: Long, cond: () -> Boolean) {
        val end = System.currentTimeMillis() + timeoutMs
        while (System.currentTimeMillis() < end) { if (cond()) return; Thread.sleep(250) }
        throw AssertionError("délai dépassé : $what")
    }

    @Suppress("UNCHECKED_CAST")
    private fun audioTracks(a: PlayerActivity): List<TrackInfo> {
        val f = PlayerActivity::class.java.getDeclaredField("audioTracks"); f.isAccessible = true
        return f.get(a) as List<TrackInfo>
    }

    private fun pos(s: ActivityScenario<PlayerActivity>) = s.read { it.stateJson().getDouble("position") }
    private fun dur(s: ActivityScenario<PlayerActivity>) = s.read { it.stateJson().getDouble("duration") }
    private fun paused(s: ActivityScenario<PlayerActivity>) = s.read { it.stateJson().getBoolean("paused") }

    private fun playAndCheck(url: String) {
        val s = launch(url)
        waitFor("lecture démarrée (Playing)", 40_000) { !paused(s) && pos(s) > 0.2 }
        val t0 = System.currentTimeMillis()
        waitFor("temps >= 3 s", 30_000) { pos(s) >= 3.0 }
        println("[PROOF] $url playing, pos=${pos(s)} after ${System.currentTimeMillis() - t0} ms of waiting")

        val d = dur(s)
        println("[PROOF] duration=$d")
        assertEquals("durée ~20 s", 20.0, d, 1.5)

        waitFor("2 pistes audio", 15_000) { s.read { audioTracks(it).size >= 2 } }
        val tracks = s.read { audioTracks(it) }
        println("[PROOF] audio tracks=" + tracks.joinToString { "${it.id}:${it.lang}:'${it.name}':sel=${it.selected}" })
        assertTrue("jpn présent", tracks.any { it.lang == "ja" })
        assertTrue("fre présent", tracks.any { it.lang == "fr" })

        waitFor("piste française sélectionnée", 15_000) { s.read { audioTracks(it).firstOrNull { t -> t.selected }?.lang == "fr" } }
        val sel = s.read { audioTracks(it).first { t -> t.selected } }
        println("[PROOF] selected audio=${sel.id}:${sel.lang}:'${sel.name}'")
        assertEquals("fr", sel.lang)

        // Seek à 15 s puis fin de lecture (EndReached).
        s.onActivity { it.seekTo(15.0) }
        waitFor("position >= 15 s", 15_000) { pos(s) >= 14.5 }
        waitFor("évènement de fin (EndReached)", 30_000) { s.read { it.stateJson().getBoolean("ended") } }
        println("[PROOF] ended reached, pos=${pos(s)}")
    }

    @Test fun playsLocalFileWithFrenchAudio() = playAndCheck(fileUrl())

    @Test fun playsHttpWithFrenchAudio() = playAndCheck(httpUrl())

    @Test fun surviveRecreateAndKeepsFrench() {
        val s = launch(fileUrl())
        waitFor("pos >= 3", 40_000) { pos(s) >= 3.0 }
        val before = pos(s)
        s.recreate()
        waitFor("lecture reprise après recréation", 40_000) { !paused(s) && pos(s) >= before - 1.0 && pos(s) > 0.5 }
        val after = pos(s)
        println("[PROOF] recreate: before=$before after=$after")
        waitFor("fr sélectionné après recréation", 20_000) { s.read { audioTracks(it).firstOrNull { t -> t.selected }?.lang == "fr" } }
        waitFor("progression après recréation", 15_000) { pos(s) >= after + 2.0 }
    }

    @Test fun enterPipDoesNotCrashAndKeepsPlaying() {
        val s = launch(fileUrl())
        waitFor("pos >= 2", 40_000) { pos(s) >= 2.0 }
        val m = PlayerActivity::class.java.getDeclaredMethod("enterPip"); m.isAccessible = true
        s.onActivity { m.invoke(it) }
        Thread.sleep(2000)
        val inPip = s.read { it.isInPictureInPictureMode }
        println("[PROOF] PiP entered=$inPip supported=${ctx.packageManager.hasSystemFeature("android.software.picture_in_picture")}")
        assertNotNull(s.read { it.stateJson() })
        val p = pos(s)
        waitFor("lecture continue", 10_000) { pos(s) > p + 1.0 }
    }
}
