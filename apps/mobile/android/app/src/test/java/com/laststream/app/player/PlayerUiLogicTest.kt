package com.laststream.app.player

import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class PlayerUiLogicTest {
    @Test fun autoHideOnlyWhilePlayingWithoutPanel() {
        assertTrue(PlayerUiLogic.shouldAutoHide(visible = true, playing = true, panelOpen = false, scrubbing = false))
        assertFalse(PlayerUiLogic.shouldAutoHide(visible = true, playing = false, panelOpen = false, scrubbing = false))
        assertFalse(PlayerUiLogic.shouldAutoHide(visible = true, playing = true, panelOpen = true, scrubbing = false))
        assertFalse(PlayerUiLogic.shouldAutoHide(visible = true, playing = true, panelOpen = false, scrubbing = true))
        assertFalse(PlayerUiLogic.shouldAutoHide(visible = false, playing = true, panelOpen = false, scrubbing = false))
        assertFalse(PlayerUiLogic.shouldAutoHide(visible = true, playing = true, panelOpen = false, scrubbing = false, fanOpen = true))
        assertEquals(4000L, PlayerUiLogic.AUTO_HIDE_MS)
    }

    @Test fun doubleTapZones() {
        assertEquals(-1, PlayerUiLogic.doubleTapDirection(0.1f))
        assertEquals(-1, PlayerUiLogic.doubleTapDirection(0.34f))
        assertEquals(0, PlayerUiLogic.doubleTapDirection(0.5f))
        assertEquals(1, PlayerUiLogic.doubleTapDirection(0.66f))
        assertEquals(1, PlayerUiLogic.doubleTapDirection(0.99f))
    }

    @Test fun dragKindByStartZone() {
        assertEquals(DragKind.MINIMIZE, PlayerUiLogic.dragKind(0.2f, 0.1f))
        assertEquals(DragKind.MINIMIZE, PlayerUiLogic.dragKind(0.8f, 0.2f))
        assertEquals(DragKind.BRIGHTNESS, PlayerUiLogic.dragKind(0.2f, 0.5f))
        assertEquals(DragKind.VOLUME, PlayerUiLogic.dragKind(0.7f, 0.5f))
        assertEquals(DragKind.NONE, PlayerUiLogic.dragKind(0.7f, 0.95f))
    }

    @Test fun verticalDragNeedsSlopAndDirection() {
        assertTrue(PlayerUiLogic.isVerticalDrag(5f, 40f, 20f))
        assertTrue(PlayerUiLogic.isVerticalDrag(0f, -40f, 20f))
        assertFalse(PlayerUiLogic.isVerticalDrag(5f, 10f, 20f))
        assertFalse(PlayerUiLogic.isVerticalDrag(40f, 42f, 20f))
    }

    @Test fun dragLevelUpRaisesDownLowersAndClamps() {
        // 600 px de haut : 360 px parcourent toute la plage.
        assertEquals(0.75f, PlayerUiLogic.dragLevel(0.5f, -90f, 600f), 0.001f)
        assertEquals(0.25f, PlayerUiLogic.dragLevel(0.5f, 90f, 600f), 0.001f)
        assertEquals(1f, PlayerUiLogic.dragLevel(0.9f, -600f, 600f), 0.001f)
        assertEquals(0f, PlayerUiLogic.dragLevel(0.1f, 600f, 600f), 0.001f)
        assertEquals(0.4f, PlayerUiLogic.dragLevel(0.4f, 50f, 0f), 0.001f)
    }

    @Test fun volumeMapping() {
        assertEquals(0, PlayerUiLogic.volumeIndex(0f, 15))
        assertEquals(15, PlayerUiLogic.volumeIndex(1f, 15))
        assertEquals(8, PlayerUiLogic.volumeIndex(0.5f, 15))
        assertEquals(15, PlayerUiLogic.volumeIndex(1.4f, 15))
        assertEquals(0, PlayerUiLogic.volumeIndex(0.5f, 0))
        assertEquals(0.4f, PlayerUiLogic.volumeLevel(6, 15), 0.001f)
        assertEquals(0f, PlayerUiLogic.volumeLevel(3, 0), 0.001f)
    }

    @Test fun brightness() {
        assertEquals(0.3f, PlayerUiLogic.startBrightness(0.3f, 200), 0.001f)
        assertEquals(1f, PlayerUiLogic.startBrightness(-1f, 255), 0.001f)
        assertEquals(0.5f, PlayerUiLogic.startBrightness(-1f, null), 0.001f)
        assertEquals(0.01f, PlayerUiLogic.windowBrightness(0f), 0.0001f)
        assertEquals(0.64f, PlayerUiLogic.windowBrightness(0.64f), 0.0001f)
    }

    @Test fun labels() {
        assertEquals("64 %", PlayerUiLogic.percentLabel(0.64f))
        assertEquals("100 %", PlayerUiLogic.percentLabel(2f))
        assertEquals("24:13 / 52:40", PlayerUiLogic.timeLabel(1453.0, 3160.0))
        assertEquals("3 avec vous", PlayerUiLogic.viewersLabel(3))
    }

    @Test fun pillsFollowAvailability() {
        assertEquals(listOf(Pill.TRACKS), PlayerUiLogic.pills(react = false, hasEpisodes = false, hasSources = false, hasNext = false))
        assertEquals(
            listOf(Pill.REACT, Pill.EPISODES, Pill.TRACKS, Pill.SOURCES, Pill.NEXT),
            PlayerUiLogic.pills(react = true, hasEpisodes = true, hasSources = true, hasNext = true),
        )
        assertEquals(listOf(Pill.TRACKS, Pill.NEXT), PlayerUiLogic.pills(react = false, hasEpisodes = false, hasSources = false, hasNext = true))
    }

    @Test fun countdownFillsFromCreditsToEnd() {
        assertEquals(0f, PlayerUiLogic.countdownFraction(100.0, null, 3000.0), 0.001f)
        assertEquals(0f, PlayerUiLogic.countdownFraction(2800.0, 2900.0, 3000.0), 0.001f)
        assertEquals(0.5f, PlayerUiLogic.countdownFraction(2950.0, 2900.0, 3000.0), 0.001f)
        assertEquals(1f, PlayerUiLogic.countdownFraction(3100.0, 2900.0, 3000.0), 0.001f)
        assertEquals(0f, PlayerUiLogic.countdownFraction(10.0, 3000.0, 3000.0), 0.001f)
    }

    @Test fun heatBinsNormalised() {
        val bins = PlayerUiLogic.heatBins(listOf(0.0, 10.0, 10.5, 99.0, 100.0, 150.0, -1.0), 100.0, 4)
        assertArrayEquals(floatArrayOf(1f, 0f, 0f, 2f / 3f), bins, 0.001f)
        assertArrayEquals(FloatArray(4), PlayerUiLogic.heatBins(listOf(5.0), 0.0, 4), 0f)
        assertEquals(0, PlayerUiLogic.heatBins(listOf(5.0), 10.0, 0).size)
    }

    @Test fun avatarColorIsStable() {
        assertEquals(PlayerUiLogic.avatarColor("lea"), PlayerUiLogic.avatarColor("lea"))
        PlayerUiLogic.avatarColor("") // pas d'exception pour un identifiant vide
    }

    @Test fun freshReactionsOnlyOthersNearPosition() {
        val other = SocialViewer("2", "Léa")
        val notes = listOf(
            SocialNote("a", 100.0, "emoji", "🔥", other, false),
            SocialNote("b", 105.0, "emoji", "😂", null, true),
            SocialNote("c", 300.0, "emoji", "😱", other, false),
            SocialNote("d", 98.0, "text", "salut", other, false),
            SocialNote("e", 101.0, "emoji", "👏", other, false),
            SocialNote("", 101.0, "emoji", "❤️", other, false),
        )
        val fresh = PlayerUiLogic.freshReactions(notes, setOf("e"), 102.0)
        assertEquals(listOf("a"), fresh.map { it.id })
    }

    @Test fun creditsSkipGoesToPostCreditsWhenAhead() {
        val credits = SkipSegment("credits", 2900.0, 3000.0)
        val post = SkipSegment("postcredits", 2950.0, 2990.0)
        assertEquals(2950.0, PlayerUiLogic.creditsSkipTarget(listOf(credits, post), 2910.0)!!, 0.0)
        assertEquals(null, PlayerUiLogic.creditsSkipTarget(listOf(credits, post), 2960.0))
        assertEquals(null, PlayerUiLogic.creditsSkipTarget(listOf(credits), 2910.0))
    }

    @Test fun panelWidthBounded() {
        assertEquals(460, PlayerUiLogic.panelWidth(800, 460))
        assertEquals(360, PlayerUiLogic.panelWidth(360, 460))
        assertEquals(0, PlayerUiLogic.panelWidth(-5, 460))
    }

    @Test fun nextCardWidthFollowsUsableWidth() {
        // Large écran : la carte garde sa largeur maximale.
        assertEquals(520, PlayerUiLogic.nextCardWidth(1200, 232, 520, 240))
        // Encoche : la largeur utile (sans les marges d'encoche) réduit la carte, plus de débordement à droite.
        assertEquals(700 - 232, PlayerUiLogic.nextCardWidth(700, 232, 520, 240))
        // Très étroit : au moins le minimum, jamais plus que la place utile.
        assertEquals(240, PlayerUiLogic.nextCardWidth(400, 232, 520, 240))
        assertEquals(200, PlayerUiLogic.nextCardWidth(200, 232, 520, 240))
        assertEquals(0, PlayerUiLogic.nextCardWidth(-10, 232, 520, 240))
    }
}
