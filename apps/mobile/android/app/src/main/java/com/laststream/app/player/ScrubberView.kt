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

    override fun onMeasure(w: Int, h: Int) {
        setMeasuredDimension(MeasureSpec.getSize(w), (32 * density).toInt())
    }

    override fun onDraw(c: Canvas) {
        val active = dragging || isFocused
        val th = (if (active) 6f else 4f) * density
        val cy = height / 2f
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
    }

    private fun fractionAt(x: Float): Double {
        val left = 8f * density
        val right = width - 8f * density
        return ((x - left) / (right - left)).toDouble().coerceIn(0.0, 1.0)
    }

    override fun onTouchEvent(e: MotionEvent): Boolean {
        when (e.actionMasked) {
            MotionEvent.ACTION_DOWN -> {
                parent?.requestDisallowInterceptTouchEvent(true)
                dragging = true
                fraction = fractionAt(e.x)
                invalidate()
                onScrub?.invoke(fraction, false)
            }
            MotionEvent.ACTION_MOVE -> {
                fraction = fractionAt(e.x)
                invalidate()
                onScrub?.invoke(fraction, false)
            }
            MotionEvent.ACTION_UP, MotionEvent.ACTION_CANCEL -> {
                fraction = fractionAt(e.x)
                dragging = false
                invalidate()
                onScrub?.invoke(fraction, true)
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
