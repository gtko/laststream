package com.laststream.app.bridge

import android.os.Build
import android.os.Handler
import android.os.Looper
import androidx.activity.OnBackPressedCallback
import com.getcapacitor.JSObject
import com.getcapacitor.Plugin
import com.getcapacitor.PluginCall
import com.getcapacitor.PluginMethod
import com.getcapacitor.annotation.CapacitorPlugin

/**
 * `@capacitor/app` : bouton retour (`backButton {canGoBack}` dès qu'un écouteur existe, sinon comportement Android),
 * `minimizeApp`, `exitApp`, `getInfo`, `getState`, `getLaunchUrl`, et les évènements `appStateChange`, `pause`, `resume`.
 */
@CapacitorPlugin(name = "App")
class AppPlugin : Plugin() {
    private val main = Handler(Looper.getMainLooper())
    @Volatile private var active = true

    override fun load() {
        main.post {
            activity.onBackPressedDispatcher.addCallback(activity, object : OnBackPressedCallback(true) {
                override fun handleOnBackPressed() {
                    if (hasListeners("backButton")) {
                        notifyListeners("backButton", JSObject().put("canGoBack", bridge.webView?.canGoBack() ?: false), true)
                    } else {
                        isEnabled = false
                        activity.onBackPressedDispatcher.onBackPressed()
                        isEnabled = true
                    }
                }
            })
        }
    }

    override fun handleOnResume() {
        active = true
        notifyListeners("appStateChange", JSObject().put("isActive", true), false)
        notifyListeners("resume", JSObject(), false)
    }

    override fun handleOnPause() {
        active = false
        notifyListeners("appStateChange", JSObject().put("isActive", false), false)
        notifyListeners("pause", JSObject(), false)
    }

    @PluginMethod
    fun minimizeApp(call: PluginCall) {
        main.post { activity.moveTaskToBack(true) }
        call.resolve()
    }

    @PluginMethod
    fun exitApp(call: PluginCall) {
        call.resolve()
        main.post { activity.finish() }
    }

    @PluginMethod
    fun getInfo(call: PluginCall) {
        val pm = context.packageManager
        val info = pm.getPackageInfo(context.packageName, 0)
        val build = if (Build.VERSION.SDK_INT >= 28) info.longVersionCode else @Suppress("DEPRECATION") info.versionCode.toLong()
        call.resolve(
            JSObject()
                .put("name", context.applicationInfo.loadLabel(pm).toString())
                .put("id", context.packageName)
                .put("build", build.toString())
                .put("version", info.versionName ?: ""),
        )
    }

    @PluginMethod
    fun getState(call: PluginCall) {
        call.resolve(JSObject().put("isActive", active))
    }

    @PluginMethod
    fun getLaunchUrl(call: PluginCall) {
        call.resolve()
    }
}
