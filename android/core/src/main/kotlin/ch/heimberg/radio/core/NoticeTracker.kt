package ch.heimberg.radio.core

/**
 * Decides what is worth a notification between two program syncs: a long production (a music hour, a
 * music block) that has just become ready, and a production that has failed since the last sync. The
 * first sync only records the state, so opening the app does not report old news.
 */
class NoticeTracker {
    data class Notices(val ready: List<TimelineItem>, val failure: FailureSummary?)

    private val states = HashMap<String, String>()
    private var lastFailureAt: String? = null
    private var started = false

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
