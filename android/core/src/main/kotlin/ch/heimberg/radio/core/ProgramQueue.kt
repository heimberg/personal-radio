package ch.heimberg.radio.core

/**
 * Decides which ready segments are appended to the player. Each segment is handed out once, in
 * program order, even if the server still lists it as ready because feedback has not arrived yet.
 * Items with Spotify tracks wait while the Spotify app is not connected; they are handed out as soon
 * as it is, so an artist hour is never played without its music.
 */
class ProgramQueue {
    private val handedOut = LinkedHashSet<String>()

    fun takeNew(items: List<TimelineItem>, musicAvailable: Boolean = false): List<TimelineItem> {
        val fresh = items.filter { it.isPlayable && it.id !in handedOut && (musicAvailable || !it.hasMusic) }.sortedBy { it.seq }
        fresh.forEach { handedOut += it.id }
        return fresh
    }

    fun forget() = handedOut.clear()
}
