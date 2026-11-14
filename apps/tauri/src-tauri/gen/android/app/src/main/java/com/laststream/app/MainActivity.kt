package com.laststream.app

import android.content.res.Configuration
import android.os.Bundle
import android.view.View
import androidx.core.splashscreen.SplashScreen.Companion.installSplashScreen
import androidx.core.view.ViewCompat
import androidx.core.view.WindowCompat
import androidx.core.view.WindowInsetsCompat
import androidx.core.view.WindowInsetsControllerCompat
import com.laststream.app.player.MiniPlayer

/**
 * Activité principale (WebView Tauri), comme celle de l'app Capacitor : bord à bord, page arrêtée aux barres système ;
 * en paysage, barres masquées (un glissement depuis le bord les affiche un instant) ; mini-lecteur natif averti du
 * cycle de vie (quitter l'app pendant la vignette passe en image dans l'image).
 */
class MainActivity : TauriActivity() {
    private var immersive = false

    override fun onCreate(savedInstanceState: Bundle?) {
        // Écran de démarrage Android 12+ (thème AppTheme.NoActionBarLaunch), puis thème de l'app.
        installSplashScreen()
        super.onCreate(savedInstanceState)
        WindowCompat.setDecorFitsSystemWindows(window, false)
        val content = findViewById<View>(android.R.id.content)
        ViewCompat.setOnApplyWindowInsetsListener(content) { v, insets ->
            // Plein écran (paysage) : les barres apparues d'un glissement passent par-dessus, sans décaler la page.
            var types = WindowInsetsCompat.Type.displayCutout() or WindowInsetsCompat.Type.ime()
            if (!immersive) types = types or WindowInsetsCompat.Type.systemBars()
            val bars = insets.getInsets(types)
            v.setPadding(bars.left, bars.top, bars.right, bars.bottom)
            WindowInsetsCompat.CONSUMED
        }
        applySystemBars()
    }

    private fun applySystemBars() {
        immersive = resources.configuration.orientation == Configuration.ORIENTATION_LANDSCAPE
        val c = WindowCompat.getInsetsController(window, window.decorView)
        if (immersive) {
            c.systemBarsBehavior = WindowInsetsControllerCompat.BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE
            c.hide(WindowInsetsCompat.Type.systemBars())
        } else {
            c.show(WindowInsetsCompat.Type.systemBars())
        }
        ViewCompat.requestApplyInsets(findViewById(android.R.id.content))
    }

    override fun onConfigurationChanged(newConfig: Configuration) {
        super.onConfigurationChanged(newConfig)
        applySystemBars()
    }

    // Retour du lecteur natif, d'une boîte de dialogue ou d'une autre application : le système a pu réafficher les barres.
    override fun onWindowFocusChanged(hasFocus: Boolean) {
        super.onWindowFocusChanged(hasFocus)
        if (hasFocus) applySystemBars()
    }

    // Mini-lecteur natif : quitter l'application pendant la vignette passe en image dans l'image (sinon pause).
    override fun onUserLeaveHint() {
        super.onUserLeaveHint()
        MiniPlayer.onHostLeaving(this)
    }

    override fun onStart() {
        super.onStart()
        MiniPlayer.onHostStarted()
    }

    override fun onStop() {
        super.onStop()
        MiniPlayer.onHostStopped()
    }

    override fun onDestroy() {
        MiniPlayer.onHostDestroyed()
        super.onDestroy()
    }
}
