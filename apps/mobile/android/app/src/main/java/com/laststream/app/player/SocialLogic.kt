package com.laststream.app.player

import org.json.JSONArray
import org.json.JSONObject

/** Spectateur affiché dans les avatars ou comme auteur d'un message (`avatarUrl` ignoré : aucun appel réseau côté natif). */
data class SocialViewer(val id: String, val name: String, val initial: String = "")

/** Note posée sur la barre : emoji ou texte, à une position (secondes). */
data class SocialNote(val id: String, val pos: Double, val kind: String, val body: String, val by: SocialViewer?, val mine: Boolean)

/** Bulle de message en haut à gauche. */
data class SocialMessage(val id: String, val from: SocialViewer, val body: String)

/** Marqueur affiché sur la barre : plusieurs notes voisines regroupées. */
data class SocialMarker(val fraction: Double, val pos: Double, val emoji: String, val count: Int)

/** État social tenu côté natif (alimenté par `setSocial` / `setNotes`). Désactivé tant que `setSocial` n'est pas appelé. */
data class SocialState(
    val enabled: Boolean = false,
    val quick: List<String> = emptyList(),
    val more: List<String> = emptyList(),
    val viewers: List<SocialViewer> = emptyList(),
    val notes: List<SocialNote> = emptyList(),
)

/** Logique pure de la couche sociale (testée sans Android). */
object SocialLogic {
    const val MARKER_GROUP_FRACTION = 0.015
    const val REACT_COOLDOWN_MS = 600L
    const val BUBBLE_TTL_MS = 6000L
    const val BUBBLE_MAX = 3
    const val AVATAR_MAX = 4
    const val FALLBACK_EMOJI = "💬"

    fun parseViewer(o: JSONObject?): SocialViewer? {
        if (o == null) return null
        val name = o.optString("name", "")
        val id = o.opt("id")?.toString().orEmpty().ifEmpty { name }
        if (id.isEmpty()) return null
        return SocialViewer(id, name, o.optString("initial", ""))
    }

    fun parseViewers(a: JSONArray?): List<SocialViewer> {
        if (a == null) return emptyList()
        return (0 until a.length()).mapNotNull { parseViewer(a.optJSONObject(it)) }
    }

    fun parseStrings(a: JSONArray?): List<String> {
        if (a == null) return emptyList()
        return (0 until a.length()).map { a.optString(it, "") }.filter { it.isNotBlank() }
    }

    fun parseNotes(a: JSONArray?): List<SocialNote> {
        if (a == null) return emptyList()
        val out = ArrayList<SocialNote>()
        for (i in 0 until a.length()) {
            val o = a.optJSONObject(i) ?: continue
            val pos = o.optDouble("pos", Double.NaN)
            if (pos.isNaN() || pos < 0) continue
            out.add(
                SocialNote(
                    o.opt("id")?.toString().orEmpty(), pos, o.optString("kind", "emoji"), o.optString("body", ""),
                    parseViewer(o.optJSONObject("by")), o.optBoolean("mine", false),
                ),
            )
        }
        return out
    }

    fun parseState(o: JSONObject, previous: SocialState): SocialState = SocialState(
        enabled = o.optBoolean("enabled", false),
        quick = parseStrings(o.optJSONArray("quick")),
        more = parseStrings(o.optJSONArray("more")),
        viewers = parseViewers(o.optJSONArray("viewers")),
        notes = previous.notes,
    )

    fun parseMessage(o: JSONObject): SocialMessage? {
        val from = parseViewer(o.optJSONObject("from")) ?: return null
        val body = o.optString("body", "").trim()
        if (body.isEmpty()) return null
        val id = o.opt("id")?.toString().orEmpty().ifEmpty { "${from.id}:${body.hashCode()}" }
        return SocialMessage(id, from, body)
    }

    /**
     * Regroupe les notes voisines (écart au début du groupe < `threshold` de la durée) : un marqueur par groupe,
     * avec l'emoji le plus fréquent (à égalité, le premier rencontré) et la position de la première note.
     * Les notes texte comptent pour un marqueur 💬. Sans durée connue : aucun marqueur.
     */
    fun groupMarkers(notes: List<SocialNote>, duration: Double, threshold: Double = MARKER_GROUP_FRACTION): List<SocialMarker> {
        if (!(duration > 0) || notes.isEmpty()) return emptyList()
        val sorted = notes.filter { it.pos in 0.0..duration }.sortedBy { it.pos }
        val out = ArrayList<SocialMarker>()
        var group = ArrayList<SocialNote>()
        fun flush() {
            if (group.isEmpty()) return
            val counts = LinkedHashMap<String, Int>()
            group.forEach { n -> val e = emojiOf(n); counts[e] = (counts[e] ?: 0) + 1 }
            val top = counts.values.max()
            val best = counts.entries.first { it.value == top }.key
            val pos = group.first().pos
            out.add(SocialMarker((pos / duration).coerceIn(0.0, 1.0), pos, best, group.size))
            group = ArrayList()
        }
        for (n in sorted) {
            if (group.isNotEmpty() && (n.pos - group.first().pos) / duration >= threshold) flush()
            group.add(n)
        }
        flush()
        return out
    }

    private fun emojiOf(n: SocialNote): String = if (n.kind == "emoji" && n.body.isNotBlank()) n.body else FALLBACK_EMOJI

    /** Initiales d'un spectateur : `initial` fourni, sinon première lettre (deux pour un nom composé). */
    fun initials(v: SocialViewer): String {
        if (v.initial.isNotBlank()) return v.initial.trim().take(2).uppercase()
        val parts = v.name.trim().split(Regex("\\s+")).filter { it.isNotEmpty() }
        if (parts.isEmpty()) return "?"
        return (if (parts.size == 1) parts[0].take(1) else parts[0].take(1) + parts[1].take(1)).uppercase()
    }

    /** Avatars visibles (max `AVATAR_MAX`) et nombre de spectateurs en plus (« +N »). */
    fun avatarSplit(viewers: List<SocialViewer>): Pair<List<SocialViewer>, Int> =
        viewers.take(AVATAR_MAX) to (viewers.size - AVATAR_MAX).coerceAtLeast(0)

    /** Anti-spam : une réaction toutes les `REACT_COOLDOWN_MS`. */
    fun allowReaction(nowMs: Long, lastMs: Long?): Boolean = lastMs == null || nowMs - lastMs >= REACT_COOLDOWN_MS

    val REPLY_EMOJIS = listOf("😂", "❤️")

    /** Fin d'activité : l'état social ne se remet à zéro que si l'écran se ferme pour de bon (pas lors d'un passage en vignette). */
    fun shouldResetOnDestroy(finishing: Boolean, handedOff: Boolean, ownsOverlay: Boolean) = finishing && !handedOff && ownsOverlay

    /** Seules les réponses prévues partent vers le JS. */
    fun isReplyEmoji(e: String) = e in REPLY_EMOJIS
}

/** File des bulles : 3 au plus (la plus ancienne cède la place), 6 s de vie, identifiant déjà présent ignoré. */
class BubbleQueue(private val max: Int = SocialLogic.BUBBLE_MAX, private val ttlMs: Long = SocialLogic.BUBBLE_TTL_MS) {
    private class Entry(val msg: SocialMessage, val expiresAt: Long)

    private val entries = ArrayList<Entry>()

    fun push(msg: SocialMessage, nowMs: Long): Boolean {
        prune(nowMs)
        if (entries.any { it.msg.id == msg.id }) return false
        entries.add(Entry(msg, nowMs + ttlMs))
        while (entries.size > max) entries.removeAt(0)
        return true
    }

    fun prune(nowMs: Long) { entries.removeAll { it.expiresAt <= nowMs } }

    fun remove(id: String) { entries.removeAll { it.msg.id == id } }

    fun clear() = entries.clear()

    fun active(nowMs: Long): List<SocialMessage> { prune(nowMs); return entries.map { it.msg } }

    /** Prochaine échéance (pour armer un minuteur), null si la file est vide. */
    fun nextExpiry(): Long? = entries.minOfOrNull { it.expiresAt }
}
