package com.laststream.app.downloads

import java.util.concurrent.CountDownLatch
import java.util.concurrent.LinkedBlockingQueue
import java.util.concurrent.ThreadPoolExecutor
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicBoolean

/** Exécute un transfert : le moteur en production, un faux dans les tests. Le 4e paramètre enregistre une action qui coupe la connexion en cours (annulation rapide). */
typealias TransferRun = (TransferRequest, () -> Boolean, (Progress) -> Unit, ((() -> Unit)?) -> Unit) -> TransferResult

/** Retours d'un job vers l'appelant (le plugin). Jamais d'URL ni de message brut : seulement un code. */
interface JobCallbacks {
    fun onProgress(p: Progress)
    fun onDone(r: TransferResult)
    fun onError(code: String)
}

/** Écouteur de l'état global : appelé depuis les threads des jobs ; liste vide = plus rien ne tourne. */
fun interface RunnerListener {
    fun onState(jobs: List<JobSnapshot>)
}

/**
 * Exécute les téléchargements : un thread par job, 4 simultanés au plus (les suivants attendent), table `id → job`.
 * Un nouveau `start` pour un id actif annule l'ancien puis attend sa fin avant de commencer (jamais deux écritures dans
 * le même `.part`). Indépendant du service Android : l'état sort par `RunnerListener`. JVM pur.
 */
class DownloadRunner(maxParallel: Int = MAX_PARALLEL, private val replaceWaitMs: Long = REPLACE_WAIT_MS) {
    companion object {
        const val MAX_PARALLEL = 4
        const val REPLACE_WAIT_MS = 40_000L

        /** Instance de l'application. */
        val shared = DownloadRunner()
    }

    private class Job(val id: String, val title: String, val callbacks: JobCallbacks) {
        val cancelled = AtomicBoolean(false)
        val finished = CountDownLatch(1)
        @Volatile var forcedCode: String? = null
        @Volatile var done = 0L
        @Volatile var total: Long? = null
        @Volatile var abort: (() -> Unit)? = null

        /** Demande l'annulation et coupe la connexion en cours : une lecture bloquée ne attend pas son délai. */
        fun cancel() {
            cancelled.set(true)
            try { abort?.invoke() } catch (_: Exception) { }
        }

        /** Enregistré par le moteur à chaque connexion ; si l'annulation est déjà demandée, coupe tout de suite. */
        fun register(a: (() -> Unit)?) {
            abort = a
            if (a != null && cancelled.get()) try { a() } catch (_: Exception) { }
        }
    }

    private val lock = Any()
    private val jobs = LinkedHashMap<String, Job>()
    @Volatile private var listener: RunnerListener? = null
    private val pool = ThreadPoolExecutor(maxParallel, maxParallel, 30, TimeUnit.SECONDS, LinkedBlockingQueue()) { r ->
        Thread(r, "laststream-download").apply { isDaemon = true }
    }.apply { allowCoreThreadTimeOut(true) }

    fun setListener(l: RunnerListener?) { listener = l }

    /** Jobs en cours (en attente ou actifs). */
    fun activeCount(): Int = synchronized(lock) { jobs.size }

    fun isActive(): Boolean = activeCount() > 0

    fun snapshot(): List<JobSnapshot> = synchronized(lock) { jobs.values.map { JobSnapshot(it.title, it.done, it.total) } }

    private fun notifyState() { listener?.onState(snapshot()) }

    /**
     * Démarre un job. `gate` s'exécute sur le thread du job avant le transfert : faux = échec `network` (transitoire),
     * utilisé pour démarrer le service de premier plan.
     */
    fun start(req: TransferRequest, title: String, callbacks: JobCallbacks, gate: () -> Boolean, run: TransferRun) {
        val job = Job(req.id, title, callbacks)
        job.total = req.bytesTotal
        val previous = synchronized(lock) {
            val old = jobs[req.id]
            old?.cancel()
            jobs[req.id] = job
            old
        }
        notifyState()
        pool.execute {
            var outcomeCode: String? = null
            var result: TransferResult? = null
            try {
                // L'ancien job doit avoir fini : sinon deux écritures dans le même .part. Délai dépassé = échec transitoire, sans transfert.
                val oldEnded = previous?.finished?.await(replaceWaitMs, TimeUnit.MILLISECONDS) ?: true
                when {
                    !oldEnded -> outcomeCode = DownloadCode.NETWORK
                    job.cancelled.get() -> outcomeCode = DownloadCode.CANCELLED
                    !safeGate(gate) -> outcomeCode = DownloadCode.NETWORK
                    else -> result = run(req, { job.cancelled.get() }, { p ->
                        job.done = p.bytesDone
                        if (p.bytesTotal != null) job.total = p.bytesTotal
                        callbacks.onProgress(p)
                        notifyState()
                    }, job::register)
                }
            } catch (e: Throwable) {
                outcomeCode = DownloadLogic.codeOf(e)
            }
            if (outcomeCode == DownloadCode.CANCELLED) outcomeCode = job.forcedCode ?: outcomeCode
            synchronized(lock) { if (jobs[req.id] === job) jobs.remove(req.id) }
            try {
                if (result != null) callbacks.onDone(result) else callbacks.onError(outcomeCode ?: DownloadCode.STORE_FAILED)
            } finally {
                job.finished.countDown()
                notifyState()
            }
        }
    }

    private fun safeGate(gate: () -> Boolean): Boolean = try { gate() } catch (_: Throwable) { false }

    /** Annule un job (le `.part` est gardé) ; retourne son verrou de fin, ou null s'il n'y en a pas. */
    fun cancel(id: String, code: String? = null): CountDownLatch? {
        val job = synchronized(lock) { jobs[id] } ?: return null
        if (code != null) job.forcedCode = code
        job.cancel()
        return job.finished
    }

    /** Annule tout. Avec `code`, les jobs échouent avec ce code plutôt que `cancelled`. */
    fun cancelAll(code: String? = null) {
        val all = synchronized(lock) { jobs.values.toList() }
        for (j in all) {
            if (code != null) j.forcedCode = code
            j.cancel()
        }
    }

    /** Annule un job et attend sa fin (au plus `timeoutMs`) : pour supprimer ses fichiers sans écriture concurrente. */
    fun cancelAndAwait(id: String, timeoutMs: Long): Boolean {
        val latch = cancel(id) ?: return true
        return latch.await(timeoutMs, TimeUnit.MILLISECONDS)
    }
}
