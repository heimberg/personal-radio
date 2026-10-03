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
 * The station's sound around each item, in the order a radio plays it:
 * - after music, before a spoken item: a station jingle (one of several variants, fixed per item);
 * - before every spoken item: the host's live transition, written and voiced by the Worker when the
 *   player loads it (`linker?after=<previous>&next=<item>`), so it knows what really ran before;
 * - before news: the news opener instead of the jingle, right after the transition.
 * [before] is the item playing now, so the first new item is judged too. Every sound is a step of the
 * item it introduces (`<item id>#ident`, `#link`, `#news`), never its last one.
 */
object StationSound {
    fun withSounds(items: List<TimelineItem>, sounds: StationSounds, before: TimelineItem?, stationName: String = ""): List<Step> {
        var previous = before
        return items.flatMap { item ->
            val steps = Program.steps(item)
            val after = previous
            previous = item
            if (steps.isEmpty() || item.hasMusic) return@flatMap steps
            // The sounds already show the item they lead into: its title, and the station (or show) beneath.
            val name = stationName.ifBlank { item.showName }
            val news = Looks.of(item).kind == Kind.NEWS && sounds.newsUrl != null
            val ident = sounds.identFor(item.id)?.takeIf { !news && after?.hasMusic == true }
                ?.let { SpeechStep(item.id, "${item.id}$IDENT", it, item.displayTitle, name, last = false) }
            val link = sounds.linkerUrl?.let { url ->
                val query = (after?.let { "after=${it.id}&" } ?: "") + "next=${item.id}"
                SpeechStep(item.id, "${item.id}$LINK", "$url?$query", item.displayTitle, name, last = false)
            }
            val opener = sounds.newsUrl?.takeIf { news }?.let { SpeechStep(item.id, "${item.id}$NEWS", it, item.displayTitle, name, last = false) }
            listOfNotNull(ident, link, opener) + steps
        }
    }

    const val IDENT = "#ident"
    const val LINK = "#link"
    const val NEWS = "#news"
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
