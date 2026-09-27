package ch.heimberg.radio.core

/**
 * One entry of the player's playlist. A normal segment is one speech step; an artist hour becomes
 * its spoken parts and Spotify tracks in playing order. [last] marks the item's final step, where
 * feedback for the whole item is reported.
 */
sealed interface Step {
    val itemId: String
    val mediaId: String
    val title: String
    val subtitle: String
    val last: Boolean
}

data class SpeechStep(
    override val itemId: String,
    override val mediaId: String,
    val audioUrl: String,
    override val title: String,
    override val subtitle: String,
    override val last: Boolean,
) : Step

data class TrackStep(
    override val itemId: String,
    override val mediaId: String,
    val spotifyUri: String,
    override val title: String,
    override val subtitle: String,
    val durationMs: Long,
    override val last: Boolean,
) : Step

object Program {
    /** Media IDs of parts are `<item id>#<part index>`; feedback always goes to the item. */
    fun itemIdOf(mediaId: String): String = mediaId.substringBefore('#')

    fun steps(item: TimelineItem): List<Step> {
        if (item.parts.isEmpty()) {
            val url = item.audioUrl ?: return emptyList()
            return listOf(SpeechStep(item.id, item.id, url, item.displayTitle, item.showName, last = true))
        }
        val last = item.parts.lastIndex
        return item.parts.mapIndexedNotNull { index, part ->
            val mediaId = "${item.id}#$index"
            if (part.isTrack) {
                part.spotifyUri?.let { uri ->
                    TrackStep(item.id, mediaId, uri, part.title ?: uri, part.artist ?: item.artist ?: "", part.durationMs, index == last)
                }
            } else {
                part.audioUrl?.let { url -> SpeechStep(item.id, mediaId, url, item.displayTitle, item.showName, index == last) }
            }
        }
    }
}

/**
 * Watches the Spotify player while one of our tracks plays and says when to hand back: the track
 * ended, or Spotify moved on to something else (autoplay, a skip in the Spotify app). Before the
 * track has actually started, older states from Spotify are ignored.
 */
class TrackWatch(val uri: String, private val durationMs: Long) {
    private var started = false

    fun ended(trackUri: String?, paused: Boolean, positionMs: Long): Boolean {
        if (trackUri != uri) return started
        if (!paused) {
            started = true
            return false
        }
        // Spotify stops at the end of a single track, either at its end or back at the start.
        return started && (positionMs == 0L || (durationMs > 0 && positionMs >= durationMs - END_TOLERANCE_MS))
    }

    companion object {
        const val END_TOLERANCE_MS = 2_000L
    }
}
