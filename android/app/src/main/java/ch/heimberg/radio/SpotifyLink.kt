package ch.heimberg.radio

import android.content.Context
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

    val connected: Boolean get() = remote?.isConnected == true
    val installed: Boolean get() = SpotifyAppRemote.isSpotifyInstalled(context)

    /**
     * Connects to the Spotify app. [showAuthView] lets Spotify ask for the one-time permission; that
     * needs an activity, so the playback service connects without it.
     */
    fun connect(clientId: String, showAuthView: Boolean, done: (String?) -> Unit) {
        if (connected) return done(null)
        if (connecting) return
        connecting = true
        val params = ConnectionParams.Builder(clientId)
            .setRedirectUri(REDIRECT_URI)
            .showAuthView(showAuthView)
            .build()
        SpotifyAppRemote.connect(context, params, object : Connector.ConnectionListener {
            override fun onConnected(appRemote: SpotifyAppRemote) {
                connecting = false
                remote = appRemote
                done(null)
            }

            override fun onFailure(error: Throwable) {
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

    private fun describe(error: Throwable): String = when (error) {
        is CouldNotFindSpotifyApp -> "Spotify-App ist nicht installiert."
        is NotLoggedInException -> "In der Spotify-App ist niemand angemeldet."
        is UserNotAuthorizedException -> "Spotify hat den Zugriff nicht erlaubt. Prüfe Paketname, SHA1 und Redirect-URI im Spotify-Dashboard."
        else -> "Spotify nicht erreichbar: ${error.message ?: error.javaClass.simpleName}"
    }

    companion object {
        /** Registered in the Spotify developer app next to the Android package and its SHA1. */
        const val REDIRECT_URI = "personal-radio://spotify-callback"
    }
}
