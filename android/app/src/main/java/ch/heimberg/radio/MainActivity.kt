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
import android.widget.EditText
import android.text.InputFilter
import android.widget.LinearLayout
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
import androidx.media3.session.SessionResult
import androidx.recyclerview.widget.LinearLayoutManager
import androidx.recyclerview.widget.RecyclerView
import androidx.swiperefreshlayout.widget.SwipeRefreshLayout
import androidx.media3.session.SessionToken
import ch.heimberg.radio.core.FeedbackPolicy
import ch.heimberg.radio.core.Program
import ch.heimberg.radio.core.TimelineItem
import ch.heimberg.radio.core.TimelineJson
import com.google.android.material.button.MaterialButton
import com.google.common.util.concurrent.ListenableFuture
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch

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
    private lateinit var upcomingView: RecyclerView
    private val program = ProgramAdapter(onPlay = { playItem(it) }, onArranged = { arrange(it) })
    private lateinit var upcomingCount: TextView
    private lateinit var upcomingEmpty: TextView
    private lateinit var notice: View
    private lateinit var noticeText: TextView
    private var upcomingItems: List<TimelineItem> = emptyList()
    private var lastMinute = -1L
    private var currentItemId: String? = null
    /** Chosen in the archive while the player connection is being rebuilt; sent once it is connected. */
    private var pendingPlay: TimelineItem? = null
    private lateinit var spotifyButton: Button
    private lateinit var spotifyStatus: TextView
    private lateinit var spotify: SpotifyLink
    private var spotifyClientId: String? = null

    private val notificationPermission = registerForActivityResult(ActivityResultContracts.RequestPermission()) { }

    /** The archive hands back the production to play. */
    private val archive = registerForActivityResult(ActivityResultContracts.StartActivityForResult()) { result ->
        result.data?.getStringExtra(LibraryActivity.EXTRA_ITEM)
            ?.let { runCatching { TimelineJson.parseItem(it) }.getOrNull() }
            ?.let(::playItem)
    }

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
        upcomingView = findViewById<RecyclerView>(R.id.upcoming).apply {
            layoutManager = LinearLayoutManager(this@MainActivity)
            adapter = program
            // The page scrolls as a whole; the list shows all its rows.
            isNestedScrollingEnabled = false
        }
        program.touchHelper.attachToRecyclerView(upcomingView)
        findViewById<SwipeRefreshLayout>(R.id.refresh).apply {
            setColorSchemeResources(R.color.accent)
            setOnRefreshListener {
                lifecycleScope.launch {
                    refreshTimeline()
                    controller?.takeIf { it.isSessionCommandAvailable(PlaybackService.SYNC) }?.sendCustomCommand(PlaybackService.SYNC, Bundle.EMPTY)
                    isRefreshing = false
                }
            }
        }
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
        findViewById<Button>(R.id.transcript).setOnClickListener { openTranscript() }
        titleView.setOnClickListener { openTranscript() }
        findViewById<Button>(R.id.dislike).setOnClickListener { rate(false) }
        spotifyButton.setOnClickListener { connectSpotify() }
        findViewById<Button>(R.id.produce_now).setOnClickListener { chooseShowToProduce() }
        findViewById<Button>(R.id.archive).setOnClickListener { archive.launch(Intent(this, LibraryActivity::class.java)) }
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
                        // Start times say when an item would begin from now; they move on every minute.
                        val minute = System.currentTimeMillis() / 60_000
                        if (minute != lastMinute) {
                            lastMinute = minute
                            program.refreshTimes(currentRemainingMs())
                        }
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
            val player = controller
            if (player == null) {
                // The connection failed: a waiting choice cannot be played.
                if (pendingPlay != null) statusView.text = getString(R.string.play_unavailable)
                pendingPlay = null
                return@addListener
            }
            player.addListener(playerListener)
            renderPlayer(player)
            pendingPlay?.let {
                pendingPlay = null
                playItem(it)
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
                RadioSettings(this).spotifyLinked = true
                spotifyButton.visibility = View.GONE
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
        statusView.performHapticFeedback(android.view.HapticFeedbackConstants.CONFIRM)
        lifecycleScope.launch {
            val result = runCatching { api.send(FeedbackPolicy.rating(id, liked)) }
            statusView.text = result.fold({ getString(if (liked) R.string.liked else R.string.disliked) }, { it.message ?: "" })
        }
    }

    /** Asks the playback service to play [item] now; the program continues afterwards. */
    private fun playItem(item: TimelineItem) {
        // Coming back from the archive, the connection to the player is released (onStop) or still being
        // rebuilt (onStart): keep the choice and send it as soon as the controller is connected.
        val future = controllerFuture
        if (future == null || !future.isDone) {
            pendingPlay = item
            return
        }
        val player = controller
        if (player == null || !player.isSessionCommandAvailable(PlaybackService.PLAY_ITEM)) {
            Toast.makeText(this, R.string.play_unavailable, Toast.LENGTH_SHORT).show()
            return
        }
        val args = Bundle().apply { putString(PlaybackService.EXTRA_ITEM, TimelineJson.encodeItem(item)) }
        val result = player.sendCustomCommand(PlaybackService.PLAY_ITEM, args)
        result.addListener({
            val ok = runCatching { result.get().resultCode == SessionResult.RESULT_SUCCESS }.getOrDefault(false)
            statusView.text = if (ok) getString(R.string.playing_now, item.displayTitle) else getString(R.string.play_unavailable)
        }, ContextCompat.getMainExecutor(this))
    }

    /** Text and sources of what is playing. */
    private fun openTranscript() {
        val player = controller ?: return
        val itemId = player.currentMediaItem?.mediaId?.let(Program::itemIdOf) ?: run {
            Toast.makeText(this, R.string.nothing_playing, Toast.LENGTH_SHORT).show()
            return
        }
        TranscriptActivity.open(this, itemId, player.mediaMetadata.title?.toString() ?: "")
    }

    private fun planNow() {
        lifecycleScope.launch {
            statusView.text = runCatching { api.plan() }.fold({ getString(R.string.planned) }, { it.message ?: "" })
            refreshTimeline()
        }
    }

    /** One tap on a show produces it; music hours first ask for an optional subject. */
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
            AlertDialog.Builder(this@MainActivity)
                .setTitle(R.string.produce_now_title)
                .setItems(shows.map { "${it.name} · ${formatLabel(it.format)}" }.toTypedArray()) { _, which ->
                    val show = shows[which]
                    if (show.format in MUSIC_HOURS) askSubject(show) else produce(show, "")
                }
                .setNegativeButton(android.R.string.cancel, null)
                .show()
        }
    }

    private fun askSubject(show: ApiClient.ShowOption) {
        val subject = EditText(this).apply {
            maxLines = 1
            filters = arrayOf(InputFilter.LengthFilter(200))
            hint = getString(
                when (show.format) {
                    "artist_hour" -> R.string.subject_artist
                    "genre_hour" -> R.string.subject_genre
                    else -> R.string.subject_theme
                },
            )
        }
        val content = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            val inset = (24 * resources.displayMetrics.density).toInt()
            setPadding(inset, inset / 3, inset, 0)
            addView(TextView(context).apply { text = getString(R.string.produce_subject_intro) })
            addView(subject)
        }
        AlertDialog.Builder(this)
            .setTitle(show.name)
            .setView(content)
            .setNegativeButton(android.R.string.cancel, null)
            .setPositiveButton(R.string.produce_now_action) { _, _ -> produce(show, subject.text.toString().trim()) }
            .show()
    }

    private fun produce(show: ApiClient.ShowOption, subject: String) {
        lifecycleScope.launch {
            statusView.text = getString(R.string.production_starting)
            statusView.text = runCatching { api.produceNow(show, subject) }
                .fold({ getString(R.string.production_queued, show.name) }, { it.message ?: getString(R.string.production_failed) })
            refreshTimeline()
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
                // Needed once: after the owner allowed it, the playback service connects on its own.
                spotifyButton.visibility = if (spotifyClientId != null && !RadioSettings(this).spotifyLinked) View.VISIBLE else View.GONE
                notice.visibility = View.GONE
                // All open items: a new order always covers the whole program.
                upcomingItems = timeline.items.filter { it.isOpen }
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
        program.submit(items, currentItemId, currentRemainingMs())
    }

    /** How long the playing item still runs: the rest of this step plus its later parts (songs, spoken parts). */
    private fun currentRemainingMs(): Long? {
        val player = controller ?: return null
        val itemId = player.currentMediaItem?.mediaId?.let(Program::itemIdOf) ?: return null
        val item = upcomingItems.firstOrNull { it.id == itemId }
        var remaining = player.duration.takeIf { it != C.TIME_UNSET && it > 0 }?.let { it - player.currentPosition.coerceAtLeast(0) } ?: return null
        val steps = (0 until player.mediaItemCount).filter { Program.itemIdOf(player.getMediaItemAt(it).mediaId) == itemId }
        val later = steps.filter { it > player.currentMediaItemIndex }
        // Spoken parts not loaded yet: an even share of the item's estimated length.
        val perStep = item?.let { (it.estimatedMinutes * 60_000 / steps.size.coerceAtLeast(1)).toLong() } ?: 60_000L
        for (index in later) remaining += player.getMediaItemAt(index).mediaMetadata.durationMs ?: perStep
        return remaining
    }

    /** Saves a new order from the list; the player follows it right away. */
    private fun arrange(items: List<TimelineItem>) {
        lifecycleScope.launch {
            val result = runCatching { api.arrange(items.map { it.id }) }
            statusView.text = result.fold(
                { getString(R.string.arrange_saved) },
                { if (it is ApiException && it.status == 409) getString(R.string.arrange_stale) else it.message ?: getString(R.string.connection_failed) },
            )
            controller?.takeIf { it.isSessionCommandAvailable(PlaybackService.SYNC) }?.sendCustomCommand(PlaybackService.SYNC, Bundle.EMPTY)
            refreshTimeline()
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

    private companion object {
        val MUSIC_HOURS = setOf("artist_hour", "genre_hour", "theme_hour")
    }
}
