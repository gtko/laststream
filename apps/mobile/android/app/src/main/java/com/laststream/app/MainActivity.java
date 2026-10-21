package com.laststream.app;

import android.os.Bundle;
import androidx.core.graphics.Insets;
import androidx.core.view.ViewCompat;
import androidx.core.view.WindowCompat;
import androidx.core.view.WindowInsetsCompat;
import com.getcapacitor.BridgeActivity;
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
        super.onCreate(savedInstanceState);
        // Bord à bord : le fond sombre passe sous les barres système, le contenu s'arrête à leurs limites.
        WindowCompat.setDecorFitsSystemWindows(getWindow(), false);
        ViewCompat.setOnApplyWindowInsetsListener(findViewById(android.R.id.content), (v, windowInsets) -> {
            Insets bars = windowInsets.getInsets(
                WindowInsetsCompat.Type.systemBars() | WindowInsetsCompat.Type.displayCutout() | WindowInsetsCompat.Type.ime());
            v.setPadding(bars.left, bars.top, bars.right, bars.bottom);
            return WindowInsetsCompat.CONSUMED;
        });
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
