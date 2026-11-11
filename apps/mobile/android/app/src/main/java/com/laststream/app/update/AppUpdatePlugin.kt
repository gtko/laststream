package com.laststream.app.update

import android.content.Intent
import android.content.pm.PackageManager
import android.net.Uri
import android.os.Build
import android.provider.Settings
import androidx.core.content.FileProvider
import com.getcapacitor.JSObject
import com.getcapacitor.Plugin
import com.getcapacitor.PluginCall
import com.getcapacitor.PluginMethod
import com.getcapacitor.annotation.CapacitorPlugin
import java.io.File
import java.io.FileInputStream
import java.net.HttpURLConnection
import java.net.URL
import kotlin.concurrent.thread

/**
 * Mise à jour en un tap : `getVersion()` donne le versionCode installé ; `install({url, sha256, versionCode})` télécharge l'APK
 * (https seulement), vérifie son empreinte SHA-256, puis ouvre l'installeur système. Si l'autorisation « sources inconnues »
 * n'est pas accordée à Laststream, l'écran Android correspondant s'ouvre et la promesse est rejetée avec le code `permission`.
 * Évènements : `updateProgress {percent}` pendant le téléchargement.
 */
@CapacitorPlugin(name = "LaststreamUpdate")
class AppUpdatePlugin : Plugin() {
    @Volatile private var busy = false

    @PluginMethod
    fun getVersion(call: PluginCall) {
        try {
            val info = context.packageManager.getPackageInfo(context.packageName, 0)
            val code = if (Build.VERSION.SDK_INT >= 28) info.longVersionCode else @Suppress("DEPRECATION") info.versionCode.toLong()
            call.resolve(JSObject().put("versionCode", code).put("versionName", info.versionName ?: ""))
        } catch (e: Exception) {
            call.reject("Version illisible", "version")
        }
    }

    @PluginMethod
    fun canInstall(call: PluginCall) {
        call.resolve(JSObject().put("allowed", canRequestInstalls()))
    }

    private fun canRequestInstalls(): Boolean = Build.VERSION.SDK_INT < 26 || context.packageManager.canRequestPackageInstalls()

    private fun openUnknownSourcesSettings() {
        val i = Intent(Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES, Uri.parse("package:${context.packageName}")).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
        context.startActivity(i)
    }

    @PluginMethod
    fun install(call: PluginCall) {
        val url = call.getString("url")
        val sha = call.getString("sha256")
        val code = call.getLong("versionCode") ?: 0L
        if (!UpdateLogic.isDownloadUrl(url) || !UpdateLogic.isSha256(sha)) { call.reject("Mise à jour invalide", "bad_request"); return }
        if (!canRequestInstalls()) {
            // Autorisation à donner une fois : l'écran Android s'ouvre, l'utilisateur revient puis appuie de nouveau sur « Installer ».
            try { openUnknownSourcesSettings() } catch (_: Exception) { }
            call.reject("Autorise l’installation depuis Laststream, puis réessaie.", "permission")
            return
        }
        if (busy) { call.reject("Téléchargement déjà en cours", "busy"); return }
        busy = true
        thread(name = "laststream-update") {
            try {
                val file = download(url!!, code)
                val actual = FileInputStream(file).use { UpdateLogic.sha256Hex(it) }
                if (!UpdateLogic.sameHash(sha!!, actual)) {
                    file.delete()
                    call.reject("Empreinte du fichier incorrecte", "hash")
                    return@thread
                }
                // Clé différente de celle de l'app installée : Android refuserait (« Application non installée »). On le dit clairement.
                if (signedByOtherKey(file)) {
                    file.delete()
                    call.reject("Signature différente de l’application installée", "signature")
                    return@thread
                }
                launchInstaller(file)
                call.resolve(JSObject().put("started", true))
            } catch (e: Exception) {
                call.reject(e.message ?: "Téléchargement impossible", "network")
            } finally {
                busy = false
            }
        }
    }

    private fun download(url: String, code: Long): File {
        val dir = File(context.cacheDir, "updates").apply { mkdirs() }
        dir.listFiles()?.forEach { it.delete() }
        val out = File(dir, UpdateLogic.fileName(code))
        val c = URL(url).openConnection() as HttpURLConnection
        c.connectTimeout = 15000
        c.readTimeout = 30000
        c.instanceFollowRedirects = true
        try {
            if (c.responseCode !in 200..299) throw IllegalStateException("Serveur : ${c.responseCode}")
            // Une redirection ne doit pas faire retomber en http.
            if (c.url.protocol != "https") throw IllegalStateException("Adresse non sécurisée")
            val total = c.contentLengthLong
            var done = 0L
            var last = -2
            c.inputStream.use { input ->
                out.outputStream().use { o ->
                    val buf = ByteArray(64 * 1024)
                    while (true) {
                        val n = input.read(buf)
                        if (n < 0) break
                        o.write(buf, 0, n)
                        done += n
                        val p = UpdateLogic.percent(done, total)
                        if (p != last) { last = p; notifyListeners("updateProgress", JSObject().put("percent", p), true) }
                    }
                }
            }
        } finally {
            c.disconnect()
        }
        return out
    }

    /** Vrai seulement si les deux certificats sont lisibles et différents ; dans le doute, l'installeur système tranche. */
    private fun signedByOtherKey(apk: File): Boolean = try {
        val pm = context.packageManager
        val installed: Set<String>
        val archive: Set<String>
        if (Build.VERSION.SDK_INT >= 28) {
            val flag = PackageManager.GET_SIGNING_CERTIFICATES
            installed = pm.getPackageInfo(context.packageName, flag).signingInfo?.apkContentsSigners?.map { it.toCharsString() }?.toSet() ?: emptySet()
            archive = pm.getPackageArchiveInfo(apk.path, flag)?.signingInfo?.apkContentsSigners?.map { it.toCharsString() }?.toSet() ?: emptySet()
        } else {
            @Suppress("DEPRECATION") val flag = PackageManager.GET_SIGNATURES
            @Suppress("DEPRECATION")
            installed = pm.getPackageInfo(context.packageName, flag).signatures?.map { it.toCharsString() }?.toSet() ?: emptySet()
            @Suppress("DEPRECATION")
            archive = pm.getPackageArchiveInfo(apk.path, flag)?.signatures?.map { it.toCharsString() }?.toSet() ?: emptySet()
        }
        UpdateLogic.otherSigner(installed, archive)
    } catch (_: Exception) {
        false
    }

    private fun launchInstaller(file: File) {
        val uri = FileProvider.getUriForFile(context, "${context.packageName}.fileprovider", file)
        val i = Intent(Intent.ACTION_VIEW)
            .setDataAndType(uri, "application/vnd.android.package-archive")
            .addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION or Intent.FLAG_ACTIVITY_NEW_TASK)
        context.startActivity(i)
    }
}
