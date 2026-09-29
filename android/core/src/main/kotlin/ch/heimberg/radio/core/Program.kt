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
    /** The album cover, shown in the app, the notification and on the lock screen. */
    val artworkUrl: String? = null,
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
                    TrackStep(item.id, mediaId, uri, part.title ?: uri, part.artist ?: item.artist ?: "", part.durationMs, index == last, part.imageUrl)
                }
            } else {
                part.audioUrl?.let { url -> SpeechStep(item.id, mediaId, url, item.displayTitle, item.showName, index == last) }
            }
        }
    }
}

/**
 * The station ident: a short jingle before a spoken item that follows music (a song, an hour or a
 * block). [before] is the item playing now, so the first new item is judged too. The jingle is a step
 * of the item it introduces (`<item id>#ident`), never its last one.
 */
object StationSound {
    fun withIdents(items: List<TimelineItem>, identUrl: String?, before: TimelineItem?, stationName: String = ""): List<Step> {
        var previous = before
        return items.flatMap { item ->
            val steps = Program.steps(item)
            val ident = identUrl != null && previous?.hasMusic == true && !item.hasMusic && steps.isNotEmpty()
            previous = item
            if (ident) listOf(SpeechStep(item.id, "${item.id}$IDENT", identUrl!!, stationName.ifBlank { item.showName }, item.showName, last = false)) + steps else steps
        }
    }

    const val IDENT = "#ident"
}

/**
 * The time signal at the full hour: once per hour, on the first change of item within the first
 * [WINDOW_MINUTES] minutes. The hour the player started in is never announced.
 */
class HourSignal(startHour: Int) {
    private var last = startHour

    fun due(hour: Int, minute: Int): Boolean {
        if (hour == last) return false
        last = hour
        return minute < WINDOW_MINUTES
    }

    companion object {
        const val WINDOW_MINUTES = 20
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
