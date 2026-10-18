package com.laststream.app.player

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class MiniLogicTest {
    private val d = 2f

    @Test fun widthPortraitAndLandscape() {
        assertEquals(432, MiniLogic.width(1080, 2200, d)) // 40 %
        assertEquals(605, MiniLogic.width(2160, 1080, d)) // 28 %
    }

    @Test fun widthIsClamped() {
        assertEquals(300, MiniLogic.width(400, 800, d)) // 150 dp minimum
        assertEquals(960, MiniLogic.width(4000, 6000, d)) // 480 dp maximum
    }

    @Test fun heightIs16by9() {
        assertEquals(243, MiniLogic.height(432))
    }

    @Test fun bottomRightKeepsMarginAndTabbar() {
        val b = MiniLogic.box(MiniCorner.BR, 1080, 2200, d)
        assertEquals(1080 - 32 - 432, b.x)
        assertEquals(2200 - 32 - 144 - 243, b.y) // marge 16 dp + barre d'onglets 72 dp
    }

    @Test fun noTabbarReserveOnWideScreens() {
        assertEquals(0, MiniLogic.bottomReserve(2160, d)) // 1080 dp de large
        val b = MiniLogic.box(MiniCorner.BR, 2160, 1080, d)
        assertEquals(1080 - 32 - MiniLogic.height(b.w), b.y)
    }

    @Test fun topCorners() {
        val tl = MiniLogic.box(MiniCorner.TL, 1080, 2200, d)
        assertEquals(32, tl.x); assertEquals(32, tl.y)
        val tr = MiniLogic.box(MiniCorner.TR, 1080, 2200, d)
        assertEquals(1080 - 32 - tr.w, tr.x); assertEquals(32, tr.y)
    }

    @Test fun snapToNearestCorner() {
        assertEquals(MiniCorner.TL, MiniLogic.snap(100f, 100f, 1000, 2000))
        assertEquals(MiniCorner.TR, MiniLogic.snap(900f, 400f, 1000, 2000))
        assertEquals(MiniCorner.BL, MiniLogic.snap(200f, 1800f, 1000, 2000))
        assertEquals(MiniCorner.BR, MiniLogic.snap(600f, 1200f, 1000, 2000))
    }

    @Test fun clampKeepsBoxInside() {
        assertEquals(0f to 0f, MiniLogic.clamp(-50f, -9f, 400, 225, 1000, 2000))
        assertEquals(600f to 1775f, MiniLogic.clamp(900f, 2100f, 400, 225, 1000, 2000))
    }

    @Test fun minimizeSwipe() {
        assertTrue(MiniLogic.isMinimizeSwipe(10f, 300f, 2000f, d))
        assertFalse(MiniLogic.isMinimizeSwipe(300f, 200f, 2000f, d)) // trop oblique
        assertFalse(MiniLogic.isMinimizeSwipe(0f, 60f, 2000f, d)) // trop court
        assertFalse(MiniLogic.isMinimizeSwipe(0f, 300f, 300f, d)) // trop lent
    }

    @Test fun cornerParse() {
        assertEquals(MiniCorner.TL, MiniCorner.parse("tl"))
        assertEquals(MiniCorner.BR, MiniCorner.parse("zz"))
        assertEquals(MiniCorner.BR, MiniCorner.parse(null))
    }

    @Test fun progress() {
        assertEquals(0.5f, MiniLogic.progress(50.0, 100.0), 0.0001f)
        assertEquals(0f, MiniLogic.progress(5.0, 0.0), 0f)
        assertEquals(1f, MiniLogic.progress(500.0, 100.0), 0f)
    }

    @Test fun machineTransitions() {
        val m = MiniMachine()
        assertFalse(m.minimize())
        assertTrue(m.open()); assertFalse(m.open())
        assertTrue(m.minimize()); assertFalse(m.minimize())
        assertTrue(m.expand()); assertFalse(m.expand())
        assertTrue(m.minimize())
        assertTrue(m.close()); assertEquals(MiniMachine.Mode.CLOSED, m.mode)
        assertFalse(m.close())
    }
}
