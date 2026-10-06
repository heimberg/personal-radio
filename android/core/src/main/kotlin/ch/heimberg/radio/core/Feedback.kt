package ch.heimberg.radio.core

import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put

enum class FeedbackAction(val wire: String) { LIKE("like"), DISLIKE("dislike"), SKIP("skip"), COMPLETE("complete") }

/** Why an item was rated down; repeated reasons teach the station: spoken ones the writer, editor and jury, music ones the music desk. */
enum class FeedbackReason(val wire: String, val label: String, val music: Boolean = false) {
    TOO_LONG("too_long", "Zu lang"), BORING("boring", "Langweilig"), TONE("tone", "Falscher Ton"),
    KNOWN("known", "Kenn ich schon"), WRONG("wrong", "Fehlerhaft"),
    NOT_MY_STYLE("not_my_style", "Nicht mein Stil", true), HEARD_TOO_OFTEN("heard_too_often", "Zu oft gehört", true),
    TOO_WILD("too_wild", "Zu wild", true), TOO_CALM("too_calm", "Zu ruhig", true), WRONG_MOMENT("wrong_moment", "Passt gerade nicht", true);

    /** Body for `POST /api/timeline/{id}/reason`. */
    fun toJson(): String = buildJsonObject { put("reason", wire) }.toString()

    companion object {
        /** The reasons offered for an item: about its music or about what was said. */
        fun forItem(music: Boolean): List<FeedbackReason> = entries.filter { it.music == music }
    }
}

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
