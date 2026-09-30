package ch.heimberg.radio

import android.Manifest
import android.content.ComponentName
import android.content.Intent
import android.content.pm.PackageManager
import android.os.Build
import android.os.Bundle
import android.webkit.WebView
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.activity.result.contract.ActivityResultContracts
import androidx.appcompat.app.AppCompatActivity
import androidx.core.content.ContextCompat
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.lifecycleScope
import androidx.lifecycle.repeatOnLifecycle
import androidx.media3.common.C
import androidx.media3.common.Player
import androidx.media3.session.MediaController
import androidx.media3.session.SessionResult
import androidx.media3.session.SessionToken
import ch.heimberg.radio.core.BlockView
import ch.heimberg.radio.core.Connection
import ch.heimberg.radio.core.DayPlan
import ch.heimberg.radio.core.FeedbackPolicy
import ch.heimberg.radio.core.FeedbackReason
import ch.heimberg.radio.core.Moods
import ch.heimberg.radio.core.Program
import ch.heimberg.radio.core.ProgramClock
import ch.heimberg.radio.core.StudioSettings
import ch.heimberg.radio.core.TimelineItem
import ch.heimberg.radio.core.TimelineJson
import com.google.common.util.concurrent.ListenableFuture
import com.spotify.sdk.android.auth.AuthorizationClient
import com.spotify.sdk.android.auth.AuthorizationRequest
import com.spotify.sdk.android.auth.AuthorizationResponse
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import java.time.Instant
import java.time.ZoneId
import java.time.format.DateTimeFormatter

/**
 * The app's one screen: «Hören», «Programm», «Archiv» and «Studio» in Compose. This activity connects
 * them to the playback service (Media3) and the private Worker; the screens only read [state].
 */
class MainActivity : AppCompatActivity(), RadioActions {
    private lateinit var api: ApiClient
    private lateinit var connection: Connection
    private val state = RadioState()
    private var controllerFuture: ListenableFuture<MediaController>? = null
    private val controller: MediaController? get() = controllerFuture?.takeIf { it.isDone && !it.isCancelled }?.let { runCatching { it.get() }.getOrNull() }

    /** Chosen while the player connection is being rebuilt; sent once it is connected. */
    private var pendingPlay: TimelineItem? = null
    private var spotifyClientId: String? = null
    private lateinit var spotify: SpotifyLink
    private lateinit var updater: AppUpdater
    private var studio: WebView? = null
    /** The voice sample playing in the studio, and whether the radio was playing before it. */
    private var sample: android.media.MediaPlayer? = null
    private var resumeAfterSample = false
    /** Items taken out by a swipe; a second swipe signal does not send it twice. */
    private val removing = mutableSetOf<String>()
    private var lastMinute = -1L

    private val notificationPermission = registerForActivityResult(ActivityResultContracts.RequestPermission()) { }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        connection = RadioSettings(this).connection() ?: run {
            startActivity(Intent(this, SetupActivity::class.java))
            finish()
            return
        }
        api = ApiClient(connection)
        spotify = SpotifyLink(this)
        updater = AppUpdater(this, api)
        // Shown so an installed build can be matched to its CI run.
        val version = "Version " + (runCatching { packageManager.getPackageInfo(packageName, 0).versionName }.getOrNull() ?: "?")
        enableEdgeToEdge()
        setContent {
            RadioTheme {
                RadioApp(state, this, studio = { studio ?: studioWebView(this, connection).also { studio = it } }, version = version)
            }
        }

        lifecycleScope.launch {
            updater.available()?.let {
                state.update = it
                state.updateNote = "Version ${it.versionName} ist bereit (installiert: ${version.removePrefix("Version ")})."
            }
        }
        lifecycleScope.launch { loadBlocks() }
        NoticeWorker.schedule(this)
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
                            renderTimes()
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
        val future = MediaController.Builder(this, token)
            .setListener(object : MediaController.Listener {
                override fun onExtrasChanged(controller: MediaController, extras: Bundle) = renderSleep(extras)
            })
            .buildAsync()
        controllerFuture = future
        future.addListener({
            val player = controller
            if (player == null) {
                // The connection failed: a waiting choice cannot be played.
                if (pendingPlay != null) state.say(getString(R.string.play_unavailable))
                pendingPlay = null
                return@addListener
            }
            player.addListener(playerListener)
            renderPlayer(player)
            renderSleep(player.sessionExtras)
            pendingPlay?.let {
                pendingPlay = null
                play(it)
            }
        }, ContextCompat.getMainExecutor(this))
    }

    override fun onStop() {
        controllerFuture?.let { MediaController.releaseFuture(it) }
        controllerFuture = null
        if (::spotify.isInitialized) spotify.disconnect()
        super.onStop()
    }

    override fun onDestroy() {
        stopSample()
        studio?.destroy()
        studio = null
        super.onDestroy()
    }

    private val playerListener = object : Player.Listener {
        override fun onEvents(player: Player, events: Player.Events) = renderPlayer(player)
    }

    // ── The player ────────────────────────────────────────────────────────────────────────────

    private fun renderPlayer(player: Player) {
        val metadata = player.mediaMetadata
        state.title = metadata.title?.toString() ?: ""
        state.show = metadata.artist?.toString() ?: ""
        state.artworkUrl = metadata.artworkUri?.toString()
        state.playWhenReady = player.playWhenReady
        state.hasMedia = player.mediaItemCount > 0
        // Live while audio plays or is about to: the dot lights, the orb and the waveform move.
        state.live = player.playWhenReady && player.mediaItemCount > 0 &&
            (player.playbackState == Player.STATE_READY || player.playbackState == Player.STATE_BUFFERING)
        val playing = player.currentMediaItem?.mediaId?.let(Program::itemIdOf)
        if (playing != state.currentItemId) {
            state.currentItemId = playing
            renderTimes()
        }
        renderProgress(player)
        state.phase = when {
            player.mediaItemCount == 0 -> Phase.WAITING
            player.playbackState == Player.STATE_BUFFERING -> Phase.BUFFERING
            player.playbackState == Player.STATE_ENDED -> Phase.ENDED
            player.isPlaying -> Phase.PLAYING
            else -> Phase.PAUSED
        }
        state.status = getString(
            when {
                player.mediaItemCount == 0 -> R.string.status_waiting
                player.playbackState == Player.STATE_BUFFERING -> R.string.status_buffering
                player.playbackState == Player.STATE_ENDED -> R.string.status_ended
                player.isPlaying -> R.string.status_playing
                else -> R.string.status_paused
            },
        )
    }

    private fun renderProgress(player: Player? = controller) {
        val duration = player?.duration ?: C.TIME_UNSET
        if (player == null || duration == C.TIME_UNSET || duration <= 0) {
            state.positionMs = 0
            state.durationMs = 0
            return
        }
        state.durationMs = duration
        state.positionMs = player.currentPosition.coerceIn(0, duration)
    }

    private fun renderSleep(extras: Bundle) {
        val at = extras.getLong(PlaybackService.EXTRA_SLEEP_AT, 0L)
        state.sleepLabel = when {
            at > 0 -> getString(R.string.sleep_at, DateTimeFormatter.ofPattern("HH:mm").withZone(ZoneId.systemDefault()).format(Instant.ofEpochMilli(at)))
            extras.getBoolean(PlaybackService.EXTRA_SLEEP_AFTER_ITEM, false) -> getString(R.string.sleep_after_item)
            else -> null
        }
    }

    /** Start times from now, with the playing item's remaining time. */
    private fun renderTimes() {
        state.starts = ProgramClock.startTimes(ProgramClock.playingOrder(state.open, state.currentItemId), Instant.now(), state.currentItemId, currentRemainingMs())
    }

    /** How long the playing item still runs: the rest of this step plus its later parts (songs, spoken parts). */
    private fun currentRemainingMs(): Long? {
        val player = controller ?: return null
        val itemId = player.currentMediaItem?.mediaId?.let(Program::itemIdOf) ?: return null
        val item = state.open.firstOrNull { it.id == itemId }
        var remaining = player.duration.takeIf { it != C.TIME_UNSET && it > 0 }?.let { it - player.currentPosition.coerceAtLeast(0) } ?: return null
        val steps = (0 until player.mediaItemCount).filter { Program.itemIdOf(player.getMediaItemAt(it).mediaId) == itemId }
        val later = steps.filter { it > player.currentMediaItemIndex }
        // Spoken parts not loaded yet: an even share of the item's estimated length.
        val perStep = item?.let { (it.estimatedMinutes * 60_000 / steps.size.coerceAtLeast(1)).toLong() } ?: 60_000L
        for (index in later) remaining += player.getMediaItemAt(index).mediaMetadata.durationMs ?: perStep
        return remaining
    }

    private fun sync() {
        controller?.takeIf { it.isSessionCommandAvailable(PlaybackService.SYNC) }?.sendCustomCommand(PlaybackService.SYNC, Bundle.EMPTY)
    }

    private fun currentId(): String? = controller?.currentMediaItem?.mediaId?.let(Program::itemIdOf)

    override fun togglePlay() {
        val player = controller ?: return
        if (player.mediaItemCount == 0) {
            // Nothing loaded yet: ask for the program and start as soon as the first item arrives.
            state.status = getString(R.string.status_waiting)
            player.play()
            sync()
            plan()
            return
        }
        if (player.playWhenReady) {
            player.pause()
        } else {
            if (player.playbackState == Player.STATE_IDLE) player.prepare()
            player.play()
        }
    }

    override fun next() { controller?.seekToNextMediaItem() }

    override fun rate(liked: Boolean) {
        val id = currentId() ?: return
        window.decorView.performHapticFeedback(android.view.HapticFeedbackConstants.CONFIRM)
        lifecycleScope.launch {
            val result = runCatching { api.send(FeedbackPolicy.rating(id, liked)) }
            state.say(result.fold({ getString(if (liked) R.string.liked else R.string.disliked) }, { it.message ?: "" }))
            val showId = state.open.firstOrNull { it.id == id }?.showId
            // One optional tap after 👎: repeated reasons teach the station's writer, editor and jury.
            if (!liked && result.isSuccess && FeedbackReason.asksFor(showId)) state.reasonFor = id
        }
    }

    override fun reason(itemId: String, reason: FeedbackReason) {
        lifecycleScope.launch {
            state.say(runCatching { api.sendReason(itemId, reason) }.fold({ getString(R.string.reason_saved) }, { it.message ?: "" }))
        }
    }

    /** «Mehr dazu»: the server researches a deeper follow-up and places it right after this item. */
    override fun deepen() {
        val id = currentId() ?: return
        window.decorView.performHapticFeedback(android.view.HapticFeedbackConstants.CONFIRM)
        lifecycleScope.launch {
            val result = runCatching { api.deepen(id) }
            state.say(getString(if (result.isSuccess) R.string.more_ordered else R.string.more_unavailable))
            if (result.isSuccess) changed()
        }
    }

    /** Text and sources of [item], or of what is playing. */
    override fun transcript(item: TimelineItem?) {
        val id = item?.id ?: currentId() ?: return state.say(getString(R.string.nothing_playing))
        TranscriptActivity.open(this, id, item?.displayTitle ?: state.title)
    }

    override fun sleep(minutes: Int) {
        val player = controller?.takeIf { it.isSessionCommandAvailable(PlaybackService.SLEEP) } ?: return state.say(getString(R.string.play_unavailable))
        player.sendCustomCommand(PlaybackService.SLEEP, Bundle().apply { putInt(PlaybackService.EXTRA_SLEEP_MINUTES, minutes) })
        if (minutes == 0) state.say(getString(R.string.sleep_cleared))
    }

    /** Asks the playback service to play [item] now; the program continues afterwards. */
    override fun play(item: TimelineItem) {
        // The connection to the player may still be being built: keep the choice and send it once connected.
        val future = controllerFuture
        if (future == null || !future.isDone) {
            pendingPlay = item
            return
        }
        val player = controller
        if (player == null || !player.isSessionCommandAvailable(PlaybackService.PLAY_ITEM)) return state.say(getString(R.string.play_unavailable))
        val args = Bundle().apply { putString(PlaybackService.EXTRA_ITEM, TimelineJson.encodeItem(item)) }
        val result = player.sendCustomCommand(PlaybackService.PLAY_ITEM, args)
        result.addListener({
            val ok = runCatching { result.get().resultCode == SessionResult.RESULT_SUCCESS }.getOrDefault(false)
            state.say(if (ok) getString(R.string.playing_now, item.displayTitle) else getString(R.string.play_unavailable))
        }, ContextCompat.getMainExecutor(this))
    }

    // ── The program ───────────────────────────────────────────────────────────────────────────

    /** «Anders»: something different at the item's place – another surprise, or a surprise instead. */
    override fun swap(item: TimelineItem) {
        window.decorView.performHapticFeedback(android.view.HapticFeedbackConstants.CONFIRM)
        serverAction({ api.swap(item.id) }, if (item.surprise) getString(R.string.surprise_swapped) else "Statt «${item.displayTitle}» kommt eine Überraschung.")
    }

    override fun remove(item: TimelineItem) {
        if (!removing.add(item.id)) return
        // The row leaves right away; the next refresh brings it back if the server refused.
        state.open = state.open.filter { it.id != item.id }
        lifecycleScope.launch {
            val result = runCatching { api.remove(item.id) }
            state.say(result.fold({ "«${item.displayTitle}» ist aus dem Programm." }, { it.message ?: getString(R.string.connection_failed) }))
            removing.remove(item.id)
            changed()
        }
    }

    override fun playNext(item: TimelineItem) = arrange(ProgramClock.playNext(state.open, item.id, state.currentItemId))

    override fun shift(item: TimelineItem, offset: Int) = arrange(ProgramClock.shift(state.open, item.id, offset, state.currentItemId))

    /** Saves a new order; the list and the player follow it right away. */
    private fun arrange(items: List<TimelineItem>) {
        if (items.map { it.id } == ProgramClock.playingOrder(state.open, state.currentItemId).map { it.id }) return
        state.open = items
        renderTimes()
        lifecycleScope.launch {
            val result = runCatching { api.arrange(items.map { it.id }) }
            state.say(result.fold(
                { getString(R.string.arrange_saved) },
                { if (it is ApiException && it.status == 409) getString(R.string.arrange_stale) else it.message ?: getString(R.string.connection_failed) },
            ))
            changed()
        }
    }

    /** One tap adds the block as the next item; a block that takes a word asks for it, empty lets the AI choose. */
    override fun chooseBlock(block: BlockView) {
        if (block.music && spotifyClientId != null && !RadioSettings(this).spotifyLinked) state.say(getString(R.string.block_needs_spotify))
        if (block.input != null) state.blockAsk = block else addBlock(block, "")
    }

    override fun addBlock(block: BlockView, subject: String) {
        window.decorView.performHapticFeedback(android.view.HapticFeedbackConstants.CONFIRM)
        serverAction(
            { api.addBlock(block.id, subject, state.currentItemId) },
            if (subject.isBlank()) getString(R.string.block_added, block.name) else getString(R.string.block_added_subject, block.name, subject),
        )
    }

    override fun shuffle() = serverAction({ api.shuffle() }, "Programm gemischt.")

    override fun addSong() = serverAction({ api.addSong() }, "Ein Song wird ausgewählt und hinten angehängt.")

    override fun plan() = serverAction({ api.plan() }, getString(R.string.planned))

    override fun retry() = serverAction({ api.retry() }, "Fehlschläge abgeräumt, wartende Beiträge neu gestartet.")

    override fun cleanup() = serverAction({ api.cleanup() }, "Fehlschläge aufgeräumt.")

    override fun refresh() {
        state.refreshing = true
        lifecycleScope.launch {
            refreshTimeline()
            loadBlocks()
            sync()
            state.refreshing = false
        }
    }

    /** Runs a change on the server, says how it went and brings list and player up to date. */
    private fun serverAction(action: suspend () -> Unit, done: String) {
        lifecycleScope.launch {
            val result = runCatching { action() }
            state.say(result.fold({ done }, { it.message ?: getString(R.string.connection_failed) }))
            changed()
        }
    }

    private suspend fun changed() {
        sync()
        refreshTimeline()
    }

    private suspend fun loadBlocks() {
        runCatching { api.blocks() }.getOrNull()?.let { state.blocks = it }
    }

    private suspend fun refreshTimeline() {
        runCatching { api.response() }
            .onSuccess { timeline ->
                spotifyClientId = timeline.spotify?.clientId
                // Needed once: after the owner allowed it, the playback service connects on its own.
                state.spotifyNeeded = spotifyClientId != null && !RadioSettings(this).spotifyLinked
                state.connectionError = null
                state.failures = timeline.failures
                if (!moodSending) state.mood = timeline.mood?.id
                // All open items: a new order always covers the whole program.
                state.open = timeline.items.filter { it.isOpen && it.id !in removing }
                state.loaded = true
                renderTimes()
            }
            .onFailure {
                // The access diagnosis says which layer refused (Access or the Worker) and why.
                state.connectionError = it.message ?: getString(R.string.connection_failed)
            }
    }

    // ── The archive ───────────────────────────────────────────────────────────────────────────

    override fun loadArchive() {
        state.archiveRefreshing = true
        lifecycleScope.launch {
            runCatching { api.library() }
                .onSuccess { library ->
                    val items = library.items.filter { it.hasAudio }
                    state.archive = items
                    state.archiveNote = if (items.isEmpty()) getString(R.string.archive_empty)
                    else "Antippen: sofort hören, danach geht das Programm weiter. Lange drücken: Text oder löschen. Gehörtes bleibt ${library.retentionDays} Tage."
                }
                .onFailure { state.archiveNote = it.message ?: getString(R.string.connection_failed) }
            state.archiveRefreshing = false
        }
    }

    override fun delete(item: TimelineItem) {
        lifecycleScope.launch {
            val result = runCatching { api.delete(item.id) }
            state.say(result.fold({ getString(R.string.deleted) }, { it.message ?: getString(R.string.connection_failed) }))
            loadArchive()
        }
    }

    // ── «Heute» and the day plan ──────────────────────────────────────────────────────────────

    /** Set while a mood is on its way, so a refresh in between does not flip the chip back. */
    private var moodSending = false

    override fun setMood(id: String?) {
        val before = state.mood
        state.mood = id
        moodSending = true
        window.decorView.performHapticFeedback(android.view.HapticFeedbackConstants.CONFIRM)
        lifecycleScope.launch {
            val result = runCatching { api.setMood(id) }
            moodSending = false
            if (result.isFailure) state.mood = before
            state.say(result.fold(
                { Moods.of(id)?.let { "${it.icon} ${it.label} – gilt ab den nächsten Beiträgen bis Mitternacht." } ?: "Wieder der normale Tagesplan." },
                { it.message ?: getString(R.string.connection_failed) },
            ))
            if (result.isSuccess) changed()
        }
    }

    override fun openDayPlan() {
        state.dayPlanOpen = true
        // Unsaved changes stay until they are saved; otherwise the plan is read fresh.
        if (state.dayPlanDirty && state.dayPlan != null) return
        state.dayPlan = null
        lifecycleScope.launch {
            runCatching { api.dayPlan() }
                .onSuccess { plan -> if (plan == null) state.say("Das Radio ist noch nicht eingerichtet – das geht im Studio.") else state.dayPlan = plan }
                .onFailure { state.say(it.message ?: getString(R.string.connection_failed)) }
        }
    }

    override fun editDayPlan(plan: DayPlan) {
        if (plan == state.dayPlan) return
        state.dayPlan = plan
        state.dayPlanDirty = true
    }

    override fun saveDayPlan() {
        val plan = state.dayPlan ?: return
        state.dayPlanSaving = true
        lifecycleScope.launch {
            val result = runCatching { api.saveDayPlan(plan) }
            state.dayPlanSaving = false
            if (result.isSuccess) state.dayPlanDirty = false
            state.say(result.fold({ "Tagesplan gespeichert. Er gilt ab den nächsten geplanten Beiträgen." }, { it.message ?: getString(R.string.connection_failed) }))
            if (result.isSuccess) changed()
        }
    }

    override fun closeDayPlan() {
        state.dayPlanOpen = false
    }

    // ── Studio ────────────────────────────────────────────────────────────────────────────────

    override fun loadStudio(force: Boolean) {
        // Unsaved changes stay until they are saved or discarded.
        if (!force && (state.studio != null || state.studioMissing)) return
        lifecycleScope.launch {
            runCatching { api.studio() }
                .onSuccess { settings ->
                    state.studio = settings
                    state.studioMissing = settings == null
                    state.studioDirty = false
                }
                .onFailure { state.say(it.message ?: getString(R.string.connection_failed)) }
        }
        if (state.voices.isEmpty()) lifecycleScope.launch { runCatching { api.voices() }.onSuccess { state.voices = it } }
    }

    override fun editStudio(settings: StudioSettings) {
        if (settings == state.studio) return
        state.studio = settings
        state.studioDirty = true
    }

    override fun saveStudio() {
        val settings = state.studio ?: return
        state.studioSaving = true
        lifecycleScope.launch {
            val result = runCatching { api.saveStudio(settings) }
            state.studioSaving = false
            if (result.isSuccess) state.studioDirty = false
            state.say(result.fold({ "Gespeichert. Gilt ab den nächsten Beiträgen." }, { it.message ?: getString(R.string.connection_failed) }))
            if (result.isSuccess) changed()
        }
    }

    override fun discardStudio() {
        state.studioDirty = false
        loadStudio(force = true)
    }

    override fun searchPlaces(name: String) {
        if (name.trim().length < 2) return
        lifecycleScope.launch {
            runCatching { api.places(name.trim()) }
                .onSuccess { state.places = it }
                .onFailure { state.say("Die Ortssuche ist gerade nicht erreichbar.") }
        }
    }

    override fun previewVoice(voiceId: String) {
        val playing = state.previewing
        stopSample()
        if (playing == voiceId) return
        val style = state.studio?.voiceStyle.orEmpty()
        state.previewing = voiceId
        // The radio pauses for the sample and goes on afterwards.
        resumeAfterSample = controller?.isPlaying == true
        controller?.pause()
        sample = android.media.MediaPlayer().apply {
            setAudioAttributes(android.media.AudioAttributes.Builder().setUsage(android.media.AudioAttributes.USAGE_MEDIA).setContentType(android.media.AudioAttributes.CONTENT_TYPE_SPEECH).build())
            setOnPreparedListener { it.start() }
            setOnCompletionListener { stopSample() }
            setOnErrorListener { _, _, _ -> state.say("Die Hörprobe ist gerade nicht verfügbar."); stopSample(); true }
            runCatching {
                setDataSource(this@MainActivity, android.net.Uri.parse(api.previewUrl(voiceId, style)), api.headers())
                prepareAsync()
            }.onFailure { state.say("Die Hörprobe ist gerade nicht verfügbar."); stopSample() }
        }
    }

    private fun stopSample() {
        sample?.let { runCatching { it.stop() }; it.release() }
        sample = null
        state.previewing = null
        if (resumeAfterSample) controller?.play()
        resumeAfterSample = false
    }

    override fun openWebStudio() {
        state.webStudioOpen = true
    }

    override fun closeWebStudio() {
        state.webStudioOpen = false
        // What was changed on the web shows here too, unless there are unsaved changes in the app.
        if (!state.studioDirty) loadStudio(force = true)
    }

    // ── Setup ─────────────────────────────────────────────────────────────────────────────────

    /**
     * Asks Spotify once for permission to control it (Spotify shows its own dialog). Afterwards the
     * playback service connects on its own and music hours play with their music.
     */
    override fun connectSpotify() {
        val clientId = spotifyClientId ?: return state.say(getString(R.string.spotify_not_configured))
        if (!spotify.installed) return state.say(getString(R.string.spotify_missing))
        state.say(getString(R.string.spotify_connecting))
        state.spotifyBusy = true
        // An earlier permission still counts: connect quietly first. Without one, Spotify's own login
        // grants «app-remote-control» (the auth flow App Remote asks for); then App Remote connects.
        spotify.connect(clientId, showAuthView = false) { quiet ->
            if (quiet == null) return@connect spotifyDone(null)
            val request = AuthorizationRequest.Builder(clientId, AuthorizationResponse.Type.TOKEN, SpotifyLink.REDIRECT_URI)
                .setScopes(arrayOf("app-remote-control"))
                .build()
            spotifyLogin.launch(AuthorizationClient.createLoginActivityIntent(this, request))
        }
    }

    /**
     * Spotify's login answers here. The token only proves the permission and is dropped; App Remote
     * then connects with it granted. Nothing of it leaves the phone.
     */
    private val spotifyLogin = registerForActivityResult(ActivityResultContracts.StartActivityForResult()) { result ->
        val clientId = spotifyClientId ?: return@registerForActivityResult spotifyDone(getString(R.string.spotify_not_configured))
        val response = AuthorizationClient.getResponse(result.resultCode, result.data)
        when (response.type) {
            AuthorizationResponse.Type.TOKEN, AuthorizationResponse.Type.CODE ->
                spotify.connect(clientId, showAuthView = true) { error -> spotifyDone(error) }
            AuthorizationResponse.Type.ERROR -> spotifyDone(
                "Spotify-Anmeldung fehlgeschlagen (${response.error}). Prüfe im Spotify-Dashboard die Redirect-URI ${SpotifyLink.REDIRECT_URI} " +
                    "und das Android-Paket ch.heimberg.radio mit seinem SHA1.",
            )
            else -> spotifyDone("Spotify-Anmeldung abgebrochen.")
        }
    }

    private fun spotifyDone(error: String?) {
        state.spotifyBusy = false
        state.say(error ?: getString(R.string.spotify_connected))
        if (error == null) {
            RadioSettings(this).spotifyLinked = true
            state.spotifyNeeded = false
            lifecycleScope.launch { refreshTimeline() }
        }
    }

    /** A newer build is on the Worker: download, verify and install it with one tap. */
    override fun installUpdate() {
        val build = state.update ?: return
        if (!updater.mayInstall()) {
            state.updateNote = getString(R.string.update_permission)
            updater.askForPermission()
            return
        }
        state.updating = true
        state.updateNote = getString(R.string.update_loading)
        lifecycleScope.launch {
            runCatching { updater.install(build) }.onFailure { state.updateNote = it.message ?: getString(R.string.connection_failed) }
            state.updating = false
        }
    }

    override fun openConnection() {
        startActivity(Intent(this, SetupActivity::class.java))
    }
}
