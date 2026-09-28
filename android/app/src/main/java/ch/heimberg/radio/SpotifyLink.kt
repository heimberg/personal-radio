package ch.heimberg.radio

import android.content.Context
import android.os.Handler
import android.os.Looper
import com.spotify.android.appremote.api.ConnectionParams
import com.spotify.android.appremote.api.Connector
import com.spotify.android.appremote.api.SpotifyAppRemote
import com.spotify.android.appremote.api.error.CouldNotFindSpotifyApp
import com.spotify.android.appremote.api.error.NotLoggedInException
import com.spotify.android.appremote.api.error.UserNotAuthorizedException
import com.spotify.protocol.client.Subscription
import com.spotify.protocol.types.PlayerState

/**
 * Controls the installed Spotify app through App Remote. Only track URIs chosen by the program go to
 * Spotify; what Spotify reports back is used for the handoff and never leaves the device.
 */
class SpotifyLink(private val context: Context) {
    private var remote: SpotifyAppRemote? = null
    private var subscription: Subscription<PlayerState>? = null
    private var connecting = false
    private var attempt = 0
    private val main = Handler(Looper.getMainLooper())

    val connected: Boolean get() = remote?.isConnected == true
    val installed: Boolean get() = SpotifyAppRemote.isSpotifyInstalled(context)

    /**
     * Connects to the Spotify app. [showAuthView] lets Spotify ask for the one-time permission; that
     * needs an activity, so the playback service connects without it.
     */
    fun connect(clientId: String, showAuthView: Boolean, done: (String?) -> Unit) {
        if (connected) return done(null)
        if (connecting) return done(BUSY)
        connecting = true
        val current = ++attempt
        // App Remote never answers when the Spotify app cannot start its service; give up after a while.
        main.postDelayed({
            if (connecting && attempt == current) {
                connecting = false
                attempt++
                done(TIMEOUT)
            }
        }, if (showAuthView) AUTH_TIMEOUT_MS else TIMEOUT_MS)
        val params = ConnectionParams.Builder(clientId)
            .setRedirectUri(REDIRECT_URI)
            .showAuthView(showAuthView)
            .build()
        SpotifyAppRemote.connect(context, params, object : Connector.ConnectionListener {
            override fun onConnected(appRemote: SpotifyAppRemote) {
                // A late success after the timeout still counts; the caller hears about it once more.
                connecting = false
                remote = appRemote
                done(null)
            }

            override fun onFailure(error: Throwable) {
                if (attempt != current) return
                connecting = false
                remote = null
                done(describe(error))
            }
        })
    }

    /** Plays one track and reports Spotify's player state until [stopWatching] or the next [play]. */
    fun play(uri: String, onState: (trackUri: String?, paused: Boolean, positionMs: Long) -> Unit): Boolean {
        val player = remote?.takeIf { it.isConnected }?.playerApi ?: return false
        stopWatching()
        subscription = player.subscribeToPlayerState().setEventCallback { state ->
            onState(state.track?.uri, state.isPaused, state.playbackPosition)
        }
        player.play(uri)
        return true
    }

    fun pause() { remote?.takeIf { it.isConnected }?.playerApi?.pause() }

    fun resume() { remote?.takeIf { it.isConnected }?.playerApi?.resume() }

    fun stopWatching() {
        subscription?.cancel()
        subscription = null
    }

    fun disconnect() {
        stopWatching()
        remote?.let { SpotifyAppRemote.disconnect(it) }
        remote = null
    }

    /** German explanation plus Spotify's own words, which name the exact dashboard problem. */
    private fun describe(error: Throwable): String {
        val hint = when (error) {
            is CouldNotFindSpotifyApp -> "Spotify-App ist nicht installiert."
            is NotLoggedInException -> "In der Spotify-App ist niemand angemeldet."
            is UserNotAuthorizedException -> "Spotify hat den Zugriff nicht erlaubt. Prüfe im Spotify-Dashboard: Redirect-URI personal-radio://spotify-callback, Android-Paket ch.heimberg.radio mit SHA1, dein Konto unter User Management."
            else -> "Spotify nicht erreichbar."
        }
        val detail = (error.message ?: "").replace(Regex("\\s+"), " ").take(200)
        return "$hint (${error.javaClass.simpleName}${if (detail.isNotEmpty()) ": $detail" else ""})"
    }

    companion object {
        /** Registered in the Spotify developer app next to the Android package and its SHA1. */
        const val REDIRECT_URI = "personal-radio://spotify-callback"
        private const val TIMEOUT_MS = 20_000L
        /** Long enough to read and confirm Spotify's permission dialog. */
        private const val AUTH_TIMEOUT_MS = 90_000L
        const val BUSY = "Verbindung zu Spotify läuft schon …"
        const val TIMEOUT = "Spotify antwortet nicht. Öffne die Spotify-App einmal, prüfe die Anmeldung und versuche es erneut."
    }
}
