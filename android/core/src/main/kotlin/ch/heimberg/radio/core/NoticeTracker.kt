package ch.heimberg.radio.core

import kotlinx.serialization.Serializable
import kotlinx.serialization.json.Json

/**
 * Decides what is worth a notification between two program syncs: a long production (a music hour, a
 * music block) that has just become ready, and a production that has failed since the last sync. The
 * first sync only records the state, so opening the app does not report old news.
 */
class NoticeTracker(saved: NoticeState = NoticeState()) {
    data class Notices(val ready: List<TimelineItem>, val failure: FailureSummary?)

    private val states = HashMap(saved.states)
    private var lastFailureAt: String? = saved.lastFailureAt
    private var started = saved.started

    /** What the tracker knows, so the player and the background check share it and report nothing twice. */
    val state: NoticeState get() = NoticeState(HashMap(states), lastFailureAt, started)

    fun update(timeline: Timeline): Notices {
        val ready = if (!started) emptyList() else timeline.items.filter { item ->
            item.state == "ready" && item.estimatedMinutes >= LONG_MINUTES && states[item.id].let { it != null && it != "ready" }
        }
        val failures = timeline.failures
        val failure = failures.takeIf { started && it.count > 0 && it.latestAt != null && it.latestAt != lastFailureAt }
        states.clear()
        timeline.items.forEach { states[it.id] = it.state }
        if (failures.latestAt != null) lastFailureAt = failures.latestAt
        started = true
        return Notices(ready, failure)
    }

    companion object {
        /** Items this long take minutes to produce, so their completion is news. */
        const val LONG_MINUTES = 15.0
    }
}

@Serializable
data class NoticeState(val states: Map<String, String> = emptyMap(), val lastFailureAt: String? = null, val started: Boolean = false) {
    fun toJson(): String = json.encodeToString(serializer(), this)

    companion object {
        private val json = Json { ignoreUnknownKeys = true }
        fun parse(body: String?): NoticeState = body?.let { runCatching { json.decodeFromString(serializer(), it) }.getOrNull() } ?: NoticeState()
    }
}
