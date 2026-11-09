package com.laststream.app.player

import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class SocialLogicTest {
    private fun note(pos: Double, body: String = "😂", kind: String = "emoji") = SocialNote("n$pos$body", pos, kind, body, null, false)

    @Test fun groupsNeighboursUnderOnePointFivePercent() {
        // durée 1000 s : 1,5 % = 15 s
        val m = SocialLogic.groupMarkers(listOf(note(100.0), note(110.0), note(114.9), note(300.0)), 1000.0)
        assertEquals(2, m.size)
        assertEquals(3, m[0].count)
        assertEquals(100.0, m[0].pos, 0.0)
        assertEquals(0.1, m[0].fraction, 1e-9)
        assertEquals(1, m[1].count)
    }

    @Test fun gapOfExactlyThresholdSplits() {
        assertEquals(2, SocialLogic.groupMarkers(listOf(note(100.0), note(115.0)), 1000.0).size)
    }

    @Test fun groupDoesNotChainBeyondThreshold() {
        val m = SocialLogic.groupMarkers(listOf(note(100.0), note(110.0), note(120.0)), 1000.0)
        assertEquals(listOf(2, 1), m.map { it.count })
    }

    @Test fun groupEmojiIsMostFrequentThenFirst() {
        val m = SocialLogic.groupMarkers(listOf(note(100.0, "🔥"), note(102.0, "😂"), note(104.0, "😂")), 1000.0)
        assertEquals("😂", m[0].emoji)
        val tie = SocialLogic.groupMarkers(listOf(note(100.0, "🔥"), note(102.0, "😂")), 1000.0)
        assertEquals("🔥", tie[0].emoji)
    }

    @Test fun unsortedInputAndTextNotes() {
        val m = SocialLogic.groupMarkers(listOf(note(500.0, "salut", "text"), note(100.0)), 1000.0)
        assertEquals(listOf(100.0, 500.0), m.map { it.pos })
        assertEquals(SocialLogic.FALLBACK_EMOJI, m[1].emoji)
    }

    @Test fun noDurationOrOutOfRangeGivesNothing() {
        assertTrue(SocialLogic.groupMarkers(listOf(note(10.0)), 0.0).isEmpty())
        assertTrue(SocialLogic.groupMarkers(listOf(note(2000.0)), 1000.0).isEmpty())
        assertTrue(SocialLogic.groupMarkers(emptyList(), 1000.0).isEmpty())
    }

    @Test fun throttleIs600ms() {
        assertTrue(SocialLogic.allowReaction(1000, null))
        assertFalse(SocialLogic.allowReaction(1599, 1000))
        assertTrue(SocialLogic.allowReaction(1600, 1000))
    }

    @Test fun bubbleQueueKeepsThreeNewest() {
        val q = BubbleQueue()
        val v = SocialViewer("1", "Léa")
        (1..4).forEach { q.push(SocialMessage("m$it", v, "b$it"), 0) }
        assertEquals(listOf("m2", "m3", "m4"), q.active(1).map { it.id })
    }

    @Test fun bubbleExpiresAfterSixSeconds() {
        val q = BubbleQueue()
        q.push(SocialMessage("a", SocialViewer("1", "Léa"), "x"), 1000)
        assertEquals(7000L, q.nextExpiry())
        assertEquals(1, q.active(6999).size)
        assertTrue(q.active(7000).isEmpty())
        assertNull(q.nextExpiry())
    }

    @Test fun bubbleDuplicateIdIgnoredAndRemove() {
        val q = BubbleQueue()
        val v = SocialViewer("1", "Léa")
        assertTrue(q.push(SocialMessage("a", v, "x"), 0))
        assertFalse(q.push(SocialMessage("a", v, "y"), 10))
        q.remove("a")
        assertTrue(q.active(20).isEmpty())
    }

    @Test fun avatarsMaxFourPlusOverflow() {
        val vs = (1..7).map { SocialViewer("$it", "N$it") }
        val (shown, extra) = SocialLogic.avatarSplit(vs)
        assertEquals(4, shown.size)
        assertEquals(3, extra)
        assertEquals(0, SocialLogic.avatarSplit(vs.take(2)).second)
    }

    @Test fun initials() {
        assertEquals("L", SocialLogic.initials(SocialViewer("1", "léa")))
        assertEquals("JD", SocialLogic.initials(SocialViewer("1", "Jean Dupont")))
        assertEquals("Z", SocialLogic.initials(SocialViewer("1", "Léa", "z")))
        assertEquals("?", SocialLogic.initials(SocialViewer("1", " ")))
    }

    @Test fun replyEmojisRestricted() {
        assertTrue(SocialLogic.isReplyEmoji("😂"))
        assertTrue(SocialLogic.isReplyEmoji("❤️"))
        assertFalse(SocialLogic.isReplyEmoji("🔥"))
    }

    @Test fun parsesStateNotesAndMessage() {
        val st = SocialLogic.parseState(
            JSONObject("""{"enabled":true,"quick":["😂","🔥"],"more":["👍"],"viewers":[{"id":"a","name":"Léa"},{"id":2,"name":"Max","initial":"M"}]}"""),
            SocialState(),
        )
        assertTrue(st.enabled)
        assertEquals(listOf("😂", "🔥"), st.quick)
        assertEquals(2, st.viewers.size)
        assertEquals("2", st.viewers[1].id)
        val notes = SocialLogic.parseNotes(
            JSONObject("""{"notes":[{"id":"n1","pos":12.5,"kind":"emoji","body":"🔥","by":{"id":"a","name":"Léa"},"mine":true},{"id":"bad","pos":-1}]}""").getJSONArray("notes"),
        )
        assertEquals(1, notes.size)
        assertTrue(notes[0].mine)
        val msg = SocialLogic.parseMessage(JSONObject("""{"id":"m1","from":{"id":"a","name":"Léa"},"body":" salut "}"""))
        assertNotNull(msg)
        assertEquals("salut", msg!!.body)
        assertNull(SocialLogic.parseMessage(JSONObject("""{"id":"m1","body":"x"}""")))
    }

    @Test fun resetOnlyOnFinalClose() {
        assertTrue(SocialLogic.shouldResetOnDestroy(finishing = true, handedOff = false, ownsOverlay = true))
        assertFalse(SocialLogic.shouldResetOnDestroy(finishing = true, handedOff = true, ownsOverlay = true))
        assertFalse(SocialLogic.shouldResetOnDestroy(finishing = false, handedOff = false, ownsOverlay = true))
        assertFalse(SocialLogic.shouldResetOnDestroy(finishing = true, handedOff = false, ownsOverlay = false))
    }

    @Test fun defaultStateIsDisabled() {
        assertFalse(SocialState().enabled)
        assertFalse(SocialLogic.parseState(JSONObject("{}"), SocialState()).enabled)
    }

    // ---------- Salon (LAST-1632) ----------

    @Test fun parsesRoomFromSetSocial() {
        val s = SocialLogic.parseState(JSONObject("""{"enabled":true,"viewers":[],"room":{"members":3,"host":false,"sync":"catching"}}"""), SocialState())
        assertEquals(SocialRoom(3, false, RoomSync.CATCHING), s.room)
        assertEquals(RoomSync.WAITING, SocialLogic.parseRoom(JSONObject("""{"members":2,"host":true,"sync":"waiting"}"""))!!.sync)
        // Synchro inconnue : synchronisé ; membres absents ou nuls : au moins 1.
        assertEquals(SocialRoom(1, false, RoomSync.SYNCED), SocialLogic.parseRoom(JSONObject("""{"members":0,"sync":"???"}""")))
        // Hors salon (null) ou JS antérieur (champ absent) : pas de salon.
        assertNull(SocialLogic.parseState(JSONObject("""{"enabled":true,"room":null}"""), SocialState()).room)
        assertNull(SocialLogic.parseState(JSONObject("""{"enabled":true}"""), SocialState()).room)
    }

    @Test fun roomReplacedOnEachSetSocialAndNotesKept() {
        val notes = listOf(note(1.0))
        val prev = SocialState(enabled = true, notes = notes, room = SocialRoom(2, true, RoomSync.SYNCED))
        val next = SocialLogic.parseState(JSONObject("""{"enabled":true}"""), prev)
        assertNull(next.room)
        assertEquals(notes, next.notes)
    }

    @Test fun pillLabelsInRoomAndOutside() {
        assertEquals("3 en salle", SocialLogic.countLabel(SocialRoom(3, true, RoomSync.SYNCED), 2))
        assertEquals("2 avec vous", SocialLogic.countLabel(null, 2))
        assertEquals("Synchronisé", SocialLogic.syncLabel(RoomSync.SYNCED))
        assertTrue(SocialLogic.syncOk(RoomSync.SYNCED))
        assertFalse(SocialLogic.syncOk(RoomSync.CATCHING))
        assertFalse(SocialLogic.syncOk(RoomSync.WAITING))
        assertTrue(SocialLogic.syncLabel(RoomSync.WAITING).isNotBlank())
    }

    @Test fun pillShownInRoomEvenAloneOutsideOnlyWithViewers() {
        val room = SocialRoom(1, true, RoomSync.SYNCED)
        assertTrue(SocialLogic.showRoomPill(true, room, 0))
        assertTrue(SocialLogic.showRoomPill(true, null, 2))
        assertFalse(SocialLogic.showRoomPill(true, null, 0))
        assertFalse(SocialLogic.showRoomPill(false, room, 3))
    }

    @Test fun hostNoteForGuestOnly() {
        assertTrue(SocialLogic.showHostNote(true, SocialRoom(3, false, RoomSync.SYNCED)))
        assertFalse(SocialLogic.showHostNote(true, SocialRoom(3, true, RoomSync.SYNCED)))
        assertFalse(SocialLogic.showHostNote(true, null))
        assertFalse(SocialLogic.showHostNote(false, SocialRoom(3, false, RoomSync.SYNCED)))
    }

    @Test fun replyTextTrimmedAndBounded() {
        assertEquals("ok", SocialLogic.replyText("  ok \n"))
        assertNull(SocialLogic.replyText("   "))
        assertEquals(SocialLogic.REPLY_TEXT_MAX, SocialLogic.replyText("x".repeat(SocialLogic.REPLY_TEXT_MAX + 10))!!.length)
    }

    @Test fun pinnedBubbleNeitherExpiresNorYieldsItsPlace() {
        val q = BubbleQueue(max = 2, ttlMs = 1000)
        val m = { id: String -> SocialMessage(id, SocialViewer("a", "A"), "x") }
        q.push(m("m1"), 0)
        q.pin("m1")
        q.push(m("m2"), 10)
        q.push(m("m3"), 20) // m2 cède sa place, pas m1 épinglé
        assertEquals(listOf("m1", "m3"), q.active(500).map { it.id })
        assertEquals(listOf("m1"), q.active(5000).map { it.id })
    }

    @Test fun unpinGivesAFullLifetime() {
        val q = BubbleQueue(max = 3, ttlMs = 1000)
        q.push(SocialMessage("m1", SocialViewer("a", "A"), "x"), 0)
        q.pin("m1")
        assertEquals(1, q.active(10_000).size)
        q.unpin("m1", 10_000)
        assertEquals(1, q.active(10_999).size)
        assertEquals(0, q.active(11_000).size)
        // Une bulle non épinglée garde son échéance.
        q.push(SocialMessage("m2", SocialViewer("a", "A"), "y"), 20_000)
        q.unpin("m2", 20_900)
        assertEquals(0, q.active(21_000).size)
    }
}
