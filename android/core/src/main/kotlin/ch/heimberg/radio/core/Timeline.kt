package ch.heimberg.radio.core

import kotlinx.serialization.Serializable
import kotlinx.serialization.json.Json

/** Mirrors `TimelineItemView` of the Worker API (`GET /api/timeline`). */
@Serializable
data class TimelineItem(
    val id: String,
    val seq: Int,
    val showId: String,
    val showName: String,
    val plannedAt: String,
    val state: String,
    val estimatedMinutes: Double,
    val title: String? = null,
    val sources: List<SourceRef> = emptyList(),
    val interestTags: List<String> = emptyList(),
    val verification: String? = null,
    val searchQueries: List<String> = emptyList(),
    val error: String? = null,
    val audioUrl: String? = null,
    /** Artist hour: spoken parts and Spotify tracks in playing order. */
    val parts: List<TimelinePart> = emptyList(),
    val artist: String? = null,
    /** 🎲 A surprise the planner mixed in; it can be swapped for another one. */
    val surprise: Boolean = false,
    /** An episode of a series: which one of how many. */
    val series: SeriesRef? = null,
    /** Shared by a family member: their name. */
    val sharedBy: String? = null,
    /** Last change on the server (for heard items: when they were heard). */
    val updatedAt: String? = null,
    /** A Mitmach-Geschichte: how it may go on after this episode. */
    val choice: StoryChoice? = null,
    /** A quiz question about this item. */
    val quiz: Quiz? = null,
) {
    val displayTitle: String get() = title ?: showName
    val hasMusic: Boolean get() = parts.any { it.isTrack }
    /** All spoken audio is still on the server (it is released some days after the item left the program). */
    val hasAudio: Boolean get() =
        if (parts.isEmpty()) audioUrl != null
        else parts.all { if (it.isTrack) it.spotifyUri != null else it.audioUrl != null }
    val isPlayable: Boolean get() = state == "ready" && hasAudio
    /** Heard before, or left the program unheard: listening again from the archive. */
    val isHeard: Boolean get() = state == "played" || state == "skipped"
    val isOpen: Boolean get() = state == "planned" || state == "voicing" || state == "ready"
    /** The item's cover: the album of its first song that has one; spoken items have none. */
    val coverUrl: String? get() = parts.firstOrNull { it.isTrack && it.imageUrl != null }?.imageUrl
}

@Serializable
data class TimelinePart(
    val kind: String,
    val audioUrl: String? = null,
    val spotifyUri: String? = null,
    val title: String? = null,
    val artist: String? = null,
    val durationMs: Long = 0,
    /** The track's album cover (Spotify's image CDN). */
    val imageUrl: String? = null,
) {
    val isTrack: Boolean get() = kind == "track"
}

@Serializable
data class SourceRef(val title: String, val url: String)

/** Where an episode belongs; [kind] is `wissen` or `geschichte`. */
@Serializable
data class SeriesRef(val id: String, val episode: Int, val total: Int, val kind: String = "wissen")

/** `GET /api/series`: a series with its episode titles and how many are already in the program. */
@Serializable
data class SeriesInfo(
    val id: String,
    val title: String,
    val subject: String = "",
    val kind: String = "wissen",
    val state: String = "active",
    val episodes: List<String> = emptyList(),
    val scheduled: Int = 0,
) {
    val active: Boolean get() = state == "active"
    val story: Boolean get() = kind == "geschichte"
    /** «Folge 2 von 5», or how it ended. */
    val progress: String get() = when (state) {
        "done" -> "Alle ${episodes.size} Folgen gehört"
        "stopped" -> "Beendet nach Folge ${scheduled.coerceAtLeast(1)}"
        else -> "Folge ${scheduled.coerceAtLeast(1)} von ${episodes.size}"
    }
}

@Serializable
data class SeriesList(val series: List<SeriesInfo> = emptyList())

@Serializable
data class SpotifySetup(val clientId: String)

/** Failed productions, summarised: how many and the latest reason. */
@Serializable
data class FailureSummary(val count: Int = 0, val latestError: String? = null, val latestAt: String? = null)

/** `GET /api/timeline`: the items plus the public Spotify client ID when the Worker has one. */
@Serializable
data class Timeline(
    val items: List<TimelineItem>,
    val spotify: SpotifySetup? = null,
    val failures: FailureSummary = FailureSummary(),
    val sounds: StationSounds = StationSounds(),
    /** Today's mood, while it lasts (until midnight in the station's time zone). */
    val mood: StationMood? = null,
    /** Unread family messages; absent without other listeners. */
    val family: FamilySummary? = null,
    /** Mitmachen: stickers, a child's station, questions to the radio. */
    val play: PlaySummary = PlaySummary(),
    /** The station's name, for the header of «Hören». */
    val station: String? = null,
)

/**
 * The station's sound; null = off. Jingles between music and speech ([identUrls], else the single
 * [identUrl]), the news opener, the time signal with the spoken hour, and live transitions ([linkerUrl]).
 */
@Serializable
data class StationSounds(
    val identUrl: String? = null,
    val identUrls: List<String> = emptyList(),
    val newsUrl: String? = null,
    val signalUrl: String? = null,
    val hourUrl: String? = null,
    val linkerUrl: String? = null,
) {
    /** One jingle variant per item, always the same for it, so a replay sounds the same. */
    fun identFor(itemId: String): String? =
        if (identUrls.isNotEmpty()) identUrls[Math.floorMod(itemId.hashCode(), identUrls.size)] else identUrl
}

/** A ready-made building block (`GET /api/blocks`): tap it, at most type one word, and it comes next. */
@Serializable
data class BlockView(
    val id: String,
    val name: String,
    val description: String,
    val minutes: Double = 0.0,
    val music: Boolean = false,
    val own: Boolean = false,
    val input: BlockInput? = null,
)

@Serializable
data class BlockInput(val kind: String, val label: String, val example: String)

@Serializable
data class BlockList(val blocks: List<BlockView> = emptyList())

/** `GET /api/timeline/{id}/script`: what was said, for reading along, and the sources behind it. */
@Serializable
data class Transcript(val title: String, val lines: List<TranscriptLine> = emptyList(), val sources: List<SourceRef> = emptyList(), val quality: Quality? = null)

/** The quality jury's marks (1–5) after the final edit. */
@Serializable
data class Quality(val overall: Double, val notes: String = "")

@Serializable
data class TranscriptLine(val text: String, val speaker: String? = null, val song: Boolean = false)

/** `GET /api/library`: productions that can still be heard, newest first, and how long heard audio is kept. */
@Serializable
data class Library(val items: List<TimelineItem>, val retentionDays: Int = 7)

object TimelineJson {
    private val json = Json { ignoreUnknownKeys = true }
    fun parseBlocks(body: String): List<BlockView> = json.decodeFromString(BlockList.serializer(), body).blocks
    fun parseSeries(body: String): List<SeriesInfo> = json.decodeFromString(SeriesList.serializer(), body).series
    fun parseTranscript(body: String): Transcript = json.decodeFromString(Transcript.serializer(), body)
    fun parseLibrary(body: String): Library = json.decodeFromString(Library.serializer(), body)
    fun encodeItem(item: TimelineItem): String = json.encodeToString(TimelineItem.serializer(), item)
    fun parseItem(body: String): TimelineItem = json.decodeFromString(TimelineItem.serializer(), body)
    fun parseResponse(body: String): Timeline = json.decodeFromString(Timeline.serializer(), body).let { it.copy(items = it.items.sortedBy { item -> item.seq }) }
    fun parse(body: String): List<TimelineItem> = parseResponse(body).items
}

/** German labels shared by the app's list and notification texts. */
object Labels {
    fun state(state: String): String = when (state) {
        "planned" -> "Geplant"
        "voicing" -> "Wird vertont"
        "ready" -> "Bereit"
        "played" -> "Gehört"
        "skipped" -> "Übersprungen"
        "archived" -> "Nicht gehört"
        "failed" -> "Fehlgeschlagen"
        "expired" -> "Abgelaufen"
        else -> state
    }

    fun error(code: String): String = when {
        code.startsWith("REJECTED: ") -> "Quellenprüfung nicht bestanden – " + code.removePrefix("REJECTED: ")
        code.startsWith("TOO_FEW_TRACKS: ") -> "Zu wenige Songs gefunden – " + code.removePrefix("TOO_FEW_TRACKS: ")
        else -> known(code)
    }

    private fun known(code: String): String = when (code) {
        "NO_SOURCES" -> "Keine neuen Quellen gefunden."
        "REJECTED" -> "Quellenprüfung nicht bestanden."
        "DAILY_LIMIT" -> "Tageslimit erreicht, morgen geht es weiter."
        "GEMINI_NOT_CONFIGURED" -> "Gemini ist nicht konfiguriert."
        "ASK_NOT_CONFIGURED" -> "ASK ist nicht konfiguriert."
        "PODCAST_PROVIDER_NOT_CONFIGURED" -> "Dialoge sind nicht konfiguriert."
        "NO_LOCATION" -> "Für das Wetter fehlt der Ort (Programm einstellen → Sendeuhr → Ort)."
        "WEATHER_NOT_CONFIGURED" -> "Das Wetter-Tool ist nicht verfügbar."
        "SPOTIFY_NOT_CONFIGURED" -> "Spotify ist auf dem Server nicht eingerichtet."
        "NO_ARTISTS" -> "Für Konzerte fehlt dein Spotify-Hörprofil (Studio → Spotify verbinden)."
        "NOTHING_NEW" -> "Nichts Neues zum Thema."
        "FOLLOW_REMOVED" -> "Du bleibst an diesem Thema nicht mehr dran."
        else -> code
    }
}
