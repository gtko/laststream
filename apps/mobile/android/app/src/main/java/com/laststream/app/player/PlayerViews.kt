package com.laststream.app.player

import android.content.Context
import android.graphics.Canvas
import android.graphics.Paint
import android.graphics.Path
import android.graphics.RectF
import android.os.SystemClock
import android.view.Gravity
import android.view.View
import android.widget.LinearLayout
import android.widget.TextView

/**
 * Anneau : chargement (arc qui tourne) ou compte à rebours (arc qui se remplit), avec un triangle de lecture optionnel.
 * Dessiné à la main : aucune dépendance d'animation, il ne tourne que tant qu'il est visible.
 */
class RingView(context: Context, private val strokeDp: Float, trackColor: Int, arcColor: Int) : View(context) {
    private val density = resources.displayMetrics.density
    private val trackPaint = Paint(Paint.ANTI_ALIAS_FLAG).apply { style = Paint.Style.STROKE; color = trackColor; strokeWidth = strokeDp * density }
    private val arcPaint = Paint(Paint.ANTI_ALIAS_FLAG).apply {
        style = Paint.Style.STROKE; color = arcColor; strokeWidth = strokeDp * density; strokeCap = Paint.Cap.ROUND
    }
    private val playPaint = Paint(Paint.ANTI_ALIAS_FLAG).apply { color = arcColor }
    private val oval = RectF()
    private val tri = Path()

    /** Vrai : arc de 90° qui tourne ; faux : arc de `progress` tour à partir du haut. */
    var spinning = true
        set(v) { field = v; invalidate() }
    var progress = 0f
        set(v) { field = v.coerceIn(0f, 1f); invalidate() }
    var showPlay = false

    override fun onDraw(c: Canvas) {
        val pad = strokeDp * density / 2 + 1
        oval.set(pad, pad, width - pad, height - pad)
        c.drawOval(oval, trackPaint)
        if (spinning) {
            val angle = (SystemClock.uptimeMillis() % 1000L) * 360f / 1000f
            c.drawArc(oval, angle - 90f, 90f, false, arcPaint)
            if (isShown) postInvalidateOnAnimation()
        } else if (progress > 0f) {
            c.drawArc(oval, -90f, 360f * progress, false, arcPaint)
        }
        if (showPlay) {
            val cx = width / 2f
            val cy = height / 2f
            val s = width * 0.2f
            tri.reset()
            tri.moveTo(cx - s * 0.7f, cy - s)
            tri.lineTo(cx + s, cy)
            tri.lineTo(cx - s * 0.7f, cy + s)
            tri.close()
            c.drawPath(tri, playPaint)
        }
    }

    override fun onVisibilityChanged(changedView: View, visibility: Int) {
        super.onVisibilityChanged(changedView, visibility)
        if (visibility == VISIBLE) invalidate()
    }
}

/** Barre verticale d'une jauge (luminosité, volume) : remplie depuis le bas. */
class LevelBar(context: Context) : View(context) {
    private val density = resources.displayMetrics.density
    private val bg = Paint(Paint.ANTI_ALIAS_FLAG).apply { color = 0x2EFFFFFF }
    private val fg = Paint(Paint.ANTI_ALIAS_FLAG).apply { color = Tokens.TEXT }
    private val r = RectF()
    var level = 0f
        set(v) { field = v.coerceIn(0f, 1f); invalidate() }

    override fun onDraw(c: Canvas) {
        val w = 6f * density
        val x = (width - w) / 2
        r.set(x, 0f, x + w, height.toFloat())
        c.drawRoundRect(r, w / 2, w / 2, bg)
        r.set(x, height * (1 - level), x + w, height.toFloat())
        c.drawRoundRect(r, w / 2, w / 2, fg)
    }
}

/** Jauge latérale (maquette « Gestes ») : icône, barre, pourcentage, sur fond verre arrondi. */
class LevelGauge(context: Context, kit: UiKit, iconRes: Int, desc: String) : LinearLayout(context) {
    private val bar = LevelBar(context)
    private val label: TextView = kit.tabular(kit.text("", 12f, Tokens.TEXT, 700))

    init {
        orientation = VERTICAL
        gravity = Gravity.CENTER_HORIZONTAL
        setPadding(0, kit.dp(14), 0, kit.dp(14))
        background = kit.round(0x990C0B11.toInt(), 26f)
        contentDescription = desc
        visibility = GONE
        addView(kit.icon(iconRes, 22))
        addView(bar, LayoutParams(kit.dp(20), 0, 1f).apply { topMargin = kit.dp(10); bottomMargin = kit.dp(10) })
        addView(label)
    }

    fun set(level: Float) {
        bar.level = level
        label.text = PlayerUiLogic.percentLabel(level)
    }
}
