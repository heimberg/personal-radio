package ch.heimberg.radio.core

import kotlinx.serialization.Serializable
import kotlinx.serialization.json.Json
import java.time.Duration
import java.time.Instant

/** In `GET /api/timeline`: how many stickers, whether this is a child's station, and whether the radio answers questions. */
@Serializable
data class PlaySummary(val stickers: Int = 0, val kids: Boolean = false, val ask: Boolean = false) {
    /** The album shows once there is something in it, and always on a child's station. */
    val album: Boolean get() = kids || stickers > 0
}

@Serializable
data class ChoiceOption(val label: String, val emoji: String = "")

/** How a Mitmach-Geschichte may go on after an episode; [picked] once chosen. */
@Serializable
data class StoryChoice(val question: String, val options: List<ChoiceOption> = emptyList(), val picked: Int? = null) {
    val open: Boolean get() = picked == null && options.size == 2
}

/** A quiz question; [correct] comes only with the answer. */
@Serializable
data class Quiz(val question: String, val options: List<String> = emptyList(), val answered: Int? = null, val correct: Int? = null) {
    val open: Boolean get() = answered == null && options.size == 3
}

@Serializable
data class Sticker(val id: String, val emoji: String, val name: String, val at: String? = null) {
    val owned: Boolean get() = at != null
}

/** `GET /api/stickers`: every sticker of the album, with the earned ones marked. */
@Serializable
data class StickerAlbum(val total: Int = 0, val count: Int = 0, val stickers: List<Sticker> = emptyList())

/** The answer to a choice or a quiz: a new sticker, and for a quiz whether it was right. */
@Serializable
data class PlayResult(val sticker: Sticker? = null, val right: Boolean? = null, val correct: Int? = null, val picked: Int? = null)

object Mitmachen {
    private val json = Json { ignoreUnknownKeys = true }
    fun parseAlbum(body: String): StickerAlbum = json.decodeFromString(StickerAlbum.serializer(), body)
    fun parseResult(body: String): PlayResult = json.decodeFromString(PlayResult.serializer(), body)

    /** How long after hearing an item its open choice or quiz still shows on «Hören». */
    val RECENT: Duration = Duration.ofHours(6)

    /**
     * The item to show a choice or quiz for: the one playing, else the newest one heard in the last hours
     * that still waits for an answer.
     */
    fun pending(current: TimelineItem?, heard: List<TimelineItem>, now: Instant): TimelineItem? {
        fun waiting(item: TimelineItem) = item.choice?.open == true || item.quiz?.open == true
        if (current != null && waiting(current)) return current
        return heard.filter { it.isHeard && waiting(it) }
            .filter { item -> item.updatedAt?.let { runCatching { Instant.parse(it) }.getOrNull() }?.let { Duration.between(it, now) < RECENT } ?: false }
            .maxByOrNull { it.seq }
    }

    /** «A», «B», «C» for the quiz buttons. */
    fun letter(index: Int): String = ('A' + index).toString()
}

/**
 * The picture cards a Mitmach-Geschichte starts from: a hero, a place and a kind of story; the chosen
 * ones (and, if wanted, the listener as a character) become its subject.
 */
object StoryCards {
    /** [label] on the card, [text] in the subject. */
    data class Card(val emoji: String, val label: String, val text: String)

    val heroes = listOf(Card("🦊", "Fuchs", "ein schlauer Fuchs"), Card("🐉", "Drache", "ein kleiner Drache"), Card("🤖", "Roboter", "ein neugieriger Roboter"),
        Card("🧙", "Zauberin", "eine junge Zauberin"), Card("🦄", "Einhorn", "ein Einhorn"), Card("🕵️", "Detektivin", "eine Detektivin"))
    val places = listOf(Card("🏰", "Burg", "in einer alten Burg"), Card("🌊", "Meer", "am Meer"), Card("🌲", "Zauberwald", "im Zauberwald"),
        Card("🚀", "Weltall", "im Weltall"), Card("🏔️", "Berge", "in den Bergen"), Card("🏙️", "Stadt", "in einer grossen Stadt"))
    val kinds = listOf(Card("✨", "Magie", "voller Magie"), Card("🔍", "Rätsel", "mit einem Rätsel"), Card("😂", "Lustig", "sehr lustig"),
        Card("🐾", "Tiere", "mit vielen Tieren"), Card("🏆", "Wettbewerb", "mit einem Wettbewerb"), Card("🌙", "Zum Einschlafen", "ruhig, zum Einschlafen"))

    /** The subject for the server, e.g. «Hauptfigur: ein schlauer Fuchs · Ort: im Zauberwald · Art: mit einem Rätsel · Nina spielt selbst mit». */
    fun subject(hero: Card?, place: Card?, kind: Card?, player: String?): String = listOfNotNull(
        hero?.let { "Hauptfigur: ${it.text}" }, place?.let { "Ort: ${it.text}" }, kind?.let { "Art: ${it.text}" },
        player?.takeIf { it.isNotBlank() }?.let { "$it spielt selbst mit" },
    ).joinToString(" · ").take(200)
}
