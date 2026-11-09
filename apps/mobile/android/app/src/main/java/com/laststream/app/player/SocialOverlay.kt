package com.laststream.app.player

import android.content.Context
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
 * Couche sociale du lecteur plein écran (maquette LAST-1628) : pastille du salon en haut à gauche (avatars, nombre),
 * éventail d'emojis ouvert par la pilule « Réagir », pastilles et carte de chaleur sur la barre, bulle de message en carte
 * avec réponses rapides, emoji flottant avec le pseudo. N'affiche que : le réseau reste côté JS (évènements `react` / `reply`).
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
    /** L'état social a changé (activation, emojis) : la pilule « Réagir » se met à jour. */
    private val onChanged: () -> Unit = {},
) {
    private val handler = Handler(Looper.getMainLooper())
    private val bubbles = BubbleQueue()
    private var lastReactAt: Long? = null
    private var moreOpen = false
    private var renderedQuick: List<String>? = null
    private var renderedMore: List<String>? = null
    private val seenNotes = HashSet<String>()
    private var notesSeeded = false
    private var suppressed = false
    private var controlsShown = false

    var fanOpen = false
        private set

    private val quickRow = pill()
    private val moreRow = pill().apply { visibility = View.GONE }
    private val moreScroll = HorizontalScrollView(ctx).apply { isHorizontalScrollBarEnabled = false; visibility = View.GONE; addView(moreRow) }
    private val fan = LinearLayout(ctx).apply {
        orientation = LinearLayout.VERTICAL
        gravity = Gravity.END
        visibility = View.GONE
        contentDescription = "Réagir"
        addView(moreScroll, LinearLayout.LayoutParams(-2, -2).apply { bottomMargin = kit.dp(8) })
        addView(quickRow, LinearLayout.LayoutParams(-2, -2))
    }
    private val avatars = LinearLayout(ctx).apply { orientation = LinearLayout.HORIZONTAL; gravity = Gravity.CENTER_VERTICAL }
    private val countLabel = kit.text("", 13f, Tokens.TEXT, 700, sora = true)
    private val roomPill = LinearLayout(ctx).apply {
        orientation = LinearLayout.HORIZONTAL
        gravity = Gravity.CENTER_VERTICAL
        visibility = View.GONE
        minimumHeight = kit.dp(44)
        setPadding(kit.dp(6), kit.dp(4), kit.dp(12), kit.dp(4))
        background = kit.round(Tokens.CARD_SOFT, 14f, Tokens.BORDER, 1)
        addView(avatars)
        addView(countLabel, LinearLayout.LayoutParams(-2, -2).apply { marginStart = kit.dp(10) })
    }
    private val bubbleBox = LinearLayout(ctx).apply { orientation = LinearLayout.VERTICAL; visibility = View.GONE }
    private val expire = Runnable { renderBubbles() }

    /** Réagir est possible : social actif et au moins un emoji proposé. */
    val reactAvailable: Boolean get() = PlayerHub.social.enabled && PlayerHub.social.quick.isNotEmpty()

    init {
        // Sous la barre haute (≈ 58 dp), à gauche : les boutons réduire / PiP / réglages restent libres.
        controls.addView(roomPill, FrameLayout.LayoutParams(-2, -2, Gravity.TOP or Gravity.START).apply { topMargin = kit.dp(72); leftMargin = kit.dp(24) })
        // Au-dessus de la barre basse, côté droit, sous la pilule « Réagir ».
        controls.addView(fan, FrameLayout.LayoutParams(-2, -2, Gravity.BOTTOM or Gravity.END).apply { bottomMargin = kit.dp(124); rightMargin = kit.dp(24) })
        ui.addView(bubbleBox, FrameLayout.LayoutParams(kit.dp(300), -2, Gravity.TOP or Gravity.START).apply { topMargin = kit.dp(24); leftMargin = kit.dp(24) })
        scrubber.onMarkerTap = { m -> seek(m.pos); interact() }
        refresh()
    }

    private fun pill() = LinearLayout(ctx).apply {
        orientation = LinearLayout.HORIZONTAL
        gravity = Gravity.CENTER_VERTICAL
        setPadding(kit.dp(8), kit.dp(8), kit.dp(8), kit.dp(8))
        background = kit.round(Tokens.CARD, 999f, Tokens.BORDER, 1)
        elevation = kit.dp(12).toFloat()
    }

    private fun emojiButton(e: String, label: String = e, sizeSp: Float = 22f, onClick: () -> Unit) = TextView(ctx).apply {
        text = e
        setTextSize(TypedValue.COMPLEX_UNIT_SP, sizeSp)
        gravity = Gravity.CENTER
        isFocusable = true
        isClickable = true
        contentDescription = label
        includeFontPadding = false
        background = kit.focusBackground(22f, 0x0FFFFFFF)
        layoutParams = LinearLayout.LayoutParams(kit.dp(44), kit.dp(44)).apply { marginStart = kit.dp(3); marginEnd = kit.dp(3) }
        setOnClickListener { onClick() }
    }

    /** Relit l'état social (activation, emojis, spectateurs, notes) et met l'affichage à jour. */
    fun refresh() {
        val s = PlayerHub.social
        if (!s.enabled) {
            fan.visibility = View.GONE
            fanOpen = false
            roomPill.visibility = View.GONE
            bubbleBox.visibility = View.GONE
            bubbles.clear()
            moreOpen = false
            renderedQuick = null
            renderedMore = null
            seenNotes.clear()
            notesSeeded = false
            scrubber.setMarkers(emptyList())
            scrubber.setHeat(FloatArray(0))
            onChanged()
            return
        }
        // Les rangées ne sont reconstruites que si les listes changent : le focus D-pad survit aux mises à jour de notes.
        if (s.quick != renderedQuick || s.more != renderedMore) {
            renderedQuick = s.quick
            renderedMore = s.more
            quickRow.removeAllViews()
            s.quick.forEach { e -> quickRow.addView(emojiButton(e, "Réagir $e") { react(e) }) }
            if (s.more.isNotEmpty()) {
                quickRow.addView(TextView(ctx).apply {
                    text = "+"
                    gravity = Gravity.CENTER
                    setTextColor(Tokens.TEXT)
                    setTextSize(TypedValue.COMPLEX_UNIT_SP, 20f)
                    typeface = kit.title(700)
                    includeFontPadding = false
                    isFocusable = true
                    isClickable = true
                    contentDescription = "Plus de réactions"
                    background = kit.focusBackground(22f)
                    foreground = kit.round(0x00000000, 22f, Tokens.BORDER, 1)
                    layoutParams = LinearLayout.LayoutParams(kit.dp(44), kit.dp(44)).apply { marginStart = kit.dp(3) }
                    setOnClickListener { toggleMore() }
                })
            } else moreOpen = false
            moreRow.removeAllViews()
            s.more.forEach { e -> moreRow.addView(emojiButton(e, "Réagir $e") { react(e) }) }
            applyMore()
        }
        if (s.quick.isEmpty()) { fanOpen = false }
        fan.visibility = if (fanOpen) View.VISIBLE else View.GONE
        renderRoom(s.viewers)
        refreshMarkers()
        renderBubbles()
        onChanged()
    }

    /** Mise à jour des marqueurs, de la carte de chaleur et des réactions des autres membres (nouvelles notes, durée connue). */
    fun refreshMarkers() {
        val s = PlayerHub.social
        if (!s.enabled) {
            scrubber.setMarkers(emptyList())
            scrubber.setHeat(FloatArray(0))
            return
        }
        val dur = duration()
        scrubber.setMarkers(SocialLogic.groupMarkers(s.notes, dur))
        scrubber.setHeat(PlayerUiLogic.heatBins(s.notes.map { it.pos }, dur))
        // Premier relevé : l'historique ne flotte pas, seules les réactions arrivées ensuite le font.
        if (notesSeeded) {
            PlayerUiLogic.freshReactions(s.notes, seenNotes, position()).take(3).forEach { n -> floatEmoji(n.body, n.by?.name?.ifBlank { null } ?: "?") }
        }
        notesSeeded = true
        s.notes.forEach { if (it.id.isNotEmpty()) seenNotes.add(it.id) }
    }

    /** Pilule « Réagir » : ouvre ou ferme l'éventail d'emojis. */
    fun toggleFan() {
        if (!reactAvailable) return
        fanOpen = !fanOpen
        if (!fanOpen && moreOpen) { moreOpen = false; applyMore() }
        fan.visibility = if (fanOpen) View.VISIBLE else View.GONE
        if (fanOpen) quickRow.getChildAt(0)?.requestFocus()
        interact()
    }

    fun closeFan() {
        if (!fanOpen) return
        fanOpen = false
        moreOpen = false
        applyMore()
        fan.visibility = View.GONE
    }

    /** Contrôles visibles : la bulle descend sous la pastille du salon pour ne pas masquer la barre haute. */
    fun setControlsVisible(v: Boolean) {
        controlsShown = v
        (bubbleBox.layoutParams as FrameLayout.LayoutParams).apply {
            topMargin = kit.dp(if (v) 128 else 24)
            leftMargin = kit.dp(if (v) 80 else 24) // à droite du bouton verrou (24 + 44 dp)
        }
        bubbleBox.requestLayout()
        if (!v) closeFan()
    }

    /** Écran verrouillé : bulles et emojis flottants masqués. */
    fun setSuppressed(v: Boolean) {
        suppressed = v
        renderBubbles()
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
        floatEmoji(emoji, "Vous")
        if (moreOpen) { moreOpen = false; applyMore() }
    }

    private var floatSlot = 0

    /** Grand emoji avec le pseudo, qui monte puis s'efface (maquette « Réactions »). */
    private fun floatEmoji(emoji: String, who: String) {
        if (suppressed) return
        val slot = floatSlot++ % 3
        val box = LinearLayout(ctx).apply {
            orientation = LinearLayout.VERTICAL
            gravity = Gravity.CENTER_HORIZONTAL
            importantForAccessibility = View.IMPORTANT_FOR_ACCESSIBILITY_NO
            addView(TextView(ctx).apply {
                text = emoji
                setTextSize(TypedValue.COMPLEX_UNIT_SP, if (slot == 0) 64f else 48f)
                includeFontPadding = false
            })
            addView(kit.text(who, 12f, Tokens.TEXT, 700, sora = true).apply {
                maxLines = 1
                ellipsize = TextUtils.TruncateAt.END
                setPadding(kit.dp(10), kit.dp(4), kit.dp(10), kit.dp(4))
                background = kit.round(0xB30C0B11.toInt(), 999f)
            }, LinearLayout.LayoutParams(-2, -2).apply { topMargin = kit.dp(6) })
        }
        val right = intArrayOf(120, 260, 190)[slot]
        val top = intArrayOf(70, 140, 100)[slot]
        ui.addView(box, FrameLayout.LayoutParams(-2, -2, Gravity.TOP or Gravity.END).apply { rightMargin = kit.dp(right); topMargin = kit.dp(top) })
        box.alpha = 0f
        box.animate().alpha(1f).setDuration(180).withEndAction {
            box.animate().translationY(-kit.dp(70).toFloat()).alpha(0f).setStartDelay(500).setDuration(1300).withEndAction { ui.removeView(box) }.start()
        }.start()
    }

    private fun avatar(label: String, fill: Int, sizeDp: Int, textSp: Float, first: Boolean, overlap: Boolean) = TextView(ctx).apply {
        text = label
        gravity = Gravity.CENTER
        setTextColor(Tokens.BG)
        setTextSize(TypedValue.COMPLEX_UNIT_SP, textSp)
        typeface = kit.title(800)
        includeFontPadding = false
        background = GradientDrawable().apply { cornerRadius = kit.dp(sizeDp) * 0.28f; setColor(fill); if (overlap) setStroke(kit.dp(2), 0xFF17151F.toInt()) }
        layoutParams = LinearLayout.LayoutParams(kit.dp(sizeDp), kit.dp(sizeDp)).apply { if (!first) marginStart = -kit.dp(6) }
    }

    private fun renderRoom(viewers: List<SocialViewer>) {
        avatars.removeAllViews()
        if (viewers.isEmpty()) { roomPill.visibility = View.GONE; return }
        val (shown, extra) = SocialLogic.avatarSplit(viewers)
        shown.forEachIndexed { i, v ->
            avatars.addView(avatar(SocialLogic.initials(v), PlayerUiLogic.avatarColor(v.id), 30, 12f, i == 0, true).apply { contentDescription = v.name })
        }
        if (extra > 0) avatars.addView(avatar("+$extra", Tokens.SECONDARY, 30, 11f, false, true))
        countLabel.text = PlayerUiLogic.viewersLabel(viewers.size)
        roomPill.contentDescription = PlayerUiLogic.viewersLabel(viewers.size) + " : " + viewers.joinToString(", ") { it.name }
        roomPill.visibility = View.VISIBLE
    }

    /** Nouveau message : carte en haut à gauche (6 s, 3 au plus). Ignoré si le social est désactivé. */
    fun pushMessage(m: SocialMessage) {
        if (!PlayerHub.social.enabled) return
        if (bubbles.push(m, SystemClock.elapsedRealtime())) renderBubbles()
    }

    private fun renderBubbles() {
        handler.removeCallbacks(expire)
        val now = SystemClock.elapsedRealtime()
        val list = bubbles.active(now)
        bubbleBox.removeAllViews()
        if (list.isEmpty() || !PlayerHub.social.enabled || suppressed) { bubbleBox.visibility = View.GONE; if (list.isNotEmpty()) armExpiry(now); return }
        list.forEach { bubbleBox.addView(bubbleView(it), LinearLayout.LayoutParams(-1, -2).apply { bottomMargin = kit.dp(8) }) }
        bubbleBox.visibility = View.VISIBLE
        armExpiry(now)
    }

    private fun armExpiry(now: Long) {
        handler.removeCallbacks(expire)
        bubbles.nextExpiry()?.let { handler.postDelayed(expire, (it - now).coerceAtLeast(50)) }
    }

    private fun bubbleView(m: SocialMessage): View {
        val name = m.from.name.ifBlank { "?" }
        val head = LinearLayout(ctx).apply { orientation = LinearLayout.HORIZONTAL; gravity = Gravity.TOP }
        head.addView(avatar(SocialLogic.initials(m.from).take(1), PlayerUiLogic.avatarColor(m.from.id), 38, 16f, true, false).apply { importantForAccessibility = View.IMPORTANT_FOR_ACCESSIBILITY_NO })
        val texts = LinearLayout(ctx).apply { orientation = LinearLayout.VERTICAL; setPadding(kit.dp(10), 0, 0, 0) }
        texts.addView(kit.text(name, 14f, Tokens.TEXT, 800, sora = true).apply { maxLines = 1; ellipsize = TextUtils.TruncateAt.END })
        texts.addView(kit.text(m.body, 15f, Tokens.TEXT, 500).apply { maxLines = 3; ellipsize = TextUtils.TruncateAt.END; setPadding(0, kit.dp(3), 0, 0); setLineSpacing(0f, 1.15f) })
        head.addView(texts, LinearLayout.LayoutParams(0, -2, 1f))
        val replies = LinearLayout(ctx).apply { orientation = LinearLayout.HORIZONTAL; setPadding(0, kit.dp(10), 0, 0) }
        SocialLogic.REPLY_EMOJIS.forEach { e ->
            replies.addView(emojiButton(e, "Répondre $e à $name", 20f) {
                if (SocialLogic.isReplyEmoji(e)) PlayerHub.emit("reply", JSObject().put("messageId", m.id).put("emoji", e))
                bubbles.remove(m.id)
                renderBubbles()
            }.apply { (layoutParams as LinearLayout.LayoutParams).apply { marginStart = 0; marginEnd = kit.dp(8) } })
        }
        return LinearLayout(ctx).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(kit.dp(12), kit.dp(12), kit.dp(12), kit.dp(12))
            background = kit.round(Tokens.CARD, 14f, Tokens.BORDER, 1)
            addView(head)
            addView(replies)
        }
    }

    fun destroy() {
        handler.removeCallbacksAndMessages(null)
        scrubber.onMarkerTap = null
    }
}
