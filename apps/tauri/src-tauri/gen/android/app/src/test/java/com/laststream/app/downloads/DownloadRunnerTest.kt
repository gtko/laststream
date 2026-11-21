package com.laststream.app.downloads

import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicInteger
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class DownloadRunnerTest {
    private class Recorder : JobCallbacks {
        val done = CountDownLatch(1)
        @Volatile var result: TransferResult? = null
        @Volatile var error: String? = null
        val progress = AtomicInteger()
        override fun onProgress(p: Progress) { progress.incrementAndGet() }
        override fun onDone(r: TransferResult) { result = r; done.countDown() }
        override fun onError(code: String) { error = code; done.countDown() }
        fun await() = assertTrue("fin du job", done.await(5, TimeUnit.SECONDS))
    }

    private fun req(id: String) = TransferRequest(id, "https://example.test/$id?token=SECRET", bytesTotal = 100)
    private val ok: TransferRun = { r, _, onProgress, _ ->
        onProgress(Progress(50, 100))
        TransferResult(100, 100, "e", null)
    }
    /** Un faux transfert qui tourne jusqu'à l'annulation. */
    private fun blocking(started: CountDownLatch): TransferRun = { _, cancelled, _, _ ->
        started.countDown()
        while (!cancelled()) Thread.sleep(5)
        throw TransferException(DownloadCode.CANCELLED)
    }

    @Test fun successResolvesAndLeavesTheTable() {
        val runner = DownloadRunner()
        val states = java.util.Collections.synchronizedList(mutableListOf<Int>())
        runner.setListener { states += it.size }
        val rec = Recorder()
        runner.start(req("a"), "A", rec, { true }, ok)
        rec.await()
        assertEquals(100L, rec.result?.bytesDone)
        assertTrue(rec.progress.get() >= 1)
        waitIdle(runner)
        assertEquals(0, states.last()) // l'écouteur apprend que plus rien ne tourne
        assertTrue(states.contains(1))
    }

    @Test fun failedGateIsATransientNetworkError() {
        val runner = DownloadRunner()
        val rec = Recorder()
        val ran = AtomicInteger()
        runner.start(req("a"), "A", rec, { false }, { _, _, _, _ -> ran.incrementAndGet(); TransferResult(1) })
        rec.await()
        assertEquals("network", rec.error)
        assertEquals(0, ran.get())
        assertTrue(DownloadCode.retryable(rec.error!!))
    }

    @Test fun throwingGateIsNetworkToo() {
        val runner = DownloadRunner()
        val rec = Recorder()
        runner.start(req("a"), "A", rec, { throw IllegalStateException("https://example.test/secret") }, ok)
        rec.await()
        assertEquals("network", rec.error)
    }

    @Test fun unexpectedExceptionNeverLeaksItsMessage() {
        val runner = DownloadRunner()
        val rec = Recorder()
        runner.start(req("a"), "A", rec, { true }, { _, _, _, _ -> throw IllegalStateException("https://example.test/secret-token") })
        rec.await()
        assertEquals("store_failed", rec.error)
    }

    @Test fun cancelReportsCancelled() {
        val runner = DownloadRunner()
        val started = CountDownLatch(1)
        val rec = Recorder()
        runner.start(req("a"), "A", rec, { true }, blocking(started))
        assertTrue(started.await(5, TimeUnit.SECONDS))
        assertTrue(runner.cancelAndAwait("a", 5_000))
        rec.await()
        assertEquals("cancelled", rec.error)
        waitIdle(runner)
    }

    @Test fun newStartForActiveIdCancelsOldAndWaitsForItsEnd() {
        val runner = DownloadRunner()
        val started = CountDownLatch(1)
        val oldRec = Recorder()
        val oldEnded = java.util.concurrent.atomic.AtomicBoolean(false)
        runner.start(req("a"), "old", oldRec, { true }, { r, c, p, _ ->
            started.countDown()
            while (!c()) Thread.sleep(5)
            Thread.sleep(50) // fin lente : le nouveau job ne doit pas démarrer avant
            oldEnded.set(true)
            throw TransferException(DownloadCode.CANCELLED)
        })
        assertTrue(started.await(5, TimeUnit.SECONDS))
        val newRec = Recorder()
        var oldEndedWhenNewStarted = false
        runner.start(req("a"), "new", newRec, { true }, { _, _, _, _ -> oldEndedWhenNewStarted = oldEnded.get(); TransferResult(100, 100) })
        newRec.await()
        oldRec.await()
        assertEquals("cancelled", oldRec.error)
        assertTrue("l'ancien job a fini avant le nouveau", oldEndedWhenNewStarted)
        assertEquals(100L, newRec.result?.bytesDone)
        waitIdle(runner)
    }

    @Test fun cancelAllCancelsEveryJobAndCanForceACode() {
        val runner = DownloadRunner()
        val started = CountDownLatch(2)
        val a = Recorder()
        val b = Recorder()
        runner.start(req("a"), "A", a, { true }, blocking(started))
        runner.start(req("b"), "B", b, { true }, blocking(started))
        assertTrue(started.await(5, TimeUnit.SECONDS))
        assertEquals(2, runner.activeCount())
        runner.cancelAll("network")
        a.await(); b.await()
        assertEquals("network", a.error)
        assertEquals("network", b.error)
        waitIdle(runner)
        assertFalse(runner.isActive())
    }

    @Test fun atMostFourJobsRunAtOnce() {
        val runner = DownloadRunner()
        val running = AtomicInteger()
        val peak = AtomicInteger()
        val release = CountDownLatch(1)
        val recs = (1..6).map { Recorder() }
        recs.forEachIndexed { i, rec ->
            runner.start(req("j$i"), "J$i", rec, { true }, { _, _, _, _ ->
                val n = running.incrementAndGet()
                peak.accumulateAndGet(n) { x, y -> maxOf(x, y) }
                release.await(5, TimeUnit.SECONDS)
                running.decrementAndGet()
                TransferResult(1)
            })
        }
        Thread.sleep(200)
        assertEquals(6, runner.activeCount()) // 4 actifs et 2 en attente, tous dans la table
        release.countDown()
        recs.forEach { it.await() }
        assertEquals(4, peak.get())
    }

    @Test fun snapshotCarriesTitleAndProgress() {
        val runner = DownloadRunner()
        val inProgress = CountDownLatch(1)
        val release = CountDownLatch(1)
        val rec = Recorder()
        runner.start(req("a"), "Dune", rec, { true }, { _, _, onProgress, _ ->
            onProgress(Progress(40, 100))
            inProgress.countDown()
            release.await(5, TimeUnit.SECONDS)
            TransferResult(100, 100)
        })
        assertTrue(inProgress.await(5, TimeUnit.SECONDS))
        val s = runner.snapshot().single()
        assertEquals("Dune", s.title)
        assertEquals(40L, s.bytesDone)
        assertEquals(100L, s.bytesTotal)
        release.countDown()
        rec.await()
    }

    private fun waitIdle(runner: DownloadRunner) {
        val end = System.currentTimeMillis() + 5_000
        while (runner.isActive() && System.currentTimeMillis() < end) Thread.sleep(5)
        assertFalse(runner.isActive())
        // l'écouteur est appelé après le retrait : laisse le temps au dernier évènement
        Thread.sleep(50)
    }

    @Test fun replacedJobThatDoesNotEndInTimeBlocksTheNewOneWithNetwork() {
        val runner = DownloadRunner(replaceWaitMs = 200)
        val started = CountDownLatch(1)
        val release = CountDownLatch(1)
        val oldRec = Recorder()
        runner.start(req("a"), "old", oldRec, { true }, { _, _, _, _ ->
            started.countDown()
            release.await(5, TimeUnit.SECONDS) // ignore l'annulation
            throw TransferException(DownloadCode.CANCELLED)
        })
        assertTrue(started.await(5, TimeUnit.SECONDS))
        val newRec = Recorder()
        val ran = AtomicInteger()
        runner.start(req("a"), "new", newRec, { true }, { _, _, _, _ -> ran.incrementAndGet(); TransferResult(1) })
        newRec.await()
        assertEquals("network", newRec.error)
        assertEquals(0, ran.get())
        release.countDown()
        oldRec.await()
        assertEquals("cancelled", oldRec.error)
    }

    @Test fun cancelCutsTheCurrentConnectionThroughTheAbortHook() {
        val runner = DownloadRunner()
        val registered = CountDownLatch(1)
        val aborted = java.util.concurrent.atomic.AtomicBoolean(false)
        val rec = Recorder()
        runner.start(req("a"), "A", rec, { true }, { _, cancelled, _, register ->
            register { aborted.set(true) }
            registered.countDown()
            // lecture bloquée : seule la coupure de la connexion la réveille
            val end = System.currentTimeMillis() + 5_000
            while (!aborted.get() && System.currentTimeMillis() < end) Thread.sleep(5)
            if (cancelled()) throw TransferException(DownloadCode.CANCELLED) else throw TransferException(DownloadCode.NETWORK)
        })
        assertTrue(registered.await(5, TimeUnit.SECONDS))
        runner.cancel("a")
        rec.await()
        assertTrue(aborted.get())
        assertEquals("cancelled", rec.error)
    }

    @Test fun abortRegisteredAfterCancelFiresImmediately() {
        val runner = DownloadRunner()
        val gateEntered = CountDownLatch(1)
        val proceed = CountDownLatch(1)
        val aborted = java.util.concurrent.atomic.AtomicBoolean(false)
        val rec = Recorder()
        runner.start(req("a"), "A", rec, { gateEntered.countDown(); proceed.await(5, TimeUnit.SECONDS); true }, { _, _, _, register ->
            register { aborted.set(true) }
            TransferResult(1)
        })
        assertTrue(gateEntered.await(5, TimeUnit.SECONDS))
        runner.cancel("a")
        proceed.countDown()
        rec.await()
        // annulé avant le transfert : soit le transfert n'a pas démarré, soit la coupure a été déclenchée à l'enregistrement
        assertTrue(rec.error == "cancelled" || aborted.get())
    }
}
