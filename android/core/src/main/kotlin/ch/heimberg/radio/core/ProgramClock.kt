package ch.heimberg.radio.core

import java.time.Instant

/**
 * When each item of the program would start if playback went on from [now]: the playing item runs for
 * [currentRemainingMs] more, the others follow in list order with their estimated length. Used for the
 * times in the app's list, which stay current while items are moved.
 */
object ProgramClock {
    fun startTimes(items: List<TimelineItem>, now: Instant, currentId: String?, currentRemainingMs: Long?): Map<String, Instant> {
        val starts = LinkedHashMap<String, Instant>()
        var at = now
        items.firstOrNull { it.id == currentId }?.let { current ->
            starts[current.id] = now
            at = now.plusMillis(currentRemainingMs?.coerceAtLeast(0) ?: lengthMs(current))
        }
        for (item in items) {
            if (item.id == currentId) continue
            starts[item.id] = at
            at = at.plusMillis(lengthMs(item))
        }
        return starts
    }

    /** The playing item first, then the rest in program order: the order the player follows. */
    fun playingOrder(items: List<TimelineItem>, currentId: String?): List<TimelineItem> {
        val current = items.firstOrNull { it.id == currentId } ?: return items
        return listOf(current) + items.filter { it.id != currentId }
    }

    /** A new order after moving the item at [from] to [to]; the playing item stays first. */
    fun move(items: List<TimelineItem>, from: Int, to: Int, currentId: String?): List<TimelineItem> {
        val pinned = if (items.firstOrNull()?.id == currentId && currentId != null) 1 else 0
        if (from < pinned || to < pinned || from !in items.indices || to !in items.indices) return items
        return items.toMutableList().apply { add(to, removeAt(from)) }
    }

    /** A new order with [id] right after the playing item: «Als Nächstes». */
    fun playNext(items: List<TimelineItem>, id: String, currentId: String?): List<TimelineItem> {
        val ordered = playingOrder(items, currentId)
        val from = ordered.indexOfFirst { it.id == id }
        val to = if (ordered.firstOrNull()?.id == currentId && currentId != null) 1 else 0
        return if (from < 0) items else move(ordered, from, to, currentId)
    }

    /** A new order with [id] moved by [offset] places (−1 up, +1 down); the playing item stays first. */
    fun shift(items: List<TimelineItem>, id: String, offset: Int, currentId: String?): List<TimelineItem> {
        val ordered = playingOrder(items, currentId)
        val from = ordered.indexOfFirst { it.id == id }
        return if (from < 0) items else move(ordered, from, from + offset, currentId)
    }

    private fun lengthMs(item: TimelineItem): Long = (item.estimatedMinutes * 60_000).toLong().coerceAtLeast(0)
}

/** The program as «Jetzt · Gleich · Später»: what plays, what comes right after it, and the rest. */
data class ProgramSections(val now: TimelineItem?, val next: TimelineItem?, val later: List<TimelineItem>) {
    companion object {
        fun of(open: List<TimelineItem>, playingId: String?): ProgramSections {
            val now = open.firstOrNull { it.id == playingId }
            val rest = open.filter { it.id != playingId }
            return ProgramSections(now, rest.firstOrNull(), rest.drop(1))
        }
    }
}
