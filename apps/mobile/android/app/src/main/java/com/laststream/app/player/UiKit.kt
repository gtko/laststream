package com.laststream.app.player

import android.content.Context
import android.graphics.Color
import android.graphics.Typeface
import android.graphics.drawable.GradientDrawable
import android.graphics.drawable.StateListDrawable
import android.os.Build
import android.util.TypedValue
import android.view.Gravity
import android.view.View
import android.widget.FrameLayout
import android.widget.ImageView
import android.widget.LinearLayout
import android.widget.TextView
import androidx.core.content.ContextCompat

/** Jetons visuels du lecteur : repris de src/styles/styles.css (corail, fond #0c0b11, Sora pour les titres). */
object Tokens {
    const val ACCENT = 0xFFFF5A36.toInt()
    const val BG = 0xFF0C0B11.toInt()
    const val SURFACE = 0xF017151F.toInt()
    const val LINE = 0xFF2A2735.toInt()
    const val TEXT = 0xFFF4F2F7.toInt()
    const val SOFT = 0xFFE4E0EC.toInt()
    const val DIM = 0xFFA19DAE.toInt()
    const val SCRIM = 0xCC0C0B11.toInt()
}

class UiKit(private val ctx: Context) {
    private val d = ctx.resources.displayMetrics.density

    fun dp(v: Number): Int = (v.toFloat() * d).toInt()

    private val cache = HashMap<String, Typeface>()

    /** Police embarquée (variable, axe `wght`) : Sora pour les titres, Plus Jakarta Sans pour le texte. */
    fun font(file: String, weight: Int): Typeface = cache.getOrPut("$file/$weight") {
        try {
            if (Build.VERSION.SDK_INT >= 26) {
                Typeface.Builder(ctx.assets, "fonts/$file").setFontVariationSettings("'wght' $weight").setWeight(weight).build() ?: fallback(weight)
            } else fallback(weight)
        } catch (e: Exception) {
            fallback(weight)
        }
    }

    private fun fallback(weight: Int) = Typeface.create(Typeface.DEFAULT, if (weight >= 700) Typeface.BOLD else Typeface.NORMAL)

    fun title(weight: Int = 700) = font("Sora.ttf", weight)
    fun body(weight: Int = 500) = font("PlusJakartaSans.ttf", weight)

    fun text(s: String, sizeSp: Float, color: Int = Tokens.TEXT, weight: Int = 600, sora: Boolean = false): TextView = TextView(ctx).apply {
        text = s
        setTextSize(TypedValue.COMPLEX_UNIT_SP, sizeSp)
        setTextColor(color)
        typeface = if (sora) title(weight) else body(weight)
        includeFontPadding = false
    }

    fun icon(res: Int, sizeDp: Int = 24, tint: Int = Color.WHITE): ImageView = ImageView(ctx).apply {
        setImageDrawable(ContextCompat.getDrawable(ctx, res)?.mutate())
        setColorFilter(tint)
        layoutParams = LinearLayout.LayoutParams(dp(sizeDp), dp(sizeDp))
        scaleType = ImageView.ScaleType.FIT_CENTER
    }

    /** Fond d'un bouton : transparent, léger au survol, liseré corail au focus (navigation à la télécommande). */
    fun focusBackground(radiusDp: Float, normal: Int = Color.TRANSPARENT, focusedFill: Int = 0x24FFFFFF, strokeFocus: Boolean = true): StateListDrawable {
        fun shape(fill: Int, stroke: Boolean) = GradientDrawable().apply {
            cornerRadius = dp(radiusDp).toFloat()
            setColor(fill)
            if (stroke) setStroke(dp(2), Tokens.ACCENT)
        }
        return StateListDrawable().apply {
            addState(intArrayOf(android.R.attr.state_focused), shape(focusedFill, strokeFocus))
            addState(intArrayOf(android.R.attr.state_pressed), shape(0x33FFFFFF, false))
            addState(intArrayOf(), shape(normal, false))
        }
    }

    fun round(color: Int, radiusDp: Float, strokeColor: Int = 0, strokeDp: Int = 0) = GradientDrawable().apply {
        cornerRadius = dp(radiusDp).toFloat()
        setColor(color)
        if (strokeDp > 0) setStroke(dp(strokeDp), strokeColor)
    }

    /** Bouton rond ou carré portant une icône. */
    fun iconButton(res: Int, desc: String, sizeDp: Int = 48, iconDp: Int = 24, fill: Int = Color.TRANSPARENT, onClick: () -> Unit): FrameLayout =
        FrameLayout(ctx).apply {
            layoutParams = LinearLayout.LayoutParams(dp(sizeDp), dp(sizeDp))
            isFocusable = true
            isClickable = true
            contentDescription = desc
            background = focusBackground(sizeDp / 2f, fill)
            addView(icon(res, iconDp).apply { layoutParams = FrameLayout.LayoutParams(dp(iconDp), dp(iconDp), Gravity.CENTER) })
            setOnClickListener { onClick() }
        }

    /** Bouton « icône + libellé » de la barre basse. */
    fun textButton(res: Int?, label: String, onClick: () -> Unit): LinearLayout = LinearLayout(ctx).apply {
        orientation = LinearLayout.HORIZONTAL
        gravity = Gravity.CENTER_VERTICAL
        isFocusable = true
        isClickable = true
        minimumHeight = dp(44)
        setPadding(dp(12), 0, dp(14), 0)
        background = focusBackground(10f)
        if (res != null) addView(icon(res, 22).apply { (layoutParams as LinearLayout.LayoutParams).marginEnd = dp(8) })
        addView(text(label, 14f, Tokens.TEXT, 700))
        setOnClickListener { onClick() }
    }

    fun spacer(wDp: Int = 0, hDp: Int = 0): View = View(ctx).apply { layoutParams = LinearLayout.LayoutParams(dp(wDp), dp(hDp)) }
}
