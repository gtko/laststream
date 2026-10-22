package com.laststream.app.downloads

import java.io.IOException
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class DownloadLogicTest {
    private fun job(title: String, done: Long, total: Long?) = JobSnapshot(title, done, total)

    @Test fun singleJobUsesProvidedTitleAndPercent() {
        val n = DownloadLogic.notification(listOf(job("Dune", 25, 100)))
        assertEquals("Dune", n.title)
        assertEquals(25, n.percent)
        assertEquals("Téléchargement en cours · 25 %", n.text)
    }

    @Test fun severalJobsShowCountAndAggregatedPercent() {
        val n = DownloadLogic.notification(listOf(job("A", 50, 100), job("B", 0, 100), job("C", 100, 200)))
        assertEquals("3 téléchargements", n.title)
        assertEquals(37, n.percent) // 150 / 400
    }

    @Test fun unknownSizeIsIndeterminate() {
        val n = DownloadLogic.notification(listOf(job("X", 500, null)))
        assertEquals(-1, n.percent)
        assertEquals("Téléchargement en cours", n.text)
    }

    @Test fun percentIgnoresUnknownSizesAndClamps() {
        assertEquals(50, DownloadLogic.aggregatePercent(listOf(job("A", 50, 100), job("B", 999, null))))
        assertEquals(100, DownloadLogic.aggregatePercent(listOf(job("A", 500, 100))))
        assertEquals(0, DownloadLogic.aggregatePercent(listOf(job("A", -5, 100))))
        assertEquals(-1, DownloadLogic.aggregatePercent(emptyList()))
        assertEquals(-1, DownloadLogic.aggregatePercent(listOf(job("A", 0, 0))))
    }

    @Test fun titleIsCleanedAndBounded() {
        assertEquals("Téléchargement", DownloadLogic.cleanTitle(null))
        assertEquals("Téléchargement", DownloadLogic.cleanTitle("   "))
        assertEquals("Dune 2", DownloadLogic.cleanTitle("  Dune\n 2\u0000 "))
        val long = DownloadLogic.cleanTitle("x".repeat(300))
        assertTrue(long.length <= 80)
        assertTrue(long.endsWith("…"))
    }

    @Test fun diskErrorsMapToStoreCodes() {
        assertEquals("store_full", DownloadLogic.diskErrorCode(IOException("write failed: ENOSPC (No space left on device)")))
        assertEquals("store_full", DownloadLogic.diskErrorCode(IOException("No space left on device")))
        assertEquals("store_full", DownloadLogic.diskErrorCode(IOException("wrapper", IOException("No space left on device"))))
        assertEquals("store_failed", DownloadLogic.diskErrorCode(IOException("Permission denied")))
        assertEquals("store_failed", DownloadLogic.diskErrorCode(IOException()))
    }

    @Test fun codeOfNeverLeaksMessages() {
        assertEquals("link_expired", DownloadLogic.codeOf(TransferException("link_expired")))
        assertEquals("store_failed", DownloadLogic.codeOf(IllegalStateException("https://x/secret-token")))
        assertEquals("store_failed", DownloadLogic.codeOf(IOException("https://x/secret-token")))
    }

    @Test fun retryableCodes() {
        assertTrue(DownloadCode.retryable("link_expired"))
        assertTrue(DownloadCode.retryable("network"))
        for (c in listOf("content", "range_mismatch", "quota_exceeded", "store_full", "store_failed", "cancelled")) {
            assertFalse(c, DownloadCode.retryable(c))
        }
        assertTrue(TransferException("network").retryable)
        assertFalse(TransferException("content").retryable)
    }

    private fun u(raw: String) = java.net.URL(raw)
    private fun ip(vararg b: Int) = java.net.InetAddress.getByAddress(ByteArray(b.size) { b[it].toByte() })

    @Test fun urlAndRedirectRules() {
        assertTrue(DownloadLogic.isUrlAllowed(u("https://h.example/f"), false))
        assertFalse(DownloadLogic.isUrlAllowed(u("http://h.example/f"), false))
        assertTrue(DownloadLogic.isUrlAllowed(u("http://localhost:8080/f"), true))
        assertFalse(DownloadLogic.isUrlAllowed(u("ftp://h.example/f"), true))
        assertFalse(DownloadLogic.isUrlAllowed("https", "", -1, null, false))
        assertTrue(DownloadLogic.isRedirectAllowed(u("https://a.example/"), u("https://b.example/x"), false))
        // jamais de rétrogradation, même quand http est toléré (tests)
        assertFalse(DownloadLogic.isRedirectAllowed(u("https://a.example/"), u("http://b.example/"), true))
        assertFalse(DownloadLogic.isRedirectAllowed(u("https://a.example/"), u("http://b.example/"), false))
        assertFalse(DownloadLogic.isRedirectAllowed(u("http://a.example/"), u("http://b.example/"), false))
        assertTrue(DownloadLogic.isRedirectAllowed(u("http://a.example/"), u("http://b.example/"), true))
    }

    @Test fun onlyDefaultHttpsPortWithoutCredentialsIsAllowed() {
        assertTrue(DownloadLogic.isUrlAllowed(u("https://cdn.example.com/f"), false))
        assertTrue(DownloadLogic.isUrlAllowed(u("https://cdn.example.com:443/f"), false))
        for (raw in listOf("https://cdn.example.com:8443/f", "https://cdn.example.com:80/f", "https://cdn.example.com:22/f", "https://u:p@cdn.example.com/f", "https://u@cdn.example.com/f")) {
            assertFalse(raw, DownloadLogic.isUrlAllowed(u(raw), false))
        }
    }

    @Test fun localAndLiteralHostsAreRefused() {
        for (raw in listOf(
            "https://127.0.0.1/f", "https://10.0.0.5/f", "https://192.168.1.2/f", "https://172.16.0.1/f", "https://169.254.169.254/latest/meta-data",
            "https://100.64.0.1/f", "https://8.8.8.8/f", "https://[::1]/f", "https://[fe80::1]/f", "https://[fd00::1]/f", "https://[::ffff:127.0.0.1]/f",
            "https://localhost/f", "https://localhost./f", "https://LOCALHOST/f", "https://nas.local/f", "https://svc.internal/f", "https://app.localhost/f", "https://nas/f",
            "https://2130706433/f", "https://0x7f000001/f", "https://0x7f.0.0.1/f", "https://0177.0.0.1/f", "https://127.1/f", "https://127.0.0.1./f",
        )) {
            assertFalse(raw, DownloadLogic.isUrlAllowed(u(raw), false))
        }
        for (host in listOf("a_b.example.com", "-a.example.com", "a..example.com", ".example.com", "exa mple.com", "")) {
            assertFalse(host, DownloadLogic.isPublicHostName(host))
        }
        for (host in listOf("cdn.example.com", "CDN.Example.Test", "a-b.c-d.example.org", "xn--bcher-kva.example", "cdn.example.com.")) {
            assertTrue(host, DownloadLogic.isPublicHostName(host))
        }
    }

    @Test fun nonPublicResolvedAddressesAreRefused() {
        val refused = listOf(
            ip(127, 0, 0, 1), ip(127, 8, 8, 8), ip(0, 0, 0, 0), ip(10, 0, 0, 1), ip(172, 16, 0, 1), ip(172, 31, 255, 255), ip(192, 168, 0, 1),
            ip(169, 254, 169, 254), ip(100, 64, 0, 1), ip(100, 127, 255, 255), ip(224, 0, 0, 1), ip(255, 255, 255, 255), ip(240, 0, 0, 1),
            ip(192, 0, 0, 1), ip(192, 0, 2, 1), ip(198, 18, 0, 1), ip(198, 51, 100, 1), ip(203, 0, 113, 1),
            java.net.InetAddress.getByName("::1"), java.net.InetAddress.getByName("::"), java.net.InetAddress.getByName("fe80::1"),
            java.net.InetAddress.getByName("fd12:3456::1"), java.net.InetAddress.getByName("fc00::1"), java.net.InetAddress.getByName("ff02::1"),
            java.net.InetAddress.getByName("::ffff:10.0.0.1"), java.net.InetAddress.getByName("64:ff9b::7f00:1"), java.net.InetAddress.getByName("2002:c0a8:101::1"),
            java.net.InetAddress.getByName("2001:db8::1"), java.net.InetAddress.getByName("::7f00:1"), java.net.InetAddress.getByName("::a00:5"),
            java.net.InetAddress.getByName("2001:0:4136:e378:8000:63bf:3fff:fdd2"), java.net.InetAddress.getByName("64:ff9b:1::1"),
        )
        for (a in refused) assertFalse(a.toString(), DownloadLogic.isPublicAddress(a))
        val accepted = listOf(
            ip(8, 8, 8, 8), ip(93, 184, 216, 34), ip(172, 15, 255, 255), ip(172, 32, 0, 1), ip(100, 63, 255, 255), ip(100, 128, 0, 1),
            java.net.InetAddress.getByName("2606:4700:4700::1111"), java.net.InetAddress.getByName("2a00:1450:4007::200e"),
        )
        for (a in accepted) assertTrue(a.toString(), DownloadLogic.isPublicAddress(a))
    }

    @Test fun idleNotificationDuringGraceHasNoStalePercent() {
        val n = DownloadLogic.notification(emptyList())
        assertEquals("Téléchargements", n.title)
        assertEquals("En attente du prochain téléchargement", n.text)
        assertEquals(-1, n.percent)
    }
}
