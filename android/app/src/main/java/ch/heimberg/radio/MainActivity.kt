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
import ch.heimberg.radio.core.DayPlan
import ch.heimberg.radio.core.FamilyMember
import ch.heimberg.radio.core.FeedbackPolicy
import ch.heimberg.radio.core.FeedbackReason
import ch.heimberg.radio.core.Moods
import ch.heimberg.radio.core.Program
import ch.heimberg.radio.core.ProgramClock
import ch.heimberg.radio.core.Reading
import ch.heimberg.radio.core.SeriesInfo
import ch.heimberg.radio.core.StudioSettings
import ch.heimberg.radio.core.TimelineItem
import ch.heimberg.radio.core.TimelineJson
import ch.heimberg.radio.core.VoiceOption
import coil.request.ImageRequest
import com.google.common.util.concurrent.ListenableFuture
import com.spotify.sdk.android.auth.AuthorizationClient
import com.spotify.sdk.android.auth.AuthorizationRequest
import com.spotify.sdk.android.auth.AuthorizationResponse
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import java.time.Instant
import java.time.ZoneId
import java.time.format.DateTimeFormatter

/** How long «Rückgängig» can bring back an item taken out of the program (the snackbar shows about four seconds). */
private const val UNDO_MS = 5_000L

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
    /** Cloning a voice: the recorder and the two recordings (they never leave the app except to Google, on «Erstellen»). */
    private val recorder = VoiceRecorder()
    private var sampleWav: ByteArray? = null
    private var consentWav: ByteArray? = null
    private var recordingConsent = false
    private var recordTicker: kotlinx.coroutines.Job? = null
    private val microphonePermission = registerForActivityResult(ActivityResultContracts.RequestPermission()) { granted ->
        if (granted) toggleRecording(recordingConsent) else state.say("Ohne Mikrofon lässt sich keine Stimme klonen.")
    }
    /** Items taken out by a swipe; a second swipe signal does not send it twice. */
    private val removing = mutableSetOf<String>()
    private var lastMinute = -1L

    private val notificationPermission = registerForActivityResult(ActivityResultContracts.RequestPermission()) { }
    // Profile picture: Android's photo picker and the camera app; neither needs a permission.
    private val avatarPicker = registerForActivityResult(ActivityResultContracts.PickVisualMedia()) { uri ->
        if (uri != null) uploadAvatar { AvatarImage.fromUri(contentResolver, uri) }
    }
    private val avatarCamera = registerForActivityResult(ActivityResultContracts.TakePicturePreview()) { bitmap ->
        if (bitmap != null) uploadAvatar { bitmap }
    }
    /** «Frag das Radio» by voice: Android's speech recognition turns it into text; nothing is recorded here. */
    private val dictation = registerForActivityResult(ActivityResultContracts.StartActivityForResult()) { result ->
        val spoken = result.data?.getStringArrayListExtra(android.speech.RecognizerIntent.EXTRA_RESULTS)?.firstOrNull()
        if (!spoken.isNullOrBlank()) state.askDraft = (state.askDraft.trim() + " " + spoken.trim()).trim().take(200)
    }
    /** Stickers known from the last timeline: more of them means one was earned (e.g. an episode heard to the end). */
    private var stickersSeen = -1

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
        recorder.release()
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
        if (block.music && spotifyClientId != null && !RadioSettings(this).spotifyLinked) state.say(getString(R.string.block_needs_spotify))
        when {
            // A Mitmach-Geschichte starts from picture cards.
            block.id == "mitmach" -> state.storyCardsFor = block
            block.input != null -> state.blockAsk = block
            else -> addBlock(block, "")
        }
    }

    override fun choose(item: TimelineItem, option: Int) {
        if (state.playSending != null) return
        state.playSending = item.id
        window.decorView.performHapticFeedback(android.view.HapticFeedbackConstants.CONFIRM)
        lifecycleScope.launch {
            runCatching { api.choose(item.id, option) }
                .onSuccess { result ->
                    val label = item.choice?.options?.getOrNull(option)?.let { "${it.emoji} ${it.label}" } ?: ""
                    state.say("Du hast gewählt: $label. So geht die Geschichte weiter!")
                    earned(result.sticker)
                }
                .onFailure { state.say(it.message ?: getString(R.string.connection_failed)) }
            state.playSending = null
            changed()
        }
    }

    override fun answer(item: TimelineItem, option: Int) {
        if (state.playSending != null) return
        state.playSending = item.id
        lifecycleScope.launch {
            runCatching { api.answer(item.id, option) }
                .onSuccess { result ->
                    val right = result.correct?.let { item.quiz?.options?.getOrNull(it) }
                    if (result.right == true) window.decorView.performHapticFeedback(android.view.HapticFeedbackConstants.CONFIRM)
                    state.say(if (result.right == true) "Richtig! 🎉" else "Knapp daneben – richtig ist ${right?.let { "«$it»" } ?: "eine andere Antwort"}.")
                    earned(result.sticker)
                }
                .onFailure { state.say(it.message ?: getString(R.string.connection_failed)) }
            state.playSending = null
            changed()
        }
    }

    /** A new sticker: shown big, and the album is loaded again when it is opened. */
    private fun earned(sticker: ch.heimberg.radio.core.Sticker?) {
        if (sticker == null) return
        state.newSticker = sticker
        state.album = null
        stickersSeen += 1
    }

    override fun openAlbum() {
        state.albumOpen = true
        lifecycleScope.launch {
            runCatching { api.stickers() }.onSuccess { state.album = it }.onFailure { state.say(it.message ?: getString(R.string.connection_failed)) }
        }
    }

    override fun ask() {
        val text = state.askDraft.trim()
        if (text.length < 3 || state.asking) return
        state.asking = true
        lifecycleScope.launch {
            runCatching { api.ask(text) }
                .onSuccess {
                    state.askDraft = ""
                    state.askOpen = false
                    state.say("Deine Frage ist im Studio – die Antwort kommt im nächsten Übergang.")
                }
                .onFailure { state.say(if (it is ApiException && it.status == 409) "Das Radio hat gerade keine Übergänge eingeschaltet, also kann niemand antworten." else it.message ?: getString(R.string.connection_failed)) }
            state.asking = false
        }
    }

    /** The item a question or bookmark is about: the given one, else what plays (from the program or the archive). */
    private fun itemOrPlaying(item: TimelineItem?): TimelineItem? {
        if (item != null) return item
        val id = currentId() ?: return null
        return state.open.firstOrNull { it.id == id } ?: state.heard.firstOrNull { it.id == id } ?: state.archive?.firstOrNull { it.id == id }
    }

    override fun askAbout(item: TimelineItem?) {
        val about = itemOrPlaying(item) ?: return state.say(getString(R.string.nothing_playing))
        if (about.hasMusic || about.showId == "_musik") return state.say("Zu Songs und Musikstunden kann das Radio keine Fragen beantworten.")
        state.askAbout = about
        state.askOpen = true
    }

    override fun sendQuestion() {
        val about = state.askAbout ?: return
        val text = state.askDraft.trim()
        if (text.length < 3 || state.asking) return
        state.asking = true
        lifecycleScope.launch {
            runCatching { api.askAbout(about.id, text) }
                .onSuccess { answer ->
                    state.askDraft = ""
                    state.askOpen = false
                    state.askAbout = null
                    changed()
                    val reply = state.open.firstOrNull { it.id == answer.itemId }
                    state.say("Die Antwort kommt direkt nach «${about.displayTitle}».", "Jetzt hören") { reply?.let { play(it) } ?: state.say(answer.text) }
                }
                .onFailure {
                    state.say(when ((it as? ApiException)?.status) {
                        409 -> "Dazu kann das Radio keine Frage beantworten."
                        429 -> "Für heute ist das Limit erreicht – morgen geht es wieder."
                        else -> it.message ?: getString(R.string.connection_failed)
                    })
                }
            state.asking = false
        }
    }

    override fun toggleBookmark(item: TimelineItem?) {
        val target = itemOrPlaying(item) ?: return state.say(getString(R.string.nothing_playing))
        val on = !state.bookmarked(target.id)
        window.decorView.performHapticFeedback(android.view.HapticFeedbackConstants.CONFIRM)
        lifecycleScope.launch {
            val result = runCatching { if (on) api.bookmark(target.id) else api.unbookmark(target.id) }
            state.say(result.fold({ if (on) "🔖 «${target.displayTitle}» ist auf deiner Leseliste." else "Von der Leseliste genommen." }, { it.message ?: getString(R.string.connection_failed) }))
            loadBookmarks()
        }
    }

    override fun removeBookmark(itemId: String) {
        lifecycleScope.launch {
            runCatching { api.unbookmark(itemId) }.onFailure { state.say(it.message ?: getString(R.string.connection_failed)) }
            loadBookmarks()
        }
    }

    override fun shareReading() {
        if (state.bookmarks.isEmpty()) return
        val send = Intent(Intent.ACTION_SEND).setType("text/plain")
            .putExtra(Intent.EXTRA_SUBJECT, "Meine Leseliste aus dem Radio")
            .putExtra(Intent.EXTRA_TEXT, Reading.shareText(state.bookmarks))
        startActivity(Intent.createChooser(send, "Leseliste teilen"))
    }

    override fun openSource(url: String) {
        if (!url.startsWith("https://") && !url.startsWith("http://")) return
        runCatching { startActivity(Intent(Intent.ACTION_VIEW, android.net.Uri.parse(url))) }.onFailure { state.say("Kein Browser gefunden.") }
    }

    override fun suggestFollow(suggestion: String) {
        if (state.follows.full) return state.say("Du bleibst schon an ${state.follows.max} Themen dran – entferne zuerst eines im Programm.")
        state.followDraft = suggestion
    }

    override fun follow(topic: String) {
        state.followDraft = null
        val clean = topic.trim()
        if (clean.length < 2) return
        lifecycleScope.launch {
            val result = runCatching { api.follow(clean) }
            state.say(result.fold(
                { "📌 Du bleibst an «$clean» dran. Gibt es Neues, kommt es ins Programm." },
                { if (it is ApiException && it.status == 409) "Du bleibst schon an ${state.follows.max} Themen dran." else it.message ?: getString(R.string.connection_failed) },
            ))
            loadFollows()
            changed()
        }
    }

    override fun unfollow(id: Long) {
        lifecycleScope.launch {
            runCatching { api.unfollow(id) }.onFailure { state.say(it.message ?: getString(R.string.connection_failed)) }
            loadFollows()
        }
    }

    private suspend fun loadBookmarks() { runCatching { api.bookmarks() }.getOrNull()?.let { state.bookmarks = it } }

    private suspend fun loadFollows() { runCatching { api.follows() }.getOrNull()?.let { state.follows = it } }

    override fun dictate() {
        val intent = Intent(android.speech.RecognizerIntent.ACTION_RECOGNIZE_SPEECH)
            .putExtra(android.speech.RecognizerIntent.EXTRA_LANGUAGE_MODEL, android.speech.RecognizerIntent.LANGUAGE_MODEL_FREE_FORM)
            .putExtra(android.speech.RecognizerIntent.EXTRA_LANGUAGE, "de-CH")
            .putExtra(android.speech.RecognizerIntent.EXTRA_PROMPT, "Was möchtest du das Radio fragen?")
        runCatching { dictation.launch(intent) }.onFailure { state.say("Auf diesem Gerät gibt es keine Spracheingabe – tipp die Frage einfach ein.") }
    }

    override fun addBlock(block: BlockView, subject: String) {
        window.decorView.performHapticFeedback(android.view.HapticFeedbackConstants.CONFIRM)
        serverAction(
            { api.addBlock(block.id, subject) },
            if (subject.isBlank()) getString(R.string.block_added, block.name) else getString(R.string.block_added_subject, block.name, subject),
        )
    }

    override fun loadFamily() {
        lifecycleScope.launch {
            runCatching { api.family() }.onSuccess { family ->
                state.family = family
                // Seen while the tab is open: read.
                val last = family.messages.lastOrNull()?.id
                if (state.tab == Tab.FAMILY && last != null && family.unread > 0) {
                    runCatching { api.markRead(last) }
                    state.familyUnread = 0
                } else state.familyUnread = family.unread
            }
        }
    }

    override fun sendMessage() {
        val text = state.familyDraft.trim()
        if (text.isEmpty() || state.familySending) return
        state.familySending = true
        lifecycleScope.launch {
            runCatching { api.sendMessage(text) }
                .onSuccess { state.familyDraft = "" }
                .onFailure { state.say(it.message ?: getString(R.string.connection_failed)) }
            state.familySending = false
            loadFamily()
        }
    }

    override fun greet(member: FamilyMember, text: String) {
        lifecycleScope.launch {
            val result = runCatching { api.greet(member.key, text.trim()) }
            state.say(result.fold({ "Der Gruss an ${member.name} kommt im nächsten Übergang im Radio." }, { it.message ?: getString(R.string.connection_failed) }))
            loadFamily()
        }
    }

    override fun listenAlong(member: FamilyMember) =
        serverAction({ api.listenAlong(member.key) }, "«${member.nowPlaying ?: "Das"}» kommt gleich auch bei dir.")

    override fun share(item: TimelineItem, member: FamilyMember) {
        lifecycleScope.launch {
            val result = runCatching { api.share(item.id, member.key) }
            state.say(result.fold({ "Mit ${member.name} geteilt: kommt gleich in ${member.name}s Programm." }, { it.message ?: getString(R.string.connection_failed) }))
            loadFamily()
        }
    }

    override fun chooseAvatar() {
        state.avatarMenuOpen = false
        avatarPicker.launch(PickVisualMediaRequest(ActivityResultContracts.PickVisualMedia.ImageOnly))
    }

    override fun takeAvatar() {
        state.avatarMenuOpen = false
        runCatching { avatarCamera.launch(null) }.onFailure { state.say("Keine Kamera-App gefunden.") }
    }

    override fun removeAvatar() {
        state.avatarMenuOpen = false
        lifecycleScope.launch {
            state.say(runCatching { api.removeAvatar() }.fold({ "Profilbild entfernt." }, { it.message ?: getString(R.string.connection_failed) }))
            loadFamily()
        }
    }

    private fun uploadAvatar(read: () -> android.graphics.Bitmap?) {
        state.avatarBusy = true
        lifecycleScope.launch {
            val image = withContext(Dispatchers.Default) { read()?.let(AvatarImage::encode) }
            val result = if (image == null) Result.failure(IllegalStateException("Das Bild konnte nicht gelesen werden.")) else runCatching { api.setAvatar(image) }
            state.say(result.fold({ "Profilbild gespeichert." }, { it.message ?: getString(R.string.connection_failed) }))
            state.avatarBusy = false
            loadFamily()
        }
    }

    override fun workerImage(path: String): Any = ImageRequest.Builder(this).data(api.resolve(path))
        .apply { api.headers().forEach { (name, value) -> addHeader(name, value) } }.build()

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
        loadSeries()
    }

    private suspend fun loadBlocks() {
        runCatching { api.blocks() }.getOrNull()?.let { state.blocks = it }
        loadSeries()
        loadFollows()
        loadBookmarks()
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
                if (!moodSending) state.mood = timeline.mood?.id
                // All open items: a new order always covers the whole program.
                state.open = timeline.items.filter { it.isOpen && it.id !in removing }
                state.heard = timeline.items.filter { it.isHeard }
                // More stickers than last time, without a choice or quiz here: earned elsewhere (an episode heard to the end).
                if (stickersSeen >= 0 && timeline.play.stickers > stickersSeen) {
                    state.say("⭐ Ein neuer Sticker ist in deinem Album!", "Ansehen") { openAlbum() }
                    state.album = null
                }
                stickersSeen = timeline.play.stickers
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
            loadBookmarks()
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
        // The sample is fetched first (a new voice can take a while), so a refusal shows its reason.
        lifecycleScope.launch {
            val file = java.io.File(cacheDir, "voice-sample")
            val loaded = withContext(Dispatchers.IO) { runCatching { api.download(api.previewPath(voiceId, style), file) } }
            if (state.previewing != voiceId) return@launch
            loaded.exceptionOrNull()?.let { error ->
                state.say(error.message ?: "Die Hörprobe ist gerade nicht verfügbar.")
                stopSample()
                return@launch
            }
            sample = android.media.MediaPlayer().apply {
                setAudioAttributes(android.media.AudioAttributes.Builder().setUsage(android.media.AudioAttributes.USAGE_MEDIA).setContentType(android.media.AudioAttributes.CONTENT_TYPE_SPEECH).build())
                setOnPreparedListener { it.start() }
                setOnCompletionListener { stopSample() }
                setOnErrorListener { _, _, _ -> state.say("Die Hörprobe lässt sich nicht abspielen."); stopSample(); true }
                runCatching {
                    setDataSource(file.path)
                    prepareAsync()
                }.onFailure { state.say("Die Hörprobe lässt sich nicht abspielen."); stopSample() }
            }
        }
    }

    private fun stopSample() {
        sample?.let { runCatching { it.stop() }; it.release() }
        sample = null
        state.previewing = null
        if (resumeAfterSample) controller?.play()
        resumeAfterSample = false
    }

    override fun searchVoices(query: String) {
        state.voiceSearch = query
        lifecycleScope.launch { runCatching { api.voices(query) }.onSuccess { state.voices = it } }
    }

    override fun designVoice(name: String, description: String, gender: String?) {
        if (state.voiceBusy) return
        state.voiceBusy = true
        lifecycleScope.launch {
            val result = runCatching { api.designVoice(name.trim(), description.trim(), gender) }
            state.voiceBusy = false
            result.onSuccess { voice -> if (voice != null) adoptVoice(voice, "Stimme «${voice.name}» entworfen – hör sie dir an.") else state.say("Google hat keine Stimme zurückgegeben.") }
                .onFailure { state.say(it.message ?: getString(R.string.connection_failed)) }
        }
    }

    override fun toggleRecording(consent: Boolean) {
        if (state.recording) {
            val wav = recorder.stop()
            recordTicker?.cancel()
            state.recording = false
            val seconds = (wav.size - 44) / (VoiceRecorder.RATE * 2)
            if (recordingConsent) { consentWav = wav; state.consentSeconds = seconds } else { sampleWav = wav; state.sampleSeconds = seconds }
            return
        }
        recordingConsent = consent
        if (ContextCompat.checkSelfPermission(this, Manifest.permission.RECORD_AUDIO) != PackageManager.PERMISSION_GRANTED) {
            microphonePermission.launch(Manifest.permission.RECORD_AUDIO)
            return
        }
        // The radio pauses while you speak.
        controller?.pause()
        runCatching { recorder.start() }.onFailure { return state.say(it.message ?: "Mikrofon nicht verfügbar.") }
        state.recording = true
        state.recordedSeconds = 0
        recordTicker = lifecycleScope.launch {
            while (recorder.recording) {
                state.recordedSeconds = recorder.seconds
                delay(250)
            }
            // The recorder stops itself at its limit.
            if (state.recording) toggleRecording(recordingConsent)
        }
    }

    override fun cloneVoice(name: String) {
        val sample = sampleWav ?: return state.say("Zuerst die Sprachprobe aufnehmen.")
        val consent = consentWav ?: return state.say("Zuerst den Einverständnis-Satz aufnehmen.")
        if (state.voiceBusy) return
        state.voiceBusy = true
        lifecycleScope.launch {
            val result = runCatching { api.cloneVoice(name.trim(), sample, consent) }
            state.voiceBusy = false
            result.onSuccess { voice -> if (voice != null) adoptVoice(voice, "Deine Stimme «${voice.name}» ist bereit – hör sie dir an.") else state.say("Google hat keine Stimme zurückgegeben.") }
                .onFailure { state.say(it.message ?: getString(R.string.connection_failed)) }
        }
    }

    /** A new own voice: listed first, chosen for the host (still to be saved) and played as a sample. */
    private fun adoptVoice(voice: VoiceOption, message: String) {
        closeVoiceDialogs()
        state.voices = listOf(voice) + state.voices.filter { it.id != voice.id }
        state.studio?.let { editStudio(it.copy(voiceId = voice.id)) }
        state.say(message)
        previewVoice(voice.id)
    }

    override fun deleteVoice(voice: VoiceOption) {
        state.voiceDeleteAsk = null
        lifecycleScope.launch {
            val result = runCatching { api.deleteVoice(voice.id) }
            if (result.isSuccess) {
                state.voices = state.voices.filter { it.id != voice.id }
                state.studio?.takeIf { it.voiceId == voice.id }?.let { editStudio(it.copy(voiceId = null)) }
            }
            state.say(result.fold({ "Stimme «${voice.name}» gelöscht." }, { it.message ?: getString(R.string.connection_failed) }))
        }
    }

    override fun closeVoiceDialogs() {
        if (state.recording) toggleRecording(recordingConsent)
        state.designOpen = false
        state.cloneOpen = false
        state.cloneStep = 0
        state.sampleSeconds = 0
        state.consentSeconds = 0
        sampleWav = null
        consentWav = null
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
