package com.laststream.app.downloads

import java.io.IOException

/** Codes d'erreur du téléchargement : ceux de `DownloadErrorCode` (src/downloads/types.ts). Jamais d'URL ni de message brut. */
object DownloadCode {
    const val LINK_EXPIRED = "link_expired"
    const val CONTENT = "content"
    const val NETWORK = "network"
    const val RANGE_MISMATCH = "range_mismatch"
    const val QUOTA_EXCEEDED = "quota_exceeded"
    const val STORE_FULL = "store_full"
    const val STORE_FAILED = "store_failed"
    const val CANCELLED = "cancelled"

    /** Lien périmé et coupure réseau valent un nouvel essai ; le reste est définitif. */
    fun retryable(code: String): Boolean = code == LINK_EXPIRED || code == NETWORK
}

/** Un job vu par la notification : titre fourni par l'application (jamais le nom de fichier du serveur) et progression. */
data class JobSnapshot(val title: String, val bytesDone: Long, val bytesTotal: Long?)

/** Contenu de la notification agrégée ; `percent` vaut -1 quand la taille est inconnue (barre indéterminée). */
data class NotificationContent(val title: String, val text: String, val percent: Int)

/** Logique pure des téléchargements natifs : textes de notification, pourcentage, contrôle des adresses, codes d'erreur. */
object DownloadLogic {
    const val CHANNEL_ID = "downloads"
    const val FALLBACK_TITLE = "Téléchargement"
    private const val MAX_TITLE = 80

    /** Titre à afficher : sans caractères de contrôle, borné ; « Téléchargement » s'il est vide. */
    fun cleanTitle(raw: String?): String {
        val t = (raw ?: "").filter { !it.isISOControl() }.trim()
        return if (t.isEmpty()) FALLBACK_TITLE else if (t.length > MAX_TITLE) t.substring(0, MAX_TITLE - 1).trimEnd() + "…" else t
    }

    /** Pourcentage agrégé (0-100) des jobs dont la taille est connue ; -1 si aucune ne l'est. */
    fun aggregatePercent(jobs: List<JobSnapshot>): Int {
        val known = jobs.filter { (it.bytesTotal ?: 0L) > 0L }
        if (known.isEmpty()) return -1
        val total = known.sumOf { it.bytesTotal!! }
        val done = known.sumOf { it.bytesDone.coerceIn(0L, it.bytesTotal!!) }
        return ((done * 100) / total).toInt().coerceIn(0, 100)
    }

    /** Texte de la notification : le titre du job, ou « N téléchargements » quand plusieurs tournent. */
    fun notification(jobs: List<JobSnapshot>): NotificationContent {
        if (jobs.isEmpty()) return NotificationContent("Téléchargements", "En attente du prochain téléchargement", -1)
        val percent = aggregatePercent(jobs)
        val title = if (jobs.size > 1) "${jobs.size} téléchargements" else cleanTitle(jobs.firstOrNull()?.title)
        val text = if (percent >= 0) "Téléchargement en cours · $percent %" else "Téléchargement en cours"
        return NotificationContent(title, text, percent)
    }

    /** Disque plein (ENOSPC) → `store_full`, toute autre erreur disque → `store_failed`. Le message n'est jamais repris. */
    fun diskErrorCode(e: Throwable): String {
        var t: Throwable? = e
        var depth = 0
        while (t != null && depth < 5) {
            val m = (t.message ?: "").lowercase()
            if (m.contains("no space left") || m.contains("enospc") || m.contains("disk quota")) return DownloadCode.STORE_FULL
            t = t.cause
            depth++
        }
        return DownloadCode.STORE_FAILED
    }

    /** Adresse de départ : https seulement (http accepté uniquement pour les tests locaux). */
    fun isUrlAllowed(protocol: String?, host: String?, allowInsecure: Boolean): Boolean {
        if (host.isNullOrEmpty()) return false
        return protocol == "https" || (allowInsecure && protocol == "http")
    }

    /** Redirection : toute adresse doit être autorisée, et jamais de rétrogradation https vers http. */
    fun isRedirectAllowed(fromProtocol: String?, toProtocol: String?, toHost: String?, allowInsecure: Boolean): Boolean =
        isUrlAllowed(toProtocol, toHost, allowInsecure) && !(fromProtocol == "https" && toProtocol != "https")

    /** Réduit une exception d'un job à un code ; les messages bruts (qui peuvent contenir l'URL) ne sortent jamais. */
    fun codeOf(e: Throwable): String = when (e) {
        is TransferException -> e.code
        is IOException -> diskErrorCode(e)
        else -> DownloadCode.STORE_FAILED
    }
}
