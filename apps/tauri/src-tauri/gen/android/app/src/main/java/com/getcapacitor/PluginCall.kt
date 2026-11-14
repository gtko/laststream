package com.getcapacitor

import android.util.Log
import org.json.JSONArray
import org.json.JSONException
import org.json.JSONObject

/**
 * Appel JS → natif, avec la même API et les mêmes conversions que le `PluginCall` de Capacitor (un nombre entier n'est
 * lu ni par `getLong` ni par `getDouble`… comme dans Capacitor). La réponse part vers le JS par `sink` (commande Tauri
 * `capacitor|call`) ; seule la première réponse compte, sauf pour un appel gardé (`keepAlive`).
 */
class PluginCall(
    val pluginId: String,
    val methodName: String,
    val data: JSObject,
    private val sink: Sink,
) {
    interface Sink {
        fun resolve(data: JSObject?)
        fun reject(error: JSObject)
    }

    @Volatile private var answered = false

    @Volatile private var keepAlive = false

    fun isKeptAlive(): Boolean = keepAlive

    fun setKeepAlive(keep: Boolean) {
        keepAlive = keep
    }

    private fun claim(): Boolean {
        if (keepAlive) return true
        synchronized(this) {
            if (answered) return false
            answered = true
            return true
        }
    }

    fun resolve(data: JSObject) {
        if (claim()) sink.resolve(data)
    }

    fun resolve() {
        if (claim()) sink.resolve(null)
    }

    fun reject(msg: String?, code: String?, ex: Exception?, data: JSObject?) {
        if (ex != null) Log.e("Capacitor/Plugin", msg ?: "", ex)
        val error = JSObject().put("message", msg).put("code", code)
        if (data != null) error.put("data", data)
        if (claim()) sink.reject(error)
    }

    fun reject(msg: String?, ex: Exception?, data: JSObject?) = reject(msg, null, ex, data)
    fun reject(msg: String?, code: String?, data: JSObject?) = reject(msg, code, null, data)
    fun reject(msg: String?, code: String?, ex: Exception?) = reject(msg, code, ex, null)
    fun reject(msg: String?, data: JSObject?) = reject(msg, null, null, data)
    fun reject(msg: String?, ex: Exception?) = reject(msg, null, ex, null)
    fun reject(msg: String?, code: String?) = reject(msg, code, null, null)
    fun reject(msg: String?) = reject(msg, null, null, null)

    fun unimplemented() = unimplemented("not implemented")
    fun unimplemented(msg: String) = reject(msg, "UNIMPLEMENTED", null, null)
    fun unavailable() = unavailable("not available")
    fun unavailable(msg: String) = reject(msg, "UNAVAILABLE", null, null)

    fun getString(name: String): String? = getString(name, null)
    fun getString(name: String, defaultValue: String?): String? = data.opt(name) as? String ?: defaultValue

    fun getInt(name: String): Int? = getInt(name, null)
    fun getInt(name: String, defaultValue: Int?): Int? = data.opt(name) as? Int ?: defaultValue

    fun getLong(name: String): Long? = getLong(name, null)
    fun getLong(name: String, defaultValue: Long?): Long? = data.opt(name) as? Long ?: defaultValue

    fun getFloat(name: String): Float? = getFloat(name, null)
    fun getFloat(name: String, defaultValue: Float?): Float? = when (val v = data.opt(name)) {
        is Float -> v
        is Double -> v.toFloat()
        is Int -> v.toFloat()
        else -> defaultValue
    }

    fun getDouble(name: String): Double? = getDouble(name, null)
    fun getDouble(name: String, defaultValue: Double?): Double? = when (val v = data.opt(name)) {
        is Double -> v
        is Float -> v.toDouble()
        is Int -> v.toDouble()
        else -> defaultValue
    }

    fun getBoolean(name: String): Boolean? = getBoolean(name, null)
    fun getBoolean(name: String, defaultValue: Boolean?): Boolean? = data.opt(name) as? Boolean ?: defaultValue

    fun getObject(name: String): JSObject? = getObject(name, null)
    fun getObject(name: String, defaultValue: JSObject?): JSObject? {
        val v = data.opt(name) as? JSONObject ?: return defaultValue
        return try { JSObject.fromJSONObject(v) } catch (_: JSONException) { defaultValue }
    }

    fun getArray(name: String): JSArray? = getArray(name, null)
    fun getArray(name: String, defaultValue: JSArray?): JSArray? {
        val v = data.opt(name) as? JSONArray ?: return defaultValue
        return try { JSArray(v.toString()) } catch (_: JSONException) { defaultValue }
    }

    fun hasOption(name: String): Boolean = data.has(name)
}
