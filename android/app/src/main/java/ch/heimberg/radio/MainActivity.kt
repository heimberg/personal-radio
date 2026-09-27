package ch.heimberg.radio

import android.Manifest
import android.content.ComponentName
import android.content.Intent
import android.content.pm.PackageManager
import android.os.Build
import android.os.Bundle
import android.view.View
import android.widget.Button
import android.widget.TextView
import androidx.activity.result.contract.ActivityResultContracts
import androidx.appcompat.app.AppCompatActivity
import androidx.core.content.ContextCompat
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.lifecycleScope
import androidx.lifecycle.repeatOnLifecycle
import androidx.media3.common.MediaMetadata
import androidx.media3.common.Player
import androidx.media3.session.MediaController
import androidx.media3.session.SessionToken
import ch.heimberg.radio.core.FeedbackPolicy
import ch.heimberg.radio.core.Labels
import ch.heimberg.radio.core.Program
import ch.heimberg.radio.core.TimelineItem
import com.google.common.util.concurrent.ListenableFuture
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import java.time.Instant
import java.time.ZoneId
import java.time.format.DateTimeFormatter

/** Tune in: what is playing, controls, feedback and what comes next. */
class MainActivity : AppCompatActivity() {
    private lateinit var api: ApiClient
    private var controllerFuture: ListenableFuture<MediaController>? = null
    private val controller: MediaController? get() = controllerFuture?.takeIf { it.isDone && !it.isCancelled }?.let { runCatching { it.get() }.getOrNull() }

    private lateinit var statusView: TextView
    private lateinit var titleView: TextView
    private lateinit var showView: TextView
    private lateinit var playPause: Button
    private lateinit var upcomingView: TextView
    private lateinit var spotifyButton: Button
    private lateinit var spotifyStatus: TextView
    private lateinit var spotify: SpotifyLink
    private var spotifyClientId: String? = null

    private val notificationPermission = registerForActivityResult(ActivityResultContracts.RequestPermission()) { }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        val connection = RadioSettings(this).connection()
        if (connection == null) {
            startActivity(Intent(this, SetupActivity::class.java))
            finish()
            return
        }
        api = ApiClient(connection)
        setContentView(R.layout.activity_main)
        statusView = findViewById(R.id.status)
        titleView = findViewById(R.id.title)
        showView = findViewById(R.id.show)
        playPause = findViewById(R.id.play_pause)
        upcomingView = findViewById(R.id.upcoming)
        spotifyButton = findViewById(R.id.spotify)
        spotifyStatus = findViewById(R.id.spotify_status)
        spotify = SpotifyLink(this)

        playPause.setOnClickListener { togglePlayback() }
        findViewById<Button>(R.id.next).setOnClickListener { controller?.seekToNextMediaItem() }
        findViewById<Button>(R.id.like).setOnClickListener { rate(true) }
        findViewById<Button>(R.id.dislike).setOnClickListener { rate(false) }
        spotifyButton.setOnClickListener { connectSpotify() }
        findViewById<Button>(R.id.plan).setOnClickListener { planNow() }
        findViewById<Button>(R.id.cockpit).setOnClickListener { startActivity(Intent(this, CockpitActivity::class.java)) }
        findViewById<Button>(R.id.connection).setOnClickListener { startActivity(Intent(this, SetupActivity::class.java)) }

        if (Build.VERSION.SDK_INT >= 33 &&
            ContextCompat.checkSelfPermission(this, Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED
        ) {
            notificationPermission.launch(Manifest.permission.POST_NOTIFICATIONS)
        }

        lifecycleScope.launch {
            repeatOnLifecycle(Lifecycle.State.STARTED) {
                while (true) {
                    refreshTimeline()
                    delay(30_000)
                }
            }
        }
    }

    override fun onStart() {
        super.onStart()
        if (!::api.isInitialized) return
        val token = SessionToken(this, ComponentName(this, PlaybackService::class.java))
        val future = MediaController.Builder(this, token).buildAsync()
        controllerFuture = future
        future.addListener({
            controller?.let { player ->
                player.addListener(playerListener)
                renderPlayer(player)
            }
        }, ContextCompat.getMainExecutor(this))
    }

    override fun onStop() {
        controllerFuture?.let { MediaController.releaseFuture(it) }
        controllerFuture = null
        if (::spotify.isInitialized) spotify.disconnect()
        super.onStop()
    }

    /**
     * Asks Spotify once for permission to control it (Spotify shows its own dialog). Afterwards the
     * playback service connects on its own and artist hours play with their music.
     */
    private fun connectSpotify() {
        val clientId = spotifyClientId ?: return
        spotifyStatus.visibility = View.VISIBLE
        if (!spotify.installed) {
            spotifyStatus.text = getString(R.string.spotify_missing)
            return
        }
        spotifyStatus.text = getString(R.string.spotify_connecting)
        spotifyButton.isEnabled = false
        spotify.connect(clientId, showAuthView = true) { error ->
            spotifyButton.isEnabled = true
            spotifyStatus.text = error ?: getString(R.string.spotify_connected)
            if (error == null) {
                spotifyButton.text = getString(R.string.spotify_connected_button)
                lifecycleScope.launch { refreshTimeline() }
            }
        }
    }

    private val playerListener = object : Player.Listener {
        override fun onEvents(player: Player, events: Player.Events) = renderPlayer(player)
    }

    private fun renderPlayer(player: Player) {
        val metadata: MediaMetadata = player.mediaMetadata
        titleView.text = metadata.title ?: getString(R.string.nothing_playing)
        showView.text = metadata.artist ?: ""
        playPause.text = getString(if (player.playWhenReady) R.string.pause else R.string.play)
        statusView.text = getString(
            when {
                player.mediaItemCount == 0 -> R.string.status_waiting
                player.playbackState == Player.STATE_BUFFERING -> R.string.status_buffering
                player.playbackState == Player.STATE_ENDED -> R.string.status_ended
                player.isPlaying -> R.string.status_playing
                else -> R.string.status_paused
            },
        )
    }

    private fun togglePlayback() {
        val player = controller ?: return
        if (player.mediaItemCount == 0) {
            statusView.text = getString(R.string.status_waiting)
            planNow()
            return
        }
        if (player.playWhenReady) {
            player.pause()
        } else {
            if (player.playbackState == Player.STATE_IDLE) player.prepare()
            player.play()
        }
    }

    private fun rate(liked: Boolean) {
        val id = controller?.currentMediaItem?.mediaId?.let(Program::itemIdOf) ?: return
        lifecycleScope.launch {
            val result = runCatching { api.send(FeedbackPolicy.rating(id, liked)) }
            statusView.text = result.fold({ getString(if (liked) R.string.liked else R.string.disliked) }, { it.message ?: "" })
        }
    }

    private fun planNow() {
        lifecycleScope.launch {
            statusView.text = runCatching { api.plan() }.fold({ getString(R.string.planned) }, { it.message ?: "" })
            refreshTimeline()
        }
    }

    private suspend fun refreshTimeline() {
        runCatching { api.response() }
            .onSuccess { timeline ->
                spotifyClientId = timeline.spotify?.clientId
                spotifyButton.visibility = if (spotifyClientId != null) View.VISIBLE else View.GONE
                upcomingView.text = describe(timeline.items.filter { it.isOpen }.take(12))
            }
            .onFailure { upcomingView.text = it.message }
    }

    private fun describe(items: List<TimelineItem>): String {
        if (items.isEmpty()) return getString(R.string.nothing_planned)
        val time = DateTimeFormatter.ofPattern("HH:mm").withZone(ZoneId.systemDefault())
        return items.joinToString("\n\n") { item ->
            val planned = runCatching { time.format(Instant.parse(item.plannedAt)) }.getOrDefault("")
            val error = item.error?.let { "\n" + Labels.error(it) } ?: ""
            val tracks = item.parts.count { it.isTrack }.takeIf { it > 0 }?.let { " · " + getString(R.string.spotify_tracks, it) } ?: ""
            "$planned  ${item.displayTitle}\n${item.showName} · ${Labels.state(item.state)}$tracks$error"
        }
    }
}
