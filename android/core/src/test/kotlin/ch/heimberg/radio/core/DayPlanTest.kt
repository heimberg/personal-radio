package ch.heimberg.radio.core

import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNull
import kotlin.test.assertSame

class DayPlanTest {
    private val body = """
        {"config":{"name":"Radio","schedule":[{"id":"immer","days":[0,1,2,3,4,5,6],"from":"00:00","to":"24:00","showIds":["kurz","_block:entdeckung"]}],
         "surprise":40,"shows":[],"extra":{"kept":true}}}
    """.trimIndent()

    @Test fun readsScheduleAndSurpriseFromTheStation() {
        val plan = DayPlan.parse(body)!!
        assertEquals(40, plan.surprise)
        assertEquals(listOf("kurz", "_block:entdeckung"), plan.slots.single().showIds)
        assertEquals(25, DayPlan.parse("""{"config":{"schedule":[]}}""")!!.surprise)
        assertNull(DayPlan.parse("""{"config":null}"""))
    }

    @Test fun presetsWindowsDaysAndBlocks() {
        var plan = DayPlan(emptyList()).add(DayPlan.PRESETS[0]).add(DayPlan.PRESETS[0])
        assertEquals(listOf("morgen", "morgen-2"), plan.slots.map { it.id })
        assertEquals(listOf("_block:morgen", "_block:entdeckung"), plan.slots[0].showIds)
        assertEquals(DayPlan.WORKDAYS, plan.slots[0].days)

        plan = plan.remove("morgen-2").toggleDay("morgen", 6).toggleDay("morgen", 1)
        assertEquals(listOf(2, 3, 4, 5, 6), plan.slots.single().days)
        // A window keeps at least one day, one block, and ends after it starts.
        val oneDay = plan.days("morgen", listOf(3))
        assertSame(oneDay, oneDay.toggleDay("morgen", 3))
        assertSame(plan, plan.times("morgen", "09:00", "06:00"))
        assertEquals("24:00", plan.times("morgen", "20:00", "24:00").slots.single().to)

        plan = plan.addBlock("morgen", "_block:wetter").removeBlock("morgen", 0)
        assertEquals(listOf("_block:entdeckung", "_block:wetter"), plan.slots.single().showIds)
        val single = plan.removeBlock("morgen", 0)
        assertSame(single, single.removeBlock("morgen", 0))
        assertEquals(100, plan.surprise(140).surprise)
    }

    @Test fun activeWindowAndBlockIds() {
        val plan = DayPlan(listOf(ScheduleSlot("a", listOf(1), "06:00", "09:00", listOf("x")), ScheduleSlot("b", listOf(1), "09:00", "24:00", listOf("y"))))
        assertEquals("a", plan.active(1, 8 * 60 + 59)?.id)
        assertEquals("b", plan.active(1, 9 * 60)?.id)
        assertNull(plan.active(2, 10 * 60))
        assertEquals("_block:wetter", DayPlan.scheduleId(BlockView("wetter", "Wetter", "")))
        assertEquals("kurz", DayPlan.scheduleId(BlockView("show:kurz", "Kurz", "")))
        assertNull(DayPlan.scheduleId(BlockView("song", "Song", "")))
        assertNull(DayPlan.scheduleId(BlockView("ueberraschung", "Überraschung", "")))
        assertEquals("00:00", DayPlan.TIMES.first())
        assertEquals("24:00", DayPlan.TIMES.last())
        assertEquals(49, DayPlan.TIMES.size)
    }

    @Test fun moodsAndTheTimelineMood() {
        assertEquals("Mehr Musik", Moods.of("musik")?.label)
        assertNull(Moods.of("laut"))
        val timeline = TimelineJson.parseResponse("""{"items":[],"mood":{"id":"wissen","until":"2026-09-29T22:00:00.000Z"}}""")
        assertEquals("wissen", timeline.mood?.id)
        assertNull(TimelineJson.parseResponse("""{"items":[]}""").mood)
    }
}
