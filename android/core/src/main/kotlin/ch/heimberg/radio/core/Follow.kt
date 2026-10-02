package ch.heimberg.radio.core

import kotlinx.serialization.Serializable
import kotlinx.serialization.json.Json

/** Dranbleiben: a topic the radio checks daily; it only speaks when something is new. */
@Serializable
data class FollowedTopic(val id: Long, val topic: String, val createdAt: String = "", val checkedAt: String? = null, val reportedAt: String? = null)

@Serializable
data class FollowList(val topics: List<FollowedTopic> = emptyList(), val max: Int = 5) {
    val full: Boolean get() = topics.size >= max
}

/** Merken: an item on the reading list, with its title and web sources (kept when the item is gone). */
@Serializable
data class Bookmark(val itemId: String, val title: String, val showName: String = "", val sources: List<SourceRef> = emptyList(), val at: String = "")

@Serializable
data class BookmarkList(val bookmarks: List<Bookmark> = emptyList())

/** «Nachfragen»: the answer, already voiced and placed right after the item. */
@Serializable
data class AnswerResult(val itemId: String, val text: String)

object Reading {
    private val json = Json { ignoreUnknownKeys = true }
    fun parseFollows(body: String): FollowList = json.decodeFromString(FollowList.serializer(), body)
    fun parseBookmarks(body: String): List<Bookmark> = json.decodeFromString(BookmarkList.serializer(), body).bookmarks
    fun parseAnswer(body: String): AnswerResult = json.decodeFromString(AnswerResult.serializer(), body)

    /** The reading list as plain text for sharing: each title with its sources' links. */
    fun shareText(bookmarks: List<Bookmark>): String = buildString {
        append("Meine Leseliste aus dem Radio\n")
        for (bookmark in bookmarks) {
            append("\n• ").append(bookmark.title)
            if (bookmark.showName.isNotBlank()) append(" (").append(bookmark.showName).append(")")
            for (source in bookmark.sources) append("\n  ").append(source.title).append(": ").append(source.url)
        }
    }.trim()

    /** A topic for «Dranbleiben» from an item: its title without the show's prefix, at most 120 characters. */
    fun topicOf(item: TimelineItem): String = item.displayTitle.substringAfter("Nachgefragt: ").substringAfter("Dranbleiben: ").trim().take(120)
}
