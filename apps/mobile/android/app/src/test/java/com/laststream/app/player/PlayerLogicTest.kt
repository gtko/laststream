package com.laststream.app.player

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class PlayerLogicTest {
    @Test fun formatClock() {
        assertEquals("0:00", PlayerLogic.formatClock(0.0))
        assertEquals("23:14", PlayerLogic.formatClock(1394.7))
        assertEquals("1:02:03", PlayerLogic.formatClock(3723.0))
        assertEquals("0:00", PlayerLogic.formatClock(-5.0))
        assertEquals("0:00", PlayerLogic.formatClock(Double.NaN))
    }

    @Test fun normalizeLang() {
        assertEquals("fr", PlayerLogic.normalizeLang("fra"))
        assertEquals("fr", PlayerLogic.normalizeLang("FR-ca"))
        assertEquals("fr", PlayerLogic.normalizeLang("Français"))
        assertEquals("en", PlayerLogic.normalizeLang("English"))
        assertEquals("ja", PlayerLogic.normalizeLang("jpn"))
        assertEquals("", PlayerLogic.normalizeLang("klingon"))
        assertEquals("", PlayerLogic.normalizeLang(null))
    }

    @Test fun langFromTrackName() {
        assertEquals("fr", PlayerLogic.langFromTrackName("Piste 2 - [Français]"))
        assertEquals("en", PlayerLogic.langFromTrackName("Track 1 - [English]"))
        assertEquals("fr", PlayerLogic.langFromTrackName("Track 3 - [fra]"))
        assertEquals("en", PlayerLogic.langFromTrackName("English DTS-HD 5.1"))
        assertEquals("", PlayerLogic.langFromTrackName("Track 1"))
    }

    private val audio = listOf(
        TrackInfo(1, "Track 1 - [English]", "en", true),
        TrackInfo(2, "Track 2 - [French]", "fr"),
    )

    @Test fun pickAudio() {
        assertEquals(2, PlayerLogic.pickAudio(audio, "fr")?.id)
        assertEquals(2, PlayerLogic.pickAudio(audio, "fra")?.id)
        assertNull(PlayerLogic.pickAudio(audio, "de"))
        assertNull(PlayerLogic.pickAudio(audio, null))
    }

    @Test fun pickAudioLangueApprise() {
        val tracks = audio + TrackInfo(3, "Track 3 - [Japanese]", "ja")
        assertEquals(3, PlayerLogic.pickAudio(tracks, "ja")?.id)
        assertEquals(3, PlayerLogic.pickAudio(tracks, "jpn")?.id)
        // Les libellés de classement des sources ne sont pas des langues : aucune piste choisie.
        assertNull(PlayerLogic.pickAudio(tracks, "original"))
        assertNull(PlayerLogic.pickAudio(tracks, "multi"))
    }

    @Test fun pickSubtitlePrefersFullOverForced() {
        val subs = listOf(
            TrackInfo(-1, "Désactiver", ""),
            TrackInfo(3, "Track 1 - [French] (forced)", "fr"),
            TrackInfo(4, "Track 2 - [French]", "fr"),
        )
        assertEquals(4, PlayerLogic.pickSubtitle(subs, "fr")?.id)
        assertNull(PlayerLogic.pickSubtitle(subs, "off"))
        assertNull(PlayerLogic.pickSubtitle(subs, "en"))
        assertEquals(3, PlayerLogic.pickSubtitle(subs.take(2), "fr")?.id)
    }

    private val segs = listOf(
        SkipSegment("recap", 0.0, 30.0),
        SkipSegment("intro", 60.0, 150.0),
        SkipSegment("credits", 2500.0, 2700.0),
    )

    @Test fun activeSkip() {
        assertEquals("recap", PlayerLogic.activeSkip(segs, 10.0)?.kind)
        assertEquals("intro", PlayerLogic.activeSkip(segs, 59.9)?.kind)
        assertNull(PlayerLogic.activeSkip(segs, 149.5))
        assertNull(PlayerLogic.activeSkip(segs, 2600.0))
        assertEquals("Passer l’intro ?", PlayerLogic.skipLabel(SkipSegment("intro", 0.0, 9.0, inferred = true)))
    }

    @Test fun pendingIsKeptWhenJsClosesTheActivity() {
        val mine = Any()
        assertTrue(PlayerLogic.shouldClearPending(mine, mine))
        assertFalse(PlayerLogic.shouldClearPending(Any(), mine)) // requête du média suivant : conservée
        assertTrue(PlayerLogic.shouldClearPending<Any>(null, mine))
        assertTrue(PlayerLogic.NEXT_REQUEST_TIMEOUT_MS in 3000L..15000L)
    }

    @Test fun nextCard() {
        assertFalse(PlayerLogic.showNextCard(segs, 2000.0, 2700.0, true))
        assertTrue(PlayerLogic.showNextCard(segs, 2510.0, 2700.0, true))
        assertFalse(PlayerLogic.showNextCard(segs, 2510.0, 2700.0, false))
        // Sans générique fiable : les 25 dernières secondes.
        assertEquals(2675.0, PlayerLogic.creditsStart(emptyList(), 2700.0))
        assertNull(PlayerLogic.creditsStart(emptyList(), 40.0))
        // Générique déduit : ignoré.
        assertEquals(2675.0, PlayerLogic.creditsStart(listOf(SkipSegment("credits", 2500.0, 2700.0, inferred = true)), 2700.0))
    }

    @Test fun seekTargetClamps() {
        assertEquals(0.0, PlayerLogic.seekTarget(5.0, -10.0, 100.0), 0.0)
        assertEquals(99.0, PlayerLogic.seekTarget(95.0, 10.0, 100.0), 0.0)
        assertEquals(25.0, PlayerLogic.seekTarget(15.0, 10.0, 0.0), 0.0)
    }

    @Test fun delayAndRate() {
        assertEquals("0 s", PlayerLogic.formatDelay(0))
        assertEquals("+0,5 s", PlayerLogic.formatDelay(500))
        assertEquals("−1,2 s", PlayerLogic.formatDelay(-1200))
        assertEquals(120_000L, PlayerLogic.clampDelayMs(999_999))
        assertEquals("1×", PlayerLogic.rateLabel(1.0))
        assertEquals("1,25×", PlayerLogic.rateLabel(1.25))
    }

    @Test fun aspectCycles() {
        var a = AspectMode.BEST
        repeat(AspectMode.values().size) { a = a.next() }
        assertEquals(AspectMode.BEST, a)
        assertNotNull(AspectMode.R16_9.vlc)
    }

    @Test fun emitCadence() {
        assertTrue(PlayerLogic.shouldEmit(1000, 0, 5000))
        assertFalse(PlayerLogic.shouldEmit(3000, 1000, 5000))
        assertTrue(PlayerLogic.shouldEmit(6000, 1000, 5000))
    }

    @Test fun defaultSubtitleModes() {
        val subs = listOf(
            TrackInfo(3, "Track 1 - [French] (forced)", "fr"),
            TrackInfo(4, "Track 2 - [French]", "fr"),
            TrackInfo(5, "Track 3 - [English]", "en"),
        )
        // Audio en VO : sous-titres complets dans la langue préférée.
        assertEquals(4, PlayerLogic.defaultSubtitle(subs, "fr", "en", "auto")?.id)
        // Audio déjà en français : seulement les forcés.
        assertEquals(3, PlayerLogic.defaultSubtitle(subs, "fr", "fr", "auto")?.id)
        assertNull(PlayerLogic.defaultSubtitle(subs.drop(1), "fr", "fr", "auto"))
        assertEquals(4, PlayerLogic.defaultSubtitle(subs, "fr", "fr", "always")?.id)
        assertNull(PlayerLogic.defaultSubtitle(subs, "fr", "en", "off"))
        assertNull(PlayerLogic.defaultSubtitle(subs, "off", "en", "always"))
    }

    @Test fun trackLabels() {
        assertEquals("Français · EAC3 5.1", PlayerLogic.trackLabel("fr", "Track 2 - [French]", "eac3", 6))
        assertEquals("Anglais", PlayerLogic.trackLabel("en", "Track 1 - [English]"))
        assertEquals("Français (forcés)", PlayerLogic.trackLabel("fr", "Track 3 - [French] (forced)"))
        assertEquals("Klingon", PlayerLogic.trackLabel("", "Piste 4 - Klingon"))
    }

    @Test fun groupsSourcesInOrder() {
        val l = listOf(
            SourceItem("1", "a", "", false, "2160p"), SourceItem("2", "b", "", true, "1080p"),
            SourceItem("3", "c", "", false, "1080p"), SourceItem("4", "d", "", false, ""),
        )
        val g = PlayerLogic.groupSources(l)
        assertEquals(listOf("2160p", "1080p", "Sources"), g.map { it.first })
        assertEquals(2, g[1].second.size)
    }

    @Test fun detailedSourceHelpers() {
        val plain = SourceItem("1", "1080p · VF", "2 Go", false, "1080p")
        assertFalse(PlayerLogic.richSource(plain))
        assertEquals("", PlayerLogic.sourceMeta(plain))
        val rich = plain.copy(
            quality = "1080p", sourceType = "WEB-DL", codec = "", hdr = listOf("DV", "HDR10"),
            bitrate = "5 Mb/s", copies = 2, origins = listOf("A", "B", "C", "D"),
        )
        assertTrue(PlayerLogic.richSource(rich))
        assertEquals(listOf("WEB-DL", "DV", "HDR10"), PlayerLogic.videoBadges(rich))
        assertEquals("5 Mb/s · 2 copies · A, B +2", PlayerLogic.sourceMeta(rich))
        assertEquals("A", PlayerLogic.sourceMeta(plain.copy(origins = listOf("A"), copies = 1)))
    }

    @Test fun episodeHelpers() {
        val e = EpisodeItem(1, 5, "", null, 42, false, 0.0, false, true)
        assertEquals("É5 · Épisode 5", PlayerLogic.episodeTitle(e))
        assertEquals("42 min", PlayerLogic.episodeMeta(e))
        assertEquals("", PlayerLogic.episodeMeta(e.copy(durationMin = 0)))
        val d = EpisodesData(listOf(SeasonInfo(1, "S1")), 1, listOf(e, e.copy(season = 2), e.copy(episode = 2)))
        assertEquals(listOf(2, 5), PlayerLogic.episodesOf(d, 1).map { it.episode })
        assertEquals(0, PlayerLogic.episodesOf(null, 1).size)
    }

    @Test fun nextCardStaysHiddenOnceDismissedOrRequested() {
        // « Ignorer » ou « Lire maintenant » : la carte ne revient pas au tick suivant (LAST-1626).
        assertFalse(PlayerLogic.showNextCard(segs, 2510.0, 2700.0, true, dismissed = true))
        assertTrue(PlayerLogic.showNextCard(segs, 2510.0, 2700.0, true, dismissed = false))
    }

    @Test fun nextRequestNotEmittedTwice() {
        assertTrue(PlayerLogic.nextRequestAllowed(inFlight = false))
        assertFalse(PlayerLogic.nextRequestAllowed(inFlight = true))
    }

    @Test fun scrubReleaseSeeksOnlyWhenNotCancelled() {
        assertTrue(PlayerLogic.scrubReleaseSeeks(cancelled = false))
        assertFalse(PlayerLogic.scrubReleaseSeeks(cancelled = true))
    }
}
