package com.laststream.app.downloads

import java.io.File
import java.io.IOException
import java.nio.file.Files
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

class DownloadFilesTest {
    private lateinit var root: File
    private lateinit var files: DownloadFiles
    private val id = "movie:tt1234567/S01E02"

    @Before fun setUp() {
        root = Files.createTempDirectory("ls-dl").toFile()
        files = DownloadFiles(File(root, "downloads"))
    }

    @After fun tearDown() { root.deleteRecursively() }

    private fun names() = File(root, "downloads").list()!!.sorted()

    @Test fun hashIsStableSha256Hex() {
        // SHA-256("abc")
        assertEquals("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad", DownloadFiles.hash("abc"))
        assertEquals(DownloadFiles.hash(id), DownloadFiles.hash(id))
        assertEquals(64, DownloadFiles.hash(id).length)
    }

    @Test fun idIsNeverInThePath() {
        files.write(id, 0, byteArrayOf(1, 2, 3))
        files.finalize(id)
        val p = files.finalPath(id)!!.path
        assertFalse(p.contains("tt1234567"))
        assertFalse(p.contains("S01E02"))
        assertTrue(p.endsWith(DownloadFiles.hash(id) + ".bin"))
    }

    @Test fun writeAppendsAndOverwritesButNeverLeavesAHole() {
        files.write(id, 0, byteArrayOf(1, 2, 3))
        files.write(id, 3, byteArrayOf(4, 5))
        assertEquals(5L, files.size(id))
        files.write(id, 1, byteArrayOf(9)) // réécriture au milieu : taille inchangée
        assertEquals(5L, files.size(id))
        try { files.write(id, 7, byteArrayOf(1)); fail("trou") } catch (_: IOException) { }
        try { files.write(id, -1, byteArrayOf(1)); fail("négatif") } catch (_: IOException) { }
        assertEquals(5L, files.size(id))
    }

    @Test fun writeOnAbsentFileOnlyAtZero() {
        try { files.write(id, 1, byteArrayOf(1)); fail("trou") } catch (_: IOException) { }
        assertEquals(0L, files.size(id))
        assertEquals(emptyList<String>(), names())
    }

    @Test fun writeAtZeroAndTruncateZeroWorkOnAnAbsentId() {
        files.truncate("nouveau", 0)
        assertEquals(0L, files.size("nouveau"))
        files.write("nouveau", 0, byteArrayOf(1, 2))
        assertEquals(2L, files.size("nouveau"))
        files.remove("absent")
    }

    @Test fun sizeIsZeroWhenAbsent() { assertEquals(0L, files.size(id)) }

    @Test fun truncateShrinksAndRefusesToGrow() {
        files.write(id, 0, ByteArray(10) { it.toByte() })
        files.truncate(id, 4)
        assertEquals(4L, files.size(id))
        try { files.truncate(id, 5); fail("agrandir") } catch (_: IOException) { }
        files.truncate(id, 0)
        assertEquals(0L, files.size(id))
    }

    @Test fun truncateOnAbsentIsANoop() {
        files.truncate(id, 0)
        assertEquals(emptyList<String>(), names())
    }

    @Test fun finalizeRenamesPartToBinAndIsIdempotent() {
        files.write(id, 0, byteArrayOf(1, 2, 3))
        assertNull(files.finalPath(id))
        assertEquals(listOf(DownloadFiles.hash(id) + ".part"), names())
        files.finalize(id)
        assertEquals(listOf(DownloadFiles.hash(id) + ".bin"), names())
        files.finalize(id) // deuxième appel : rien à faire
        assertEquals(3L, files.size(id))
        assertArrayEquals(byteArrayOf(1, 2, 3), files.finalPath(id)!!.readBytes())
    }

    @Test fun finalizeWithoutAnyFileFails() {
        try { files.finalize(id); fail("absent") } catch (_: IOException) { }
    }

    @Test fun localPathRefusedUntilFinalized() {
        assertNull(files.finalPath(id))
        files.write(id, 0, byteArrayOf(1))
        assertNull(files.finalPath(id))
        files.finalize(id)
        assertNotNull(files.finalPath(id))
    }

    @Test fun removeDeletesBothFilesAndFreesSpace() {
        files.write(id, 0, ByteArray(100))
        files.finalize(id)
        files.write(id, 0, ByteArray(40)) // un nouveau .part à côté du .bin
        assertEquals(140L, files.usage().used)
        files.remove(id)
        assertEquals(emptyList<String>(), names())
        assertEquals(0L, files.usage().used)
        assertNull(files.finalPath(id))
        files.remove(id) // idempotent
    }

    @Test fun usageSumsAllFilesAndReportsFreeSpace() {
        files.write("a", 0, ByteArray(10))
        files.write("b", 0, ByteArray(20))
        files.finalize("b")
        val u = files.usage()
        assertEquals(30L, u.used)
        assertTrue(u.available > 0)
    }

    @Test fun finalizedFileIsResumableAsPartAfterTruncate() {
        files.write(id, 0, ByteArray(10))
        files.finalize(id)
        files.truncate(id, 6)
        assertNull(files.finalPath(id))
        assertEquals(6L, files.size(id))
    }

    @Test fun openAppendOnFinalizedFileResumesIntoItInsteadOfAnEmptyPart() {
        files.write(id, 0, byteArrayOf(1, 2, 3, 4))
        files.finalize(id)
        files.openAppend(id).use { it.write(byteArrayOf(5, 6)) }
        assertNull(files.finalPath(id))
        assertEquals(listOf(DownloadFiles.hash(id) + ".part"), names())
        assertEquals(6L, files.size(id))
        files.finalize(id)
        assertArrayEquals(byteArrayOf(1, 2, 3, 4, 5, 6), files.finalPath(id)!!.readBytes())
    }
}
