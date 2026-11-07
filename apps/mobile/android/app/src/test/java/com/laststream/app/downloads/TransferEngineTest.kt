package com.laststream.app.downloads

import java.io.File
import java.net.InetAddress
import java.nio.file.Files
import java.util.concurrent.atomic.AtomicInteger
import org.junit.After
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Before
import org.junit.Test

class TransferEngineTest {
    private lateinit var root: File
    private lateinit var files: DownloadFiles
    private lateinit var server: MiniServer
    private val requests = AtomicInteger()
    private val ranges = java.util.Collections.synchronizedList(mutableListOf<String?>())
    private val id = "dl-1"
    private val token = "SECRET-TOKEN-123"
    private val content = ByteArray(1_000_000) { (it * 31 + 7).toByte() }

    @Before fun setUp() {
        root = Files.createTempDirectory("ls-engine").toFile()
        files = DownloadFiles(File(root, "downloads"))
        server = MiniServer()
    }

    @After fun tearDown() {
        server.stop()
        root.deleteRecursively()
    }

    private val base get() = "http://127.0.0.1:${server.port}"
    private fun url(path: String = "/file") = "$base$path?token=$token"
    private fun engine() = TransferEngine(files, allowInsecure = true)
    private fun req(path: String = "/file", total: Long? = null, etag: String? = null, max: Long? = null) =
        TransferRequest(id, url(path), total, etag, max)
    private fun run(r: TransferRequest, e: TransferEngine = engine(), cancelled: () -> Boolean = { false }, progress: (Progress) -> Unit = {}) =
        e.run(r, cancelled, progress)

    private fun on(path: String, handler: (MiniServer.Exchange) -> Unit) {
        server.on(path) { ex ->
            requests.incrementAndGet()
            ranges.add(ex.header("Range"))
            try { handler(ex) } catch (_: Exception) { }
        }
    }

    private fun send(ex: MiniServer.Exchange, status: Int, body: ByteArray, headers: Map<String, String> = emptyMap()) {
        headers.forEach { (k, v) -> ex.responseHeaders[k] = v }
        ex.send(status, body)
    }

    /** Serveur de fichier avec plages. `honorRange` faux = serveur qui ignore Range et répond 200. */
    private fun serveFile(path: String = "/file", etag: String? = "\"v1\"", honorRange: Boolean = true, type: String = "video/mp4") {
        on(path) { ex ->
            val h = LinkedHashMap<String, String>()
            h["Content-Type"] = type
            if (etag != null) h["ETag"] = etag
            val range = ex.header("Range")
            val m = range?.let { Regex("^bytes=(\\d+)-$").matchEntire(it) }
            if (!honorRange || m == null) {
                send(ex, 200, content, h)
            } else {
                val start = m.groupValues[1].toInt()
                if (start >= content.size) {
                    h["Content-Range"] = "bytes */${content.size}"
                    send(ex, 416, ByteArray(0), h)
                } else {
                    h["Content-Range"] = "bytes $start-${content.size - 1}/${content.size}"
                    send(ex, 206, content.copyOfRange(start, content.size), h)
                }
            }
        }
    }

    private fun expectCode(code: String, block: () -> Unit) {
        try { block(); fail("attendu $code") } catch (e: TransferException) {
            assertEquals(code, e.code)
            assertEquals(code, e.message)
            assertFalse(e.toString().contains(token))
            assertFalse(e.toString().contains("127.0.0.1"))
            assertNull(e.cause)
        }
    }

    private fun partBytes(): ByteArray = File(root, "downloads/${DownloadFiles.hash(id)}.part").readBytes()

    @Test fun fullDownloadWith206() {
        serveFile()
        val seen = mutableListOf<Progress>()
        val r = run(req(), progress = { seen += it })
        assertEquals(content.size.toLong(), r.bytesDone)
        assertEquals(content.size.toLong(), r.bytesTotal)
        assertEquals("\"v1\"", r.etag)
        assertArrayEquals(content, partBytes())
        assertEquals("bytes=0-", ranges.first())
        // au moins le dernier évènement, avec la taille finale
        assertEquals(content.size.toLong(), seen.last().bytesDone)
    }

    @Test fun resumesFromExistingPart() {
        serveFile()
        files.write(id, 0, content.copyOfRange(0, 400_000))
        val r = run(req(total = content.size.toLong(), etag = "\"v1\""))
        assertEquals(content.size.toLong(), r.bytesDone)
        assertEquals("bytes=400000-", ranges.last())
        assertEquals(1, requests.get())
        assertArrayEquals(content, partBytes())
    }

    @Test fun serverIgnoringRangeInTheMiddleRestartsOnceFromZero() {
        serveFile(honorRange = false)
        files.write(id, 0, content.copyOfRange(0, 300_000))
        val r = run(req())
        assertEquals(content.size.toLong(), r.bytesDone)
        assertArrayEquals(content, partBytes())
        assertEquals(listOf<String?>("bytes=300000-", "bytes=0-"), ranges.toList())
    }

    @Test fun serverIgnoringRangeFromZeroIsAFullFile() {
        serveFile(honorRange = false)
        val r = run(req())
        assertEquals(content.size.toLong(), r.bytesDone)
        assertArrayEquals(content, partBytes())
        assertEquals(1, requests.get())
    }

    @Test fun rangeMismatchWhenRestartKeepsHappening() {
        // 206 qui répond toujours une mauvaise plage
        on("/file") { ex ->
            ex.responseHeaders.put("Content-Type", "video/mp4")
            ex.responseHeaders.put("Content-Range", "bytes 5-9/100")
            send(ex, 206, ByteArray(5))
        }
        files.write(id, 0, ByteArray(50))
        expectCode("range_mismatch") { run(req()) }
        assertEquals(0L, files.size(id)) // le seul redémarrage a vidé le fichier
        assertEquals(2, requests.get())
    }

    @Test fun rangeNotSatisfiableAtEndOfFileMeansDone() {
        serveFile()
        files.write(id, 0, content)
        // taille inconnue : le serveur dit 416 */total avec total == offset
        val r = run(req())
        assertEquals(content.size.toLong(), r.bytesDone)
        assertEquals(content.size.toLong(), r.bytesTotal)
        assertEquals(1, requests.get())
    }

    @Test fun knownSizeAlreadyReachedMakesNoRequest() {
        serveFile()
        files.write(id, 0, content)
        val r = run(req(total = content.size.toLong()))
        assertEquals(content.size.toLong(), r.bytesDone)
        assertEquals(0, requests.get())
    }

    @Test fun rangeNotSatisfiableWithAnotherTotalRestartsThenMismatch() {
        on("/file") { ex ->
            ex.responseHeaders.put("Content-Range", "bytes */999")
            send(ex, 416, ByteArray(0))
        }
        files.write(id, 0, ByteArray(10))
        expectCode("range_mismatch") { run(req()) }
        assertEquals(2, requests.get())
    }

    @Test fun forbiddenMeansLinkExpired() {
        on("/file") { ex -> send(ex, 403, ByteArray(0)) }
        expectCode("link_expired") { run(req()) }
    }

    @Test fun otherExpiredStatuses() {
        for (s in listOf(401, 404, 410)) {
            val p = "/s$s"
            on(p) { ex -> send(ex, s, ByteArray(0)) }
            expectCode("link_expired") { run(req(p)) }
        }
    }

    @Test fun htmlPageMeansLinkExpired() {
        on("/file") { ex -> send(ex, 200, "<html>expired</html>".toByteArray(), mapOf("Content-Type" to "text/html; charset=utf-8")) }
        expectCode("link_expired") { run(req()) }
        assertEquals(0L, files.size(id)) // jamais écrite comme fichier
    }

    @Test fun serviceUnavailableAndTooManyRequestsAreNetwork() {
        on("/s503") { ex -> send(ex, 503, ByteArray(0)) }
        on("/s429") { ex -> send(ex, 429, ByteArray(0)) }
        on("/s500") { ex -> send(ex, 500, ByteArray(0)) }
        for (p in listOf("/s503", "/s429", "/s500")) expectCode("network") { run(req(p)) }
        assertTrue(TransferException("network").retryable)
    }

    @Test fun otherStatusesAreContent() {
        on("/s400") { ex -> send(ex, 400, ByteArray(0)) }
        on("/s204") { ex -> send(ex, 204, ByteArray(0)) }
        expectCode("content") { run(req("/s400")) }
        expectCode("content") { run(req("/s204")) }
    }

    @Test fun connectionRefusedIsNetwork() {
        val port = server.port
        server.stop()
        expectCode("network") { run(TransferRequest(id, "http://127.0.0.1:$port/file?token=$token")) }
    }

    @Test fun nonHttpsUrlIsRefusedBeforeAnyConnection() {
        serveFile()
        val strict = TransferEngine(files, allowInsecure = false)
        expectCode("content") { run(req(), strict) }
        assertEquals(0, requests.get())
        expectCode("content") { run(TransferRequest(id, "ftp://example.com/x?token=$token"), strict) }
        expectCode("content") { run(TransferRequest(id, "pas une url $token"), strict) }
    }

    @Test fun redirectsAreFollowedByHandUpToFive() {
        serveFile("/final")
        for (i in 1..5) {
            val next = if (i == 5) "/final" else "/hop${i + 1}"
            on("/hop$i") { ex -> ex.responseHeaders.put("Location", next + "?token=$token"); send(ex, 302, ByteArray(0)) }
        }
        val r = run(req("/hop1"))
        assertEquals(content.size.toLong(), r.bytesDone)
    }

    @Test fun moreThanFiveRedirectsIsContent() {
        for (i in 1..7) {
            on("/hop$i") { ex -> ex.responseHeaders.put("Location", "/hop${i + 1}"); send(ex, 302, ByteArray(0)) }
        }
        expectCode("content") { run(req("/hop1")) }
    }

    @Test fun redirectWithoutLocationIsContent() {
        on("/file") { ex -> send(ex, 302, ByteArray(0)) }
        expectCode("content") { run(req()) }
    }

    @Test fun redirectToAnotherSchemeIsRefused() {
        on("/file") { ex -> ex.responseHeaders.put("Location", "ftp://example.com/x?token=$token"); send(ex, 302, ByteArray(0)) }
        expectCode("content") { run(req()) }
    }

    @Test fun redirectToHttpIsRefusedWhenInsecureIsNotAllowed() {
        // Le départ est en http (refusé tout de suite) : la règle de rétrogradation https vers http est testée dans DownloadLogicTest.
        on("/file") { ex -> ex.responseHeaders.put("Location", "http://127.0.0.1:1/x"); send(ex, 302, ByteArray(0)) }
        expectCode("content") { run(req(), TransferEngine(files, allowInsecure = false)) }
        assertEquals(0, requests.get())
    }

    // --- Cibles autorisées (ODY-232) : jamais le réseau local, ni par le lien de départ ni par une redirection ---

    private fun ipv4(vararg b: Int): InetAddress = InetAddress.getByAddress(ByteArray(4) { b[it].toByte() })
    private val publicIp = ipv4(93, 184, 216, 34)

    /** Moteur strict (https public seulement), résolveur injecté qui compte ses appels : aucune connexion réelle n'est possible. */
    private fun strictEngine(calls: AtomicInteger, answer: (String) -> List<InetAddress>) =
        TransferEngine(files, allowInsecure = false, resolver = { host -> calls.incrementAndGet(); answer(host) })

    @Test fun strictEngineRefusesLocalLiteralAndUnexpectedTargetsBeforeResolvingOrConnecting() {
        val calls = AtomicInteger()
        val strict = strictEngine(calls) { listOf(publicIp) }
        for (raw in listOf(
            "http://cdn.example.com/f", "https://127.0.0.1/f", "https://192.168.1.2/f", "https://169.254.169.254/f", "https://[::1]/f", "https://localhost/f",
            "https://nas.local/f", "https://nas/f", "https://2130706433/f", "https://cdn.example.com:8443/f", "https://u:p@cdn.example.com/f",
        )) {
            expectCode("content") { run(TransferRequest(id, "$raw?token=$token"), strict) }
        }
        assertEquals(0, calls.get())
        assertEquals(0L, files.size(id))
    }

    @Test fun publicNameResolvingToPrivateAddressIsContentWithoutAnyConnection() {
        for (bad in listOf(ipv4(127, 0, 0, 1), ipv4(10, 1, 2, 3), ipv4(192, 168, 1, 20), ipv4(169, 254, 169, 254), InetAddress.getByName("::1"), InetAddress.getByName("fd00::1"))) {
            val calls = AtomicInteger()
            val strict = strictEngine(calls) { listOf(publicIp, bad) } // une seule adresse privée parmi les réponses suffit à refuser
            expectCode("content") { run(TransferRequest(id, "https://cdn.example.com/f?token=$token"), strict) }
            assertEquals(1, calls.get())
        }
    }

    @Test fun unresolvableNameIsNetwork() {
        val strict = strictEngine(AtomicInteger()) { throw java.net.UnknownHostException("cdn.example.com") }
        expectCode("network") { run(TransferRequest(id, "https://cdn.example.com/f?token=$token"), strict) }
        val empty = strictEngine(AtomicInteger()) { emptyList() }
        expectCode("network") { run(TransferRequest(id, "https://cdn.example.com/f?token=$token"), empty) }
    }

    @Test fun redirectToLocalNetworkIsRefusedAndNeverRequested() {
        val hits = AtomicInteger()
        on("/start") { ex -> ex.responseHeaders.put("Location", "http://localhost:${server.port}/internal?token=$token"); send(ex, 302, ByteArray(0)) }
        on("/internal") { ex -> hits.incrementAndGet(); send(ex, 200, content) }
        // Le départ (127.0.0.1) est présenté comme public ; la redirection vers « localhost » se résout vers le loopback.
        val e = TransferEngine(files, allowInsecure = true, checkAddresses = true, resolver = { host ->
            if (host == "127.0.0.1") listOf(publicIp) else listOf(InetAddress.getByName("127.0.0.1"))
        })
        expectCode("content") { run(req("/start"), e) }
        assertEquals(1, requests.get())
        assertEquals(0, hits.get())
        assertEquals(0L, files.size(id))
    }

    @Test fun redirectToLiteralPrivateAddressIsRefused() {
        for (target in listOf("http://10.0.0.5/x", "http://192.168.1.2:8080/x", "http://169.254.169.254/latest", "http://[::1]/x")) {
            requests.set(0)
            on("/start") { ex -> ex.responseHeaders.put("Location", target); send(ex, 302, ByteArray(0)) }
            val e = TransferEngine(files, allowInsecure = true, checkAddresses = true, resolver = { host ->
                if (host == "127.0.0.1") listOf(publicIp) else listOf(InetAddress.getByName(host.removePrefix("[").removeSuffix("]")))
            })
            expectCode("content") { run(req("/start"), e) }
            assertEquals(target, 1, requests.get())
        }
    }

    @Test fun redirectBetweenPublicHostsIsStillFollowed() {
        serveFile("/final")
        on("/start") { ex -> ex.responseHeaders.put("Location", "http://localhost:${server.port}/final?token=$token"); send(ex, 302, ByteArray(0)) }
        val e = TransferEngine(files, allowInsecure = true, checkAddresses = true, resolver = { listOf(publicIp) })
        assertEquals(content.size.toLong(), run(req("/start"), e).bytesDone)
    }

    @Test fun maxBytesDeclaredTotalIsQuotaExceededWithoutWriting() {
        serveFile()
        expectCode("quota_exceeded") { run(req(max = 500_000)) }
        assertEquals(0L, files.size(id))
    }

    @Test fun maxBytesDuringStreamKeepsPart() {
        // Corps sans taille annoncée (chunked) : le plafond est vérifié sur la progression.
        on("/file") { ex ->
            ex.responseHeaders.put("Content-Type", "video/mp4")
            ex.sendChunked(200, content)
        }
        expectCode("quota_exceeded") { run(req(max = 300_000)) }
        assertTrue(files.size(id) > 0)
        assertTrue(files.size(id) <= content.size)
    }

    @Test fun cancelledMidStreamKeepsPart() {
        serveFile()
        var calls = 0
        expectCode("cancelled") { run(req(), cancelled = { ++calls > 3 }) }
        val size = files.size(id)
        assertTrue("part partiel conservé", size > 0 && size < content.size)
        assertArrayEquals(content.copyOfRange(0, size.toInt()), partBytes())
    }

    @Test fun cancelledBeforeStartMakesNoRequest() {
        serveFile()
        expectCode("cancelled") { run(req(), cancelled = { true }) }
        assertEquals(0, requests.get())
    }

    @Test fun differentEtagRestartsOnceFromZero() {
        // ETag courant « v2 » ; l'ancien .part (dernier lien) venait de « v1 ».
        serveFile(etag = "\"v2\"")
        files.write(id, 0, content.copyOfRange(0, 200_000))
        val r = run(req(total = content.size.toLong(), etag = "\"v1\""))
        assertEquals(content.size.toLong(), r.bytesDone)
        assertEquals("\"v2\"", r.etag)
        assertArrayEquals(content, partBytes())
        assertEquals(listOf<String?>("bytes=200000-", "bytes=0-"), ranges.toList())
    }

    @Test fun sameEtagResumesWithoutRestart() {
        serveFile(etag = "\"v1\"")
        files.write(id, 0, content.copyOfRange(0, 200_000))
        run(req(total = content.size.toLong(), etag = "\"v1\""))
        assertEquals(1, requests.get())
    }

    @Test fun contentDispositionIsIgnored() {
        on("/file") { ex ->
            send(ex, 200, content, mapOf("Content-Type" to "video/mp4", "Content-Disposition" to "attachment; filename=\"../../evil.sh\""))
        }
        run(req())
        assertEquals(listOf(DownloadFiles.hash(id) + ".part"), File(root, "downloads").list()!!.toList())
    }

    @Test fun progressIsThrottledToAboutOnePerSecondPlusFinalCall() {
        serveFile()
        var now = 0L
        val e = TransferEngine(files, allowInsecure = true, clock = { now })
        val seen = mutableListOf<Progress>()
        run(req(), e) { seen += it } // l'horloge est figée : premier évènement + final
        assertEquals(2, seen.size)
        assertEquals(content.size.toLong(), seen.last().bytesDone)
        // avec une horloge qui avance de 2 s à chaque lecture : un évènement par tampon
        files.remove(id)
        val e2 = TransferEngine(files, allowInsecure = true, clock = { now += 2_000; now })
        val seen2 = mutableListOf<Progress>()
        run(req(), e2) { seen2 += it }
        assertTrue(seen2.size > seen.size || content.size <= TransferEngine.BUFFER_SIZE)
    }

    @Test fun messagesNeverContainTheLinkOrToken() {
        on("/file") { ex -> send(ex, 403, ByteArray(0)) }
        try { run(req()); fail() } catch (e: TransferException) {
            assertFalse(e.message!!.contains(token))
            assertFalse(e.stackTraceToString().contains(token))
        }
        assertFalse(req().toString().contains(token))
        assertNotNull(req().toString())
    }

    @Test fun diskFullAndDiskFailureCodesComeFromTheException() {
        // Le mapping disque est testé sur la fonction pure ; ici on vérifie qu'un dossier devenu fichier donne store_failed.
        serveFile()
        val dir = File(root, "downloads")
        dir.deleteRecursively()
        dir.writeText("je ne suis pas un dossier")
        expectCode("store_failed") { run(req()) }
    }

    @Test fun cancelAfterABlockedReadIsCancelledNotNetworkAndCallsTheAbortHook() {
        on("/file") { ex ->
            ex.responseHeaders["Content-Type"] = "video/mp4"
            ex.sendPartialThenHold(200, content.size.toLong(), content.copyOfRange(0, 2_000), 1_500)
        }
        val stop = java.util.concurrent.atomic.AtomicBoolean(false)
        val registeredOnce = java.util.concurrent.atomic.AtomicBoolean(false)
        val abortRef = java.util.concurrent.atomic.AtomicReference<(() -> Unit)?>(null)
        val outcome = java.util.concurrent.atomic.AtomicReference<String>()
        val t = Thread {
            try {
                engine().run(req(), { stop.get() }, { }, { if (it != null) registeredOnce.set(true); abortRef.set(it) })
                outcome.set("done")
            } catch (e: TransferException) { outcome.set(e.code) }
        }
        t.start()
        val waitEnd = System.currentTimeMillis() + 5_000
        while (files.size(id) == 0L && System.currentTimeMillis() < waitEnd) Thread.sleep(10) // le client est bloqué en lecture
        assertTrue(files.size(id) > 0)
        stop.set(true)
        abortRef.get()?.invoke()
        t.join(5_000)
        assertFalse("le transfert doit finir", t.isAlive)
        assertEquals("cancelled", outcome.get())
        assertTrue("action de coupure enregistrée", registeredOnce.get())
        assertTrue(files.size(id) > 0) // .part conservé
    }
}
