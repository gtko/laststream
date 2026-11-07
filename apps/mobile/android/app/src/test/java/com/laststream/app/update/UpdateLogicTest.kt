package com.laststream.app.update

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.ByteArrayInputStream

class UpdateLogicTest {
    @Test fun sha256OfKnownInputs() {
        assertEquals("e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855", UpdateLogic.sha256Hex(ByteArrayInputStream(ByteArray(0))))
        assertEquals("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad", UpdateLogic.sha256Hex(ByteArrayInputStream("abc".toByteArray())))
    }

    @Test fun sha256ReadsLargeStreamsInBlocks() {
        val big = ByteArray(300_000) { (it % 251).toByte() }
        assertEquals(64, UpdateLogic.sha256Hex(ByteArrayInputStream(big)).length)
    }

    @Test fun hashValidation() {
        assertTrue(UpdateLogic.isSha256("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"))
        assertTrue(UpdateLogic.isSha256("BA7816BF8F01CFEA414140DE5DAE2223B00361A396177A9CB410FF61F20015AD"))
        assertFalse(UpdateLogic.isSha256("abc"))
        assertFalse(UpdateLogic.isSha256(null))
        assertFalse(UpdateLogic.isSha256("zz7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"))
    }

    @Test fun sameHashIgnoresCase() {
        assertTrue(UpdateLogic.sameHash("ABC123", "abc123"))
        assertFalse(UpdateLogic.sameHash("abc123", "abc124"))
    }

    @Test fun onlyHttpsDownloads() {
        assertTrue(UpdateLogic.isDownloadUrl("https://app.laststream.app/app/android/laststream-2026101801.apk"))
        assertFalse(UpdateLogic.isDownloadUrl("http://app.laststream.app/a.apk"))
        assertFalse(UpdateLogic.isDownloadUrl("file:///sdcard/a.apk"))
        assertFalse(UpdateLogic.isDownloadUrl(null))
    }

    @Test fun percent() {
        assertEquals(50, UpdateLogic.percent(50, 100))
        assertEquals(100, UpdateLogic.percent(120, 100))
        assertEquals(-1, UpdateLogic.percent(10, -1))
        assertEquals(0, UpdateLogic.percent(0, 1000))
    }

    @Test fun fileName() {
        assertEquals("laststream-2026101801.apk", UpdateLogic.fileName(2026101801L))
    }
}
