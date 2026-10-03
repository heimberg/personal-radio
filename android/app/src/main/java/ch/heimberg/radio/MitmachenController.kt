package ch.heimberg.radio

import ch.heimberg.radio.core.Sticker
import ch.heimberg.radio.core.TimelineItem
import kotlinx.coroutines.launch

/** Mitmachen: how a story goes on, a quiz answer, the sticker album, a question to the radio (typed or spoken). */
interface MitmachenActions {
    fun choose(item: TimelineItem, option: Int)
    fun answer(item: TimelineItem, option: Int)
    fun openAlbum()
    fun ask()
    fun dictate()
}

class MitmachenController(private val ref: HostRef) : MitmachenActions {
    private val host get() = ref.host
    private val state get() = host.state
    private val api get() = host.api

    /** Stickers known from the last program: more of them means one was earned elsewhere (an episode heard to the end). */
    private var stickersSeen = -1

    override fun choose(item: TimelineItem, option: Int) {
        if (state.playSending != null) return
        state.playSending = item.id
        host.confirm()
        host.scope.launch {
            runCatching { api.choose(item.id, option) }
                .onSuccess { result ->
                    val label = item.choice?.options?.getOrNull(option)?.let { "${it.emoji} ${it.label}" } ?: ""
                    state.say("Du hast gewählt: $label. So geht die Geschichte weiter!")
                    earned(result.sticker)
                }
                .onFailure { state.say(host.failure(it)) }
            state.playSending = null
            host.changed()
        }
    }

    override fun answer(item: TimelineItem, option: Int) {
        if (state.playSending != null) return
        state.playSending = item.id
        host.scope.launch {
            runCatching { api.answer(item.id, option) }
                .onSuccess { result ->
                    val right = result.correct?.let { item.quiz?.options?.getOrNull(it) }
                    if (result.right == true) host.confirm()
                    state.say(if (result.right == true) "Richtig! 🎉" else "Knapp daneben – richtig ist ${right?.let { "«$it»" } ?: "eine andere Antwort"}.")
                    earned(result.sticker)
                }
                .onFailure { state.say(host.failure(it)) }
            state.playSending = null
            host.changed()
        }
    }

    /** A new sticker: shown big, and the album is loaded again when it is opened. */
    private fun earned(sticker: Sticker?) {
        if (sticker == null) return
        state.newSticker = sticker
        state.album = null
        stickersSeen += 1
    }

    /** The number of stickers in the latest program: more than before, without a choice or quiz here, is news. */
    fun stickersNow(count: Int) {
        if (stickersSeen in 0 until count) {
            state.say("⭐ Ein neuer Sticker ist in deinem Album!", "Ansehen") { openAlbum() }
            state.album = null
        }
        stickersSeen = count
    }

    override fun openAlbum() {
        state.albumOpen = true
        host.scope.launch {
            runCatching { api.stickers() }.onSuccess { state.album = it }.onFailure { state.say(host.failure(it)) }
        }
    }

    override fun ask() {
        val text = state.askDraft.trim()
        if (text.length < 3 || state.asking) return
        state.asking = true
        host.scope.launch {
            runCatching { api.ask(text) }
                .onSuccess {
                    state.askDraft = ""
                    state.askOpen = false
                    state.say("Deine Frage ist im Studio – die Antwort kommt im nächsten Übergang.")
                }
                .onFailure { state.say(if (it is ApiException && it.status == 409) "Das Radio hat gerade keine Übergänge eingeschaltet, also kann niemand antworten." else host.failure(it)) }
            state.asking = false
        }
    }

    /** «Frag das Radio» by voice: Android's speech recognition turns it into text; nothing is recorded here. */
    override fun dictate() = host.startDictation()

    /** What the speech recognition heard, added to the question. */
    fun dictated(spoken: String?) {
        if (!spoken.isNullOrBlank()) state.askDraft = (state.askDraft.trim() + " " + spoken.trim()).trim().take(200)
    }
}
