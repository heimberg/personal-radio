package ch.heimberg.radio.core

/**
 * Decides what the player should play after the current item: the playable open items in program
 * order, so a new order from the cockpit (moved, removed, shuffled items) is followed on the next sync.
 * Items the player has already left stay behind even if the server still lists them as ready because
 * feedback has not arrived yet. Items with Spotify tracks wait while the Spotify app is not connected,
 * so a music hour or song is never played without its music.
 */
class ProgramQueue {
    private val passed = LinkedHashSet<String>()

    fun markPassed(itemId: String) { passed += itemId }

    fun upcoming(items: List<TimelineItem>, musicAvailable: Boolean, current: String?): List<TimelineItem> =
        items.filter { it.isPlayable && it.id != current && it.id !in passed && (musicAvailable || !it.hasMusic) }.sortedBy { it.seq }

    /** True when the player's upcoming items already match [wanted], so nothing needs rebuilding. */
    fun matches(present: List<String>, wanted: List<TimelineItem>): Boolean = present == wanted.map { it.id }
}
