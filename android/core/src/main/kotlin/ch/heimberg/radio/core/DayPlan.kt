package ch.heimberg.radio.core

import kotlinx.serialization.Serializable
import kotlinx.serialization.builtins.ListSerializer
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.intOrNull
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive

/** «Heute»: a mood for the rest of the day (`POST /api/mood`), mirroring src/domain/mood.ts. */
@Serializable
data class StationMood(val id: String, val until: String)

data class Mood(val id: String, val label: String, val icon: String, val description: String)

object Moods {
    val ALL = listOf(
        Mood("ruhig", "Eher ruhig", "😌", "Mehr Musik, keine Schlagzeilen, keine Überraschungen"),
        Mood("wissen", "Mehr Wissen", "🧠", "Öfter Entdeckungen und Hintergründe"),
        Mood("musik", "Mehr Musik", "🎵", "Mehr Songs zwischen den Beiträgen und Musikblöcke"),
        Mood("aktuell", "Was läuft?", "📰", "Öfter die Schlagzeilen"),
        Mood("ueberraschung", "Überrasch mich", "🎲", "Viel öfter etwas Unerwartetes"),
    )

    fun of(id: String?): Mood? = ALL.firstOrNull { it.id == id }
}

/** One time window of the day plan: on these weekdays (0 = Sunday), from–to, these blocks take turns. */
@Serializable
data class ScheduleSlot(val id: String, val days: List<Int>, val from: String, val to: String, val showIds: List<String>)

/** A ready-made window, as in the web studio. */
data class SlotPreset(val name: String, val from: String, val to: String, val blocks: List<String>)

/**
 * The day plan as the app edits it: the station's `schedule` and `surprise` level. Pure functions, so
 * every change is tested; the app sends only these two fields back and keeps the rest of the settings.
 */
data class DayPlan(val slots: List<ScheduleSlot>, val surprise: Int = 25) {
    fun add(preset: SlotPreset): DayPlan {
        if (slots.size >= MAX_SLOTS) return this
        val base = preset.name.lowercase().replace(Regex("[^a-z0-9]+"), "-")
        var id = base
        var n = 2
        while (slots.any { it.id == id }) id = "$base-${n++}"
        return copy(slots = slots + ScheduleSlot(id, WORKDAYS, preset.from, preset.to, preset.blocks.map { BLOCK_PREFIX + it }))
    }

    fun remove(slotId: String): DayPlan = copy(slots = slots.filter { it.id != slotId })

    fun times(slotId: String, from: String, to: String): DayPlan =
        if (minutesOf(from) >= minutesOf(to)) this else update(slotId) { it.copy(from = from, to = to) }

    fun days(slotId: String, days: List<Int>): DayPlan = if (days.isEmpty()) this else update(slotId) { it.copy(days = days.distinct().sorted()) }

    fun toggleDay(slotId: String, day: Int): DayPlan {
        val slot = slots.firstOrNull { it.id == slotId } ?: return this
        return days(slotId, if (day in slot.days) slot.days - day else slot.days + day)
    }

    /** Adds a block ID (`_block:…` or an own show's ID) to a window; at most 20 per window. */
    fun addBlock(slotId: String, showId: String): DayPlan = update(slotId) { if (it.showIds.size >= 20) it else it.copy(showIds = it.showIds + showId) }

    /** Takes the block at [position] out; a window keeps at least one. */
    fun removeBlock(slotId: String, position: Int): DayPlan =
        update(slotId) { if (it.showIds.size <= 1 || position !in it.showIds.indices) it else it.copy(showIds = it.showIds.filterIndexed { index, _ -> index != position }) }

    fun surprise(level: Int): DayPlan = copy(surprise = level.coerceIn(0, 100))

    /** The window that is on air at [day] and [minutes] after midnight, like the planner's `activeSlot`. */
    fun active(day: Int, minutes: Int): ScheduleSlot? = slots.firstOrNull { day in it.days && minutesOf(it.from) <= minutes && minutes < minutesOf(it.to) }

    fun schedulesJson(): String = json.encodeToString(ListSerializer(ScheduleSlot.serializer()), slots)

    /** Applies [change] to one window; an unchanged window leaves the plan as it is (same instance). */
    private fun update(slotId: String, change: (ScheduleSlot) -> ScheduleSlot): DayPlan {
        val slot = slots.firstOrNull { it.id == slotId } ?: return this
        val changed = change(slot)
        return if (changed == slot) this else copy(slots = slots.map { if (it.id == slotId) changed else it })
    }

    companion object {
        const val BLOCK_PREFIX = "_block:"
        const val MAX_SLOTS = 50
        val WORKDAYS = listOf(1, 2, 3, 4, 5)
        val DAY_SETS = listOf("Täglich" to listOf(0, 1, 2, 3, 4, 5, 6), "Werktags" to WORKDAYS, "Wochenende" to listOf(0, 6))
        val WEEKDAYS = listOf(1 to "Mo", 2 to "Di", 3 to "Mi", 4 to "Do", 5 to "Fr", 6 to "Sa", 0 to "So")
        val PRESETS = listOf(
            SlotPreset("Morgen", "06:00", "09:00", listOf("morgen", "entdeckung")),
            SlotPreset("Mittag", "12:00", "13:30", listOf("schlagzeilen", "entdeckung")),
            SlotPreset("Nachmittag", "14:00", "18:00", listOf("entdeckung", "hintergrund")),
            SlotPreset("Abend", "18:00", "22:00", listOf("kuenstler", "musik")),
        )
        /** Times a window can start or end: every half hour, and 24:00 for the end of the day. */
        val TIMES = (0..48).map { "%02d:%02d".format(it / 2, (it % 2) * 30) }

        private val json = Json { ignoreUnknownKeys = true }

        /** Reads `schedule` and `surprise` from `GET /api/station` (`{ "config": … }`). */
        fun parse(stationBody: String): DayPlan? {
            val config = runCatching { json.parseToJsonElement(stationBody).jsonObject["config"] as? JsonObject }.getOrNull() ?: return null
            val slots = config["schedule"]?.let { json.decodeFromJsonElement(ListSerializer(ScheduleSlot.serializer()), it) } ?: emptyList()
            return DayPlan(slots, config["surprise"]?.jsonPrimitive?.intOrNull ?: 25)
        }

        /** The block ID a palette block (`GET /api/blocks`) has in the day plan; songs and «Überraschung» are not a window's block. */
        /** Series are started once from «Programm», not put into time slots. */
        private val SERIES_BLOCKS = setOf("serie", "geschichte")

        fun scheduleId(block: BlockView): String? = when {
            block.id == "song" || block.id == "ueberraschung" || block.id in SERIES_BLOCKS -> null
            block.id.startsWith("show:") -> block.id.removePrefix("show:")
            else -> BLOCK_PREFIX + block.id
        }

        fun minutesOf(time: String): Int {
            val (hours, minutes) = time.split(":").map { it.toIntOrNull() ?: 0 } + listOf(0, 0)
            return hours * 60 + minutes
        }
    }
}
