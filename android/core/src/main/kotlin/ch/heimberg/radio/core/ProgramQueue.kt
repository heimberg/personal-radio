package ch.heimberg.radio.core

/**
 * Decides which ready segments are appended to the player. Each segment is handed out once, in
 * program order, even if the server still lists it as ready because feedback has not arrived yet.
 */
class ProgramQueue {
    private val handedOut = LinkedHashSet<String>()

    fun takeNew(items: List<TimelineItem>): List<TimelineItem> {
        val fresh = items.filter { it.isPlayable && it.id !in handedOut }.sortedBy { it.seq }
        fresh.forEach { handedOut += it.id }
        return fresh
    }

    fun forget() = handedOut.clear()
}
