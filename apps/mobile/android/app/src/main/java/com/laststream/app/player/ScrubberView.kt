package com.laststream.app.player

import android.content.Context
import android.graphics.Canvas
import android.graphics.Paint
import android.graphics.RectF
import android.view.KeyEvent
import android.view.MotionEvent
import android.view.View

/**
 * Barre de position du lecteur web (LAST-1628) : piste de 5 dp qui s'épaissit au toucher ou au focus, partie lue corail,
 * point blanc, repères d'intro et de générique juste au-dessus, carte de chaleur des réactions et pastilles sociales.
 */
class ScrubberView(context: Context) : View(context) {
    var onScrub: ((fraction: Double, final: Boolean) -> Unit)? = null
    var onStep: ((deltaSeconds: Double) -> Unit)? = null
    /** Tap sur un marqueur social : saut à sa position. */
    var onMarkerTap: ((SocialMarker) -> Unit)? = null

    private val density = resources.displayMetrics.density
    private val track = Paint(Paint.ANTI_ALIAS_FLAG).apply { color = 0x26FFFFFF }
    private val played = Paint(Paint.ANTI_ALIAS_FLAG).apply { color = Tokens.ACCENT }
    private val mark = Paint(Paint.ANTI_ALIAS_FLAG).apply { color = 0xB3FFFFFF.toInt() }
    private val thumb = Paint(Paint.ANTI_ALIAS_FLAG).apply { color = 0xFFFFFFFF.toInt() }
    private val heatPaint = Paint(Paint.ANTI_ALIAS_FLAG)
    private val pastille = Paint(Paint.ANTI_ALIAS_FLAG).apply { color = 0xE60C0B11.toInt() }
    private val countDot = Paint(Paint.ANTI_ALIAS_FLAG).apply { color = Tokens.ACCENT }
    private val emojiPaint = Paint(Paint.ANTI_ALIAS_FLAG).apply { textSize = 13f * density; textAlign = Paint.Align.CENTER }
    private val rect = RectF()
    private var fraction = 0.0
    private var dragging = false
    private var marks: List<Pair<Double, Double>> = emptyList()
    private var markers: List<SocialMarker> = emptyList()
    private var heat: FloatArray = FloatArray(0)
    private var tapMarker: SocialMarker? = null

    /** Bande au-dessus de la piste : pastilles et carte de chaleur, seulement s'il y en a. */
    private val extraH get() = if (markers.isEmpty() && heat.none { it > 0f }) 0 else (26 * density).toInt()

    init {
        isFocusable = true
        isFocusableInTouchMode = false
        contentDescription = "Position de lecture"
    }

    fun setProgress(f: Double) {
        if (dragging) return
        fraction = f.coerceIn(0.0, 1.0)
        invalidate()
    }

    /** Repères (début, fin) en fractions de la durée : intro, récap, générique. */
    fun setMarks(m: List<Pair<Double, Double>>) {
        marks = m
        invalidate()
    }

    /** Marqueurs sociaux (pastilles emoji) dessinés au-dessus de la piste. */
    fun setMarkers(m: List<SocialMarker>) {
        val before = extraH
        markers = m
        if (before != extraH) requestLayout()
        invalidate()
    }

    /** Carte de chaleur des réactions : valeurs 0..1 réparties sur la durée. */
    fun setHeat(bins: FloatArray) {
        val before = extraH
        heat = bins
        if (before != extraH) requestLayout()
        invalidate()
    }

    override fun onMeasure(w: Int, h: Int) {
        setMeasuredDimension(MeasureSpec.getSize(w), (30 * density).toInt() + extraH)
    }

    private fun trackCy() = height - 12f * density
    private fun left() = 8f * density
    private fun right() = width - 8f * density

    private fun markerX(m: SocialMarker): Float = left() + (right() - left()) * m.fraction.toFloat()

    private fun markerAt(x: Float, y: Float): SocialMarker? {
        if (markers.isEmpty() || y > trackCy() - 8f * density) return null
        return markers.minByOrNull { kotlin.math.abs(markerX(it) - x) }?.takeIf { kotlin.math.abs(markerX(it) - x) <= 18f * density }
    }

    private fun heatColor(v: Float): Int {
        // #3a3647 (calme) → #ff5a36 (pic), par interpolation linéaire.
        fun mix(a: Int, b: Int) = (a + (b - a) * v).toInt()
        return (0xFF shl 24) or (mix(0x3A, 0xFF) shl 16) or (mix(0x36, 0x5A) shl 8) or mix(0x47, 0x36)
    }

    override fun onDraw(c: Canvas) {
        val active = dragging || isFocused || isPressed
        val th = (if (active) 8f else 5f) * density
        val cy = trackCy()
        val l = left()
        val r = right()
        val x = l + (r - l) * fraction.toFloat()

        // Carte de chaleur : barres de 18 dp au plus, plus pâles après la position courante.
        if (heat.isNotEmpty()) {
            val n = heat.size
            val gap = 2f * density
            val bw = ((r - l) - gap * (n - 1)) / n
            val base = cy - th / 2 - 6f * density
            heat.forEachIndexed { i, v ->
                if (v <= 0f) return@forEachIndexed
                val bx = l + i * (bw + gap)
                heatPaint.color = heatColor(v)
                heatPaint.alpha = if (bx + bw / 2 > x) 100 else 230
                rect.set(bx, base - (3f + 15f * v) * density, bx + bw, base)
                c.drawRect(rect, heatPaint)
            }
        }

        // Repères d'intro / générique : trait de 3 dp juste au-dessus de la piste.
        marks.forEach { (s, e) ->
            val top = cy - th / 2 - 5f * density
            rect.set(l + (r - l) * s.toFloat(), top, l + (r - l) * e.toFloat(), top + 3f * density)
            c.drawRect(rect, mark)
        }

        rect.set(l, cy - th / 2, r, cy + th / 2)
        c.drawRoundRect(rect, th / 2, th / 2, track)
        rect.set(l, cy - th / 2, x, cy + th / 2)
        c.drawRoundRect(rect, th / 2, th / 2, played)
        c.drawCircle(x, cy, (if (active) 9f else 7.5f) * density, thumb)

        markers.forEach { m ->
            val mx = markerX(m)
            val my = cy - 20f * density
            c.drawCircle(mx, my, 10f * density, pastille)
            c.drawText(m.emoji, mx, my + 4.5f * density, emojiPaint)
            if (m.count > 1) c.drawCircle(mx + 8f * density, my - 8f * density, 3f * density, countDot)
        }
    }

    private fun fractionAt(x: Float): Double = ((x - left()) / (right() - left())).toDouble().coerceIn(0.0, 1.0)

    override fun onTouchEvent(e: MotionEvent): Boolean {
        when (e.actionMasked) {
            MotionEvent.ACTION_DOWN -> {
                tapMarker = markerAt(e.x, e.y)
                parent?.requestDisallowInterceptTouchEvent(true)
                if (tapMarker != null) return true
                dragging = true
                isPressed = true
                fraction = fractionAt(e.x)
                invalidate()
                onScrub?.invoke(fraction, false)
            }
            MotionEvent.ACTION_MOVE -> {
                if (tapMarker != null) return true
                fraction = fractionAt(e.x)
                invalidate()
                onScrub?.invoke(fraction, false)
            }
            MotionEvent.ACTION_UP, MotionEvent.ACTION_CANCEL -> {
                val tm = tapMarker
                if (tm != null) {
                    tapMarker = null
                    if (e.actionMasked == MotionEvent.ACTION_UP && markerAt(e.x, e.y) === tm) onMarkerTap?.invoke(tm)
                    return true
                }
                // Annulation (ACTION_CANCEL) : le glissé se termine sans chercher la vidéo.
                val seek = PlayerLogic.scrubReleaseSeeks(e.actionMasked == MotionEvent.ACTION_CANCEL)
                if (seek) fraction = fractionAt(e.x)
                dragging = false
                isPressed = false
                invalidate()
                if (seek) onScrub?.invoke(fraction, true)
            }
        }
        return true
    }

    /** Glissé en cours : le masquage automatique attend le relâché. */
    val isScrubbing: Boolean get() = dragging

    override fun onKeyDown(keyCode: Int, event: KeyEvent): Boolean {
        return when (keyCode) {
            KeyEvent.KEYCODE_DPAD_LEFT -> { onStep?.invoke(-PlayerLogic.SEEK_STEP_S); true }
            KeyEvent.KEYCODE_DPAD_RIGHT -> { onStep?.invoke(PlayerLogic.SEEK_STEP_S); true }
            else -> super.onKeyDown(keyCode, event)
        }
    }

    override fun onFocusChanged(gainFocus: Boolean, direction: Int, previouslyFocusedRect: android.graphics.Rect?) {
        super.onFocusChanged(gainFocus, direction, previouslyFocusedRect)
        invalidate()
    }
}
