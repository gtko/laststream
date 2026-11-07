package com.laststream.app.player

import kotlin.math.roundToInt

/** Coin d'ancrage de la vignette. */
enum class MiniCorner(val key: String) {
    TL("tl"), TR("tr"), BL("bl"), BR("br");

    val left get() = this == TL || this == BL
    val top get() = this == TL || this == TR

    companion object {
        fun parse(s: String?): MiniCorner = values().firstOrNull { it.key == s } ?: BR
    }
}

/** Boîte en pixels (origine en haut à gauche du conteneur). */
data class MiniBox(val x: Int, val y: Int, val w: Int, val h: Int)

/** Calculs purs du mini-lecteur natif (taille, position, aimantation) : testés sans appareil. */
object MiniLogic {
    const val PORTRAIT_RATIO = 0.40
    const val LANDSCAPE_RATIO = 0.28
    const val MARGIN_DP = 16
    /** Hauteur de la barre d'onglets de l'interface (CSS `.tabbar`, visible jusqu'à 760 px de large). */
    const val TABBAR_DP = 72
    const val TABBAR_MAX_WIDTH_DP = 760
    const val MIN_WIDTH_DP = 150
    const val MAX_WIDTH_DP = 480

    /** Largeur de la vignette : 40 % en portrait, 28 % en paysage, bornée (150 à 480 dp). */
    fun width(containerW: Int, containerH: Int, density: Float): Int {
        val ratio = if (containerH >= containerW) PORTRAIT_RATIO else LANDSCAPE_RATIO
        val lo = (MIN_WIDTH_DP * density).roundToInt()
        val hi = (MAX_WIDTH_DP * density).roundToInt()
        return (containerW * ratio).roundToInt().coerceIn(lo, maxOf(lo, hi)).coerceAtMost(maxOf(1, containerW))
    }

    fun height(w: Int): Int = (w * 9.0 / 16.0).roundToInt()

    /** Espace réservé en bas pour ne pas masquer la barre d'onglets. */
    fun bottomReserve(containerW: Int, density: Float): Int =
        if (containerW / density <= TABBAR_MAX_WIDTH_DP) (TABBAR_DP * density).roundToInt() else 0

    fun box(corner: MiniCorner, containerW: Int, containerH: Int, density: Float): MiniBox {
        val w = width(containerW, containerH, density)
        val h = height(w)
        val m = (MARGIN_DP * density).roundToInt()
        val reserve = bottomReserve(containerW, density)
        val x = if (corner.left) m else containerW - m - w
        val y = if (corner.top) m else containerH - m - reserve - h
        return MiniBox(x.coerceAtLeast(0), y.coerceAtLeast(0), w, h)
    }

    /** Coin le plus proche du centre de la vignette après un glissement. */
    fun snap(centerX: Float, centerY: Float, containerW: Int, containerH: Int): MiniCorner {
        val left = centerX < containerW / 2f
        val top = centerY < containerH / 2f
        return when {
            top && left -> MiniCorner.TL
            top -> MiniCorner.TR
            left -> MiniCorner.BL
            else -> MiniCorner.BR
        }
    }

    /** Garde la vignette entièrement dans le conteneur pendant le glissement. */
    fun clamp(x: Float, y: Float, w: Int, h: Int, containerW: Int, containerH: Int): Pair<Float, Float> =
        x.coerceIn(0f, maxOf(0, containerW - w).toFloat()) to y.coerceIn(0f, maxOf(0, containerH - h).toFloat())

    /** Geste « glisser vers le bas » du plein écran : vertical, assez long et assez vif. */
    fun isMinimizeSwipe(dx: Float, dy: Float, velocityY: Float, density: Float): Boolean =
        dy > 80 * density && dy > 1.5f * kotlin.math.abs(dx) && velocityY > 600 * density

    fun progress(pos: Double, dur: Double): Float = if (dur > 0) (pos / dur).coerceIn(0.0, 1.0).toFloat() else 0f
}

/** États du lecteur natif : plein écran, vignette, fermé. Les transitions renvoient faux quand elles ne changent rien. */
class MiniMachine {
    enum class Mode { CLOSED, FULL, MINI }

    var mode = Mode.CLOSED
        private set

    fun open(): Boolean { if (mode == Mode.FULL) return false; mode = Mode.FULL; return true }
    fun minimize(): Boolean { if (mode != Mode.FULL) return false; mode = Mode.MINI; return true }
    fun expand(): Boolean { if (mode != Mode.MINI) return false; mode = Mode.FULL; return true }
    fun close(): Boolean { if (mode == Mode.CLOSED) return false; mode = Mode.CLOSED; return true }
}
