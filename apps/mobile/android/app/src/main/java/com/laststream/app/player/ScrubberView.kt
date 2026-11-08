package com.laststream.app.player

import android.content.Context
import android.graphics.Canvas
import android.graphics.Paint
import android.graphics.RectF
import android.view.KeyEvent
import android.view.MotionEvent
import android.view.View

/** Barre de position façon Netflix : piste fine qui s'épaissit au focus ou au toucher, corail, repères de segments. */
class ScrubberView(context: Context) : View(context) {
    var onScrub: ((fraction: Double, final: Boolean) -> Unit)? = null
    var onStep: ((deltaSeconds: Double) -> Unit)? = null
    /** Tap sur un marqueur social : saut à sa position. */
    var onMarkerTap: ((SocialMarker) -> Unit)? = null

    private val accent = 0xFFFF5A36.toInt()
    private val track = Paint(Paint.ANTI_ALIAS_FLAG).apply { color = 0x40FFFFFF }
    private val played = Paint(Paint.ANTI_ALIAS_FLAG).apply { color = accent }
    private val mark = Paint(Paint.ANTI_ALIAS_FLAG).apply { color = 0xCCFFFFFF.toInt() }
    private val thumb = Paint(Paint.ANTI_ALIAS_FLAG).apply { color = accent }
    private val rect = RectF()
    private var fraction = 0.0
    private var dragging = false
    private var marks: List<Pair<Double, Double>> = emptyList()
    private val density = resources.displayMetrics.density
    private var markers: List<SocialMarker> = emptyList()
    private var tapMarker: SocialMarker? = null
    private val emojiPaint = Paint(Paint.ANTI_ALIAS_FLAG).apply { textSize = 15f * density; textAlign = Paint.Align.CENTER }
    private val extraH get() = if (markers.isEmpty()) 0 else (22 * density).toInt()

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

    /** Repères (début, fin) en fractions de la durée. */
    fun setMarks(m: List<Pair<Double, Double>>) {
        marks = m
        invalidate()
    }

    /** Marqueurs sociaux (emojis) dessinés au-dessus de la piste. */
    fun setMarkers(m: List<SocialMarker>) {
        val grew = m.isEmpty() != markers.isEmpty()
        markers = m
        if (grew) requestLayout()
        invalidate()
    }

    override fun onMeasure(w: Int, h: Int) {
        setMeasuredDimension(MeasureSpec.getSize(w), (32 * density).toInt() + extraH)
    }

    private fun trackCy() = height - 16f * density

    private fun markerX(m: SocialMarker): Float {
        val left = 8f * density
        return left + (width - 16f * density) * m.fraction.toFloat()
    }

    private fun markerAt(x: Float, y: Float): SocialMarker? {
        if (markers.isEmpty() || y > trackCy() - 8f * density) return null
        return markers.minByOrNull { kotlin.math.abs(markerX(it) - x) }?.takeIf { kotlin.math.abs(markerX(it) - x) <= 18f * density }
    }

    override fun onDraw(c: Canvas) {
        val active = dragging || isFocused
        val th = (if (active) 6f else 4f) * density
        val cy = trackCy()
        val left = 8f * density
        val right = width - 8f * density
        rect.set(left, cy - th / 2, right, cy + th / 2)
        c.drawRoundRect(rect, th / 2, th / 2, track)
        marks.forEach { (s, e) ->
            rect.set(left + (right - left) * s.toFloat(), cy - th / 2, left + (right - left) * e.toFloat(), cy + th / 2)
            c.drawRect(rect, mark)
        }
        val x = left + (right - left) * fraction.toFloat()
        rect.set(left, cy - th / 2, x, cy + th / 2)
        c.drawRoundRect(rect, th / 2, th / 2, played)
        c.drawCircle(x, cy, (if (active) 8f else 5f) * density, thumb)
        markers.forEach { m ->
            val mx = markerX(m)
            c.drawText(m.emoji, mx, cy - 12f * density, emojiPaint)
            if (m.count > 1) c.drawCircle(mx + 9f * density, cy - 24f * density, 3f * density, thumb)
        }
    }

    private fun fractionAt(x: Float): Double {
        val left = 8f * density
        val right = width - 8f * density
        return ((x - left) / (right - left)).toDouble().coerceIn(0.0, 1.0)
    }

    override fun onTouchEvent(e: MotionEvent): Boolean {
        when (e.actionMasked) {
            MotionEvent.ACTION_DOWN -> {
                tapMarker = markerAt(e.x, e.y)
                if (tapMarker != null) { parent?.requestDisallowInterceptTouchEvent(true); return true }
                parent?.requestDisallowInterceptTouchEvent(true)
                dragging = true
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
                invalidate()
                if (seek) onScrub?.invoke(fraction, true)
            }
        }
        return true
    }

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
