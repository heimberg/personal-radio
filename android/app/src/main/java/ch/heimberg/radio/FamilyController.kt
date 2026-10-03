package ch.heimberg.radio

import ch.heimberg.radio.core.FamilyMember
import ch.heimberg.radio.core.TimelineItem
import coil.request.ImageRequest
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext

/** «Familie»: members and chat, greetings, sharing, listening along and the own profile picture. */
interface FamilyActions {
    /** Loads members and chat (and marks it read while the tab is open). */
    fun loadFamily()
    fun sendMessage()
    fun greet(member: FamilyMember, text: String)
    fun listenAlong(member: FamilyMember)
    fun share(item: TimelineItem, member: FamilyMember)
    /** Profile picture: from the gallery, from the camera, or none. */
    fun chooseAvatar()
    fun takeAvatar()
    fun removeAvatar()
    /** A picture on the Worker (a profile picture), as Coil loads it: with the connection's headers. */
    fun workerImage(path: String): Any
}

class FamilyController(private val ref: HostRef) : FamilyActions {
    private val host get() = ref.host
    private val state get() = host.state
    private val api get() = host.api

    override fun loadFamily() {
        host.scope.launch {
            runCatching { api.family() }.onSuccess { family ->
                state.family = family
                // Seen while the tab is open: read.
                val last = family.messages.lastOrNull()?.id
                if (state.tab == Tab.FAMILY && last != null && family.unread > 0) {
                    runCatching { api.markRead(last) }
                    state.familyUnread = 0
                } else state.familyUnread = family.unread
            }
        }
    }

    override fun sendMessage() {
        val text = state.familyDraft.trim()
        if (text.isEmpty() || state.familySending) return
        state.familySending = true
        host.scope.launch {
            runCatching { api.sendMessage(text) }
                .onSuccess { state.familyDraft = "" }
                .onFailure { state.say(host.failure(it)) }
            state.familySending = false
            loadFamily()
        }
    }

    override fun greet(member: FamilyMember, text: String) {
        host.scope.launch {
            val result = runCatching { api.greet(member.key, text.trim()) }
            state.say(result.fold({ "Der Gruss an ${member.name} kommt im nächsten Übergang im Radio." }, { host.failure(it) }))
            loadFamily()
        }
    }

    override fun listenAlong(member: FamilyMember) =
        host.serverAction({ api.listenAlong(member.key) }, "«${member.nowPlaying ?: "Das"}» kommt gleich auch bei dir.")

    override fun share(item: TimelineItem, member: FamilyMember) {
        host.scope.launch {
            val result = runCatching { api.share(item.id, member.key) }
            state.say(result.fold({ "Mit ${member.name} geteilt: kommt gleich in ${member.name}s Programm." }, { host.failure(it) }))
            loadFamily()
        }
    }

    override fun chooseAvatar() {
        state.avatarMenuOpen = false
        host.pickAvatar()
    }

    override fun takeAvatar() {
        state.avatarMenuOpen = false
        host.takeAvatarPhoto()
    }

    override fun removeAvatar() {
        state.avatarMenuOpen = false
        host.scope.launch {
            state.say(runCatching { api.removeAvatar() }.fold({ "Profilbild entfernt." }, { host.failure(it) }))
            loadFamily()
        }
    }

    /** A picture from the picker or the camera, made small and square, as the own profile picture. */
    fun uploadAvatar(read: () -> android.graphics.Bitmap?) {
        state.avatarBusy = true
        host.scope.launch {
            val image = withContext(Dispatchers.Default) { read()?.let(AvatarImage::encode) }
            val result = if (image == null) Result.failure(IllegalStateException("Das Bild konnte nicht gelesen werden.")) else runCatching { api.setAvatar(image) }
            state.say(result.fold({ "Profilbild gespeichert." }, { host.failure(it) }))
            state.avatarBusy = false
            loadFamily()
        }
    }

    override fun workerImage(path: String): Any = ImageRequest.Builder(host.activity).data(api.resolve(path))
        .apply { api.headers().forEach { (name, value) -> addHeader(name, value) } }.build()
}
