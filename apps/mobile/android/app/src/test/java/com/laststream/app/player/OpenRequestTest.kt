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
}
