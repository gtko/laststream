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

    @Test fun urlAndRedirectRules() {
        assertTrue(DownloadLogic.isUrlAllowed("https", "h.example", false))
        assertFalse(DownloadLogic.isUrlAllowed("http", "h.example", false))
        assertTrue(DownloadLogic.isUrlAllowed("http", "localhost", true))
        assertFalse(DownloadLogic.isUrlAllowed("ftp", "h.example", true))
        assertFalse(DownloadLogic.isUrlAllowed("https", "", false))
        assertTrue(DownloadLogic.isRedirectAllowed("https", "https", "b.example", false))
        // jamais de rétrogradation, même quand http est toléré (tests)
        assertFalse(DownloadLogic.isRedirectAllowed("https", "http", "b.example", true))
        assertFalse(DownloadLogic.isRedirectAllowed("https", "http", "b.example", false))
        assertFalse(DownloadLogic.isRedirectAllowed("http", "http", "b.example", false))
        assertTrue(DownloadLogic.isRedirectAllowed("http", "http", "b.example", true))
    }

    @Test fun idleNotificationDuringGraceHasNoStalePercent() {
        val n = DownloadLogic.notification(emptyList())
        assertEquals("Téléchargements", n.title)
        assertEquals("En attente du prochain téléchargement", n.text)
        assertEquals(-1, n.percent)
    }
}
