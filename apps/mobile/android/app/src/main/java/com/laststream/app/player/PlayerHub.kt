package com.laststream.app.player

import com.getcapacitor.JSObject
import org.json.JSONArray
import org.json.JSONObject

/** Paramètres d'ouverture du lecteur, tels que le JS les envoie (`LaststreamPlayer.open`). */
data class OpenRequest(
    val url: String,
    val title: String = "",
    val subtitle: String = "",
    val startPosition: Double = 0.0,
    val preferredAudioLang: String = "",
    val preferredSubLang: String = "",
    /** `auto` (sous-titres si l'audio n'est pas dans la langue préférée), `always` ou `off`. */
    val subMode: String = "auto",
    val subtitles: List<SubtitleSource> = emptyList(),
    val skipSegments: List<SkipSegment> = emptyList(),
    val nextEpisode: NextEpisodeInfo? = null,
    val headers: Map<String, String> = emptyMap(),
) {
    companion object {
        fun fromJson(o: JSONObject): OpenRequest? {
            val url = o.optString("url", "").trim()
            if (url.isEmpty()) return null
            return OpenRequest(
                url = url,
                title = o.optString("title", ""),
                subtitle = o.optString("subtitle", ""),
                startPosition = o.optDouble("startPosition", 0.0).let { if (it.isNaN() || it < 0) 0.0 else it },
                preferredAudioLang = o.optString("preferredAudioLang", ""),
                preferredSubLang = o.optString("preferredSubLang", ""),
                subMode = o.optString("subMode", "auto").ifBlank { "auto" },
                subtitles = parseSubtitles(o.optJSONArray("subtitles")),
                skipSegments = parseSegments(o.optJSONArray("skipSegments")),
                nextEpisode = parseNext(o.optJSONObject("nextEpisode")),
                headers = o.optJSONObject("headers")?.let { h -> h.keys().asSequence().associateWith { k -> h.optString(k) } } ?: emptyMap(),
            )
        }

        fun parseSubtitles(a: JSONArray?): List<SubtitleSource> {
            if (a == null) return emptyList()
            val out = ArrayList<SubtitleSource>()
            for (i in 0 until a.length()) {
                val s = a.optJSONObject(i) ?: continue
                val u = s.optString("url", "")
                if (u.isBlank()) continue
                out.add(SubtitleSource(u, s.optString("lang", ""), s.optString("label", "")))
            }
            return out
        }

        fun parseSegments(a: JSONArray?): List<SkipSegment> {
            if (a == null) return emptyList()
            val out = ArrayList<SkipSegment>()
            for (i in 0 until a.length()) {
                val s = a.optJSONObject(i) ?: continue
                val start = s.optDouble("start", Double.NaN)
                val end = s.optDouble("end", Double.NaN)
                if (start.isNaN() || end.isNaN() || end - start < 3 || start < 0) continue
                out.add(
                    SkipSegment(
                        s.optString("kind", ""), start, end, s.optBoolean("inferred", false),
                        if (s.has("confidence")) s.optDouble("confidence") else null,
                    ),
                )
            }
            return out.sortedBy { it.start }
        }

        fun parseNext(o: JSONObject?): NextEpisodeInfo? {
            if (o == null) return null
            val t = o.optString("title", "")
            return NextEpisodeInfo(t, o.optString("still", "").ifBlank { null })
        }
    }
}

/**
 * Passerelle entre le plugin Capacitor (processus du WebView) et l'activité du lecteur : l'un et l'autre vivent dans le même
 * processus, mais pas forcément en même temps.
 */
object PlayerHub {
    @Volatile var plugin: LaststreamPlayerPlugin? = null
    @Volatile var activity: PlayerActivity? = null
    @Volatile var pending: OpenRequest? = null

    fun emit(event: String, data: JSObject = JSObject()) {
        plugin?.emit(event, data)
    }
}
