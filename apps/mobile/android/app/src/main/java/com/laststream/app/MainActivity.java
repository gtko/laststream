package com.laststream.app;

import android.content.res.Configuration;
import android.os.Bundle;
import androidx.core.graphics.Insets;
import androidx.core.view.ViewCompat;
import androidx.core.view.WindowCompat;
import androidx.core.view.WindowInsetsCompat;
import androidx.core.view.WindowInsetsControllerCompat;
import com.getcapacitor.BridgeActivity;
import com.laststream.app.display.DisplayPlugin;
import com.laststream.app.downloads.DownloadsPlugin;
import com.laststream.app.player.LaststreamPlayerPlugin;
import com.laststream.app.player.MiniPlayer;
import com.laststream.app.update.AppUpdatePlugin;

public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(Bundle savedInstanceState) {
        registerPlugin(LaststreamPlayerPlugin.class);
        registerPlugin(AppUpdatePlugin.class);
        registerPlugin(DownloadsPlugin.class);
        registerPlugin(DisplayPlugin.class);
        super.onCreate(savedInstanceState);
        // Bord à bord : le fond sombre passe sous les barres système, le contenu s'arrête à leurs limites.
        WindowCompat.setDecorFitsSystemWindows(getWindow(), false);
        ViewCompat.setOnApplyWindowInsetsListener(findViewById(android.R.id.content), (v, windowInsets) -> {
            // Plein écran (paysage) : les barres apparues d'un glissement passent par-dessus, sans décaler la page.
            int types = WindowInsetsCompat.Type.displayCutout() | WindowInsetsCompat.Type.ime();
            if (!immersive) types |= WindowInsetsCompat.Type.systemBars();
            Insets bars = windowInsets.getInsets(types);
            v.setPadding(bars.left, bars.top, bars.right, bars.bottom);
            return WindowInsetsCompat.CONSUMED;
        });
        applySystemBars();
    }

    /** Paysage : barre d'état et barre de navigation masquées (un glissement depuis le bord les affiche un instant). */
    private boolean immersive = false;

    private void applySystemBars() {
        immersive = getResources().getConfiguration().orientation == Configuration.ORIENTATION_LANDSCAPE;
        WindowInsetsControllerCompat c = WindowCompat.getInsetsController(getWindow(), getWindow().getDecorView());
        if (immersive) {
            c.setSystemBarsBehavior(WindowInsetsControllerCompat.BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE);
            c.hide(WindowInsetsCompat.Type.systemBars());
        } else {
            c.show(WindowInsetsCompat.Type.systemBars());
        }
        ViewCompat.requestApplyInsets(findViewById(android.R.id.content));
    }

    @Override
    public void onConfigurationChanged(Configuration newConfig) {
        super.onConfigurationChanged(newConfig);
        applySystemBars();
    }

    // Retour du lecteur natif, d'une boîte de dialogue ou d'une autre application : le système a pu réafficher les barres.
    @Override
    public void onWindowFocusChanged(boolean hasFocus) {
        super.onWindowFocusChanged(hasFocus);
        if (hasFocus) applySystemBars();
    }

    // Mini-lecteur natif : quitter l'application pendant la vignette passe en image dans l'image (sinon pause).
    @Override
    public void onUserLeaveHint() {
        super.onUserLeaveHint();
        MiniPlayer.onHostLeaving(this);
    }

    @Override
    public void onStart() {
        super.onStart();
        MiniPlayer.onHostStarted();
    }

    @Override
    public void onStop() {
        super.onStop();
        MiniPlayer.onHostStopped();
    }

    @Override
    public void onDestroy() {
        MiniPlayer.onHostDestroyed();
        super.onDestroy();
    }
}
