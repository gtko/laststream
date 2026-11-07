package com.laststream.app.downloads

import java.io.IOException
import java.net.Inet4Address
import java.net.Inet6Address
import java.net.InetAddress
import java.net.URL

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

    private val LABEL = Regex("^[a-z0-9]([a-z0-9-]*[a-z0-9])?$")
    private val TLD = Regex("^([a-z]{2,63}|xn--[a-z0-9-]{1,59})$")
    private val LOCAL_SUFFIXES = listOf(".local", ".internal", ".localhost")

    /**
     * Nom d'hôte public (miroir de `isAddonLinkUrl`, src/downloads/linkHosts.ts) : un nom de domaine à point, jamais une IP littérale
     * (IPv4 sous toutes ses écritures : décimale, hexadécimale, octale, abrégée ; IPv6 entre crochets), localhost ni nom local.
     * Le dernier libellé doit être alphabétique : aucune écriture numérique d'adresse n'y passe.
     */
    fun isPublicHostName(host: String?): Boolean {
        val h = (host ?: "").lowercase().removeSuffix(".")
        if (h.isEmpty() || h.length > 253 || !h.contains('.')) return false
        if (h == "localhost" || LOCAL_SUFFIXES.any { h.endsWith(it) }) return false
        val labels = h.split('.')
        if (labels.any { it.length > 63 || !LABEL.matches(it) }) return false
        return TLD.matches(labels.last())
    }

    /**
     * Adresse résolue publique : ni loopback, ni passe-partout (0.0.0.0, ::), ni lien local (169.254/16, fe80::/10), ni réseau privé
     * (10/8, 172.16/12, 192.168/16, fc00::/7), ni partage opérateur (100.64/10), ni multicast, ni plage réservée ou de test. Les adresses
     * IPv6 qui embarquent une IPv4 (NAT64 64:ff9b::/96, 6to4 2002::/16) sont jugées sur l'IPv4 embarquée.
     */
    fun isPublicAddress(addr: InetAddress): Boolean {
        if (addr.isAnyLocalAddress || addr.isLoopbackAddress || addr.isLinkLocalAddress || addr.isSiteLocalAddress || addr.isMulticastAddress) return false
        val b = addr.address.map { it.toInt() and 0xff }
        if (addr is Inet4Address) return isPublicV4(b[0], b[1], b[2])
        if (addr is Inet6Address) {
            if ((b[0] and 0xfe) == 0xfc) return false // fc00::/7 (adresses locales uniques)
            if ((0..11).all { b[it] == 0 }) return isPublicV4(b[12], b[13], b[14]) // ::a.b.c.d (compatible IPv4, obsolète)
            if (b[0] == 0x20 && b[1] == 0x02) return isPublicV4(b[2], b[3], b[4]) // 6to4
            if (b[0] == 0x20 && b[1] == 0x01 && b[2] == 0x00 && b[3] == 0x00) return false // Teredo 2001::/32
            if (b[0] == 0x00 && b[1] == 0x64 && b[2] == 0xff && b[3] == 0x9b && b[4] == 0x00 && b[5] == 0x01) return false // NAT64 local 64:ff9b:1::/48
            val nat64 = b[0] == 0x00 && b[1] == 0x64 && b[2] == 0xff && b[3] == 0x9b && (4..11).all { b[it] == 0 }
            if (nat64) return isPublicV4(b[12], b[13], b[14])
            if (b[0] == 0x20 && b[1] == 0x01 && b[2] == 0x0d && b[3] == 0xb8) return false // 2001:db8::/32 (documentation)
        }
        return true
    }

    private fun isPublicV4(a: Int, b: Int, c: Int): Boolean = when {
        a == 0 || a >= 224 -> false // « ce réseau », multicast, réservé, diffusion
        a == 10 || a == 127 -> false // réseau privé, loopback
        a == 172 && b in 16..31 -> false
        a == 192 && b == 168 -> false
        a == 169 && b == 254 -> false // lien local
        a == 100 && b in 64..127 -> false // partage d'adresses opérateur (CGNAT)
        a == 192 && b == 0 && (c == 0 || c == 2) -> false // 192.0.0.0/24, 192.0.2.0/24
        a == 192 && b == 88 && c == 99 -> false
        a == 198 && (b == 18 || b == 19) -> false // bancs d'essai
        a == 198 && b == 51 && c == 100 -> false
        a == 203 && b == 0 && c == 113 -> false
        else -> true
    }

    /**
     * Adresse autorisée : https seulement, port par défaut (443) sans identifiants dans l'URL, nom d'hôte public. `allowInsecure`
     * (tests locaux uniquement) tolère http, tout port et tout hôte non vide.
     */
    fun isUrlAllowed(protocol: String?, host: String?, port: Int, userInfo: String?, allowInsecure: Boolean): Boolean {
        if (host.isNullOrEmpty()) return false
        if (allowInsecure) return protocol == "https" || protocol == "http"
        return protocol == "https" && userInfo == null && (port == -1 || port == 443) && isPublicHostName(host)
    }

    fun isUrlAllowed(url: URL, allowInsecure: Boolean): Boolean =
        isUrlAllowed(url.protocol, url.host, url.port, url.userInfo, allowInsecure)

    /** Redirection : toute adresse doit être autorisée, et jamais de rétrogradation https vers http. */
    fun isRedirectAllowed(from: URL, to: URL, allowInsecure: Boolean): Boolean =
        isUrlAllowed(to, allowInsecure) && !(from.protocol == "https" && to.protocol != "https")

    /** Réduit une exception d'un job à un code ; les messages bruts (qui peuvent contenir l'URL) ne sortent jamais. */
    fun codeOf(e: Throwable): String = when (e) {
        is TransferException -> e.code
        is IOException -> diskErrorCode(e)
        else -> DownloadCode.STORE_FAILED
    }
}
