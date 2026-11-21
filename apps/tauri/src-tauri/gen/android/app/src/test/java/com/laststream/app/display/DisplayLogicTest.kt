package com.laststream.app.display

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class DisplayLogicTest {
    private fun o(w: Int, h: Int) = DisplayLogic.Output(w, h)

    @Test fun tvBoxOutputsFourKWhileUiIs1080p() {
        assertEquals(o(3840, 2160), DisplayLogic.best(o(3840, 2160), o(1920, 1080)))
    }

    @Test fun orderDoesNotMatter() {
        assertEquals(o(3840, 2160), DisplayLogic.best(o(1920, 1080), o(3840, 2160)))
    }

    @Test fun portraitUsesShortSide() {
        assertEquals(1440, o(1440, 3120).shortSide)
        assertEquals(o(1440, 3120), DisplayLogic.best(o(1080, 2400), o(1440, 3120)))
    }

    @Test fun invalidOrMissingSizesAreIgnored() {
        assertEquals(o(1920, 1080), DisplayLogic.best(o(0, 0), null, o(1920, 1080)))
        assertNull(DisplayLogic.best(null, o(0, 1080), o(-1, -1)))
        assertNull(DisplayLogic.best())
    }
}
