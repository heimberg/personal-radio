package ch.heimberg.radio

import androidx.activity.ComponentActivity
import androidx.media3.session.MediaController
import kotlinx.coroutines.CoroutineScope

/**
 * What the area controllers (studio, voices, family, Mitmachen, day plan) need from the activity: the
 * connection to the Worker, the shared state, a scope that ends with the activity, the player and a few
 * things only the activity can do. The activity implements it; the controllers reach it through [HostRef],
 * because they are created before the activity is.
 */
interface RadioHost {
    val activity: ComponentActivity
    val api: ApiClient
    val state: RadioState
    val scope: CoroutineScope
    /** The playback service's controller, once connected. */
    val player: MediaController?
    /** All actions, for a controller that triggers one of another area (play an answer, open the album). */
    val actions: RadioActions
    /** Reloads the program, the series and the player's queue after a change on the server. */
    suspend fun changed()
    /** Runs [action] on the server, says [done] or the error, then reloads. */
    fun serverAction(action: suspend () -> Unit, done: String)
    /** The item that plays now, if any. */
    fun currentId(): String?
    /** The system pickers: they must be registered by the activity. */
    fun requestMicrophone()
    fun pickAvatar()
    fun takeAvatarPhoto()
    fun startDictation()
}

/** Lets a controller be created before the activity that hosts it; [host] is set in the activity's init. */
class HostRef {
    lateinit var host: RadioHost
}

/** The error's message, or the generic «no connection». */
fun RadioHost.failure(error: Throwable): String = error.message ?: activity.getString(R.string.connection_failed)

/** A light confirming tap, as for adding, choosing and rating. */
fun RadioHost.confirm() {
    activity.window.decorView.performHapticFeedback(android.view.HapticFeedbackConstants.CONFIRM)
}
