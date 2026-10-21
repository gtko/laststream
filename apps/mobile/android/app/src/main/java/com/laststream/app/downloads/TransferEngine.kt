package com.laststream.app.downloads

import java.io.IOException
import java.net.HttpURLConnection
import java.net.URL

/** Erreur d'un transfert : le message est le code seul, jamais l'URL ni un message système (qui peut la contenir). */
class TransferException(val code: String, val retryable: Boolean = DownloadCode.retryable(code)) : Exception(code)

/** Ce qu'il faut pour télécharger un fichier. `url` est un lien débridé : en mémoire seulement, jamais affiché ni écrit. */
data class TransferRequest(
    val id: String,
    val url: String,
    val bytesTotal: Long? = null,
    val etag: String? = null,
    val maxBytes: Long? = null,
) {
    /** Jamais d'URL dans un journal ou une trace. */
    override fun toString(): String = "TransferRequest(id=$id)"
}

/** Avancement d'un transfert. */
data class Progress(val bytesDone: Long, val bytesTotal: Long? = null, val etag: String? = null, val lastModified: String? = null)

/** Fin d'un transfert réussi : le fichier est complet (non finalisé, c'est à l'appelant de le faire). */
data class TransferResult(val bytesDone: Long, val bytesTotal: Long? = null, val etag: String? = null, val lastModified: String? = null)

/**
 * Transfert d'un fichier par HTTP avec reprise (miroir natif de src/downloads/transfer.ts) : repart de la taille déjà écrite
 * (`Range: bytes=<offset>-`), écrit en flux dans le `.part` (jamais le corps entier en mémoire), classe chaque réponse en code
 * d'erreur. Redirections suivies à la main : https obligatoire, jamais de rétrogradation vers http. JVM pur.
 *
 * @param allowInsecure autorise http (tests locaux uniquement).
 * @param clock horloge en millisecondes (injectable pour tester la limitation des évènements de progression).
 */
class TransferEngine(
    private val files: DownloadFiles,
    private val allowInsecure: Boolean = false,
    private val clock: () -> Long = { System.currentTimeMillis() },
) {
    companion object {
        const val BUFFER_SIZE = 256 * 1024
        const val SYNC_EVERY = 32L * 1024 * 1024
        const val MAX_REDIRECTS = 5
        const val CONNECT_TIMEOUT_MS = 15_000
        const val READ_TIMEOUT_MS = 30_000
        const val PROGRESS_INTERVAL_MS = 1_000L
        private val CONTENT_RANGE = Regex("^bytes (\\d+)-(\\d+)/(\\d+|\\*)$")
        private val UNSATISFIED_RANGE = Regex("^bytes \\*/(\\d+)$")
        private val LINK_EXPIRED_STATUS = setOf(401, 403, 404, 410)
        private val REDIRECT_STATUS = setOf(301, 302, 303, 307, 308)
    }

    private class Range(val start: Long, val last: Long, val total: Long?)

    private fun fail(code: String): Nothing = throw TransferException(code)

    /** Échec réseau, ou `cancelled` si l'annulation est demandée (la connexion coupée par `registerAbort` lève une IOException). */
    private fun netFail(cancelled: () -> Boolean): Nothing = if (cancelled()) fail(DownloadCode.CANCELLED) else fail(DownloadCode.NETWORK)

    /**
     * @param registerAbort reçoit une action qui coupe la connexion en cours (appelée depuis un autre thread à l'annulation),
     * puis null quand il n'y en a plus.
     */
    fun run(
        req: TransferRequest,
        cancelled: () -> Boolean,
        onProgress: (Progress) -> Unit,
        registerAbort: ((() -> Unit)?) -> Unit = {},
    ): TransferResult {
        val start = try { URL(req.url) } catch (_: Exception) { fail(DownloadCode.CONTENT) }
        if (!DownloadLogic.isUrlAllowed(start.protocol, start.host, allowInsecure)) fail(DownloadCode.CONTENT)

        var bytesTotal = req.bytesTotal
        var etag = req.etag
        var lastModified: String? = null
        var restarted = false
        var offset = 0L
        var lastEmit = 0L
        var emitted = false

        fun disk(op: () -> Unit) {
            try { op() } catch (e: IOException) { fail(DownloadLogic.diskErrorCode(e)) }
        }
        fun emit(force: Boolean) {
            val now = clock()
            if (force || !emitted || now - lastEmit >= PROGRESS_INTERVAL_MS) {
                emitted = true
                lastEmit = now
                onProgress(Progress(offset, bytesTotal, etag, lastModified))
            }
        }
        // Changement distant pendant la reprise : on repart de zéro, une seule fois, en oubliant ETag et taille.
        fun restartFromZero() {
            if (restarted) fail(DownloadCode.RANGE_MISMATCH)
            restarted = true
            disk { files.truncate(req.id, 0) }
            offset = 0
            bytesTotal = null
            etag = null
            lastModified = null
        }
        fun finished(): TransferResult {
            emit(true)
            return TransferResult(offset, bytesTotal, etag, lastModified)
        }
        fun checkQuota(size: Long?) {
            if (size != null && req.maxBytes != null && size > req.maxBytes) fail(DownloadCode.QUOTA_EXCEEDED)
        }

        while (true) {
            if (cancelled()) fail(DownloadCode.CANCELLED)
            offset = files.size(req.id)
            val known = bytesTotal
            if (known != null && offset > known) {
                disk { files.truncate(req.id, 0) }
                offset = 0
            }
            checkQuota(bytesTotal)
            if (bytesTotal != null && bytesTotal!! > 0 && offset == bytesTotal) return finished()

            val conn = connect(req.url, offset, cancelled, registerAbort)
            try {
                val status = try { conn.responseCode } catch (_: IOException) { netFail(cancelled) }
                val html = (conn.contentType ?: "").lowercase().contains("text/html")
                if ((status == 200 || status == 206) && html) fail(DownloadCode.LINK_EXPIRED)
                if (status in LINK_EXPIRED_STATUS) fail(DownloadCode.LINK_EXPIRED)
                if (status == 429 || status >= 500) fail(DownloadCode.NETWORK)

                when (status) {
                    416 -> {
                        val unsatisfied = UNSATISFIED_RANGE.matchEntire(conn.getHeaderField("Content-Range") ?: "")
                        val total = unsatisfied?.groupValues?.get(1)?.toLongOrNull()
                        if (total != null && total == offset && (bytesTotal == null || bytesTotal == offset)) {
                            bytesTotal = offset
                            return finished()
                        }
                        restartFromZero()
                        continue
                    }
                    206 -> {
                        val m = CONTENT_RANGE.matchEntire(conn.getHeaderField("Content-Range") ?: "")
                        val range = m?.let { Range(it.groupValues[1].toLong(), it.groupValues[2].toLong(), it.groupValues[3].toLongOrNull()) }
                        val resEtag = conn.getHeaderField("ETag")
                        val valid = range != null && range.start == offset && range.last >= range.start &&
                            (range.total == null || (range.last < range.total && (bytesTotal == null || range.total == bytesTotal))) &&
                            (etag == null || resEtag == null || resEtag == etag)
                        if (range == null || !valid) {
                            restartFromZero()
                            continue
                        }
                        checkQuota(range.total)
                        if (bytesTotal == null) bytesTotal = range.total
                        if (etag == null) etag = resEtag
                        if (lastModified == null) lastModified = conn.getHeaderField("Last-Modified")
                        offset = stream(conn, req, offset, cancelled, ::emit) { offset = it }
                        // Corps plus court que la plage annoncée : coupure, la reprise repartira de ce qui est écrit.
                        if (offset != range.last + 1) netFail(cancelled)
                        if (bytesTotal == null) { bytesTotal = offset; return finished() }
                        if (offset >= bytesTotal!!) return finished()
                    }
                    200 -> {
                        if (offset > 0) { // plage ignorée : le serveur renvoie tout le fichier
                            restartFromZero()
                            continue
                        }
                        val length = conn.contentLengthLong.takeIf { it >= 0 }
                        checkQuota(length)
                        etag = conn.getHeaderField("ETag")
                        lastModified = conn.getHeaderField("Last-Modified")
                        bytesTotal = length ?: bytesTotal
                        offset = stream(conn, req, 0, cancelled, ::emit) { offset = it }
                        if (length != null && offset != length) netFail(cancelled)
                        bytesTotal = offset
                        return finished()
                    }
                    else -> fail(DownloadCode.CONTENT)
                }
            } finally {
                conn.disconnect()
                registerAbort(null)
            }
        }
    }

    /**
     * Copie le corps de la réponse à la suite du `.part` par tampons de 256 Kio. Retourne la taille écrite au total.
     * `setOffset` met à jour l'avancement vu par `emit` avant chaque évènement de progression.
     */
    private fun stream(
        conn: HttpURLConnection,
        req: TransferRequest,
        from: Long,
        cancelled: () -> Boolean,
        emit: (Boolean) -> Unit,
        setOffset: (Long) -> Unit,
    ): Long {
        var offset = from
        val input = try { conn.inputStream } catch (_: IOException) { netFail(cancelled) }
        val out = try { files.openAppend(req.id) } catch (e: IOException) { input.close(); fail(DownloadLogic.diskErrorCode(e)) }
        try {
            val buf = ByteArray(BUFFER_SIZE)
            var sinceSync = 0L
            while (true) {
                if (cancelled()) fail(DownloadCode.CANCELLED)
                val n = try { input.read(buf) } catch (_: IOException) { netFail(cancelled) }
                if (n < 0) break
                if (n == 0) continue
                try {
                    out.write(buf, 0, n)
                    offset += n
                    sinceSync += n
                    if (sinceSync >= SYNC_EVERY) { out.fd.sync(); sinceSync = 0 }
                } catch (e: IOException) {
                    fail(DownloadLogic.diskErrorCode(e))
                }
                if (req.maxBytes != null && offset > req.maxBytes) {
                    setOffset(offset)
                    fail(DownloadCode.QUOTA_EXCEEDED)
                }
                setOffset(offset)
                emit(false)
            }
            try { out.flush(); out.fd.sync() } catch (e: IOException) { fail(DownloadLogic.diskErrorCode(e)) }
            return offset
        } finally {
            try { out.close() } catch (_: IOException) { }
            try { input.close() } catch (_: IOException) { }
        }
    }

    /** Ouvre la connexion en suivant les redirections à la main (5 au plus). Toute erreur devient un code sans URL. */
    private fun connect(startUrl: String, offset: Long, cancelled: () -> Boolean, registerAbort: ((() -> Unit)?) -> Unit): HttpURLConnection {
        var url = try { URL(startUrl) } catch (_: Exception) { fail(DownloadCode.CONTENT) }
        var hops = 0
        while (true) {
            val conn = try { url.openConnection() as HttpURLConnection } catch (_: Exception) { netFail(cancelled) }
            // Hors du thread appelant : sur certaines implémentations disconnect() attend la lecture en cours (jamais bloquer cancel()).
            registerAbort { Thread { try { conn.disconnect() } catch (_: Exception) { } }.apply { isDaemon = true }.start() }
            if (cancelled()) { conn.disconnect(); fail(DownloadCode.CANCELLED) }
            conn.instanceFollowRedirects = false
            conn.connectTimeout = CONNECT_TIMEOUT_MS
            conn.readTimeout = READ_TIMEOUT_MS
            conn.requestMethod = "GET"
            conn.setRequestProperty("Range", "bytes=$offset-")
            conn.setRequestProperty("Accept-Encoding", "identity")
            conn.setRequestProperty("Connection", "close") // pas de connexion réutilisée : disconnect() coupe vraiment la socket
            val code = try { conn.responseCode } catch (_: Exception) { conn.disconnect(); netFail(cancelled) }
            if (code !in REDIRECT_STATUS) return conn
            val location = conn.getHeaderField("Location")
            conn.disconnect()
            if (location.isNullOrBlank() || ++hops > MAX_REDIRECTS) fail(DownloadCode.CONTENT)
            val next = try { URL(url, location) } catch (_: Exception) { fail(DownloadCode.CONTENT) }
            if (!DownloadLogic.isRedirectAllowed(url.protocol, next.protocol, next.host, allowInsecure)) fail(DownloadCode.CONTENT)
            url = next
        }
    }
}
