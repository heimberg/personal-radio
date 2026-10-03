package ch.heimberg.radio

import android.content.Intent
import ch.heimberg.radio.core.Reading
import ch.heimberg.radio.core.TimelineItem
import kotlinx.coroutines.launch

/** Nachfragen, Merken (the reading list) and Dranbleiben (followed topics). */
interface ReadingActions {
    /** Opens the question dialog for [item] (or what plays); sends the question. */
    fun askAbout(item: TimelineItem? = null)
    fun sendQuestion()
    /** On or off the reading list; the list to share. */
    fun toggleBookmark(item: TimelineItem? = null)
    fun removeBookmark(itemId: String)
    fun shareReading()
    fun openSource(url: String)
    /** Follow a topic (the dialog with [suggestion]), stop following one. */
    fun suggestFollow(suggestion: String)
    fun follow(topic: String)
    fun unfollow(id: Long)
}

class ReadingController(private val ref: HostRef) : ReadingActions {
    private val host get() = ref.host
    private val state get() = host.state
    private val api get() = host.api

    suspend fun loadBookmarks() { runCatching { api.bookmarks() }.getOrNull()?.let { state.bookmarks = it } }

    suspend fun loadFollows() { runCatching { api.follows() }.getOrNull()?.let { state.follows = it } }

    /** The item a question or bookmark is about: the given one, else what plays (from the program or the archive). */
    private fun itemOrPlaying(item: TimelineItem?): TimelineItem? {
        if (item != null) return item
        val id = host.currentId() ?: return null
        return state.open.firstOrNull { it.id == id } ?: state.heard.firstOrNull { it.id == id } ?: state.archive?.firstOrNull { it.id == id }
    }

    override fun askAbout(item: TimelineItem?) {
        val about = itemOrPlaying(item) ?: return state.say(host.activity.getString(R.string.nothing_playing))
        if (about.hasMusic || about.showId == "_musik") return state.say("Zu Songs und Musikstunden kann das Radio keine Fragen beantworten.")
        state.askAbout = about
        state.askOpen = true
    }

    override fun sendQuestion() {
        val about = state.askAbout ?: return
        val text = state.askDraft.trim()
        if (text.length < 3 || state.asking) return
        state.asking = true
        host.scope.launch {
            runCatching { api.askAbout(about.id, text) }
                .onSuccess { answer ->
                    state.askDraft = ""
                    state.askOpen = false
                    state.askAbout = null
                    host.changed()
                    val reply = state.open.firstOrNull { it.id == answer.itemId }
                    state.say("Die Antwort kommt direkt nach «${about.displayTitle}».", "Jetzt hören") { reply?.let { host.actions.play(it) } ?: state.say(answer.text) }
                }
                .onFailure {
                    state.say(when ((it as? ApiException)?.status) {
                        409 -> "Dazu kann das Radio keine Frage beantworten."
                        429 -> "Für heute ist das Limit erreicht – morgen geht es wieder."
                        else -> host.failure(it)
                    })
                }
            state.asking = false
        }
    }

    override fun toggleBookmark(item: TimelineItem?) {
        val target = itemOrPlaying(item) ?: return state.say(host.activity.getString(R.string.nothing_playing))
        val on = !state.bookmarked(target.id)
        host.confirm()
        host.scope.launch {
            val result = runCatching { if (on) api.bookmark(target.id) else api.unbookmark(target.id) }
            state.say(result.fold({ if (on) "🔖 «${target.displayTitle}» ist auf deiner Leseliste." else "Von der Leseliste genommen." }, { host.failure(it) }))
            loadBookmarks()
        }
    }

    override fun removeBookmark(itemId: String) {
        host.scope.launch {
            runCatching { api.unbookmark(itemId) }.onFailure { state.say(host.failure(it)) }
            loadBookmarks()
        }
    }

    override fun shareReading() {
        if (state.bookmarks.isEmpty()) return
        val send = Intent(Intent.ACTION_SEND).setType("text/plain")
            .putExtra(Intent.EXTRA_SUBJECT, "Meine Leseliste aus dem Radio")
            .putExtra(Intent.EXTRA_TEXT, Reading.shareText(state.bookmarks))
        host.activity.startActivity(Intent.createChooser(send, "Leseliste teilen"))
    }

    override fun openSource(url: String) {
        if (!url.startsWith("https://") && !url.startsWith("http://")) return
        runCatching { host.activity.startActivity(Intent(Intent.ACTION_VIEW, android.net.Uri.parse(url))) }.onFailure { state.say("Kein Browser gefunden.") }
    }

    override fun suggestFollow(suggestion: String) {
        if (state.follows.full) return state.say("Du bleibst schon an ${state.follows.max} Themen dran – entferne zuerst eines im Programm.")
        state.followDraft = suggestion
    }

    override fun follow(topic: String) {
        state.followDraft = null
        val clean = topic.trim()
        if (clean.length < 2) return
        host.scope.launch {
            val result = runCatching { api.follow(clean) }
            state.say(result.fold(
                { "📌 Du bleibst an «$clean» dran. Gibt es Neues, kommt es ins Programm." },
                { if (it is ApiException && it.status == 409) "Du bleibst schon an ${state.follows.max} Themen dran." else host.failure(it) },
            ))
            loadFollows()
            host.changed()
        }
    }

    override fun unfollow(id: Long) {
        host.scope.launch {
            runCatching { api.unfollow(id) }.onFailure { state.say(host.failure(it)) }
            loadFollows()
        }
    }
}
