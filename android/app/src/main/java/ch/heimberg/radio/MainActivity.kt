package ch.heimberg.radio

import android.Manifest
import android.content.ComponentName
import android.content.Intent
import android.content.pm.PackageManager
import android.content.res.ColorStateList
import android.os.Build
import android.os.Bundle
import android.view.View
import android.widget.Button
import android.widget.ArrayAdapter
import android.widget.EditText
import android.text.InputFilter
import android.widget.ImageView
import android.widget.LinearLayout
import android.widget.Spinner
import android.widget.TextView
import android.widget.Toast
import androidx.activity.result.contract.ActivityResultContracts
import androidx.appcompat.app.AppCompatActivity
import androidx.appcompat.app.AlertDialog
import androidx.core.content.ContextCompat
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.lifecycleScope
import androidx.lifecycle.repeatOnLifecycle
import androidx.media3.common.C
import androidx.media3.common.MediaMetadata
import androidx.media3.common.Player
import androidx.media3.session.MediaController
import androidx.media3.session.SessionToken
import ch.heimberg.radio.core.FeedbackPolicy
import ch.heimberg.radio.core.Labels
import ch.heimberg.radio.core.Program
import ch.heimberg.radio.core.TimelineItem
import com.google.android.material.button.MaterialButton
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
    private lateinit var liveDot: View
    private lateinit var orb: OrbView
    private lateinit var progress: WaveformView
    private lateinit var timeView: TextView
    private lateinit var playPause: MaterialButton
    private lateinit var upcomingView: LinearLayout
    private lateinit var upcomingCount: TextView
    private lateinit var upcomingEmpty: TextView
    private lateinit var notice: View
    private lateinit var noticeText: TextView
    private var upcomingItems: List<TimelineItem> = emptyList()
    private var currentItemId: String? = null
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
        liveDot = findViewById(R.id.live_dot)
        orb = findViewById(R.id.orb)
        progress = findViewById(R.id.progress)
        timeView = findViewById(R.id.time)
        playPause = findViewById(R.id.play_pause)
        upcomingView = findViewById(R.id.upcoming)
        upcomingCount = findViewById(R.id.upcoming_count)
        upcomingEmpty = findViewById(R.id.upcoming_empty)
        notice = findViewById(R.id.notice)
        noticeText = findViewById(R.id.notice_text)
        spotifyButton = findViewById(R.id.spotify)
        spotifyStatus = findViewById(R.id.spotify_status)
        // Shown so an installed build can be matched to its CI run.
        findViewById<TextView>(R.id.version).text = getString(R.string.version, runCatching {
            packageManager.getPackageInfo(packageName, 0).versionName
        }.getOrNull() ?: "?")
        spotify = SpotifyLink(this)

        playPause.setOnClickListener { togglePlayback() }
        findViewById<Button>(R.id.next).setOnClickListener { controller?.seekToNextMediaItem() }
        findViewById<Button>(R.id.like).setOnClickListener { rate(true) }
        findViewById<Button>(R.id.dislike).setOnClickListener { rate(false) }
        spotifyButton.setOnClickListener { connectSpotify() }
        findViewById<Button>(R.id.plan).setOnClickListener { planNow() }
        findViewById<Button>(R.id.produce_now).setOnClickListener { chooseShowToProduce() }
        findViewById<Button>(R.id.cockpit).setOnClickListener { startActivity(Intent(this, CockpitActivity::class.java)) }
        findViewById<Button>(R.id.connection).setOnClickListener { startActivity(Intent(this, SetupActivity::class.java)) }

        if (Build.VERSION.SDK_INT >= 33 &&
            ContextCompat.checkSelfPermission(this, Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED
        ) {
            notificationPermission.launch(Manifest.permission.POST_NOTIFICATIONS)
        }

        lifecycleScope.launch {
            repeatOnLifecycle(Lifecycle.State.STARTED) {
                launch {
                    while (true) {
                        renderProgress()
                        delay(500)
                    }
                }
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
        spotifyStatus.visibility = View.VISIBLE
        val clientId = spotifyClientId ?: run {
            spotifyStatus.text = getString(R.string.spotify_not_configured)
            return
        }
        if (!spotify.installed) {
            spotifyStatus.text = getString(R.string.spotify_missing)
            return
        }
        spotifyStatus.text = getString(R.string.spotify_connecting)
        Toast.makeText(this, R.string.spotify_connecting, Toast.LENGTH_SHORT).show()
        spotifyButton.isEnabled = false
        spotify.connect(clientId, showAuthView = true) { error ->
            spotifyButton.isEnabled = true
            spotifyStatus.text = error ?: getString(R.string.spotify_connected)
            Toast.makeText(this, error ?: getString(R.string.spotify_connected), Toast.LENGTH_LONG).show()
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
        playPause.setIconResource(if (player.playWhenReady) R.drawable.ic_pause else R.drawable.ic_play)
        playPause.contentDescription = getString(if (player.playWhenReady) R.string.pause else R.string.play)
        // Live while audio plays or is about to: the dot lights, the orb and the waveform move.
        val live = player.playWhenReady && player.mediaItemCount > 0 &&
            (player.playbackState == Player.STATE_READY || player.playbackState == Player.STATE_BUFFERING)
        orb.active = live
        progress.active = live
        liveDot.backgroundTintList = ColorStateList.valueOf(ContextCompat.getColor(this, if (live) R.color.accent else R.color.neutral_600))
        val playingItem = player.currentMediaItem?.mediaId?.let(Program::itemIdOf)
        if (playingItem != currentItemId) {
            currentItemId = playingItem
            renderUpcoming()
        }
        renderProgress(player)
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

    private fun chooseShowToProduce() {
        lifecycleScope.launch {
            val shows = runCatching { api.shows() }.getOrElse {
                statusView.text = it.message ?: getString(R.string.production_failed)
                return@launch
            }
            if (shows.isEmpty()) {
                statusView.text = getString(R.string.no_shows)
                return@launch
            }

            val labels = shows.map { "${it.name} · ${formatLabel(it.format)}" }
            val picker = Spinner(this@MainActivity).apply {
                adapter = ArrayAdapter(this@MainActivity, android.R.layout.simple_spinner_dropdown_item, labels)
            }
            val subject = EditText(this@MainActivity).apply {
                maxLines = 1
                filters = arrayOf(InputFilter.LengthFilter(200))
                hint = getString(R.string.production_subject_hint)
            }
            val explanation = TextView(this@MainActivity).apply {
                text = getString(R.string.production_subject_optional)
                setPadding(0, 8, 0, 8)
            }
            val content = LinearLayout(this@MainActivity).apply {
                orientation = LinearLayout.VERTICAL
                val inset = (24 * resources.displayMetrics.density).toInt()
                setPadding(inset, 0, inset, 0)
                addView(picker)
                addView(subject)
                addView(explanation)
            }
            fun updateSubjectVisibility() {
                val musicHour = shows.getOrNull(picker.selectedItemPosition)?.format in setOf("artist_hour", "genre_hour", "theme_hour")
                subject.visibility = if (musicHour) View.VISIBLE else View.GONE
                explanation.visibility = if (musicHour) View.VISIBLE else View.GONE
                subject.hint = when (shows.getOrNull(picker.selectedItemPosition)?.format) {
                    "artist_hour" -> getString(R.string.subject_artist)
                    "genre_hour" -> getString(R.string.subject_genre)
                    "theme_hour" -> getString(R.string.subject_theme)
                    else -> getString(R.string.production_subject_hint)
                }
            }
            picker.onItemSelectedListener = object : android.widget.AdapterView.OnItemSelectedListener {
                override fun onItemSelected(parent: android.widget.AdapterView<*>?, view: View?, position: Int, id: Long) = updateSubjectVisibility()
                override fun onNothingSelected(parent: android.widget.AdapterView<*>?) = Unit
            }
            updateSubjectVisibility()

            AlertDialog.Builder(this@MainActivity)
                .setTitle(R.string.produce_now_title)
                .setView(content)
                .setNegativeButton(android.R.string.cancel, null)
                .setPositiveButton(R.string.produce_now_action) { _, _ ->
                    val selected = shows.getOrNull(picker.selectedItemPosition) ?: return@setPositiveButton
                    val requestedSubject = subject.text.toString().trim().takeIf { subject.visibility == View.VISIBLE }.orEmpty()
                    lifecycleScope.launch {
                        statusView.text = getString(R.string.production_starting)
                        statusView.text = runCatching { api.produceNow(selected, requestedSubject) }
                            .fold({ getString(R.string.production_queued, selected.name) }, { it.message ?: getString(R.string.production_failed) })
                        refreshTimeline()
                    }
                }
                .show()
        }
    }

    private fun formatLabel(format: String): String = when (format) {
        "artist_hour" -> getString(R.string.format_artist_hour)
        "genre_hour" -> getString(R.string.format_genre_hour)
        "theme_hour" -> getString(R.string.format_theme_hour)
        "podcast" -> getString(R.string.format_podcast)
        else -> getString(R.string.format_brief)
    }

    private suspend fun refreshTimeline() {
        runCatching { api.response() }
            .onSuccess { timeline ->
                spotifyClientId = timeline.spotify?.clientId
                spotifyButton.visibility = if (spotifyClientId != null) View.VISIBLE else View.GONE
                notice.visibility = View.GONE
                upcomingItems = timeline.items.filter { it.isOpen }.take(12)
                renderUpcoming()
            }
            .onFailure {
                // The access diagnosis says which layer refused (Access or the Worker) and why.
                noticeText.text = it.message ?: getString(R.string.connection_failed)
                notice.visibility = View.VISIBLE
            }
    }

    private fun renderUpcoming() {
        val items = upcomingItems
        upcomingEmpty.visibility = if (items.isEmpty()) View.VISIBLE else View.GONE
        upcomingCount.text = if (items.isEmpty()) "" else resources.getQuantityString(R.plurals.upcoming_count, items.size, items.size)
        upcomingView.removeAllViews()
        val time = DateTimeFormatter.ofPattern("HH:mm").withZone(ZoneId.systemDefault())
        for (item in items) {
            val row = layoutInflater.inflate(R.layout.item_timeline, upcomingView, false)
            val playing = item.id == currentItemId
            row.findViewById<TextView>(R.id.time).text = runCatching { time.format(Instant.parse(item.plannedAt)) }.getOrDefault("")
            row.findViewById<TextView>(R.id.title).apply {
                text = item.displayTitle
                if (playing) setTextColor(ContextCompat.getColor(context, R.color.accent_300))
            }
            val tracks = item.parts.count { it.isTrack }.takeIf { it > 0 }?.let { " · " + getString(R.string.spotify_tracks, it) } ?: ""
            row.findViewById<TextView>(R.id.meta).text = "${item.showName} · ${Labels.state(item.state)}$tracks"
            item.error?.let { error ->
                row.findViewById<TextView>(R.id.error).apply {
                    text = Labels.error(error)
                    visibility = View.VISIBLE
                }
            }
            row.findViewById<ImageView>(R.id.state).apply {
                setImageResource(
                    when {
                        playing -> R.drawable.ic_waveform
                        item.state == "ready" -> R.drawable.ic_check_circle
                        item.state == "voicing" -> R.drawable.ic_waveform
                        else -> R.drawable.ic_clock
                    },
                )
                if (playing || item.state == "ready") imageTintList = ColorStateList.valueOf(ContextCompat.getColor(context, R.color.accent_300))
            }
            upcomingView.addView(row)
        }
    }

    private fun renderProgress(player: Player? = controller) {
        val duration = player?.duration ?: C.TIME_UNSET
        if (player == null || duration == C.TIME_UNSET || duration <= 0) {
            progress.progress = 0f
            timeView.text = ""
            return
        }
        val position = player.currentPosition.coerceIn(0, duration)
        progress.progress = position.toFloat() / duration
        timeView.text = "${clock(position)} / ${clock(duration)}"
    }

    private fun clock(ms: Long): String {
        val seconds = ms / 1000
        return "${seconds / 60}:${(seconds % 60).toString().padStart(2, '0')}"
    }
}
