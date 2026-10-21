package com.laststream.app.downloads

import android.Manifest
import android.os.Build
import android.util.Base64
import com.getcapacitor.JSObject
import com.getcapacitor.PermissionState
import com.getcapacitor.Plugin
import com.getcapacitor.PluginCall
import com.getcapacitor.PluginMethod
import com.getcapacitor.annotation.CapacitorPlugin
import com.getcapacitor.annotation.Permission
import com.getcapacitor.annotation.PermissionCallback
import java.io.File
import java.io.IOException
import kotlin.concurrent.thread

/**
 * Téléchargements hors ligne natifs (ODY-200). Aucune méthode n'accepte un chemin : seulement un `id` (le fichier s'appelle
 * le SHA-256 de l'id dans le stockage privé de l'application). Le lien débridé est résolu côté JS, passé à `start` et n'existe
 * qu'en mémoire : jamais persisté, journalisé ni renvoyé (les rejets ne portent qu'un code de `DownloadErrorCode`).
 *
 * - `start({id, url, title, bytesTotal?, etag?, maxBytes?})` : la promesse se résout à la fin du transfert avec
 *   `{bytesDone, bytesTotal?, etag?, lastModified?}` (fichier complet, à finaliser) et se rejette avec un code
 *   (`cancelled` si annulé). Évènement `progress {id, bytesDone, bytesTotal?, etag?, lastModified?}` (environ 1 par seconde).
 * - `cancel({id})` garde le `.part` ; `size`, `truncate`, `write` (repli de contrat), `finalize`, `remove`, `usage`, `localPath`.
 * - `requestNotifications()` : permission POST_NOTIFICATIONS (API 33+), jamais bloquante pour le téléchargement.
 */
@CapacitorPlugin(
    name = "LaststreamDownloads",
    permissions = [Permission(strings = [Manifest.permission.POST_NOTIFICATIONS], alias = "notifications")],
)
class DownloadsPlugin : Plugin() {
    private val runner = DownloadRunner.shared
    private val files: DownloadFiles by lazy { DownloadFiles(File(context.filesDir, "downloads")) }
    private val engine: TransferEngine by lazy { TransferEngine(files) }

    // La WebView peut se recharger : plus de job orphelin, le gestionnaire JS reprend.
    override fun load() { runner.cancelAll() }

    override fun handleOnDestroy() { runner.cancelAll() }

    private fun idOf(call: PluginCall): String? {
        val id = call.getString("id")
        if (id.isNullOrEmpty() || id.length > 512) { call.reject(DownloadCode.CONTENT, DownloadCode.CONTENT); return null }
        return id
    }

    /** Nombre JSON (entier ou décimal) en Long, null s'il est absent ou invalide. */
    private fun num(call: PluginCall, name: String): Long? {
        val v = call.data.opt(name)
        return if (v is Number && v.toDouble() >= 0) v.toLong() else null
    }

    private fun progressObject(p: Progress): JSObject {
        val o = JSObject().put("bytesDone", p.bytesDone)
        p.bytesTotal?.let { o.put("bytesTotal", it) }
        p.etag?.let { o.put("etag", it) }
        p.lastModified?.let { o.put("lastModified", it) }
        return o
    }

    @PluginMethod
    fun start(call: PluginCall) {
        val id = idOf(call) ?: return
        val url = call.getString("url")
        if (url.isNullOrEmpty()) { call.reject(DownloadCode.CONTENT, DownloadCode.CONTENT); return }
        val req = TransferRequest(id, url, num(call, "bytesTotal"), call.getString("etag"), num(call, "maxBytes"))
        val title = DownloadLogic.cleanTitle(call.getString("title"))
        bridge.saveCall(call)
        val callbacks = object : JobCallbacks {
            override fun onProgress(p: Progress) {
                notifyListeners("progress", progressObject(p).put("id", id), false)
            }
            override fun onDone(r: TransferResult) {
                call.resolve(progressObject(Progress(r.bytesDone, r.bytesTotal, r.etag, r.lastModified)))
                bridge.releaseCall(call)
            }
            override fun onError(code: String) {
                call.reject(code, code)
                bridge.releaseCall(call)
            }
        }
        runner.start(req, title, callbacks, gate = { DownloadService.ensureStarted(context) }) { r, cancelled, onProgress, abort ->
            engine.run(r, cancelled, onProgress, abort)
        }
    }

    @PluginMethod
    fun cancel(call: PluginCall) {
        val id = idOf(call) ?: return
        runner.cancel(id)
        call.resolve()
    }

    @PluginMethod
    fun size(call: PluginCall) {
        val id = idOf(call) ?: return
        call.resolve(JSObject().put("size", files.size(id)))
    }

    @PluginMethod
    fun truncate(call: PluginCall) {
        val id = idOf(call) ?: return
        val len = num(call, "len")
        if (len == null) { call.reject(DownloadCode.CONTENT, DownloadCode.CONTENT); return }
        disk(call) { files.truncate(id, len); call.resolve() }
    }

    @PluginMethod
    fun write(call: PluginCall) {
        val id = idOf(call) ?: return
        val offset = num(call, "offset")
        val data = call.getString("data")
        if (offset == null || data == null) { call.reject(DownloadCode.CONTENT, DownloadCode.CONTENT); return }
        val bytes = try { Base64.decode(data, Base64.DEFAULT) } catch (_: IllegalArgumentException) {
            call.reject(DownloadCode.CONTENT, DownloadCode.CONTENT); return
        }
        disk(call) { files.write(id, offset, bytes); call.resolve() }
    }

    @PluginMethod
    fun finalize(call: PluginCall) {
        val id = idOf(call) ?: return
        disk(call) { files.finalize(id); call.resolve() }
    }

    /** Annule le job puis supprime `.part` et `.bin` (attend la fin du job : pas d'écriture concurrente). */
    @PluginMethod
    fun remove(call: PluginCall) {
        val id = idOf(call) ?: return
        thread(name = "laststream-download-remove") {
            if (!runner.cancelAndAwait(id, 40_000)) { call.reject(DownloadCode.STORE_FAILED, DownloadCode.STORE_FAILED); return@thread }
            disk(call) { files.remove(id); call.resolve() }
        }
    }

    @PluginMethod
    fun usage(call: PluginCall) {
        val u = files.usage()
        call.resolve(JSObject().put("used", u.used).put("available", u.available))
    }

    /** Chemin lisible par libVLC, seulement pour un fichier finalisé. */
    @PluginMethod
    fun localPath(call: PluginCall) {
        val id = idOf(call) ?: return
        val f = files.finalPath(id)
        if (f == null) { call.reject("not_found", "not_found"); return }
        call.resolve(JSObject().put("path", f.absolutePath).put("uri", "file://" + f.absolutePath))
    }

    @PluginMethod
    fun requestNotifications(call: PluginCall) {
        if (Build.VERSION.SDK_INT < 33 || getPermissionState("notifications") == PermissionState.GRANTED) {
            call.resolve(JSObject().put("granted", true))
            return
        }
        requestPermissionForAlias("notifications", call, "notificationsResult")
    }

    @PermissionCallback
    fun notificationsResult(call: PluginCall) {
        call.resolve(JSObject().put("granted", getPermissionState("notifications") == PermissionState.GRANTED))
    }

    /** Erreur disque : seulement un code, jamais le message système. */
    private inline fun disk(call: PluginCall, op: () -> Unit) {
        try {
            op()
        } catch (e: IOException) {
            val code = DownloadLogic.diskErrorCode(e)
            call.reject(code, code)
        } catch (e: Exception) {
            call.reject(DownloadCode.STORE_FAILED, DownloadCode.STORE_FAILED)
        }
    }
}
