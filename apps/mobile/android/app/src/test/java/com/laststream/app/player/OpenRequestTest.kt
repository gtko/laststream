package com.laststream.app.player

import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Test

class OpenRequestTest {
    @Test fun parsesFullRequest() {
        val o = JSONObject(
            """{"url":"http://192.168.1.10:11470/x.mkv","title":"Dune","subtitle":"S1:É2","startPosition":125.5,
            "preferredAudioLang":"fr","preferredSubLang":"off",
            "subtitles":[{"url":"http://s/1.srt","lang":"fr","label":"Français"},{"url":"","lang":"en"}],
            "skipSegments":[{"kind":"intro","start":60,"end":150},{"kind":"intro","start":10,"end":11},{"kind":"credits","start":2500,"end":2700,"confidence":0.9}],
            "nextEpisode":{"title":"S1:É3","still":"https://img/x.jpg"}}""",
        )
        val r = OpenRequest.fromJson(o)!!
        assertEquals("Dune", r.title)
        assertEquals(125.5, r.startPosition, 0.0)
        assertEquals(1, r.subtitles.size)
        assertEquals(2, r.skipSegments.size)
        assertEquals(0.9, r.skipSegments[1].confidence!!, 0.0)
        assertEquals("S1:É3", r.nextEpisode?.title)
    }

    @Test fun rejectsMissingUrl() {
        assertNull(OpenRequest.fromJson(JSONObject("""{"title":"x"}""")))
    }

    @Test fun toleratesGarbage() {
        val r = OpenRequest.fromJson(JSONObject("""{"url":"a","startPosition":-3,"skipSegments":[{"kind":"intro"}],"nextEpisode":null}"""))
        assertNotNull(r)
        assertEquals(0.0, r!!.startPosition, 0.0)
        assertEquals(0, r.skipSegments.size)
        assertNull(r.nextEpisode)
    }

    @Test fun parsesSourcesAndEpisodes() {
        val o = JSONObject(
            """{"url":"u","sources":[{"id":3,"label":"1080p · VFF ⚡","detail":"2 Go","current":true,"group":"1080p"},{"id":"x","label":""},{"label":"sans id"}],
            "episodes":{"seasons":[{"number":1,"name":"Saison 1"},{"number":2}],"currentSeason":2,
            "items":[{"season":2,"episode":1,"title":"A","still":"http://i/1.jpg","durationMin":42,"watched":true,"progress":0.5,"current":false,"aired":true},
                     {"season":2,"episode":2,"title":"B","current":true},{"episode":3}]}}""",
        )
        val r = OpenRequest.fromJson(o)!!
        assertEquals(1, r.sources.size)
        assertEquals("3", r.sources[0].id)
        assertEquals(true, r.sources[0].current)
        val e = r.episodes!!
        assertEquals(2, e.currentSeason)
        assertEquals("Saison 2", e.seasons[1].name)
        assertEquals(2, e.items.size)
        assertEquals(0.5, e.items[0].progress, 0.0)
        assertEquals(true, e.items[1].aired)
    }

    @Test fun parsesDetailedSourceFields() {
        val a = org.json.JSONArray(
            """[{"id":"7","label":"1080p","detail":"","current":false,"group":"1080p","quality":"1080p","sourceType":"BluRay",
            "codec":"HEVC","audio":"EAC3 5.1","hdr":["HDR10",""],"langs":[{"label":"VF","verified":true},{"label":"VO"},{"label":""}],
            "size":"1,3 Go","bitrate":"7,4 Mb/s","release":"Show.S01E01.mkv","releaseGroup":"FTMVHD","status":"cached",
            "statusLabel":"En cache ⚡","origins":["Lumio","C411"],"copies":3}]""",
        )
        val s = OpenRequest.parseSources(a).single()
        assertEquals("BluRay", s.sourceType)
        assertEquals(listOf("HDR10"), s.hdr)
        assertEquals(listOf(SourceLang("VF", true), SourceLang("VO", false)), s.langs)
        assertEquals("FTMVHD", s.releaseGroup)
        assertEquals("cached", s.status)
        assertEquals(listOf("Lumio", "C411"), s.origins)
        assertEquals(3, s.copies)
        // Forme historique : champs détaillés vides, la carte retombe sur libellé et détail.
        val old = OpenRequest.parseSources(org.json.JSONArray("""[{"id":1,"label":"1080p · VF","detail":"2 Go"}]""")).single()
        assertEquals("", old.quality)
        assertEquals(emptyList<String>(), old.origins)
    }

    @Test fun noEpisodesForMovies() {
        assertNull(OpenRequest.fromJson(JSONObject("""{"url":"u"}"""))!!.episodes)
        assertNull(OpenRequest.parseEpisodes(JSONObject("""{"seasons":[],"items":[]}""")))
    }

    @Test fun networkCachingDefaultsAndBounds() {
        assertEquals(3000, OpenRequest.fromJson(JSONObject("""{"url":"u"}"""))!!.networkCachingMs)
        assertEquals(20000, OpenRequest.fromJson(JSONObject("""{"url":"u","networkCachingMs":20000}"""))!!.networkCachingMs)
        assertEquals(60000, OpenRequest.fromJson(JSONObject("""{"url":"u","networkCachingMs":999999}"""))!!.networkCachingMs)
        assertEquals(1000, OpenRequest.fromJson(JSONObject("""{"url":"u","networkCachingMs":5}"""))!!.networkCachingMs)
    }

    private val pending = OpenRequest(
        url = "u", title = "Dune", subtitle = "S1:É2",
        subtitles = listOf(SubtitleSource("http://s/1.srt", "fr", "Français")),
        nextEpisode = NextEpisodeInfo("S1:É3", null),
    )

    @Test fun updateSansSousTitreGardeLeSousTitre() {
        // `subtitle` absent de la mise à jour : la valeur en attente ne doit pas être effacée (LAST-1626).
        val r = pending.withUpdate(JSONObject("""{"title":"Dune 2"}"""))
        assertEquals("Dune 2", r.title)
        assertEquals("S1:É2", r.subtitle)
        assertEquals("S1:É3", r.nextEpisode?.title)
    }

    @Test fun updateSousTitreVideEfface() {
        // Présent mais vide : c'est bien une demande d'effacement.
        val r = pending.withUpdate(JSONObject("""{"subtitle":""}"""))
        assertEquals("Dune", r.title)
        assertEquals("", r.subtitle)
    }

    @Test fun updateRemplaceSeulementLesCleesPresentes() {
        val r = pending.withUpdate(JSONObject("""{"skipSegments":[{"kind":"intro","start":60,"end":150}]}"""))
        assertEquals(1, r.skipSegments.size)
        assertEquals("S1:É3", r.nextEpisode?.title)
        assertEquals(pending.subtitles, r.subtitles)
        assertNull(pending.withUpdate(JSONObject("""{"nextEpisode":null}""")).nextEpisode)
    }

    @Test fun sousTitresAjoutesSansDoublon() {
        // Fusion : les sous-titres déjà en attente restent, les doublons ne se répètent pas.
        val en = pending.copy(subtitles = listOf(SubtitleSource("http://s/a.srt", "fr", "A"), SubtitleSource("http://s/b.srt", "fr", "B")))
        val r = en.withSubtitles(listOf(SubtitleSource("http://s/b.srt", "fr", "B bis"), SubtitleSource("http://s/c.srt", "en", "C")))
        assertEquals(listOf("http://s/a.srt", "http://s/b.srt", "http://s/c.srt"), r.subtitles.map { it.url })
    }
}
