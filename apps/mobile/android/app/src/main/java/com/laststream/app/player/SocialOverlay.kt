package com.laststream.app.player

import android.content.Context
import android.graphics.Color
import android.graphics.drawable.GradientDrawable
import android.os.Handler
import android.os.Looper
import android.os.SystemClock
import android.text.TextUtils
import android.util.TypedValue
import android.view.Gravity
import android.view.View
import android.widget.FrameLayout
import android.widget.HorizontalScrollView
import android.widget.LinearLayout
import android.widget.TextView
import com.getcapacitor.JSObject

/**
 * Couche sociale « Dock » du lecteur plein écran : rangée d'emojis au-dessus de la barre, marqueurs sur la barre, bulle de
 * message en haut à gauche, avatars en haut à droite. N'affiche que : le réseau reste côté JS (évènements `react` / `reply`).
 * Tant que `setSocial` n'a pas activé le social, rien n'est visible.
 */
class SocialOverlay(
    private val ctx: Context,
    private val kit: UiKit,
    private val ui: FrameLayout,
    private val controls: FrameLayout,
    private val scrubber: ScrubberView,
    private val position: () -> Double,
    private val duration: () -> Double,
    private val seek: (Double) -> Unit,
    private val interact: () -> Unit,
) {
    private val handler = Handler(Looper.getMainLooper())
    private val bubbles = BubbleQueue()
    private var lastReactAt: Long? = null
    private var moreOpen = false
    private var renderedQuick: List<String>? = null
    private var renderedMore: List<String>? = null

    private val quickRow = pill()
    private val moreRow = pill().apply { visibility = View.GONE }
    private val moreScroll = HorizontalScrollView(ctx).apply { isHorizontalScrollBarEnabled = false; visibility = View.GONE; addView(moreRow) }
    private val dock = LinearLayout(ctx).apply {
        orientation = LinearLayout.VERTICAL
        gravity = Gravity.CENTER_HORIZONTAL
        visibility = View.GONE
        addView(moreScroll, LinearLayout.LayoutParams(-2, -2).apply { bottomMargin = kit.dp(8) })
        addView(quickRow, LinearLayout.LayoutParams(-2, -2))
    }
    private val avatars = LinearLayout(ctx).apply { orientation = LinearLayout.HORIZONTAL; gravity = Gravity.CENTER_VERTICAL; visibility = View.GONE }
    private val bubbleBox = LinearLayout(ctx).apply { orientation = LinearLayout.VERTICAL; visibility = View.GONE }
    private val expire = Runnable { renderBubbles() }

    init {
        // Au-dessus de la barre basse (≈ 150 dp avec les marqueurs), centré, dans `controls` : il suit leur affichage.
        controls.addView(dock, FrameLayout.LayoutParams(-2, -2, Gravity.BOTTOM or Gravity.CENTER_HORIZONTAL).apply { bottomMargin = kit.dp(158) })
        // Sous la barre haute (≈ 92 dp), côté droit : les boutons réduire / PiP / réglages restent libres.
        controls.addView(avatars, FrameLayout.LayoutParams(-2, -2, Gravity.TOP or Gravity.END).apply { topMargin = kit.dp(84); rightMargin = kit.dp(24) })
        ui.addView(bubbleBox, FrameLayout.LayoutParams(kit.dp(300), -2, Gravity.TOP or Gravity.START).apply { topMargin = kit.dp(96); leftMargin = kit.dp(24) })
        scrubber.onMarkerTap = { m -> seek(m.pos); interact() }
        refresh()
    }

    private fun pill() = LinearLayout(ctx).apply {
        orientation = LinearLayout.HORIZONTAL
        gravity = Gravity.CENTER_VERTICAL
        setPadding(kit.dp(8), kit.dp(4), kit.dp(8), kit.dp(4))
        background = kit.round(Tokens.SURFACE, 999f, Tokens.LINE, 1)
    }

    private fun emojiButton(e: String, label: String = e, onClick: () -> Unit) = TextView(ctx).apply {
        text = e
        setTextSize(TypedValue.COMPLEX_UNIT_SP, 22f)
        gravity = Gravity.CENTER
        isFocusable = true
        isClickable = true
        contentDescription = label
        includeFontPadding = false
        background = kit.focusBackground(20f)
        layoutParams = LinearLayout.LayoutParams(kit.dp(44), kit.dp(40))
        setOnClickListener { onClick() }
    }

    /** Relit l'état social (activation, emojis, spectateurs, notes) et met l'affichage à jour. */
    fun refresh() {
        val s = PlayerHub.social
        if (!s.enabled) {
            dock.visibility = View.GONE
            avatars.visibility = View.GONE
            bubbleBox.visibility = View.GONE
            bubbles.clear()
            moreOpen = false
            renderedQuick = null
            renderedMore = null
            scrubber.setMarkers(emptyList())
            return
        }
        // Les rangées ne sont reconstruites que si les listes changent : le focus D-pad survit aux mises à jour de notes.
        if (s.quick != renderedQuick || s.more != renderedMore) {
            renderedQuick = s.quick
            renderedMore = s.more
            quickRow.removeAllViews()
            s.quick.forEach { e -> quickRow.addView(emojiButton(e) { react(e) }) }
            if (s.more.isNotEmpty()) {
                quickRow.addView(emojiButton("＋", "Plus d'emojis") { toggleMore() }.apply {
                    setTextColor(Tokens.ACCENT)
                    typeface = kit.title(800)
                })
            } else moreOpen = false
            moreRow.removeAllViews()
            s.more.forEach { e -> moreRow.addView(emojiButton(e) { react(e) }) }
            applyMore()
        }
        dock.visibility = if (s.quick.isEmpty()) View.GONE else View.VISIBLE
        renderAvatars(s.viewers)
        refreshMarkers()
        renderBubbles()
    }

    /** Mise à jour des seuls marqueurs de la barre (nouvelles notes, durée connue). */
    fun refreshMarkers() {
        val s = PlayerHub.social
        scrubber.setMarkers(if (s.enabled) SocialLogic.groupMarkers(s.notes, duration()) else emptyList())
    }

    private fun toggleMore() { moreOpen = !moreOpen; applyMore(); interact() }

    private fun applyMore() {
        val v = if (moreOpen) View.VISIBLE else View.GONE
        moreRow.visibility = v
        moreScroll.visibility = v
    }

    private fun react(emoji: String) {
        interact()
        val now = SystemClock.elapsedRealtime()
        if (!SocialLogic.allowReaction(now, lastReactAt)) return
        lastReactAt = now
        PlayerHub.emit("react", JSObject().put("emoji", emoji).put("pos", position()))
        floatEmoji(emoji)
        if (moreOpen) { moreOpen = false; applyMore() }
    }

    /** Petit emoji qui monte depuis le dock puis s'efface. */
    private fun floatEmoji(emoji: String) {
        val tv = TextView(ctx).apply {
            text = emoji
            setTextSize(TypedValue.COMPLEX_UNIT_SP, 30f)
            includeFontPadding = false
        }
        ui.addView(tv, FrameLayout.LayoutParams(-2, -2, Gravity.BOTTOM or Gravity.CENTER_HORIZONTAL).apply { bottomMargin = kit.dp(170) })
        tv.animate().translationY(-kit.dp(140).toFloat()).alpha(0f).setDuration(1000).withEndAction { ui.removeView(tv) }.start()
    }

    private fun renderAvatars(viewers: List<SocialViewer>) {
        avatars.removeAllViews()
        if (viewers.isEmpty()) { avatars.visibility = View.GONE; return }
        val (shown, extra) = SocialLogic.avatarSplit(viewers)
        fun disc(label: String, fill: Int, textColor: Int, first: Boolean) = TextView(ctx).apply {
            text = label
            gravity = Gravity.CENTER
            setTextColor(textColor)
            setTextSize(TypedValue.COMPLEX_UNIT_SP, 12f)
            typeface = kit.title(800)
            includeFontPadding = false
            background = GradientDrawable().apply { shape = GradientDrawable.OVAL; setColor(fill); setStroke(kit.dp(2), Tokens.BG) }
            layoutParams = LinearLayout.LayoutParams(kit.dp(32), kit.dp(32)).apply { if (!first) marginStart = -kit.dp(8) }
        }
        shown.forEachIndexed { i, v ->
            avatars.addView(disc(SocialLogic.initials(v), Tokens.ACCENT, Color.WHITE, i == 0).apply { contentDescription = v.name })
        }
        if (extra > 0) avatars.addView(disc("+$extra", Tokens.LINE, Tokens.TEXT, false))
        avatars.visibility = View.VISIBLE
    }

    /** Nouveau message : bulle en haut à gauche (6 s, 3 au plus). Ignoré si le social est désactivé. */
    fun pushMessage(m: SocialMessage) {
        if (!PlayerHub.social.enabled) return
        if (bubbles.push(m, SystemClock.elapsedRealtime())) renderBubbles()
    }

    private fun renderBubbles() {
        handler.removeCallbacks(expire)
        val now = SystemClock.elapsedRealtime()
        val list = bubbles.active(now)
        bubbleBox.removeAllViews()
        if (list.isEmpty() || !PlayerHub.social.enabled) { bubbleBox.visibility = View.GONE; return }
        list.forEach { bubbleBox.addView(bubbleView(it), LinearLayout.LayoutParams(-2, -2).apply { bottomMargin = kit.dp(8) }) }
        bubbleBox.visibility = View.VISIBLE
        bubbles.nextExpiry()?.let { handler.postDelayed(expire, (it - now).coerceAtLeast(50)) }
    }

    private fun bubbleView(m: SocialMessage): View {
        val body = LinearLayout(ctx).apply { orientation = LinearLayout.VERTICAL }
        body.addView(kit.text(m.from.name.ifBlank { "?" }, 13f, Tokens.ACCENT, 800, sora = true).apply { maxLines = 1; ellipsize = TextUtils.TruncateAt.END })
        body.addView(kit.text(m.body, 14f, Tokens.TEXT, 600).apply { maxLines = 3; ellipsize = TextUtils.TruncateAt.END; setPadding(0, kit.dp(2), 0, 0) })
        val replies = LinearLayout(ctx).apply { orientation = LinearLayout.HORIZONTAL; setPadding(0, kit.dp(4), 0, 0) }
        SocialLogic.REPLY_EMOJIS.forEach { e ->
            replies.addView(emojiButton(e, "Répondre $e") {
                if (SocialLogic.isReplyEmoji(e)) PlayerHub.emit("reply", JSObject().put("messageId", m.id).put("emoji", e))
                bubbles.remove(m.id)
                renderBubbles()
            }.apply { setTextSize(TypedValue.COMPLEX_UNIT_SP, 18f); layoutParams = LinearLayout.LayoutParams(kit.dp(40), kit.dp(34)) })
        }
        body.addView(replies)
        return LinearLayout(ctx).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(kit.dp(14), kit.dp(10), kit.dp(14), kit.dp(6))
            background = kit.round(Tokens.SURFACE, 16f, Tokens.LINE, 1)
            addView(body)
        }
    }

    fun destroy() {
        handler.removeCallbacksAndMessages(null)
        scrubber.onMarkerTap = null
    }
}
