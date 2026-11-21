package com.laststream.app.display

import android.app.UiModeManager
import android.content.Context
import android.content.res.Configuration
import android.graphics.Point
import android.hardware.display.DisplayManager
import android.view.Display
import com.getcapacitor.JSObject
import com.getcapacitor.Plugin
import com.getcapacitor.PluginCall
import com.getcapacitor.PluginMethod
import com.getcapacitor.annotation.CapacitorPlugin

/**
 * Résolution réelle de la sortie vidéo (ODY-251) : `getOutput()` donne `{width, height}` en pixels physiques. La WebView d'une
 * box Android TV déclare souvent 1920×1080 avec un ratio de 1 sur une TV 4K ; `Display.Mode` (API 23, minSdk 24) donne la
 * sortie réelle (sur une TV : le meilleur mode pris en charge), que l'app utilise pour le plafond de résolution automatique.
 */
@CapacitorPlugin(name = "LaststreamDisplay")
class DisplayPlugin : Plugin() {
    @PluginMethod
    fun getOutput(call: PluginCall) {
        try {
            val display = (context.getSystemService(Context.DISPLAY_SERVICE) as DisplayManager).getDisplay(Display.DEFAULT_DISPLAY)
            if (display == null) { call.reject("Écran indisponible", "no_display"); return }
            val mode = display.mode
            val real = Point().also { @Suppress("DEPRECATION") display.getRealSize(it) }
            val outputs = mutableListOf(DisplayLogic.Output(mode.physicalWidth, mode.physicalHeight), DisplayLogic.Output(real.x, real.y))
            // Une box réglée en 1080p mais « adaptée au contenu » passe en 4K à la demande : sur une TV, le plafond est le meilleur mode.
            if (isTelevision()) display.supportedModes.forEach { outputs.add(DisplayLogic.Output(it.physicalWidth, it.physicalHeight)) }
            val best = DisplayLogic.best(*outputs.toTypedArray())
            if (best == null) { call.reject("Écran illisible", "no_size"); return }
            call.resolve(JSObject().put("width", best.width).put("height", best.height))
        } catch (e: Exception) {
            call.reject("Écran illisible", "no_size")
        }
    }

    private fun isTelevision(): Boolean =
        (context.getSystemService(Context.UI_MODE_SERVICE) as? UiModeManager)?.currentModeType == Configuration.UI_MODE_TYPE_TELEVISION
}
