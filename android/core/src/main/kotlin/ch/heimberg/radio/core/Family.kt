package ch.heimberg.radio.core

import kotlinx.serialization.Serializable
import kotlinx.serialization.json.Json
import java.time.Duration
import java.time.Instant

/** `GET /api/family`: who is there, what they hear, and the chat. */
@Serializable
data class Family(
    val me: String,
    val members: List<FamilyMember> = emptyList(),
    val messages: List<FamilyMessage> = emptyList(),
    val unread: Int = 0,
) {
    val others: List<FamilyMember> get() = members.filter { !it.me }
    val self: FamilyMember? get() = members.firstOrNull { it.me }
    val isOwner: Boolean get() = me == "owner"

    /** Who [item] can go to: everyone else, a child's station only from the owner. */
    fun shareTargets(): List<FamilyMember> = others.filter { !it.kids || isOwner }

    /** Listening along takes another member's item; a child's station takes nothing from others. */
    fun canListenAlong(member: FamilyMember): Boolean = !member.me && member.nowPlaying != null && self?.kids != true

    companion object {
        private val json = Json { ignoreUnknownKeys = true }
        fun parse(body: String): Family = json.decodeFromString(serializer(), body)
    }
}

@Serializable
data class FamilyMember(
    val key: String,
    val name: String,
    val kids: Boolean = false,
    val me: Boolean = false,
    val nowPlaying: String? = null,
    val lastSeen: String? = null,
) {
    /** «hört gerade «…»», else when last active; nothing for oneself. */
    fun status(now: Instant): String {
        if (nowPlaying != null) return "hört gerade «$nowPlaying»"
        val seen = lastSeen?.let { runCatching { Instant.parse(it) }.getOrNull() } ?: return "noch nie zugehört"
        return "zuletzt aktiv " + ago(seen, now)
    }

    /** The first letter, for the round badge. */
    val initial: String get() = name.take(1).uppercase()
}

@Serializable
data class FamilyMessage(
    val id: Long,
    val from: String,
    val fromName: String,
    val to: String? = null,
    val toName: String? = null,
    /** `text`, `share` or `greeting`. */
    val kind: String = "text",
    val text: String,
    val at: String,
) {
    /** What the chat shows: plain text, or what happened for a share or a greeting. */
    val line: String get() = when (kind) {
        "share" -> "hat «$text» mit ${toName ?: "jemandem"} geteilt"
        "greeting" -> "grüsst ${toName ?: "jemanden"} im Radio: «$text»"
        else -> text
    }
    val icon: String get() = when (kind) { "share" -> "🎧"; "greeting" -> "💌"; else -> "" }
}

/** In `GET /api/timeline`: unread family messages and the newest of them, for the badge and a notification. */
@Serializable
data class FamilySummary(val unread: Int = 0, val latest: LatestMessage? = null)

@Serializable
data class LatestMessage(val id: Long, val line: String)

/** «vor 5 Min.», «vor 3 Std.», «gestern», «vor 4 Tagen». */
fun ago(then: Instant, now: Instant): String {
    val minutes = Duration.between(then, now).toMinutes().coerceAtLeast(0)
    return when {
        minutes < 2 -> "gerade eben"
        minutes < 60 -> "vor $minutes Min."
        minutes < 24 * 60 -> "vor ${minutes / 60} Std."
        minutes < 48 * 60 -> "gestern"
        else -> "vor ${minutes / (24 * 60)} Tagen"
    }
}
