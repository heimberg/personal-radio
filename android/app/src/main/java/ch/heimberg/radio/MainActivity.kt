package ch.heimberg.radio

import kotlinx.coroutines.CoroutineScope
import androidx.activity.ComponentActivity
import android.Manifest
import android.content.ComponentName
import android.content.Intent
import android.content.pm.PackageManager
import android.os.Build
import android.os.Bundle
import androidx.activity.compose.setContent
import androidx.activity.SystemBarStyle
import androidx.activity.enableEdgeToEdge
import androidx.activity.result.PickVisualMediaRequest
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
import ch.heimberg.radio.core.Fix
import ch.heimberg.radio.core.PlaceTrigger
import ch.heimberg.radio.core.FeedbackPolicy
import ch.heimberg.radio.core.FeedbackReason
import ch.heimberg.radio.core.Program
import ch.heimberg.radio.core.ProgramClock
import ch.heimberg.radio.core.SeriesInfo
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

/** How long «Rückgängig» can bring back an item taken out of the program (the snackbar shows about four seconds). */
private const val UNDO_MS = 5_000L

/** How often an open app asks the Worker for a newer build. */
private const val UPDATE_CHECK_MS = 10 * 60_000L

/**
 * The app's one screen: «Hören», «Programm», «Archiv» and «Studio» in Compose. This activity connects
 * them to the playback service (Media3) and the private Worker; the screens only read [state].
 */
class MainActivity private constructor(
    ref: HostRef,
    private val studio: StudioController = StudioController(ref),
    private val voices: VoiceController = VoiceController(ref),
    private val family: FamilyController = FamilyController(ref),
    private val mitmachen: MitmachenController = MitmachenController(ref),
    private val reading: ReadingController = ReadingController(ref),
    private val dayPlans: DayPlanController = DayPlanController(ref),
) : AppCompatActivity(), RadioActions, RadioHost,
    StudioActions by studio, VoiceActions by voices, FamilyActions by family,
    MitmachenActions by mitmachen, ReadingActions by reading, DayPlanActions by dayPlans {

    /** Android creates the activity without arguments; the area controllers reach it through [HostRef]. */
    constructor() : this(HostRef())

    init { ref.host = this }

    override lateinit var api: ApiClient
    private lateinit var connection: Connection
    override val state = RadioState()
    override val activity: ComponentActivity get() = this
    override val scope: CoroutineScope get() = lifecycleScope
    override val player: MediaController? get() = controller
    override val actions: RadioActions get() = this
    private lateinit var catalogPrefs: CatalogPrefs
    private var controllerFuture: ListenableFuture<MediaController>? = null
    private val controller: MediaController? get() = controllerFuture?.takeIf { it.isDone && !it.isCancelled }?.let { runCatching { it.get() }.getOrNull() }

    /** Chosen while the player connection is being rebuilt; sent once it is connected. */
    private var pendingPlay: TimelineItem? = null
    private var spotifyClientId: String? = null
    private lateinit var spotify: SpotifyLink
    private lateinit var updater: AppUpdater
    private val microphonePermission = registerForActivityResult(ActivityResultContracts.RequestPermission()) { granted ->
        voices.microphoneAnswered(granted)
    }
    /** Items taken out by a swipe; a second swipe signal does not send it twice. */
    private val removing = mutableSetOf<String>()
    private var lastMinute = -1L

    private val notificationPermission = registerForActivityResult(ActivityResultContracts.RequestPermission()) { }
    // Profile picture: Android's photo picker and the camera app; neither needs a permission.
    private val avatarPicker = registerForActivityResult(ActivityResultContracts.PickVisualMedia()) { uri ->
        if (uri != null) family.uploadAvatar { AvatarImage.fromUri(contentResolver, uri) }
    }
    private val avatarCamera = registerForActivityResult(ActivityResultContracts.TakePicturePreview()) { bitmap ->
        if (bitmap != null) family.uploadAvatar { bitmap }
    }
    /** «Frag das Radio» by voice: Android's speech recognition turns it into text; nothing is recorded here. */
    private val dictation = registerForActivityResult(ActivityResultContracts.StartActivityForResult()) { result ->
        mitmachen.dictated(result.data?.getStringArrayListExtra(android.speech.RecognizerIntent.EXTRA_RESULTS)?.firstOrNull())
    }
    /** Ortsgeschichten: the location permission, asked when the feature is switched on; then it is switched on. */
    private val locationPermission = registerForActivityResult(ActivityResultContracts.RequestMultiplePermissions()) { granted ->
        if (granted.values.any { it }) setFeature("places", true)
        else state.say("Ohne Standort gibt es keine Ortsgeschichten.")
    }
    /** Where the last place story was asked for (in memory; the server tells each place once a month anyway). */
    private var lastPlaceFix: Fix? = null
    private var lastPlaceCheck = 0L

    override fun requestMicrophone() = microphonePermission.launch(Manifest.permission.RECORD_AUDIO)

    override fun pickAvatar() = avatarPicker.launch(PickVisualMediaRequest(ActivityResultContracts.PickVisualMedia.ImageOnly))

    override fun takeAvatarPhoto() {
        runCatching { avatarCamera.launch(null) }.onFailure { state.say("Keine Kamera-App gefunden.") }
    }

    override fun startDictation() {
        val intent = Intent(android.speech.RecognizerIntent.ACTION_RECOGNIZE_SPEECH)
            .putExtra(android.speech.RecognizerIntent.EXTRA_LANGUAGE_MODEL, android.speech.RecognizerIntent.LANGUAGE_MODEL_FREE_FORM)
            .putExtra(android.speech.RecognizerIntent.EXTRA_LANGUAGE, "de-CH")
            .putExtra(android.speech.RecognizerIntent.EXTRA_PROMPT, "Was möchtest du das Radio fragen?")
        runCatching { dictation.launch(intent) }.onFailure { state.say("Auf diesem Gerät gibt es keine Spracheingabe – tipp die Frage einfach ein.") }
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        connection = RadioSettings(this).connection() ?: run {
            startActivity(Intent(this, SetupActivity::class.java))
            finish()
            return
        }
        api = ApiClient(connection)
        spotify = SpotifyLink(this)
        catalogPrefs = CatalogPrefs(this)
        state.favorites = catalogPrefs.favorites
        state.usage = catalogPrefs.usage
        updater = AppUpdater(this, api)
        // Shown so an installed build can be matched to its CI run.
        val version = "Version " + (runCatching { packageManager.getPackageInfo(packageName, 0).versionName }.getOrNull() ?: "?")
        // A light ground: dark icons in the status and navigation bars.
        enableEdgeToEdge(
            statusBarStyle = SystemBarStyle.light(android.graphics.Color.TRANSPARENT, android.graphics.Color.TRANSPARENT),
            navigationBarStyle = SystemBarStyle.light(android.graphics.Color.TRANSPARENT, android.graphics.Color.TRANSPARENT),
        )
        setContent {
            RadioTheme {
                RadioApp(state, this, version = version)
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
                // A new build shows up whenever the app comes to the front, and while it stays open; the player
                // service keeps the app alive, so a check at start only would wait for a cold start.
                launch {
                    while (true) {
                        checkUpdate(version)
                        delay(UPDATE_CHECK_MS)
                    }
                }
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
                    checkPlace()
                    delay(30_000)
                }
            }
        }
    }

    private suspend fun checkUpdate(version: String) {
        if (state.updating) return
        val build = updater.available() ?: return
        if (state.update?.versionCode == build.versionCode) return
        state.update = build
        state.updateNote = "Version ${build.versionName} ist bereit (installiert: ${version.removePrefix("Version ")})."
    }

    override fun onStart() {
        super.onStart()
        if (!::api.isInitialized) return
        // Back from Spotify's login in the browser: the listening profile shows its new state.
        if (state.listening?.connected == false) loadListening()
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
        voices.release()
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

    override fun currentId(): String? = controller?.currentMediaItem?.mediaId?.let(Program::itemIdOf)

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
        // The row leaves right away, but the server only takes it out after a few seconds without
        // «Rückgängig»: until then it keeps its place and its audio.
        val before = state.open
        state.open = state.open.filter { it.id != item.id }
        renderTimes()
        val pending = lifecycleScope.launch {
            delay(UNDO_MS)
            val result = runCatching { api.remove(item.id) }
            result.exceptionOrNull()?.let { state.say(it.message ?: getString(R.string.connection_failed)) }
            removing.remove(item.id)
            changed()
        }
        state.say("«${item.displayTitle}» ist aus dem Programm.", "Rückgängig") {
            pending.cancel()
            removing.remove(item.id)
            state.open = before
            renderTimes()
            lifecycleScope.launch { changed() }
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
        state.usage = catalogPrefs.used(block.id)
        if (block.music && spotifyClientId != null && !RadioSettings(this).spotifyLinked) state.say(getString(R.string.block_needs_spotify))
        when {
            // A Mitmach-Geschichte starts from picture cards.
            block.id == "mitmach" -> state.storyCardsFor = block
            block.input != null -> state.blockAsk = block
            else -> addBlock(block, "")
        }
    }

    override fun toggleFavorite(block: BlockView) {
        val next = if (block.id in state.favorites) state.favorites - block.id else state.favorites + block.id
        catalogPrefs.favorites = next
        state.favorites = next
    }

    override fun loadFeatures() {
        lifecycleScope.launch { runCatching { api.features() }.onSuccess { state.features = it }.onFailure { state.say(it.message ?: getString(R.string.connection_failed)) } }
    }

    override fun setFeature(id: String, on: Boolean) {
        // Ortsgeschichten need the location first; the permission answer switches them on.
        if (id == "places" && on && !hasLocation()) {
            locationPermission.launch(arrayOf(Manifest.permission.ACCESS_FINE_LOCATION, Manifest.permission.ACCESS_COARSE_LOCATION))
            return
        }
        state.featuresBusy = true
        lifecycleScope.launch {
            runCatching { api.setFeature(id, on) }
                .onSuccess { catalog ->
                    state.features = catalog
                    // Live transitions are also a station-sound setting: keep the studio's copy in step.
                    if (id == "linker") state.studio = state.studio?.copy(linker = on)
                    if (id == "places" && on) { lastPlaceFix = null; lastPlaceCheck = 0 }
                }
                .onFailure { state.say(it.message ?: getString(R.string.connection_failed)) }
            state.featuresBusy = false
        }
    }

    override fun setBlockVisible(id: String, visible: Boolean) {
        val catalog = state.features ?: return
        val hidden = catalog.blocks.filter { if (it.id == id) !visible else !it.visible }.map { it.id }
        state.featuresBusy = true
        lifecycleScope.launch {
            runCatching { api.setHiddenBlocks(hidden) }
                .onSuccess { state.features = it; loadBlocks() }
                .onFailure { state.say(it.message ?: getString(R.string.connection_failed)) }
            state.featuresBusy = false
        }
    }

    private fun hasLocation(): Boolean = listOf(Manifest.permission.ACCESS_FINE_LOCATION, Manifest.permission.ACCESS_COARSE_LOCATION)
        .any { ContextCompat.checkSelfPermission(this, it) == PackageManager.PERMISSION_GRANTED }

    /**
     * Ortsgeschichten: every two minutes while the app is open, where the phone is (the freshest position
     * Android already has). After moving a few kilometres, the Worker names the place and plans its story.
     */
    @android.annotation.SuppressLint("MissingPermission")
    private suspend fun checkPlace() {
        if (state.features?.on("places") != true || !hasLocation()) return
        val now = System.currentTimeMillis()
        if (now - lastPlaceCheck < 2 * 60_000) return
        lastPlaceCheck = now
        val manager = getSystemService(LOCATION_SERVICE) as android.location.LocationManager
        val location = manager.getProviders(true).mapNotNull { runCatching { manager.getLastKnownLocation(it) }.getOrNull() }
            .maxByOrNull { it.time } ?: return
        // Older than a quarter of an hour: not where the listener is now.
        if (now - location.time > 15 * 60_000) return
        val fix = Fix(location.latitude, location.longitude, now)
        if (!PlaceTrigger.shouldReport(lastPlaceFix, fix)) return
        lastPlaceFix = fix
        runCatching { api.placeStory(fix.latitude, fix.longitude) }.onSuccess { story ->
            if (story.itemId != null) {
                state.say("📍 Gleich im Radio: die Geschichte von ${story.place}.")
                changed()
            }
        }
    }

    override fun addBlock(block: BlockView, subject: String) {
        window.decorView.performHapticFeedback(android.view.HapticFeedbackConstants.CONFIRM)
        serverAction(
            { api.addBlock(block.id, subject) },
            if (subject.isBlank()) getString(R.string.block_added, block.name) else getString(R.string.block_added_subject, block.name, subject),
        )
    }

    override fun stopSeries(series: SeriesInfo) = serverAction({ api.stopSeries(series.id) }, "«${series.title}» ist beendet.")

    override fun shuffle() = serverAction({ api.shuffle() }, "Programm gemischt.")

    override fun addSong() = serverAction({ api.addSong() }, "Ein Song wird ausgewählt und hinten angehängt.")

    override fun plan() = serverAction({ api.plan() }, getString(R.string.planned))

    override fun retry() = serverAction({ api.retry() }, "Fehlgeschlagene Beiträge werden neu produziert.")

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
    override fun serverAction(action: suspend () -> Unit, done: String) {
        lifecycleScope.launch {
            val result = runCatching { action() }
            state.say(result.fold({ done }, { it.message ?: getString(R.string.connection_failed) }))
            changed()
        }
    }

    override suspend fun changed() {
        sync()
        refreshTimeline()
        loadSeries()
    }

    private suspend fun loadBlocks() {
        runCatching { api.blocks() }.getOrNull()?.let { state.blocks = it }
        loadSeries()
        reading.loadFollows()
        reading.loadBookmarks()
        if (state.features == null) runCatching { api.features() }.getOrNull()?.let { state.features = it }
    }

    private suspend fun loadSeries() {
        runCatching { api.series() }.getOrNull()?.let { state.series = it }
    }

    private suspend fun refreshTimeline() {
        runCatching { api.response() }
            .onSuccess { timeline ->
                spotifyClientId = timeline.spotify?.clientId
                // Needed once: after the owner allowed it, the playback service connects on its own.
                state.spotifyNeeded = spotifyClientId != null && !RadioSettings(this).spotifyLinked
                state.connectionError = null
                state.failures = timeline.failures
                state.familyEnabled = timeline.family != null
                state.familyUnread = timeline.family?.unread ?: 0
                // The share menu needs the members; the open tab keeps its chat current.
                if (timeline.family != null && (state.family == null || (state.tab == Tab.FAMILY && state.familyUnread > 0))) loadFamily()
                if (!dayPlans.moodSending) state.mood = timeline.mood?.id
                // All open items: a new order always covers the whole program.
                state.open = timeline.items.filter { it.isOpen && it.id !in removing }
                state.heard = timeline.items.filter { it.isHeard }
                mitmachen.stickersNow(timeline.play.stickers)
                state.play = timeline.play
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
            reading.loadBookmarks()
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
