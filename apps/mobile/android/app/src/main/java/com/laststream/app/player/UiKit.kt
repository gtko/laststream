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
    // Habillage LAST-1628 (maquette validée) : cartes, liserés, textes secondaires, états du salon.
    const val CARD = 0xF017151F.toInt()
    const val CARD_SOFT = 0xE017151F.toInt()
    const val BORDER = 0xFF33303F.toInt()
    const val SECONDARY = 0xFFC9C4D6.toInt()
    const val GREEN = 0xFF4ADE80.toInt()
    const val AMBER = 0xFFF5B942.toInt()
    /** Fond translucide des boutons posés sur la vidéo (rgba(12,11,17,.55)). */
    const val GLASS = 0x8C0C0B11.toInt()
    const val SHEET = 0xEB110F18.toInt()
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

    /** Chiffres à chasse fixe (temps, pourcentages) : le texte ne tremble pas en défilant. */
    fun tabular(t: TextView): TextView = t.apply { fontFeatureSettings = "tnum" }

    /**
     * Pilule de la barre basse (maquette : 40 dp de haut, liseré blanc 14 %, fond verre) ; la zone tactile fait 44 dp,
     * le fond est inséré de 2 dp en haut et en bas. `accent` : variante orange (Réagir).
     */
    fun pill(res: Int?, label: String, desc: String = label, accent: Boolean = false, onClick: () -> Unit): LinearLayout = LinearLayout(ctx).apply {
        orientation = LinearLayout.HORIZONTAL
        gravity = Gravity.CENTER_VERTICAL
        isFocusable = true
        isClickable = true
        contentDescription = desc
        minimumHeight = dp(44)
        val fill = if (accent) Tokens.ACCENT else Tokens.GLASS
        val stroke = if (accent) Tokens.ACCENT else 0x24FFFFFF
        fun shape(f: Int, s: Int, w: Int) = android.graphics.drawable.InsetDrawable(GradientDrawable().apply {
            cornerRadius = dp(999).toFloat()
            setColor(f)
            setStroke(dp(w), s)
        }, 0, dp(2), 0, dp(2))
        background = StateListDrawable().apply {
            addState(intArrayOf(android.R.attr.state_focused), shape(fill, if (accent) Color.WHITE else Tokens.ACCENT, 2))
            addState(intArrayOf(android.R.attr.state_pressed), shape(if (accent) 0xFFFF7A5C.toInt() else 0x33FFFFFF, stroke, 1))
            addState(intArrayOf(), shape(fill, stroke, 1))
        }
        // Après le fond : un InsetDrawable impose son propre padding (0 à gauche et à droite) et effaçait celui-ci.
        setPadding(dp(14), 0, dp(14), 0)
        val fg = if (accent) Tokens.BG else Tokens.TEXT
        if (res != null) addView(icon(res, 18, fg).apply { (layoutParams as LinearLayout.LayoutParams).marginEnd = dp(8) })
        addView(text(label, 13f, fg, if (accent) 700 else 600))
        setOnClickListener { onClick() }
        layoutParams = LinearLayout.LayoutParams(-2, dp(44)).apply { marginStart = dp(6) }
    }

    /** Pastille de texte (badge) : padding interne, coins arrondis, une seule ligne. */
    fun chip(label: String, fg: Int = Tokens.SOFT, fill: Int = 0x1AFFFFFF, stroke: Int = 0, sizeSp: Float = 12f, weight: Int = 700): TextView =
        text(label, sizeSp, fg, weight).apply {
            maxLines = 1
            gravity = Gravity.CENTER
            setPadding(dp(8), dp(3), dp(8), dp(3))
            background = round(fill, 6f, stroke, if (stroke != 0) 1 else 0)
        }

    companion object {
        /** Emoji dessiné dans une image carrée de `sizePx` (rendu logiciel, glyphe entier et centré). */
        fun emojiBitmap(emoji: String, sizePx: Int): android.graphics.Bitmap {
            val size = sizePx.coerceAtLeast(8)
            val paint = android.text.TextPaint(android.graphics.Paint.ANTI_ALIAS_FLAG).apply { textSize = size * 0.78f }
            val w = paint.measureText(emoji)
            // Réduit si une séquence (drapeau, famille) est plus large que le carré.
            if (w > size * 0.92f) paint.textSize = paint.textSize * size * 0.92f / w
            val fm = paint.fontMetrics
            val bmp = android.graphics.Bitmap.createBitmap(size, size, android.graphics.Bitmap.Config.ARGB_8888)
            val x = (size - paint.measureText(emoji)) / 2f
            val y = size / 2f - (fm.ascent + fm.descent) / 2f
            android.graphics.Canvas(bmp).drawText(emoji, x, y, paint)
            return bmp
        }
    }

    fun spacer(wDp: Int = 0, hDp: Int = 0): View = View(ctx).apply { layoutParams = LinearLayout.LayoutParams(dp(wDp), dp(hDp)) }
}

/** Rangée qui passe à la ligne quand la place manque (badges d'une carte de source). Espacements en pixels. */
class FlowRow(ctx: Context, private val hGap: Int, private val vGap: Int) : android.view.ViewGroup(ctx) {
    override fun onMeasure(widthMeasureSpec: Int, heightMeasureSpec: Int) {
        val maxW = MeasureSpec.getSize(widthMeasureSpec) - paddingLeft - paddingRight
        val unbounded = MeasureSpec.getMode(widthMeasureSpec) == MeasureSpec.UNSPECIFIED
        var x = 0
        var y = 0
        var lineH = 0
        var widest = 0
        for (i in 0 until childCount) {
            val c = getChildAt(i)
            if (c.visibility == View.GONE) continue
            c.measure(MeasureSpec.makeMeasureSpec(if (unbounded) 0 else maxW, if (unbounded) MeasureSpec.UNSPECIFIED else MeasureSpec.AT_MOST), MeasureSpec.makeMeasureSpec(0, MeasureSpec.UNSPECIFIED))
            if (x > 0 && !unbounded && x + c.measuredWidth > maxW) { x = 0; y += lineH + vGap; lineH = 0 }
            x += c.measuredWidth + hGap
            widest = maxOf(widest, x - hGap)
            lineH = maxOf(lineH, c.measuredHeight)
        }
        val w = if (unbounded) widest + paddingLeft + paddingRight else MeasureSpec.getSize(widthMeasureSpec)
        setMeasuredDimension(w, y + lineH + paddingTop + paddingBottom)
    }

    override fun onLayout(changed: Boolean, l: Int, t: Int, r: Int, b: Int) {
        val maxW = r - l - paddingLeft - paddingRight
        var x = 0
        var y = 0
        var lineH = 0
        for (i in 0 until childCount) {
            val c = getChildAt(i)
            if (c.visibility == View.GONE) continue
            if (x > 0 && x + c.measuredWidth > maxW) { x = 0; y += lineH + vGap; lineH = 0 }
            // Centrage vertical dans la ligne : badges de hauteurs différentes (qualité plus grande).
            c.layout(paddingLeft + x, paddingTop + y, paddingLeft + x + c.measuredWidth, paddingTop + y + c.measuredHeight)
            x += c.measuredWidth + hGap
            lineH = maxOf(lineH, c.measuredHeight)
        }
    }
}
