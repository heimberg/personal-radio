package ch.heimberg.radio

import android.app.PendingIntent
import android.content.Intent
import android.net.Uri
import android.os.Bundle
import android.os.SystemClock
import androidx.annotation.OptIn
import androidx.media3.common.AudioAttributes
import androidx.media3.common.C
import androidx.media3.common.MediaItem
import androidx.media3.common.MediaMetadata
import androidx.media3.common.PlaybackException
import androidx.media3.common.Player
import androidx.media3.common.util.UnstableApi
import androidx.media3.datasource.DataSpec
import androidx.media3.datasource.DefaultHttpDataSource
import androidx.media3.datasource.cache.CacheDataSource
import androidx.media3.datasource.cache.CacheWriter
import androidx.media3.exoplayer.ExoPlayer
import androidx.media3.exoplayer.source.DefaultMediaSourceFactory
import androidx.media3.exoplayer.source.MediaSource
import androidx.media3.exoplayer.source.SilenceMediaSource
import androidx.media3.session.MediaSession
import androidx.media3.session.MediaSessionService
import androidx.media3.session.SessionCommand
import androidx.media3.session.SessionResult
import ch.heimberg.radio.core.Connection
import ch.heimberg.radio.core.Feedback
import ch.heimberg.radio.core.FeedbackPolicy
import ch.heimberg.radio.core.Program
import ch.heimberg.radio.core.ProgramQueue
import ch.heimberg.radio.core.SpeechStep
import ch.heimberg.radio.core.Step
import ch.heimberg.radio.core.TimelineItem
import ch.heimberg.radio.core.TimelineJson
import ch.heimberg.radio.core.TrackStep
import ch.heimberg.radio.core.TrackWatch
import com.google.common.util.concurrent.Futures
import com.google.common.util.concurrent.ListenableFuture
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.delay
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch

/**
 * Plays the program: ready segments from the Worker are appended to one ExoPlayer playlist as they
 * are produced. The media session gives lock-screen, notification and Bluetooth controls; playback
 * continues with the screen off because this is a foreground media service.
 *
 * Spotify tracks of an artist hour sit in the same playlist as silent placeholders with the track's
 * title, so the notification, pause and "next" work the same for speech and music. While a
 * placeholder is current, the Spotify app plays the track through App Remote and our player gives up
 * audio focus; when Spotify reports the track's end, the playlist moves on to the next spoken part.
 *
 * The app can ask for any production to play right away ([PLAY_ITEM], from the program list or the
 * archive). It plays after the current step; the program then continues where the sync puts it.
 */
@OptIn(UnstableApi::class)
class PlaybackService : MediaSessionService() {
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main)
    private val queue = ProgramQueue()
    private val steps = HashMap<String, Step>()
    private val durations = HashMap<String, Long>()
    private val reported = HashSet<String>()
    private var session: MediaSession? = null
    private var connection: Connection? = null
    private var api: ApiClient? = null
    private lateinit var player: ExoPlayer
    private lateinit var dataSourceFactory: CacheDataSource.Factory

    private lateinit var spotify: SpotifyLink
    private var spotifyClientId: String? = null
    private var lastSpotifyAttempt = 0L
    private var watch: TrackWatch? = null
    private var handingBack = false
    private var holdsFocus = true
    /** True while jumping to a chosen production: the item left behind is neither rated nor dropped. */
    private var jumping = false

    override fun onCreate() {
        super.onCreate()
        connection = RadioSettings(this).connection()
        api = connection?.let { ApiClient(it) }
        spotify = SpotifyLink(this)

        val http = DefaultHttpDataSource.Factory()
            .setDefaultRequestProperties(connection?.headers() ?: emptyMap())
            .setAllowCrossProtocolRedirects(false)
        dataSourceFactory = CacheDataSource.Factory()
            .setCache(AudioCache.get(this))
            .setUpstreamDataSourceFactory(http)

        player = ExoPlayer.Builder(this)
            .setMediaSourceFactory(ProgramSourceFactory(DefaultMediaSourceFactory(dataSourceFactory)))
            .setAudioAttributes(AUDIO, /* handleAudioFocus = */ true)
            .setHandleAudioBecomingNoisy(true)
            .setWakeMode(C.WAKE_MODE_NETWORK)
            .build()
        player.addListener(listener)

        val openApp = PendingIntent.getActivity(
            this, 0, Intent(this, MainActivity::class.java), PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT,
        )
        session = MediaSession.Builder(this, player).setSessionActivity(openApp).setCallback(sessionCallback).build()

        scope.launch {
            while (isActive) {
                sync()
                delay(60_000)
            }
        }
    }

    override fun onGetSession(controllerInfo: MediaSession.ControllerInfo): MediaSession? = session

    override fun onTaskRemoved(rootIntent: Intent?) {
        // Keep playing when the app is swiped away; stop only if nothing is playing.
        if (!player.playWhenReady || player.mediaItemCount == 0) stopSelf()
    }

    override fun onDestroy() {
        scope.cancel()
        if (watch != null) spotify.pause()
        spotify.disconnect()
        session?.release()
        session = null
        player.release()
        super.onDestroy()
    }

    /**
     * Fetches the timeline and makes the playlist after the current item follow the program order: newly
     * produced items are added, and items moved, removed or shuffled in the cockpit are rearranged. The
     * item that is playing is never touched. Asks the server to plan if nothing is open.
     */
    private suspend fun sync() {
        val api = api ?: return
        val timeline = runCatching { api.response() }.getOrElse { return }
        val items = timeline.items
        spotifyClientId = timeline.spotify?.clientId
        if (items.none { it.isOpen }) runCatching { api.plan() }
        if (items.any { it.isPlayable && it.hasMusic }) connectSpotify()
        val currentItem = player.currentMediaItem?.mediaId?.let(Program::itemIdOf)
        val wanted = queue.upcoming(items, musicAvailable = spotify.connected, current = currentItem)
        // The playlist after the current item's own parts.
        var firstUpcoming = if (player.mediaItemCount == 0) 0 else player.currentMediaItemIndex + 1
        while (firstUpcoming < player.mediaItemCount && Program.itemIdOf(player.getMediaItemAt(firstUpcoming).mediaId) == currentItem) firstUpcoming++
        val present = (firstUpcoming until player.mediaItemCount).map { Program.itemIdOf(player.getMediaItemAt(it).mediaId) }.distinct()
        if (queue.matches(present, wanted)) return
        val newSteps = wanted.flatMap(Program::steps)
        newSteps.forEach { steps[it.mediaId] = it }
        val ranOut = player.playbackState == Player.STATE_ENDED
        if (firstUpcoming < player.mediaItemCount) player.removeMediaItems(firstUpcoming, player.mediaItemCount)
        val firstNew = player.mediaItemCount
        player.addMediaItems(newSteps.map(::mediaItemFor))
        if (newSteps.isEmpty()) return
        if (ranOut && player.playWhenReady) {
            // The program had run out while listening: continue with the new segment.
            player.seekTo(firstNew, 0)
            player.prepare()
        } else if (player.playbackState == Player.STATE_IDLE) {
            player.prepare()
        }
        prefetch(newSteps.filterIsInstance<SpeechStep>())
    }

    /**
     * Plays [item] now: its steps replace the rest of the playlist after the current item and playback
     * jumps there. An interrupted program item is not marked as passed, so the next sync queues it again.
     */
    private fun playNow(item: TimelineItem) {
        val newSteps = Program.steps(item)
        if (newSteps.isEmpty()) return
        newSteps.forEach { steps[it.mediaId] = it }
        // Heard again: the server decides whether it counts (only unheard items are rated as listened).
        reported.remove(item.id)
        if (item.hasMusic) connectSpotify()
        val currentItem = player.currentMediaItem?.mediaId?.let(Program::itemIdOf)
        var insertAt = if (player.mediaItemCount == 0) 0 else player.currentMediaItemIndex + 1
        while (insertAt < player.mediaItemCount && Program.itemIdOf(player.getMediaItemAt(insertAt).mediaId) == currentItem) insertAt++
        if (insertAt < player.mediaItemCount) player.removeMediaItems(insertAt, player.mediaItemCount)
        player.addMediaItems(insertAt, newSteps.map(::mediaItemFor))
        jumping = true
        try {
            player.seekTo(insertAt, 0)
        } finally {
            jumping = false
        }
        if (player.playbackState == Player.STATE_IDLE || player.playbackState == Player.STATE_ENDED) player.prepare()
        player.play()
        scope.launch { sync() }
    }

    private val sessionCallback = object : MediaSession.Callback {
        override fun onConnect(session: MediaSession, controller: MediaSession.ControllerInfo): MediaSession.ConnectionResult {
            val commands = MediaSession.ConnectionResult.DEFAULT_SESSION_COMMANDS.buildUpon().add(PLAY_ITEM).build()
            return MediaSession.ConnectionResult.AcceptedResultBuilder(session).setAvailableSessionCommands(commands).build()
        }

        override fun onCustomCommand(
            session: MediaSession,
            controller: MediaSession.ControllerInfo,
            customCommand: SessionCommand,
            args: Bundle,
        ): ListenableFuture<SessionResult> {
            if (customCommand.customAction != PLAY_ITEM.customAction) return super.onCustomCommand(session, controller, customCommand, args)
            val item = args.getString(EXTRA_ITEM)?.let { runCatching { TimelineJson.parseItem(it) }.getOrNull() }
                ?: return Futures.immediateFuture(SessionResult(SessionResult.RESULT_ERROR_BAD_VALUE))
            playNow(item)
            return Futures.immediateFuture(SessionResult(SessionResult.RESULT_SUCCESS))
        }
    }

    /** Connects in the background; the one-time permission is granted with "Spotify verbinden" in the app. */
    private fun connectSpotify() {
        val clientId = spotifyClientId ?: return
        if (spotify.connected || !spotify.installed) return
        val now = SystemClock.elapsedRealtime()
        if (lastSpotifyAttempt != 0L && now - lastSpotifyAttempt < SPOTIFY_RETRY_MS) return
        lastSpotifyAttempt = now
        spotify.connect(clientId, showAuthView = false) { error ->
            if (error == null) scope.launch { sync() }
        }
    }

    private fun mediaItemFor(step: Step): MediaItem {
        val metadata = MediaMetadata.Builder()
            .setTitle(step.title)
            .setArtist(step.subtitle)
            .setAlbumTitle(getString(R.string.app_name))
        val uri = when (step) {
            is SpeechStep -> connection!!.resolve(step.audioUrl)
            is TrackStep -> {
                metadata.setDurationMs(step.durationMs)
                step.spotifyUri
            }
        }
        return MediaItem.Builder().setMediaId(step.mediaId).setUri(uri).setMediaMetadata(metadata.build()).build()
    }

    /** Downloads upcoming spoken segments into the cache while the network is available. */
    private fun prefetch(items: List<SpeechStep>) {
        val connection = connection ?: return
        scope.launch(Dispatchers.IO) {
            for (item in items.take(4)) {
                runCatching {
                    val spec = DataSpec(Uri.parse(connection.resolve(item.audioUrl)))
                    CacheWriter(dataSourceFactory.createDataSource(), spec, null, null).cache()
                }
            }
        }
    }

    private fun report(feedback: Feedback) {
        if (!reported.add(feedback.itemId)) return
        val api = api ?: return
        scope.launch { runCatching { api.send(feedback) } }
    }

    /** Feedback belongs to the whole item; for an artist hour it is sent when its last part is left. */
    private fun reportLeaving(mediaId: String, natural: Boolean, positionMs: Long) {
        val step = steps[mediaId] ?: return
        if (!step.last) return
        report(FeedbackPolicy.onLeave(step.itemId, natural, positionMs, durations[mediaId] ?: C.TIME_UNSET))
    }

    private fun currentStep(): Step? = player.currentMediaItem?.mediaId?.let(steps::get)

    /** Called whenever the current playlist entry changes or playback starts or stops. */
    private fun follow() {
        val step = currentStep()
        if (step !is TrackStep) {
            stopTrack()
            handleFocus(true)
            return
        }
        // Spotify takes audio focus for the track; our silent placeholder must not pause because of it.
        handleFocus(false)
        val current = watch
        when {
            !player.playWhenReady -> if (current != null) spotify.pause()
            current == null || current.uri != step.spotifyUri -> startTrack(step)
            else -> spotify.resume()
        }
    }

    private fun handleFocus(handle: Boolean) {
        if (holdsFocus == handle) return
        holdsFocus = handle
        player.setAudioAttributes(AUDIO, handle)
    }

    private fun startTrack(step: TrackStep) {
        val trackWatch = TrackWatch(step.spotifyUri, step.durationMs)
        watch = trackWatch
        val started = spotify.play(step.spotifyUri) { uri, paused, position ->
            if (watch !== trackWatch) return@play
            when {
                trackWatch.ended(uri, paused, position) -> handBack()
                uri != step.spotifyUri -> Unit
                // Spotify paused or resumed on its own (a call, its own controls): follow it.
                paused && player.playWhenReady && position > 0 -> player.pause()
                !paused && !player.playWhenReady -> player.play()
            }
        }
        if (!started) {
            // Spotify disconnected meanwhile: skip the track rather than play silence.
            watch = null
            connectSpotify()
            if (player.hasNextMediaItem()) player.seekToNextMediaItem()
        }
    }

    /** The Spotify track is over: pause Spotify at once and continue with the next spoken part. */
    private fun handBack() {
        stopTrack()
        handingBack = true
        if (player.hasNextMediaItem()) {
            player.seekToNextMediaItem()
        } else {
            player.seekTo(player.duration.takeIf { it != C.TIME_UNSET } ?: 0)
        }
        handingBack = false
    }

    private fun stopTrack() {
        if (watch == null) return
        watch = null
        spotify.stopWatching()
        spotify.pause()
    }

    private val listener = object : Player.Listener {
        override fun onPositionDiscontinuity(oldPosition: Player.PositionInfo, newPosition: Player.PositionInfo, reason: Int) {
            val left = oldPosition.mediaItem ?: return
            if (oldPosition.mediaItemIndex == newPosition.mediaItemIndex || jumping) return
            val natural = reason == Player.DISCONTINUITY_REASON_AUTO_TRANSITION || handingBack
            reportLeaving(left.mediaId, natural, oldPosition.positionMs)
            val leftItem = Program.itemIdOf(left.mediaId)
            if (leftItem != newPosition.mediaItem?.mediaId?.let(Program::itemIdOf)) queue.markPassed(leftItem)
        }

        override fun onMediaItemTransition(mediaItem: MediaItem?, reason: Int) = follow()

        override fun onPlayWhenReadyChanged(playWhenReady: Boolean, reason: Int) = follow()

        override fun onPlaybackStateChanged(playbackState: Int) {
            when (playbackState) {
                Player.STATE_READY -> player.currentMediaItem?.let {
                    if (player.duration != C.TIME_UNSET && steps[it.mediaId] is SpeechStep) durations[it.mediaId] = player.duration
                }
                Player.STATE_ENDED -> {
                    // The last segment ended on its own; look for the next one right away.
                    stopTrack()
                    player.currentMediaItem?.let {
                        reportLeaving(it.mediaId, true, 0)
                        queue.markPassed(Program.itemIdOf(it.mediaId))
                    }
                    scope.launch { sync() }
                }
                else -> Unit
            }
        }

        override fun onPlayerError(error: PlaybackException) {
            // A segment that cannot be loaded is skipped instead of stopping the program.
            if (player.hasNextMediaItem()) {
                player.seekToNextMediaItem()
                player.prepare()
            }
        }
    }

    /** Spoken parts stream from the Worker; Spotify tracks become silence of the track's length plus a margin. */
    private class ProgramSourceFactory(private val audio: MediaSource.Factory) : MediaSource.Factory by audio {
        override fun createMediaSource(mediaItem: MediaItem): MediaSource {
            if (mediaItem.localConfiguration?.uri?.scheme != "spotify") return audio.createMediaSource(mediaItem)
            val durationMs = (mediaItem.mediaMetadata.durationMs ?: 0L) + SPOTIFY_MARGIN_MS
            return SilenceMediaSource(durationMs * 1_000).apply { updateMediaItem(mediaItem) }
        }
    }

    companion object {
        /** Custom session command: play the production in [EXTRA_ITEM] (a timeline item as JSON) now. */
        val PLAY_ITEM = SessionCommand("ch.heimberg.radio.PLAY_ITEM", Bundle.EMPTY)
        const val EXTRA_ITEM = "item"

        private val AUDIO = AudioAttributes.Builder().setUsage(C.USAGE_MEDIA).setContentType(C.AUDIO_CONTENT_TYPE_SPEECH).build()

        /** Spotify reports the end; the placeholder only runs out if Spotify never does. */
        private const val SPOTIFY_MARGIN_MS = 60_000L
        private const val SPOTIFY_RETRY_MS = 2 * 60_000L
    }
}
