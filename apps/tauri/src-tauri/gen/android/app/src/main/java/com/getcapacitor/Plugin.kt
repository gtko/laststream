package com.getcapacitor

import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import androidx.appcompat.app.AppCompatActivity
import androidx.core.content.ContextCompat
import com.getcapacitor.annotation.CapacitorPlugin

/**
 * Base des plugins natifs, avec l'API du `Plugin` de Capacitor dont se servent les plugins Laststream : activité et
 * contexte, cycle de vie, évènements vers le JS, permissions. `bridge` est posé par `Bridge.register`, avant `load()`.
 */
open class Plugin {
    lateinit var bridge: Bridge
        internal set

    val activity: AppCompatActivity get() = bridge.activity
    val context: Context get() = bridge.activity

    /** Nom vu du JS (`@CapacitorPlugin(name)`). */
    val pluginName: String
        get() = javaClass.getAnnotation(CapacitorPlugin::class.java)?.name?.takeIf { it.isNotEmpty() } ?: javaClass.simpleName

    open fun load() {}

    protected open fun handleOnStart() {}
    protected open fun handleOnResume() {}
    protected open fun handleOnPause() {}
    protected open fun handleOnStop() {}
    protected open fun handleOnDestroy() {}
    protected open fun handleOnNewIntent(intent: Intent) {}

    internal fun lifecycle(event: String, intent: Intent? = null) {
        when (event) {
            "start" -> handleOnStart()
            "resume" -> handleOnResume()
            "pause" -> handleOnPause()
            "stop" -> handleOnStop()
            "destroy" -> handleOnDestroy()
            "newIntent" -> if (intent != null) handleOnNewIntent(intent)
        }
    }

    protected fun notifyListeners(eventName: String, data: JSObject) = notifyListeners(eventName, data, false)

    /** `retainUntilConsumed` : sans écouteur, l'évènement est gardé et remis au premier écouteur (comme Capacitor). */
    protected fun notifyListeners(eventName: String, data: JSObject, retainUntilConsumed: Boolean) {
        bridge.emit(pluginName, eventName, data, retainUntilConsumed)
    }

    protected fun hasListeners(eventName: String): Boolean = bridge.hasListener(pluginName, eventName)

    private fun permissionStrings(alias: String): Array<String> =
        javaClass.getAnnotation(CapacitorPlugin::class.java)?.permissions
            ?.filter { it.alias == alias }?.flatMap { it.strings.toList() }?.toTypedArray() ?: emptyArray()

    /** Accordée si toutes les permissions de l'alias le sont ; sinon à demander (`PROMPT`). */
    fun getPermissionState(alias: String): PermissionState? {
        val strings = permissionStrings(alias)
        if (strings.isEmpty()) return null
        val granted = strings.all { ContextCompat.checkSelfPermission(context, it) == PackageManager.PERMISSION_GRANTED }
        return if (granted) PermissionState.GRANTED else PermissionState.PROMPT
    }

    /** Demande les permissions de l'alias, puis appelle la méthode `@PermissionCallback` `callbackName` avec `call`. */
    protected fun requestPermissionForAlias(alias: String, call: PluginCall, callbackName: String) {
        bridge.requestPermissions(this, permissionStrings(alias), call, callbackName)
    }
}
