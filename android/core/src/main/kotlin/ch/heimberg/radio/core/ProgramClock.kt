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

    private fun lengthMs(item: TimelineItem): Long = (item.estimatedMinutes * 60_000).toLong().coerceAtLeast(0)
}
