package com.laststream.app.bridge

import android.app.Activity
import android.content.Intent
import android.content.res.Configuration
import android.net.Uri
import android.webkit.WebView
import androidx.appcompat.app.AppCompatActivity
import app.tauri.annotation.Command
import app.tauri.annotation.InvokeArg
import app.tauri.annotation.TauriPlugin
import app.tauri.plugin.Invoke
import app.tauri.plugin.Plugin
import app.tauri.plugin.PluginManager
import com.getcapacitor.Bridge
import com.getcapacitor.JSObject
import com.getcapacitor.PluginCall
import com.laststream.app.display.DisplayPlugin
import com.laststream.app.downloads.DownloadsPlugin
import com.laststream.app.player.LaststreamPlayerPlugin
import com.laststream.app.update.AppUpdatePlugin
import app.tauri.plugin.JSObject as TauriObject

@InvokeArg
internal class OpenExternalArgs {
    lateinit var url: String
}

/**
 * Plugin Tauri `capacitor` : sert à l'interface web l'API des plugins Capacitor de l'app Android (voir `capacitor.js`).
 * - `call {plugin, method, options}` : appelle la méthode `@PluginMethod` du plugin ;
 * - `registerListener` / `removeListener` (hérités) : évènements `<plugin>:<évènement>` ;
 * - `openExternal {url}` : lien ouvert dans le navigateur (appelé par le Rust, `mobile.rs`).
 */
@TauriPlugin
class CapacitorBridgePlugin(private val activity: Activity) : Plugin(activity) {
    private val bridge = Bridge(activity as AppCompatActivity, object : Bridge.Events {
        override fun hasListener(key: String): Boolean = this@CapacitorBridgePlugin.hasListener(key)
        override fun trigger(key: String, data: JSObject) = this@CapacitorBridgePlugin.trigger(key, TauriObject(data.toString()))
        override fun requestPermissions(strings: Array<String>, done: () -> Unit) {
            PluginManager.requestPermissions(strings) { done() }
        }
    })

    init {
        bridge.register(LaststreamPlayerPlugin())
        bridge.register(AppUpdatePlugin())
        bridge.register(DownloadsPlugin())
        bridge.register(DisplayPlugin())
        bridge.register(HttpPlugin())
        bridge.register(AppPlugin())
        active = bridge
    }

    override fun load(webView: WebView) {
        bridge.webView = webView
    }

    @Command
    fun call(invoke: Invoke) {
        val args = invoke.getArgs()
        val plugin = args.getString("plugin", null)
        val method = args.getString("method", null)
        if (plugin.isNullOrEmpty() || method.isNullOrEmpty()) {
            invoke.reject("Appel invalide", "bad_request")
            return
        }
        val options = args.optJSONObject("options")?.toString()?.let { JSObject(it) } ?: JSObject()
        bridge.call(plugin, method, options, object : PluginCall.Sink {
            override fun resolve(data: JSObject?) {
                if (data == null) invoke.resolve() else invoke.resolve(TauriObject(data.toString()))
            }

            override fun reject(error: JSObject) {
                val data = error.optJSONObject("data")?.let { TauriObject(it.toString()) }
                invoke.reject(error.optString("message", "Erreur native"), error.optString("code").ifEmpty { null }, data)
            }
        })
    }

    @Command
    override fun registerListener(invoke: Invoke) {
        val event = invoke.getArgs().getString("event", null)
        super.registerListener(invoke)
        if (event != null) bridge.listenerAdded(event)
    }

    @Command
    fun openExternal(invoke: Invoke) {
        val url = invoke.parseArgs(OpenExternalArgs::class.java).url
        val uri = Uri.parse(url)
        if (uri.scheme != "http" && uri.scheme != "https") {
            invoke.reject("Lien refusé")
            return
        }
        try {
            activity.startActivity(Intent(Intent.ACTION_VIEW, uri).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
            invoke.resolve()
        } catch (e: Exception) {
            invoke.reject(e.message ?: "Aucune application pour ce lien")
        }
    }

    override fun onNewIntent(intent: Intent) = bridge.lifecycle("newIntent", intent)
    override fun onResume(activity: AppCompatActivity) = bridge.lifecycle("resume")
    override fun onPause(activity: AppCompatActivity) = bridge.lifecycle("pause")
    override fun onRestart(activity: AppCompatActivity) = bridge.lifecycle("start")
    override fun onStop(activity: AppCompatActivity) = bridge.lifecycle("stop")
    override fun onDestroy(activity: AppCompatActivity) {
        bridge.lifecycle("destroy")
        if (active === bridge) active = null
    }

    override fun onConfigurationChanged(newConfig: Configuration) {}

    companion object {
        /** Pont en service (tests instrumentés, activité principale). */
        @Volatile var active: Bridge? = null
    }
}
