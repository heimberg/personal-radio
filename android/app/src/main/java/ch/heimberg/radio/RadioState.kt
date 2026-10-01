package ch.heimberg.radio

import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableLongStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import ch.heimberg.radio.core.AppBuild
import ch.heimberg.radio.core.BlockView
import ch.heimberg.radio.core.DayPlan
import ch.heimberg.radio.core.FailureSummary
import ch.heimberg.radio.core.Family
import ch.heimberg.radio.core.FamilyMember
import ch.heimberg.radio.core.FeedbackReason
import ch.heimberg.radio.core.Kind
import ch.heimberg.radio.core.Look
import ch.heimberg.radio.core.Looks
import ch.heimberg.radio.core.Place
import ch.heimberg.radio.core.ProgramSections
import ch.heimberg.radio.core.SeriesInfo
import ch.heimberg.radio.core.StudioSettings
import ch.heimberg.radio.core.TimelineItem
import ch.heimberg.radio.core.VoiceOption
import java.time.Instant

enum class Tab(val label: String, val icon: Int) {
    LISTEN("Hören", R.drawable.ic_waveform),
    PROGRAM("Programm", R.drawable.ic_clock),
    ARCHIVE("Archiv", R.drawable.ic_archive),
    FAMILY("Familie", R.drawable.ic_users),
    STUDIO("Studio", R.drawable.ic_sliders),
}

/** What the player is doing, in a word for the header chip. */
enum class Phase(val icon: String, val label: String) {
    WAITING("⏳", "In Produktion"),
    BUFFERING("⏳", "Lädt"),
    PLAYING("●", "Läuft"),
    PAUSED("⏸", "Pausiert"),
    ENDED("⏳", "Wartet auf den nächsten Beitrag"),
}

/** A short message for the snackbar; the counter lets the same text show twice. */
data class Message(val text: String, val id: Int)

/** Everything the screens show. The activity writes it; Compose redraws what changed. */
class RadioState {
    var tab by mutableStateOf(Tab.LISTEN)

    // The player, from the playback service.
    var title by mutableStateOf("")
    var show by mutableStateOf("")
    var status by mutableStateOf("")
    var phase by mutableStateOf(Phase.WAITING)
    var playWhenReady by mutableStateOf(false)
    var live by mutableStateOf(false)
    var hasMedia by mutableStateOf(false)
    var positionMs by mutableLongStateOf(0L)
    var durationMs by mutableLongStateOf(0L)
    var currentItemId by mutableStateOf<String?>(null)
    var sleepLabel by mutableStateOf<String?>(null)
    /** The playing song's album cover, from the player's metadata. */
    var artworkUrl by mutableStateOf<String?>(null)

    // The program, from the Worker.
    var open by mutableStateOf<List<TimelineItem>>(emptyList())
    var starts by mutableStateOf<Map<String, Instant>>(emptyMap())
    var failures by mutableStateOf(FailureSummary())
    var blocks by mutableStateOf<List<BlockView>>(emptyList())
    /** Running series (and recently ended ones), shown in «Programm». */
    var series by mutableStateOf<List<SeriesInfo>>(emptyList())
    var loaded by mutableStateOf(false)
    var refreshing by mutableStateOf(false)
    var connectionError by mutableStateOf<String?>(null)
    var spotifyNeeded by mutableStateOf(false)
    var spotifyBusy by mutableStateOf(false)

    // The archive.
    var archive by mutableStateOf<List<TimelineItem>?>(null)
    var archiveNote by mutableStateOf("")
    var archiveRefreshing by mutableStateOf(false)

    // «Familie»: shown once there are other listeners on the Worker.
    var familyEnabled by mutableStateOf(false)
    var family by mutableStateOf<Family?>(null)
    var familyUnread by mutableIntStateOf(0)
    var familyDraft by mutableStateOf("")
    var familySending by mutableStateOf(false)
    /** The member a greeting is being written for. */
    var greetFor by mutableStateOf<FamilyMember?>(null)

    // «Heute» and the day plan.
    var mood by mutableStateOf<String?>(null)
    var dayPlan by mutableStateOf<DayPlan?>(null)
    var dayPlanOpen by mutableStateOf(false)
    var dayPlanDirty by mutableStateOf(false)
    var dayPlanSaving by mutableStateOf(false)
    /** A window's start (true) or end (false) time being chosen. */
    var timeAsk by mutableStateOf<Pair<String, Boolean>?>(null)
    var blockPickFor by mutableStateOf<String?>(null)

    // «Studio»: the native settings; the web studio opens for the rest.
    var studio by mutableStateOf<StudioSettings?>(null)
    var studioMissing by mutableStateOf(false)
    var studioDirty by mutableStateOf(false)
    var studioSaving by mutableStateOf(false)
    var voices by mutableStateOf<List<VoiceOption>>(emptyList())
    var places by mutableStateOf<List<Place>?>(null)
    /** The voice whose sample is playing (or loading). */
    var previewing by mutableStateOf<String?>(null)
    var webStudioOpen by mutableStateOf(false)
    /** Which studio card is open; one at a time keeps the page short. */
    var studioCard by mutableStateOf<String?>(null)
    var voiceSearch by mutableStateOf("")
    /** The voice list sets the co-host's voice (dialogs) instead of the host's. */
    var voiceForCohost by mutableStateOf(false)
    // Own voices: designing one from a description, cloning one from two recordings.
    var designOpen by mutableStateOf(false)
    var cloneOpen by mutableStateOf(false)
    /** 0 = what happens, 1 = speech sample, 2 = spoken consent, 3 = name. */
    var cloneStep by mutableIntStateOf(0)
    var recording by mutableStateOf(false)
    var recordedSeconds by mutableIntStateOf(0)
    var sampleSeconds by mutableIntStateOf(0)
    var consentSeconds by mutableIntStateOf(0)
    var voiceBusy by mutableStateOf(false)
    var voiceDeleteAsk by mutableStateOf<VoiceOption?>(null)

    // Updates, messages and open dialogs.
    var update by mutableStateOf<AppBuild?>(null)
    var updateNote by mutableStateOf("")
    var updating by mutableStateOf(false)
    var message by mutableStateOf<Message?>(null)
    /** A long message opened from the snackbar's «Details». */
    var detail by mutableStateOf<String?>(null)
    private var messages by mutableIntStateOf(0)
    var reasonFor by mutableStateOf<String?>(null)
    var sleepOpen by mutableStateOf(false)
    var blockAsk by mutableStateOf<BlockView?>(null)
    var actionsFor by mutableStateOf<TimelineItem?>(null)
    var deleteAsk by mutableStateOf<TimelineItem?>(null)

    val sections: ProgramSections get() = ProgramSections.of(open, currentItemId)
    val current: TimelineItem? get() = open.firstOrNull { it.id == currentItemId }
    val look: Look? get() = current?.let(Looks::of)
    /** The cover of what plays: the song's album, else the item's first album, else none (the kind's tile). */
    val coverUrl: String? get() = artworkUrl ?: current?.coverUrl
    val progress: Float get() = if (durationMs > 0) (positionMs.toFloat() / durationMs).coerceIn(0f, 1f) else 0f
    val readyCount: Int get() = open.count { it.isPlayable }

    /** Music starts within the hour: only then is Spotify worth a note on «Hören». */
    val musicSoon: Boolean get() {
        val horizon = Instant.now().plusSeconds(3_600)
        return open.any { Looks.of(it).kind == Kind.MUSIC && (starts[it.id]?.isBefore(horizon) ?: true) }
    }

    fun say(text: String) {
        if (text.isBlank()) return
        message = Message(text, ++messages)
    }
}

/** What the screens can ask for; the activity does it. */
interface RadioActions {
    fun togglePlay()
    fun next()
    fun rate(liked: Boolean)
    fun reason(itemId: String, reason: FeedbackReason)
    fun deepen()
    fun transcript(item: TimelineItem? = null)
    fun sleep(minutes: Int)

    fun play(item: TimelineItem)
    fun swap(item: TimelineItem)
    fun remove(item: TimelineItem)
    fun playNext(item: TimelineItem)
    fun shift(item: TimelineItem, offset: Int)
    fun chooseBlock(block: BlockView)
    fun addBlock(block: BlockView, subject: String)
    fun stopSeries(series: SeriesInfo)

    /** «Familie»: loads members and chat (and marks it read while the tab is open). */
    fun loadFamily()
    fun sendMessage()
    fun greet(member: FamilyMember, text: String)
    fun listenAlong(member: FamilyMember)
    fun share(item: TimelineItem, member: FamilyMember)
    fun shuffle()
    fun addSong()
    fun plan()
    fun retry()
    fun cleanup()
    fun refresh()

    fun loadArchive()
    fun delete(item: TimelineItem)

    /** «Heute»: a mood until midnight, or none. */
    fun setMood(id: String?)
    fun openDayPlan()
    fun editDayPlan(plan: DayPlan)
    fun saveDayPlan()
    fun closeDayPlan()

    /** «Studio»: loads the settings (once, or again with [force]), edits them locally, saves them. */
    fun loadStudio(force: Boolean = false)
    fun editStudio(settings: StudioSettings)
    fun saveStudio()
    fun discardStudio()
    fun searchPlaces(name: String)
    /** Plays the voice sample, or stops it when it is playing. */
    fun previewVoice(voiceId: String)
    fun openWebStudio()
    fun closeWebStudio()

    /** Own voices: library search, a voice from a description, a cloned voice (two recordings), delete. */
    fun searchVoices(query: String)
    fun designVoice(name: String, description: String, gender: String?)
    /** Starts or stops a recording: the speech sample, or with [consent] the spoken consent. */
    fun toggleRecording(consent: Boolean)
    fun cloneVoice(name: String)
    fun deleteVoice(voice: VoiceOption)
    fun closeVoiceDialogs()

    fun connectSpotify()
    fun installUpdate()
    fun openConnection()
}
