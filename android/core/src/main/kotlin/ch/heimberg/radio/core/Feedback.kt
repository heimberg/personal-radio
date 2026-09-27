package ch.heimberg.radio.core

import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put

enum class FeedbackAction(val wire: String) { LIKE("like"), DISLIKE("dislike"), SKIP("skip"), COMPLETE("complete") }

data class Feedback(val itemId: String, val action: FeedbackAction, val listenedRatio: Double) {
    /** Body for `POST /api/timeline/{id}/feedback`. */
    fun toJson(): String = buildJsonObject {
        put("action", action.wire)
        put("listenedRatio", listenedRatio)
    }.toString()
}

object FeedbackPolicy {
    /**
     * A segment that played to its end counts as complete; leaving it earlier is a skip with the share
     * that was heard. The server ignores skips below 20 % when it learns, so an accidental tap costs nothing.
     */
    fun onLeave(itemId: String, finishedNaturally: Boolean, positionMs: Long, durationMs: Long): Feedback {
        if (finishedNaturally) return Feedback(itemId, FeedbackAction.COMPLETE, 1.0)
        val ratio = if (durationMs > 0) (positionMs.toDouble() / durationMs).coerceIn(0.0, 1.0) else 0.0
        return Feedback(itemId, FeedbackAction.SKIP, ratio)
    }

    fun rating(itemId: String, liked: Boolean): Feedback =
        Feedback(itemId, if (liked) FeedbackAction.LIKE else FeedbackAction.DISLIKE, 1.0)
}
