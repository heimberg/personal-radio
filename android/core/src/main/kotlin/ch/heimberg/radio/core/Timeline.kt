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
}

@Serializable
data class TimelinePart(
    val kind: String,
    val audioUrl: String? = null,
    val spotifyUri: String? = null,
    val title: String? = null,
    val artist: String? = null,
    val durationMs: Long = 0,
) {
    val isTrack: Boolean get() = kind == "track"
}

@Serializable
data class SourceRef(val title: String, val url: String)

@Serializable
data class SpotifySetup(val clientId: String)

/** Failed productions, summarised: how many and the latest reason. */
@Serializable
data class FailureSummary(val count: Int = 0, val latestError: String? = null, val latestAt: String? = null)

/** `GET /api/timeline`: the items plus the public Spotify client ID when the Worker has one. */
@Serializable
data class Timeline(val items: List<TimelineItem>, val spotify: SpotifySetup? = null, val failures: FailureSummary = FailureSummary())

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
data class Transcript(val title: String, val lines: List<TranscriptLine> = emptyList(), val sources: List<SourceRef> = emptyList())

@Serializable
data class TranscriptLine(val text: String, val speaker: String? = null, val song: Boolean = false)

/** `GET /api/library`: productions that can still be heard, newest first, and how long heard audio is kept. */
@Serializable
data class Library(val items: List<TimelineItem>, val retentionDays: Int = 7)

object TimelineJson {
    private val json = Json { ignoreUnknownKeys = true }
    fun parseBlocks(body: String): List<BlockView> = json.decodeFromString(BlockList.serializer(), body).blocks
    fun parseTranscript(body: String): Transcript = json.decodeFromString(Transcript.serializer(), body)
    fun parseLibrary(body: String): Library = json.decodeFromString(Library.serializer(), body)
    fun encodeItem(item: TimelineItem): String = json.encodeToString(TimelineItem.serializer(), item)
    fun parseItem(body: String): TimelineItem = json.decodeFromString(TimelineItem.serializer(), body)
    fun parseResponse(body: String): Timeline = json.decodeFromString(Timeline.serializer(), body).let { it.copy(items = it.items.sortedBy { item -> item.seq }) }
    fun parse(body: String): List<TimelineItem> = parseResponse(body).items
}

/** German labels shared by the app's list and notification texts; the cockpit uses the same wording. */
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
        else -> code
    }
}
