package ch.heimberg.radio

import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableLongStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import ch.heimberg.radio.core.AppBuild
import ch.heimberg.radio.core.BlockView
import ch.heimberg.radio.core.Bookmark
import ch.heimberg.radio.core.FollowList
import ch.heimberg.radio.core.DayPlan
import ch.heimberg.radio.core.FailureSummary
import ch.heimberg.radio.core.Family
import ch.heimberg.radio.core.FamilyMember
import ch.heimberg.radio.core.FeatureCatalog
import ch.heimberg.radio.core.FeedbackReason
import ch.heimberg.radio.core.Kind
import ch.heimberg.radio.core.Look
import ch.heimberg.radio.core.Looks
import ch.heimberg.radio.core.Mitmachen
import ch.heimberg.radio.core.Place
import ch.heimberg.radio.core.PlaySummary
import ch.heimberg.radio.core.Sticker
import ch.heimberg.radio.core.StickerAlbum
import ch.heimberg.radio.core.ProgramSections
import ch.heimberg.radio.core.SeriesInfo
import ch.heimberg.radio.core.StudioSettings
import ch.heimberg.radio.core.StationDraft
import ch.heimberg.radio.core.Show
import ch.heimberg.radio.core.ListeningProfile
import ch.heimberg.radio.core.Insights
import ch.heimberg.radio.core.AgentPreset
import ch.heimberg.radio.core.AgentInfo
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
data class Message(val text: String, val id: Int, val action: String? = null, val onAction: (() -> Unit)? = null)

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
    // «＋ Einfügen» and «Für dich»: favourites and how often each block was inserted, kept on this phone only.
    var catalogOpen by mutableStateOf(false)
    var catalogQuery by mutableStateOf("")
    var catalogRubric by mutableStateOf(Kind.NEWS)
    var favorites by mutableStateOf<Set<String>>(emptySet())
    var usage by mutableStateOf<Map<String, Int>>(emptyMap())
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
    /** The choices for one's own profile picture; uploading it. */
    var avatarMenuOpen by mutableStateOf(false)
    var avatarBusy by mutableStateOf(false)

    // Mitmachen: choices, quizzes, stickers and questions to the radio.
    /** Items heard recently (from the timeline), for a choice or quiz still waiting after they ended. */
    var heard by mutableStateOf<List<TimelineItem>>(emptyList())
    var play by mutableStateOf(PlaySummary())
    /** The item whose choice or quiz is being sent. */
    var playSending by mutableStateOf<String?>(null)
    var askOpen by mutableStateOf(false)
    var askDraft by mutableStateOf("")
    var asking by mutableStateOf(false)
    var album by mutableStateOf<StickerAlbum?>(null)
    var albumOpen by mutableStateOf(false)
    /** A sticker just earned: shown big, once. */
    var newSticker by mutableStateOf<Sticker?>(null)
    /** Starting a Mitmach-Geschichte from picture cards. */
    var storyCardsFor by mutableStateOf<BlockView?>(null)

    // Nachfragen (a question about an item), Merken (the reading list) and Dranbleiben (followed topics).
    /** The item a question is asked about; the question dialog asks the radio when it is null. */
    var askAbout by mutableStateOf<TimelineItem?>(null)
    var bookmarks by mutableStateOf<List<Bookmark>>(emptyList())
    /** «Archiv» shows the reading list instead of the productions. */
    var readingList by mutableStateOf(false)
    var follows by mutableStateOf(FollowList())
    /** The topic being entered for «Dranbleiben». */
    var followDraft by mutableStateOf<String?>(null)

    // «Funktionen»: what the station does on its own, and which blocks the palette shows.
    var features by mutableStateOf<FeatureCatalog?>(null)
    var featuresBusy by mutableStateOf(false)

    // «Heute» and the day plan.
    var mood by mutableStateOf<String?>(null)
    var dayPlan by mutableStateOf<DayPlan?>(null)
    var dayPlanOpen by mutableStateOf(false)
    var dayPlanDirty by mutableStateOf(false)
    var dayPlanSaving by mutableStateOf(false)
    /** A window's start (true) or end (false) time being chosen. */
    var timeAsk by mutableStateOf<Pair<String, Boolean>?>(null)
    var blockPickFor by mutableStateOf<String?>(null)

    // «Studio»: every setting of the station, natively.
    var studio by mutableStateOf<StudioSettings?>(null)
    /** Shows, feeds and the editorial agents, edited with the rest and saved with «Speichern». */
    var station by mutableStateOf<StationDraft?>(null)
    /** The show being edited in its sheet (a new one until «Übernehmen»). */
    var showEdit by mutableStateOf<Show?>(null)
    var agentInfo by mutableStateOf<List<AgentInfo>>(emptyList())
    var agentPresets by mutableStateOf<List<AgentPreset>>(emptyList())
    /** The agent open in its sheet, and the trial runs so far. */
    var agentEdit by mutableStateOf<AgentInfo?>(null)
    var trials by mutableStateOf<Map<String, TrialResult?>>(emptyMap())
    var insights by mutableStateOf<Insights?>(null)
    var listening by mutableStateOf<ListeningProfile?>(null)
    var settingUp by mutableStateOf(false)
    var studioMissing by mutableStateOf(false)
    var studioDirty by mutableStateOf(false)
    var studioSaving by mutableStateOf(false)
    var voices by mutableStateOf<List<VoiceOption>>(emptyList())
    var places by mutableStateOf<List<Place>?>(null)
    /** The voice whose sample is playing (or loading). */
    var previewing by mutableStateOf<String?>(null)
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
    fun bookmarked(itemId: String?): Boolean = itemId != null && bookmarks.any { it.itemId == itemId }
    /** The choice or quiz to show on «Hören»: for what plays, else for something heard a little earlier. */
    val mitmachen: TimelineItem? get() = Mitmachen.pending(current, heard, Instant.now())

    /** Music starts within the hour: only then is Spotify worth a note on «Hören». */
    val musicSoon: Boolean get() {
        val horizon = Instant.now().plusSeconds(3_600)
        return open.any { Looks.of(it).kind == Kind.MUSIC && (starts[it.id]?.isBefore(horizon) ?: true) }
    }

    fun say(text: String) {
        if (text.isBlank()) return
        message = Message(text, ++messages)
    }

    /** A message with one action, e.g. «Rückgängig». */
    fun say(text: String, action: String, onAction: () -> Unit) {
        message = Message(text, ++messages, action, onAction)
    }
}

/** What the screens can ask for; the activity does it. */
/**
 * Everything the screens can ask for. The areas with their own controller (studio, voices, family,
 * Mitmachen, reading list, day plan) have their own interfaces; the activity handles the rest: playback,
 * the program, the archive, features and setup.
 */
interface RadioActions : StudioActions, VoiceActions, FamilyActions, MitmachenActions, ReadingActions, DayPlanActions {
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
    /** A new order of the open items (by id), from dragging in the program. */
    fun reorder(order: List<String>)
    fun chooseBlock(block: BlockView)
    /** ⭐ in the catalog: favourites come first there and in «Für dich». */
    fun toggleFavorite(block: BlockView)
    fun addBlock(block: BlockView, subject: String)
    fun stopSeries(series: SeriesInfo)

    /** «Funktionen»: load, switch a feature (Ortsgeschichten asks for the location first), show or hide a block. */
    fun loadFeatures()
    fun setFeature(id: String, on: Boolean)
    fun setBlockVisible(id: String, visible: Boolean)

    fun shuffle()
    fun addSong()
    fun plan()
    fun retry()
    fun cleanup()
    fun refresh()

    fun loadArchive()
    fun delete(item: TimelineItem)

    fun connectSpotify()
    fun installUpdate()
    fun openConnection()
}
