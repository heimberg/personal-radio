package ch.heimberg.radio

import android.app.PendingIntent
import android.content.Intent
import android.net.Uri
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
import androidx.media3.session.MediaSession
import androidx.media3.session.MediaSessionService
import ch.heimberg.radio.core.Connection
import ch.heimberg.radio.core.Feedback
import ch.heimberg.radio.core.FeedbackPolicy
import ch.heimberg.radio.core.ProgramQueue
import ch.heimberg.radio.core.TimelineItem
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
 */
@OptIn(UnstableApi::class)
class PlaybackService : MediaSessionService() {
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main)
    private val queue = ProgramQueue()
    private val durations = HashMap<String, Long>()
    private val reported = HashSet<String>()
    private var session: MediaSession? = null
    private var connection: Connection? = null
    private var api: ApiClient? = null
    private lateinit var player: ExoPlayer
    private lateinit var dataSourceFactory: CacheDataSource.Factory

    override fun onCreate() {
        super.onCreate()
        connection = RadioSettings(this).connection()
        api = connection?.let { ApiClient(it) }

        val http = DefaultHttpDataSource.Factory()
            .setDefaultRequestProperties(connection?.headers() ?: emptyMap())
            .setAllowCrossProtocolRedirects(false)
        dataSourceFactory = CacheDataSource.Factory()
            .setCache(AudioCache.get(this))
            .setUpstreamDataSourceFactory(http)

        player = ExoPlayer.Builder(this)
            .setMediaSourceFactory(DefaultMediaSourceFactory(dataSourceFactory))
            .setAudioAttributes(
                AudioAttributes.Builder().setUsage(C.USAGE_MEDIA).setContentType(C.AUDIO_CONTENT_TYPE_SPEECH).build(),
                /* handleAudioFocus = */ true,
            )
            .setHandleAudioBecomingNoisy(true)
            .setWakeMode(C.WAKE_MODE_NETWORK)
            .build()
        player.addListener(listener)

        val openApp = PendingIntent.getActivity(
            this, 0, Intent(this, MainActivity::class.java), PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT,
        )
        session = MediaSession.Builder(this, player).setSessionActivity(openApp).build()

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
        session?.release()
        session = null
        player.release()
        super.onDestroy()
    }

    /** Fetches the timeline and appends newly ready segments; asks the server to plan if nothing is open. */
    private suspend fun sync() {
        val api = api ?: return
        val items = runCatching { api.timeline() }.getOrElse { return }
        if (items.none { it.isOpen }) runCatching { api.plan() }
        val fresh = queue.takeNew(items)
        if (fresh.isEmpty()) return
        val ranOut = player.playbackState == Player.STATE_ENDED
        val firstNew = player.mediaItemCount
        player.addMediaItems(fresh.map(::mediaItemFor))
        if (ranOut && player.playWhenReady) {
            // The program had run out while listening: continue with the new segment.
            player.seekTo(firstNew, 0)
            player.prepare()
        } else if (player.playbackState == Player.STATE_IDLE) {
            player.prepare()
        }
        prefetch(fresh)
    }

    private fun mediaItemFor(item: TimelineItem): MediaItem = MediaItem.Builder()
        .setMediaId(item.id)
        .setUri(connection!!.resolve(item.audioUrl!!))
        .setMediaMetadata(
            MediaMetadata.Builder()
                .setTitle(item.displayTitle)
                .setArtist(item.showName)
                .setAlbumTitle(getString(R.string.app_name))
                .build(),
        )
        .build()

    /** Downloads upcoming segments into the cache while the network is available. */
    private fun prefetch(items: List<TimelineItem>) {
        val connection = connection ?: return
        scope.launch(Dispatchers.IO) {
            for (item in items.take(4)) {
                runCatching {
                    val spec = DataSpec(Uri.parse(connection.resolve(item.audioUrl!!)))
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

    private val listener = object : Player.Listener {
        override fun onPositionDiscontinuity(oldPosition: Player.PositionInfo, newPosition: Player.PositionInfo, reason: Int) {
            val left = oldPosition.mediaItem ?: return
            if (oldPosition.mediaItemIndex == newPosition.mediaItemIndex) return
            val natural = reason == Player.DISCONTINUITY_REASON_AUTO_TRANSITION
            report(FeedbackPolicy.onLeave(left.mediaId, natural, oldPosition.positionMs, durations[left.mediaId] ?: C.TIME_UNSET))
        }

        override fun onPlaybackStateChanged(playbackState: Int) {
            when (playbackState) {
                Player.STATE_READY -> player.currentMediaItem?.let { if (player.duration != C.TIME_UNSET) durations[it.mediaId] = player.duration }
                Player.STATE_ENDED -> {
                    // The last segment ended on its own; look for the next one right away.
                    player.currentMediaItem?.let { report(FeedbackPolicy.onLeave(it.mediaId, true, 0, 0)) }
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
}
