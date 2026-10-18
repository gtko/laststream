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
    val sources: List<SourceItem> = emptyList(),
    val episodes: EpisodesData? = null,
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
                sources = parseSources(o.optJSONArray("sources")),
                episodes = parseEpisodes(o.optJSONObject("episodes")),
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

        fun parseSources(a: JSONArray?): List<SourceItem> {
            if (a == null) return emptyList()
            val out = ArrayList<SourceItem>()
            for (i in 0 until a.length()) {
                val s = a.optJSONObject(i) ?: continue
                val id = s.opt("id")?.toString().orEmpty()
                val label = s.optString("label", "")
                if (id.isEmpty() || label.isEmpty()) continue
                out.add(SourceItem(id, label, s.optString("detail", ""), s.optBoolean("current", false), s.optString("group", "")))
            }
            return out
        }

        /** Saisons et épisodes ; null si rien d'exploitable (film). */
        fun parseEpisodes(o: JSONObject?): EpisodesData? {
            if (o == null) return null
            val seasons = ArrayList<SeasonInfo>()
            o.optJSONArray("seasons")?.let { a ->
                for (i in 0 until a.length()) {
                    val s = a.optJSONObject(i) ?: continue
                    if (!s.has("number")) continue
                    val n = s.optInt("number")
                    seasons.add(SeasonInfo(n, s.optString("name", "").ifBlank { "Saison $n" }))
                }
            }
            val items = ArrayList<EpisodeItem>()
            o.optJSONArray("items")?.let { a ->
                for (i in 0 until a.length()) {
                    val e = a.optJSONObject(i) ?: continue
                    if (!e.has("season") || !e.has("episode")) continue
                    items.add(
                        EpisodeItem(
                            e.optInt("season"), e.optInt("episode"), e.optString("title", ""), e.optString("still", "").ifBlank { null },
                            e.optInt("durationMin", 0), e.optBoolean("watched", false), e.optDouble("progress", 0.0).let { if (it.isNaN()) 0.0 else it.coerceIn(0.0, 1.0) },
                            e.optBoolean("current", false), e.optBoolean("aired", true),
                        ),
                    )
                }
            }
            if (seasons.isEmpty() && items.isEmpty()) return null
            return EpisodesData(seasons, o.optInt("currentSeason", items.firstOrNull { it.current }?.season ?: seasons.firstOrNull()?.number ?: 1), items)
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

    /** Écouteur de test (instrumenté) : reçoit les mêmes évènements que le JS. */
    @Volatile var listener: ((String, JSObject) -> Unit)? = null

    fun emit(event: String, data: JSObject = JSObject()) {
        listener?.invoke(event, data)
        plugin?.emit(event, data)
    }
}
