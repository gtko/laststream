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

    @Test fun noEpisodesForMovies() {
        assertNull(OpenRequest.fromJson(JSONObject("""{"url":"u"}"""))!!.episodes)
        assertNull(OpenRequest.parseEpisodes(JSONObject("""{"seasons":[],"items":[]}""")))
    }
}
