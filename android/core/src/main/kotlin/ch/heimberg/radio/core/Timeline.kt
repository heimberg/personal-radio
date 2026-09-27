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
) {
    val displayTitle: String get() = title ?: showName
    val isPlayable: Boolean get() = state == "ready" && audioUrl != null
    val isOpen: Boolean get() = state == "planned" || state == "voicing" || state == "ready"
}

@Serializable
data class SourceRef(val title: String, val url: String)

@Serializable
private data class TimelineResponse(val items: List<TimelineItem>)

object TimelineJson {
    private val json = Json { ignoreUnknownKeys = true }
    fun parse(body: String): List<TimelineItem> = json.decodeFromString(TimelineResponse.serializer(), body).items.sortedBy { it.seq }
}

/** German labels shared by the app's list and notification texts; the cockpit uses the same wording. */
object Labels {
    fun state(state: String): String = when (state) {
        "planned" -> "Geplant"
        "voicing" -> "Wird vertont"
        "ready" -> "Bereit"
        "played" -> "Gehört"
        "skipped" -> "Übersprungen"
        "failed" -> "Fehlgeschlagen"
        "expired" -> "Abgelaufen"
        else -> state
    }

    fun error(code: String): String = when (code) {
        "NO_SOURCES" -> "Keine neuen Quellen gefunden."
        "REJECTED" -> "Quellenprüfung nicht bestanden."
        "DAILY_LIMIT" -> "Tageslimit erreicht, morgen geht es weiter."
        "GEMINI_NOT_CONFIGURED" -> "Gemini ist nicht konfiguriert."
        "ASK_NOT_CONFIGURED" -> "ASK ist nicht konfiguriert."
        "PODCAST_PROVIDER_NOT_CONFIGURED" -> "Dialoge sind nicht konfiguriert."
        else -> code
    }
}
