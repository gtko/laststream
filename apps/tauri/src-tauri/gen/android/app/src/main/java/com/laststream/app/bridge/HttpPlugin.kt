package com.laststream.app.bridge

import android.util.Base64
import com.getcapacitor.JSObject
import com.getcapacitor.Plugin
import com.getcapacitor.PluginCall
import com.getcapacitor.PluginMethod
import com.getcapacitor.annotation.CapacitorPlugin
import org.json.JSONArray
import org.json.JSONObject
import java.io.ByteArrayOutputStream
import java.io.InputStream
import java.net.HttpURLConnection
import java.net.URL
import java.net.URLEncoder
import kotlin.concurrent.thread

/**
 * `CapacitorHttp` natif (requête hors de la WebView : ni CORS ni blocage du contenu mixte), avec les options et la
 * réponse du plugin de Capacitor : `{url, method, headers, params, data, responseType, connectTimeout, readTimeout,
 * disableRedirects}` → `{status, headers, url, data}`. `data` : base64 pour `arraybuffer` / `blob`, texte pour `text`,
 * JSON décodé si le serveur répond en JSON, sinon texte. Un statut d'erreur HTTP résout ; seule une erreur réseau rejette.
 */
@CapacitorPlugin(name = "CapacitorHttp")
class HttpPlugin : Plugin() {
    @PluginMethod fun request(call: PluginCall) = run(call, null)
    @PluginMethod fun get(call: PluginCall) = run(call, "GET")
    @PluginMethod fun post(call: PluginCall) = run(call, "POST")
    @PluginMethod fun put(call: PluginCall) = run(call, "PUT")
    @PluginMethod fun patch(call: PluginCall) = run(call, "PATCH")
    @PluginMethod fun delete(call: PluginCall) = run(call, "DELETE")

    private fun run(call: PluginCall, forced: String?) {
        thread(name = "laststream-http") {
            try {
                call.resolve(HttpRequest.execute(call.data, forced))
            } catch (e: Exception) {
                call.reject(e.message ?: e.toString(), "NETWORK", e)
            }
        }
    }
}

internal object HttpRequest {
    fun execute(o: JSONObject, forced: String?): JSObject {
        val base = o.optString("url")
        val scheme = base.substringBefore(':').lowercase()
        if (scheme != "http" && scheme != "https") throw IllegalArgumentException("Adresse invalide")
        val method = (forced ?: o.optString("method", "GET").ifEmpty { "GET" }).uppercase()
        val url = URL(withParams(base, o.optJSONObject("params")))
        val c = url.openConnection() as HttpURLConnection
        try {
            c.requestMethod = if (method == "PATCH") "POST" else method
            if (method == "PATCH") c.setRequestProperty("X-HTTP-Method-Override", "PATCH")
            c.connectTimeout = o.optInt("connectTimeout", 0).coerceAtLeast(0)
            c.readTimeout = o.optInt("readTimeout", 0).coerceAtLeast(0)
            c.instanceFollowRedirects = !o.optBoolean("disableRedirects", false)
            val headers = o.optJSONObject("headers") ?: JSONObject()
            var contentType: String? = null
            for (k in headers.keys()) {
                val v = headers.optString(k)
                if (k.equals("content-type", ignoreCase = true)) contentType = v
                c.setRequestProperty(k, v)
            }
            if (o.has("data") && !o.isNull("data") && method != "GET" && method != "HEAD") {
                val body = encodeBody(o.opt("data"), contentType)
                c.doOutput = true
                c.outputStream.use { it.write(body.toByteArray(Charsets.UTF_8)) }
            }
            val status = c.responseCode
            val stream = (if (status >= 400) c.errorStream else c.inputStream)
            val bytes = stream?.use { read(it) } ?: ByteArray(0)
            val out = JSObject()
            out.put("status", status)
            out.put("url", c.url.toString())
            val h = JSObject()
            for ((k, v) in c.headerFields) if (k != null) h.put(k, v.joinToString(", "))
            out.put("headers", h)
            out.put("data", decodeBody(bytes, o.optString("responseType", "json"), c.contentType))
            return out
        } finally {
            c.disconnect()
        }
    }

    private fun withParams(base: String, params: JSONObject?): String {
        if (params == null || params.length() == 0) return base
        val q = StringBuilder()
        for (k in params.keys()) {
            val v = params.opt(k)
            val values = if (v is JSONArray) (0 until v.length()).map { v.opt(it).toString() } else listOf(v.toString())
            for (one in values) {
                if (q.isNotEmpty()) q.append('&')
                q.append(enc(k)).append('=').append(enc(one))
            }
        }
        return base + (if (base.contains('?')) "&" else "?") + q
    }

    private fun enc(s: String): String = URLEncoder.encode(s, "UTF-8")

    /** JSON → texte JSON ; formulaire urlencodé → `k=v&…` ; le reste tel quel. */
    internal fun encodeBody(data: Any?, contentType: String?): String {
        val type = contentType?.lowercase() ?: ""
        return when {
            type.contains("application/x-www-form-urlencoded") && data is JSONObject ->
                data.keys().asSequence().joinToString("&") { enc(it) + "=" + enc(data.opt(it).toString()) }
            data is JSONObject || data is JSONArray -> data.toString()
            else -> data.toString()
        }
    }

    internal fun decodeBody(bytes: ByteArray, responseType: String, contentType: String?): Any {
        when (responseType) {
            "arraybuffer", "blob" -> return Base64.encodeToString(bytes, Base64.NO_WRAP)
            "text", "document" -> return String(bytes, Charsets.UTF_8)
        }
        val text = String(bytes, Charsets.UTF_8)
        if (contentType?.contains("application/json", ignoreCase = true) == true) {
            val t = text.trim()
            try {
                if (t.startsWith("{")) return JSONObject(t)
                if (t.startsWith("[")) return JSONArray(t)
            } catch (_: Exception) {
            }
        }
        return text
    }

    private fun read(input: InputStream): ByteArray {
        val out = ByteArrayOutputStream()
        val buf = ByteArray(64 * 1024)
        while (true) {
            val n = input.read(buf)
            if (n < 0) break
            out.write(buf, 0, n)
        }
        return out.toByteArray()
    }
}
