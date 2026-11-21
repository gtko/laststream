package com.laststream.app.player

import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.os.Handler
import android.os.Looper
import android.util.LruCache
import android.widget.ImageView
import java.net.HttpURLConnection
import java.net.URL
import java.util.concurrent.Executors

/** Chargeur d'images minimal (vignettes d'épisodes) : cache mémoire, 3 fils, décodage réduit. Aucune dépendance. */
class ImageLoader {
    private val cache = object : LruCache<String, Bitmap>(8 * 1024 * 1024) {
        override fun sizeOf(key: String, value: Bitmap) = value.byteCount
    }
    private val pool = Executors.newFixedThreadPool(3)
    private val main = Handler(Looper.getMainLooper())

    fun load(url: String, view: ImageView) {
        if (pool.isShutdown) return
        view.tag = url
        cache.get(url)?.let { view.setImageBitmap(it); return }
        pool.execute {
            val bmp = try { fetch(url) } catch (_: Exception) { null } ?: return@execute
            cache.put(url, bmp)
            main.post { if (view.tag == url) view.setImageBitmap(bmp) }
        }
    }

    /** Fermeture de l'activité : les téléchargements en cours sont interrompus, plus rien ne se charge ensuite. */
    fun shutdown() {
        pool.shutdownNow()
    }

    private fun fetch(url: String): Bitmap? {
        val c = URL(url).openConnection() as HttpURLConnection
        c.connectTimeout = 6000
        c.readTimeout = 6000
        return c.inputStream.use { s ->
            val bytes = s.readBytes()
            val o = BitmapFactory.Options().apply { inJustDecodeBounds = true }
            BitmapFactory.decodeByteArray(bytes, 0, bytes.size, o)
            var sample = 1
            while (o.outWidth / (sample * 2) >= 360) sample *= 2
            BitmapFactory.decodeByteArray(bytes, 0, bytes.size, BitmapFactory.Options().apply { inSampleSize = sample })
        }
    }
}
