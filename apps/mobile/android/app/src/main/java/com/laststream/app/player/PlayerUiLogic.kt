package com.laststream.app.player

import kotlin.math.abs
import kotlin.math.roundToInt

/** Glisser vertical sur la vidéo : selon la zone de départ, réduction en vignette, luminosité ou volume. */
enum class DragKind { NONE, MINIMIZE, BRIGHTNESS, VOLUME }

/** Pilules de la barre basse, dans l'ordre d'affichage. */
enum class Pill { REACT, EPISODES, TRACKS, SOURCES, NEXT }

/** Logique pure de l'habillage du lecteur plein écran (LAST-1628), testée sans Android. */
object PlayerUiLogic {
    /** Masquage automatique des contrôles (tactile). */
    const val AUTO_HIDE_MS = 4000L
    /** Double-tap : tiers gauche = recul, tiers droit = avance, centre = lecture / pause. */
    const val DOUBLE_TAP_LEFT = 0.35f
    const val DOUBLE_TAP_RIGHT = 0.65f
    /** Bande haute réservée au « glisser vers le bas » qui réduit en vignette. */
    const val MINIMIZE_ZONE = 0.25f
    /** Bande basse ignorée (barre de gestes du système). */
    const val BOTTOM_DEAD_ZONE = 0.9f
    /** Un glisser sur cette fraction de la hauteur parcourt toute la plage (0 à 100 %). */
    const val DRAG_FULL_RANGE = 0.6f
    /** Pas du décalage des sous-titres dans le panneau. */
    const val SUB_DELAY_STEP_MS = 100L
    /** Fenêtre autour de la position courante pour faire flotter la réaction d'un autre membre. */
    const val FRESH_REACTION_WINDOW_S = 20.0
    const val HEAT_BINS = 48

    /** Contrôles masqués au bout de `AUTO_HIDE_MS` : jamais en pause, panneau ou éventail d'emojis ouvert, barre tenue. */
    fun shouldAutoHide(visible: Boolean, playing: Boolean, panelOpen: Boolean, scrubbing: Boolean, fanOpen: Boolean = false): Boolean =
        visible && playing && !panelOpen && !scrubbing && !fanOpen

    /** « Passer le générique » : début de la scène post-générique si elle est encore à venir, sinon null (épisode suivant). */
    fun creditsSkipTarget(segments: List<SkipSegment>, position: Double): Double? =
        segments.filter { it.kind == "postcredits" && it.start > position }.minByOrNull { it.start }?.start

    /** −1 : recul, +1 : avance, 0 : lecture / pause. */
    fun doubleTapDirection(xFraction: Float): Int = when {
        xFraction < DOUBLE_TAP_LEFT -> -1
        xFraction > DOUBLE_TAP_RIGHT -> 1
        else -> 0
    }

    /** Nature d'un glisser selon son point de départ (fractions de la largeur et de la hauteur). */
    fun dragKind(xFraction: Float, yFraction: Float): DragKind = when {
        yFraction < MINIMIZE_ZONE -> DragKind.MINIMIZE
        yFraction > BOTTOM_DEAD_ZONE -> DragKind.NONE
        xFraction < 0.5f -> DragKind.BRIGHTNESS
        else -> DragKind.VOLUME
    }

    /** Le geste est un glisser vertical : au-delà du seuil et nettement plus vertical qu'horizontal. */
    fun isVerticalDrag(dx: Float, dy: Float, slopPx: Float): Boolean = abs(dy) >= slopPx && abs(dy) > abs(dx) * 1.2f

    /** Niveau (0..1) après un glisser de `dyPx` (positif vers le bas : le niveau baisse). */
    fun dragLevel(start: Float, dyPx: Float, heightPx: Float): Float {
        if (!(heightPx > 0f)) return start.coerceIn(0f, 1f)
        return (start - dyPx / (heightPx * DRAG_FULL_RANGE)).coerceIn(0f, 1f)
    }

    /** Index de volume d'un niveau 0..1 sur `max` crans. */
    fun volumeIndex(level: Float, max: Int): Int = if (max <= 0) 0 else (level.coerceIn(0f, 1f) * max).roundToInt().coerceIn(0, max)

    fun volumeLevel(index: Int, max: Int): Float = if (max <= 0) 0f else (index.toFloat() / max).coerceIn(0f, 1f)

    /** Luminosité de départ : celle de la fenêtre si fixée (≥ 0), sinon celle du système (0..255). */
    fun startBrightness(window: Float, system: Int?): Float = when {
        window >= 0f -> window.coerceIn(0f, 1f)
        system != null -> (system / 255f).coerceIn(0f, 1f)
        else -> 0.5f
    }

    /** Luminosité appliquée à la fenêtre : jamais 0 (écran noir), au moins 1 %. */
    fun windowBrightness(level: Float): Float = level.coerceIn(0.01f, 1f)

    /** « 64 % ». */
    fun percentLabel(level: Float): String = "${(level.coerceIn(0f, 1f) * 100).roundToInt()} %"

    /** « 24:13 / 52:40 ». */
    fun timeLabel(position: Double, duration: Double): String = PlayerLogic.formatClock(position) + " / " + PlayerLogic.formatClock(duration)

    /** Pilules visibles, chacune seulement si elle a un sens (mêmes conditions que les anciens boutons). */
    fun pills(react: Boolean, hasEpisodes: Boolean, hasSources: Boolean, hasNext: Boolean): List<Pill> = buildList {
        if (react) add(Pill.REACT)
        if (hasEpisodes) add(Pill.EPISODES)
        add(Pill.TRACKS)
        if (hasSources) add(Pill.SOURCES)
        if (hasNext) add(Pill.NEXT)
    }

    /** Anneau de « Lire maintenant » : part du début du générique et se remplit jusqu'à la fin de l'épisode. */
    fun countdownFraction(position: Double, creditsStart: Double?, duration: Double): Float {
        if (creditsStart == null || !(duration > creditsStart)) return 0f
        return ((position - creditsStart) / (duration - creditsStart)).toFloat().coerceIn(0f, 1f)
    }

    /** Carte de chaleur : nombre de notes par tranche de la durée, normalisé sur la tranche la plus remplie. */
    fun heatBins(positions: List<Double>, duration: Double, bins: Int = HEAT_BINS): FloatArray {
        val out = FloatArray(bins.coerceAtLeast(0))
        if (!(duration > 0) || bins <= 0) return out
        positions.forEach { p ->
            if (p < 0 || p > duration) return@forEach
            out[((p / duration) * bins).toInt().coerceIn(0, bins - 1)] += 1f
        }
        val top = out.maxOrNull() ?: 0f
        if (top > 0f) for (i in out.indices) out[i] /= top
        return out
    }

    /** « 1 avec vous », « 3 avec vous » : le natif ne sait pas s'il s'agit d'un salon ou d'amis qui regardent. */
    fun viewersLabel(n: Int): String = "$n avec vous"

    private val AVATAR_COLORS = intArrayOf(0xFFFF5A36.toInt(), 0xFF6EC6FF.toInt(), 0xFFC9C4D6.toInt(), 0xFF4ADE80.toInt(), 0xFFF5B942.toInt())

    /** Couleur stable d'un avatar (même membre, même couleur). */
    fun avatarColor(id: String): Int = AVATAR_COLORS[Math.floorMod(id.hashCode(), AVATAR_COLORS.size)]

    /** Réactions d'autres membres arrivées depuis le dernier relevé, proches de la position courante : elles flottent à l'écran. */
    fun freshReactions(notes: List<SocialNote>, seen: Set<String>, position: Double, window: Double = FRESH_REACTION_WINDOW_S): List<SocialNote> =
        notes.filter { it.id.isNotEmpty() && it.id !in seen && !it.mine && it.kind == "emoji" && it.body.isNotBlank() && abs(it.pos - position) <= window }

    /** Largeur d'un panneau latéral : `wanted`, bornée à la largeur disponible. */
    fun panelWidth(available: Int, wanted: Int): Int = minOf(wanted, available).coerceAtLeast(0)
}
