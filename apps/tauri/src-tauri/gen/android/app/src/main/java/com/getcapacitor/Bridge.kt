package com.getcapacitor

import android.content.Intent
import android.os.Handler
import android.os.HandlerThread
import android.os.Looper
import android.util.Log
import android.webkit.WebView
import androidx.appcompat.app.AppCompatActivity
import com.getcapacitor.annotation.PermissionCallback
import java.lang.reflect.InvocationTargetException
import java.lang.reflect.Method
import java.util.concurrent.ConcurrentHashMap

/**
 * Pont Capacitor de l'app Tauri : plugins enregistrés par nom, appels JS exécutés sur un fil dédié (comme Capacitor),
 * évènements remis au JS par `Events` (plugin Tauri `capacitor`), appels gardés (`saveCall`) et permissions.
 */
class Bridge(val activity: AppCompatActivity, private val events: Events) {
    /** Sortie vers le JS : `capacitor|registerListener` côté page. */
    interface Events {
        fun hasListener(key: String): Boolean
        fun trigger(key: String, data: JSObject)
        fun requestPermissions(strings: Array<String>, done: () -> Unit)
    }

    @Volatile var webView: WebView? = null
        internal set

    private class Entry(val plugin: Plugin, val methods: Map<String, Method>)

    private val plugins = LinkedHashMap<String, Entry>()
    private val saved = ConcurrentHashMap<String, PluginCall>()
    private val retained = HashMap<String, MutableList<JSObject>>()
    private val worker = HandlerThread("CapacitorPlugins").apply { start() }
    private val handler = Handler(worker.looper)
    private val main = Handler(Looper.getMainLooper())

    fun register(plugin: Plugin) {
        plugin.bridge = this
        val methods = HashMap<String, Method>()
        var cls: Class<*>? = plugin.javaClass
        while (cls != null && cls != Plugin::class.java) {
            for (m in cls.declaredMethods) {
                if (m.isAnnotationPresent(PluginMethod::class.java) && m.parameterTypes.contentEquals(arrayOf(PluginCall::class.java))) {
                    methods.putIfAbsent(m.name, m)
                }
            }
            cls = cls.superclass
        }
        plugins[plugin.pluginName] = Entry(plugin, methods)
        plugin.load()
    }

    fun pluginNames(): Set<String> = plugins.keys

    fun methodNames(plugin: String): Set<String> = plugins[plugin]?.methods?.keys ?: emptySet()

    /** Appel JS : méthode `@PluginMethod`, sur le fil des plugins ; un plugin ou une méthode inconnus sont refusés. */
    fun call(plugin: String, method: String, options: JSObject, sink: PluginCall.Sink) {
        val call = PluginCall(plugin, method, options, sink)
        val entry = plugins[plugin]
        val target = entry?.methods?.get(method)
        if (entry == null || target == null) {
            call.reject("\"$plugin.$method()\" is not implemented on android", "UNIMPLEMENTED")
            return
        }
        handler.post { invoke(entry.plugin, target, call) }
    }

    private fun invoke(plugin: Plugin, method: Method, call: PluginCall) {
        try {
            method.isAccessible = true
            method.invoke(plugin, call)
        } catch (e: InvocationTargetException) {
            val cause = e.targetException
            Log.e("Capacitor", "${call.pluginId}.${call.methodName}", cause)
            call.reject(cause?.message ?: cause.toString())
        } catch (e: Exception) {
            Log.e("Capacitor", "${call.pluginId}.${call.methodName}", e)
            call.reject(e.message ?: e.toString())
        }
    }

    fun saveCall(call: PluginCall) {
        saved[call.pluginId + "/" + System.identityHashCode(call)] = call
    }

    fun releaseCall(call: PluginCall) {
        saved.remove(call.pluginId + "/" + System.identityHashCode(call))
    }

    internal fun hasListener(plugin: String, event: String): Boolean = events.hasListener("$plugin:$event")

    internal fun emit(plugin: String, event: String, data: JSObject, retain: Boolean) {
        val key = "$plugin:$event"
        if (events.hasListener(key)) {
            events.trigger(key, data)
        } else if (retain) {
            synchronized(retained) { retained.getOrPut(key) { mutableListOf() }.add(data) }
        }
    }

    /** Premier écouteur d'un évènement : les évènements gardés lui sont remis. */
    fun listenerAdded(key: String) {
        val pending = synchronized(retained) { retained.remove(key) } ?: return
        for (data in pending) events.trigger(key, data)
    }

    internal fun requestPermissions(plugin: Plugin, strings: Array<String>, call: PluginCall, callbackName: String) {
        val callback = plugin.javaClass.methods.firstOrNull {
            it.name == callbackName && it.isAnnotationPresent(PermissionCallback::class.java)
        } ?: plugin.javaClass.declaredMethods.firstOrNull { it.name == callbackName }
        val done = {
            if (callback == null) call.reject("Permission callback $callbackName introuvable")
            else handler.post { invoke(plugin, callback, call) }
        }
        if (strings.isEmpty()) {
            done()
            return
        }
        main.post { events.requestPermissions(strings, done) }
    }

    fun lifecycle(event: String, intent: Intent? = null) {
        for (entry in plugins.values) {
            try {
                entry.plugin.lifecycle(event, intent)
            } catch (e: Exception) {
                Log.e("Capacitor", "${entry.plugin.pluginName} $event", e)
            }
        }
    }
}
