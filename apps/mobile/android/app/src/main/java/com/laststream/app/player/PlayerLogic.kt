package com.laststream.app.player

import java.text.Normalizer
import java.util.Locale
import kotlin.math.abs
import kotlin.math.max
import kotlin.math.min
import kotlin.math.roundToInt

/** Segment à proposer (intro, récap, générique…), en secondes. Même vocabulaire que src/player/skip.ts. */
data class SkipSegment(val kind: String, val start: Double, val end: Double, val inferred: Boolean = false, val confidence: Double? = null)

data class SubtitleSource(val url: String, val lang: String, val label: String)

data class NextEpisodeInfo(val title: String, val still: String?)

/** Piste audio ou sous-titres exposée par libVLC (`id` -1 : « Désactivé »). */
data class TrackInfo(val id: Int, val name: String, val lang: String, val selected: Boolean = false)

/** Source de lecture proposée dans le panneau « Sources » (libellé et détail composés côté JS). */
data class SourceItem(val id: String, val label: String, val detail: String, val current: Boolean, val group: String = "")

data class SeasonInfo(val number: Int, val name: String)

data class EpisodeItem(
    val season: Int, val episode: Int, val title: String, val still: String?, val durationMin: Int,
    val watched: Boolean, val progress: Double, val current: Boolean, val aired: Boolean,
)

data class EpisodesData(val seasons: List<SeasonInfo>, val currentSeason: Int, val items: List<EpisodeItem>)

enum class AspectMode(val label: String, val vlc: String?) {
    BEST("Ajusté", null), FILL("Remplir", "fill"), R16_9("16:9", "16:9"), R4_3("4:3", "4:3"), R21_9("21:9", "21:9");

    fun next(): AspectMode = values()[(ordinal + 1) % values().size]
}

/** Logique pure du lecteur (testée sans Android). */
object PlayerLogic {
    val RATES = listOf(0.5, 0.75, 1.0, 1.25, 1.5, 2.0)
    const val SEEK_STEP_S = 10.0
    const val FALLBACK_TAIL_SECONDS = 25.0
    const val CREDITS_MIN_CONFIDENCE = 0.6

    /** 1:02:03 ou 23:14 (même rendu que formatClock côté web). */
    fun formatClock(sec: Double): String {
        val v = if (sec.isNaN() || sec < 0) 0.0 else sec
        val s = v.toLong()
        val h = s / 3600
        val m = (s % 3600) / 60
        val r = s % 60
        val mm = if (h > 0) m.toString().padStart(2, '0') else m.toString()
        return (if (h > 0) "$h:" else "") + mm + ":" + r.toString().padStart(2, '0')
    }

    private val LANG_NAMES: Map<String, String> = mapOf(
        "fr" to "fr fra fre french francais fr-fr fr-ca fr-be fr-ch vf vff vfq",
        "en" to "en eng english anglais en-us en-gb",
        "es" to "es spa esl spanish espagnol espanol castellano",
        "de" to "de deu ger german allemand deutsch",
        "it" to "it ita italian italien italiano",
        "pt" to "pt por portuguese portugais portugues pt-br pt-pt",
        "ja" to "ja jpn japanese japonais",
        "ko" to "ko kor korean coreen",
        "zh" to "zh zho chi chinese chinois mandarin cantonese",
        "ru" to "ru rus russian russe",
        "ar" to "ar ara arabic arabe",
        "nl" to "nl nld dut dutch neerlandais",
        "pl" to "pl pol polish polonais",
        "tr" to "tr tur turkish turc",
        "sv" to "sv swe swedish suedois",
        "da" to "da dan danish danois",
        "no" to "no nor nob norwegian norvegien",
        "fi" to "fi fin finnish finnois",
        "cs" to "cs ces cze czech tcheque",
        "el" to "el ell gre greek grec",
        "he" to "he heb hebrew hebreu",
        "hi" to "hi hin hindi",
        "hu" to "hu hun hungarian hongrois",
        "ro" to "ro ron rum romanian roumain",
        "uk" to "uk ukr ukrainian ukrainien",
    ).flatMap { (code, names) -> names.split(' ').map { it to code } }.toMap()

    private fun fold(s: String): String =
        Normalizer.normalize(s.lowercase(Locale.ROOT), Normalizer.Form.NFD).replace(Regex("\\p{M}+"), "").trim()

    /** « fra », « French », « Français », « fr-CA » donnent « fr » ; chaîne vide si inconnue. */
    fun normalizeLang(raw: String?): String {
        if (raw.isNullOrBlank()) return ""
        val f = fold(raw)
        LANG_NAMES[f]?.let { return it }
        val base = f.substringBefore('-').substringBefore('_')
        return LANG_NAMES[base] ?: ""
    }

    /** Langue annoncée dans le nom d'une piste libVLC : « Piste 2 - [Français] », « Track 1 - [eng] ». */
    fun langFromTrackName(name: String): String {
        val br = Regex("\\[([^\\]]+)]").find(name)?.groupValues?.get(1)
        if (br != null) normalizeLang(br).let { if (it.isNotEmpty()) return it }
        val words = fold(name).split(Regex("[^a-z-]+")).filter { it.length > 2 }
        for (w in words) normalizeLang(w).let { if (it.isNotEmpty()) return it }
        return ""
    }

    /** Piste audio : la première dans la langue souhaitée ; sinon rien (libVLC garde sa piste par défaut). */
    fun pickAudio(tracks: List<TrackInfo>, preferred: String?): TrackInfo? {
        val want = normalizeLang(preferred)
        if (want.isEmpty()) return null
        return tracks.firstOrNull { it.id >= 0 && it.lang == want }
    }

    private val FR_NAMES = mapOf(
        "fr" to "Français", "en" to "Anglais", "es" to "Espagnol", "de" to "Allemand", "it" to "Italien", "pt" to "Portugais",
        "ja" to "Japonais", "ko" to "Coréen", "zh" to "Chinois", "ru" to "Russe", "ar" to "Arabe", "nl" to "Néerlandais",
        "pl" to "Polonais", "tr" to "Turc", "sv" to "Suédois", "da" to "Danois", "no" to "Norvégien", "fi" to "Finnois",
        "cs" to "Tchèque", "el" to "Grec", "he" to "Hébreu", "hi" to "Hindi", "hu" to "Hongrois", "ro" to "Roumain", "uk" to "Ukrainien",
    )

    /** Nom français d'une langue (code à deux lettres) ; chaîne vide si inconnue. */
    fun languageName(code: String): String = FR_NAMES[normalizeLang(code)] ?: ""

    /** Libellé d'une piste : « Français · EAC3 5.1 », sinon le nom brut de libVLC nettoyé. */
    fun trackLabel(lang: String, rawName: String, codec: String = "", channels: Int = 0, forced: Boolean = false): String {
        val base = languageName(lang).ifEmpty { rawName.replace(Regex("^(Track|Piste)\\s*\\d+\\s*-?\\s*"), "").trim().ifEmpty { rawName } }
        val ch = when (channels) { 0 -> ""; 1 -> "1.0"; 2 -> "2.0"; 6 -> "5.1"; 8 -> "7.1"; else -> "$channels ch" }
        val tech = listOf(codec.uppercase(Locale.ROOT), ch).filter { it.isNotEmpty() }.joinToString(" ")
        return base + (if (forced || isForcedName(rawName)) " (forcés)" else "") + (if (tech.isNotEmpty()) " · $tech" else "")
    }

    private fun isForcedName(n: String) = Regex("forc", RegexOption.IGNORE_CASE).containsMatchIn(n)

    private fun isForced(t: TrackInfo): Boolean = Regex("forc", RegexOption.IGNORE_CASE).containsMatchIn(t.name)

    /** Sous-titres : langue souhaitée (les pistes complètes avant les « forcés »), `off` ou vide : aucun. */
    fun pickSubtitle(tracks: List<TrackInfo>, preferred: String?): TrackInfo? {
        if (preferred.isNullOrBlank() || preferred.equals("off", true)) return null
        val want = normalizeLang(preferred)
        if (want.isEmpty()) return null
        val matching = tracks.filter { it.id >= 0 && it.lang == want }
        return matching.firstOrNull { !isForced(it) } ?: matching.firstOrNull()
    }

    /**
     * Sous-titres par défaut, comme le lecteur web : `off` aucun ; `auto` seulement si l'audio n'est pas dans la langue
     * préférée (sinon les « forcés » uniquement) ; `always` toujours dans la langue préférée.
     */
    fun defaultSubtitle(subs: List<TrackInfo>, preferred: String?, audioLang: String, mode: String): TrackInfo? {
        if (mode == "off" || preferred.isNullOrBlank() || preferred.equals("off", true)) return null
        val want = normalizeLang(preferred)
        if (want.isEmpty()) return null
        val mine = subs.filter { it.id >= 0 && it.lang == want }
        if (mode == "auto" && normalizeLang(audioLang) == want) return mine.firstOrNull { isForced(it) }
        return mine.firstOrNull { !isForced(it) } ?: mine.firstOrNull()
    }

    /** Sources regroupées par qualité en gardant l'ordre reçu ; groupe vide : « Sources ». */
    fun groupSources(items: List<SourceItem>): List<Pair<String, List<SourceItem>>> {
        val out = ArrayList<Pair<String, MutableList<SourceItem>>>()
        for (it in items) {
            val g = it.group.ifBlank { "Sources" }
            val last = out.lastOrNull()
            if (last != null && last.first == g) last.second.add(it) else out.add(g to mutableListOf(it))
        }
        return out
    }

    fun episodesOf(d: EpisodesData?, season: Int): List<EpisodeItem> = d?.items?.filter { it.season == season }?.sortedBy { it.episode } ?: emptyList()

    /** « É5 · Titre » ; « Épisode 5 » sans titre. */
    fun episodeTitle(e: EpisodeItem): String = "É${e.episode} · " + e.title.ifBlank { "Épisode ${e.episode}" }

    fun episodeMeta(e: EpisodeItem): String = if (e.durationMin > 0) "${e.durationMin} min" else ""

    private val SKIPPABLE = setOf("intro", "recap", "preview")

    fun activeSkip(segments: List<SkipSegment>, t: Double): SkipSegment? =
        segments.firstOrNull { it.kind in SKIPPABLE && t >= it.start - 0.25 && t < it.end - 1 }

    fun skipLabel(seg: SkipSegment): String {
        val base = when (seg.kind) {
            "intro" -> "Passer l’intro"
            "recap" -> "Passer le récap"
            "credits" -> "Passer le générique"
            "postcredits" -> "Passer la scène post-générique"
            else -> "Passer l’aperçu"
        }
        return base + if (seg.inferred) " ?" else ""
    }

    private fun validCredits(seg: SkipSegment, duration: Double): Boolean {
        if (seg.kind != "credits" || seg.inferred) return false
        if (seg.confidence != null && seg.confidence < CREDITS_MIN_CONFIDENCE) return false
        return seg.start >= duration - min(duration * 0.15, 240.0) && seg.start < duration
    }

    /** Début du générique de fin : segment fiable, sinon les 25 dernières secondes. */
    fun creditsStart(segments: List<SkipSegment>, duration: Double): Double? {
        if (!(duration > 0)) return null
        segments.firstOrNull { validCredits(it, duration) }?.let { return it.start }
        return if (duration > FALLBACK_TAIL_SECONDS * 2) duration - FALLBACK_TAIL_SECONDS else null
    }

    /** Délai après lequel une demande d'épisode suivant restée sans réponse du JS rend la main au lecteur. */
    const val NEXT_REQUEST_TIMEOUT_MS = 8000L

    /** Activité finie : `pending` n'est effacé que s'il est encore celui de cette activité (jamais celui du média suivant). */
    fun <T : Any> shouldClearPending(current: T?, own: T?): Boolean = current == null || current === own

    /** Carte « Épisode suivant » : dès le générique, jamais pendant une intro ou un récap. */
    fun showNextCard(segments: List<SkipSegment>, t: Double, duration: Double, hasNext: Boolean): Boolean {
        if (!hasNext || !(duration > 0)) return false
        val start = creditsStart(segments, duration) ?: return false
        if (t < start) return false
        return segments.none { (it.kind == "intro" || it.kind == "recap") && t >= it.start && t < it.end }
    }

    /** Position après un saut relatif, bornée à la durée connue. */
    fun seekTarget(position: Double, delta: Double, duration: Double): Double {
        val hi = if (duration > 0) max(0.0, duration - 1) else Double.MAX_VALUE
        return min(hi, max(0.0, position + delta))
    }

    /** « +0,5 s », « −1,2 s », « 0 s ». */
    fun formatDelay(ms: Long): String {
        if (ms == 0L) return "0 s"
        val s = abs(ms) / 1000.0
        val txt = String.format(Locale.FRANCE, "%.1f", s)
        return (if (ms > 0) "+" else "−") + txt + " s"
    }

    fun clampDelayMs(ms: Long): Long = min(120_000L, max(-120_000L, ms))

    fun rateLabel(r: Double): String =
        (if (r == r.roundToInt().toDouble()) r.roundToInt().toString() else r.toString().replace('.', ',')) + "×"

    /** Cadence d'un événement : au plus un toutes les `everyMs`. */
    fun shouldEmit(nowMs: Long, lastMs: Long, everyMs: Long): Boolean = lastMs == 0L || nowMs - lastMs >= everyMs
}
