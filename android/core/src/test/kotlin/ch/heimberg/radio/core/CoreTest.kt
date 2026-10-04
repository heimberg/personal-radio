package ch.heimberg.radio.core

import kotlin.test.Test
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlin.test.assertEquals
import kotlin.test.assertNull
import kotlin.test.assertFalse
import kotlin.test.assertFailsWith
import kotlin.test.assertTrue

class ConnectionTest {
    private val connection = Connection.create(" https://radio.example.workers.dev ", " id.access ", " secret ")

    @Test fun normalizesAndResolvesSameOriginPaths() {
        assertEquals("https://radio.example.workers.dev/", connection.baseUrl)
        assertEquals("https://radio.example.workers.dev", connection.origin)
        assertEquals("https://radio.example.workers.dev/api/timeline/t1/audio", connection.resolve("api/timeline/t1/audio"))
        assertEquals(mapOf("CF-Access-Client-Id" to "id.access", "CF-Access-Client-Secret" to "secret"), connection.headers())
    }

    @Test fun neverSendsTheTokenToAnotherHost() {
        assertFailsWith<IllegalArgumentException> { connection.resolve("https://evil.example/audio") }
        assertFailsWith<IllegalArgumentException> { connection.resolve("//evil.example/audio") }
    }

    @Test fun rejectsUnsafeSetup() {
        assertFailsWith<IllegalArgumentException> { Connection.create("http://radio.example", "a", "b") }
        assertFailsWith<IllegalArgumentException> { Connection.create("https://user@radio.example", "a", "b") }
        assertFailsWith<IllegalArgumentException> { Connection.create("https://radio.example", "", "b") }
    }
}

class TimelineTest {
    private val body = """
        {"items":[
          {"id":"b","seq":2,"showId":"kurz","showName":"Kurzbeitrag","plannedAt":"2026-09-27T08:02:00.000Z","state":"planned","estimatedMinutes":2},
          {"id":"a","seq":1,"showId":"kurz","showName":"Kurzbeitrag","plannedAt":"2026-09-27T08:00:00.000Z","state":"ready","estimatedMinutes":2,
           "title":"Sonde gelandet","audioUrl":"api/timeline/a/audio","interestTags":["Raumfahrt"],"sources":[{"title":"example.org","url":"https://example.org"}],
           "searchQueries":["sonde"],"futureField":true}
        ]}
    """.trimIndent()

    @Test fun parsesSortedAndToleratesNewFields() {
        val items = TimelineJson.parse(body)
        assertEquals(listOf("a", "b"), items.map { it.id })
        assertEquals("Sonde gelandet", items[0].displayTitle)
        assertEquals("Kurzbeitrag", items[1].displayTitle)
        assertTrue(items[0].isPlayable)
        assertEquals(listOf(SourceRef("example.org", "https://example.org")), items[0].sources)
    }

    @Test fun rejectionsShowTheReason() {
        assertEquals("Quellenprüfung nicht bestanden – Nicht belegt: «X»", Labels.error("REJECTED: Nicht belegt: «X»"))
        assertEquals("Quellenprüfung nicht bestanden.", Labels.error("REJECTED"))
        assertEquals("Unerwarteter Fehler (SOMETHING_NEW).", Labels.error("SOMETHING_NEW"))
        assertEquals("Gemini antwortete nicht.", Labels.error("Gemini antwortete nicht."))
        assert(Labels.error("INVALID_INPUT").startsWith("Die Quellen oder der Text"))
        assertEquals("Produktion abgebrochen – Text zu lang", Labels.error("INVALID_INPUT: Text zu lang"))
    }

    @Test fun queueFollowsTheProgramOrderAndSkipsWhatWasPlayed() {
        val queue = ProgramQueue()
        val items = TimelineJson.parse(body)
        assertEquals(listOf("a"), queue.upcoming(items, false, null).map { it.id })
        val later = items.map { if (it.id == "b") it.copy(state = "ready", audioUrl = "api/timeline/b/audio") else it }
        assertEquals(listOf("a", "b"), queue.upcoming(later, false, null).map { it.id })
        // Reordered in the program: the new order wins.
        val reordered = later.map { if (it.id == "b") it.copy(seq = 0) else it }
        assertEquals(listOf("b", "a"), queue.upcoming(reordered, false, null).map { it.id })
        // The current item and those already left are not queued again.
        assertEquals(listOf("b"), queue.upcoming(later, false, "a").map { it.id })
        queue.markPassed("a")
        assertEquals(listOf("b"), queue.upcoming(later, false, null).map { it.id })
        assertTrue(queue.matches(listOf("b"), queue.upcoming(later, false, null)))
    }
}

class FeedbackTest {
    @Test fun naturalEndIsCompleteAndLeavingEarlyIsASkipWithTheHeardShare() {
        assertEquals(Feedback("a", FeedbackAction.COMPLETE, 1.0), FeedbackPolicy.onLeave("a", true, 10, 100))
        assertEquals(Feedback("a", FeedbackAction.SKIP, 0.25), FeedbackPolicy.onLeave("a", false, 30_000, 120_000))
        assertEquals(0.0, FeedbackPolicy.onLeave("a", false, 5, 0).listenedRatio)
        assertEquals("""{"action":"like","listenedRatio":1.0}""", FeedbackPolicy.rating("a", true).toJson())
        assertEquals("""{"reason":"too_long"}""", FeedbackReason.TOO_LONG.toJson())
        assertTrue(FeedbackReason.asksFor("entdecken"))
        assertFalse(FeedbackReason.asksFor("_musik"))
    }
}

class ArtistHourTest {
    private val body = """
        {"spotify":{"clientId":"abc"},"items":[
          {"id":"h","seq":3,"showId":"kuenstler","showName":"Künstlerstunde","plannedAt":"2026-09-27T09:00:00.000Z","state":"ready","estimatedMinutes":60,
           "title":"Portishead","artist":"Portishead","parts":[
             {"kind":"speech","audioUrl":"api/timeline/h/audio?part=0"},
             {"kind":"track","spotifyUri":"spotify:track:1","title":"Glory Box","artist":"Portishead","durationMs":305000},
             {"kind":"speech","audioUrl":"api/timeline/h/audio?part=2"}]},
          {"id":"a","seq":1,"showId":"kurz","showName":"Kurzbeitrag","plannedAt":"2026-09-27T08:00:00.000Z","state":"ready","estimatedMinutes":2,"audioUrl":"api/timeline/a/audio"}
        ]}
    """.trimIndent()

    @Test fun readsPartsAndTheSpotifyClientId() {
        val timeline = TimelineJson.parseResponse(body)
        assertEquals("abc", timeline.spotify?.clientId)
        val hour = timeline.items.last()
        assertTrue(hour.isPlayable && hour.hasMusic)
        assertEquals(null, TimelineJson.parseResponse("""{"items":[]}""").spotify)
        val unvoiced = hour.copy(parts = hour.parts.mapIndexed { i, p -> if (i == 2) p.copy(audioUrl = null) else p })
        assertTrue(!unvoiced.isPlayable)
    }

    @Test fun anHourBecomesStepsInPlayingOrderWithFeedbackOnTheLastOne() {
        val hour = TimelineJson.parse(body).last()
        val steps = Program.steps(hour)
        assertEquals(listOf("h#0", "h#1", "h#2"), steps.map { it.mediaId })
        val track = steps[1] as TrackStep
        assertEquals("spotify:track:1", track.spotifyUri); assertEquals("Glory Box", track.title); assertEquals(305_000, track.durationMs)
        assertEquals(listOf(false, false, true), steps.map { it.last })
        assertEquals("h", Program.itemIdOf("h#2")); assertEquals("a", Program.itemIdOf("a"))
        assertEquals(listOf("a"), Program.steps(TimelineJson.parse(body).first()).map { it.mediaId })
    }

    @Test fun hoursWaitUntilSpotifyIsConnected() {
        val queue = ProgramQueue()
        val items = TimelineJson.parse(body)
        assertEquals(listOf("a"), queue.upcoming(items, musicAvailable = false, current = null).map { it.id })
        assertEquals(listOf("a", "h"), queue.upcoming(items, musicAvailable = true, current = null).map { it.id })
    }

    @Test fun theTrackWatchHandsBackAtTheEndOrWhenSpotifyMovesOn() {
        val watch = TrackWatch("spotify:track:1", 300_000)
        assertTrue(!watch.ended("spotify:track:old", true, 50_000)) // state from before our track started
        assertTrue(!watch.ended("spotify:track:1", false, 0))
        assertTrue(!watch.ended("spotify:track:1", true, 120_000)) // paused in the middle, e.g. a call
        assertTrue(watch.ended("spotify:track:1", true, 299_000))
        val moved = TrackWatch("spotify:track:1", 300_000)
        moved.ended("spotify:track:1", false, 1_000)
        assertTrue(moved.ended("spotify:track:autoplay", false, 0))
        val reset = TrackWatch("spotify:track:1", 300_000)
        reset.ended("spotify:track:1", false, 1_000)
        assertTrue(reset.ended("spotify:track:1", true, 0))
    }

    @Test fun artistHourErrorsAreExplained() {
        assertEquals("Zu wenige Songs gefunden – 2 von 14 Songs auf Spotify gefunden", Labels.error("TOO_FEW_TRACKS: 2 von 14 Songs auf Spotify gefunden"))
        assertEquals("Spotify ist auf dem Server nicht eingerichtet.", Labels.error("SPOTIFY_NOT_CONFIGURED"))
    }
}

class AccessDiagnosisTest {
    @Test fun namesTheLayerThatRefused() {
        assertEquals(AccessDiagnosis.ACCESS_REFUSED, AccessDiagnosis.message(302, "https://team.cloudflareaccess.com/cdn-cgi/access/login/radio", ""))
        assertEquals(AccessDiagnosis.ACCESS_REFUSED, AccessDiagnosis.message(403, null, "<html>Forbidden</html>"))
        assertTrue(AccessDiagnosis.message(401, null, """{"error":"unauthorized","reason":"service_token_not_allowed"}""").contains("ACCESS_SERVICE_TOKEN_ID"))
        assertTrue(AccessDiagnosis.message(403, null, """{"error":"origin_rejected"}""").contains("Origin"))
        assertEquals("Tageslimit erreicht.", AccessDiagnosis.message(429, null, ""))
    }

    @Test fun aGoneItemIsNotAWrongAddress() {
        assertTrue(AccessDiagnosis.message(404, null, """{"error":"not_found"}""").contains("Beitrag"))
        assertTrue(AccessDiagnosis.message(404, null, """{"error":"unknown_block"}""").contains("Baustein"))
        assertTrue(AccessDiagnosis.message(404, null, "<html>Not Found</html>").contains("kein Radio-Server"))
    }
}

class LibraryTest {
    @Test fun listsWhatCanStillBeHeardAndRoundTripsAnItem() {
        val library = TimelineJson.parseLibrary(
            """{"items":[
              {"id":"a","seq":9,"showId":"news","showName":"News","plannedAt":"2026-09-28T08:00:00Z","state":"archived","estimatedMinutes":2,"audioUrl":"api/timeline/a/audio"},
              {"id":"b","seq":3,"showId":"k","showName":"Künstler","plannedAt":"2026-09-27T08:00:00Z","state":"played","estimatedMinutes":60,
               "parts":[{"kind":"speech"},{"kind":"track","spotifyUri":"spotify:track:x","durationMs":1000}]}
            ],"retentionDays":7,"future":1}""",
        )
        assertEquals(listOf("a", "b"), library.items.map { it.id })
        assertEquals(7, library.retentionDays)
        assertTrue(library.items[0].hasAudio && !library.items[0].isPlayable && !library.items[0].isHeard)
        assertTrue(!library.items[1].hasAudio && library.items[1].isHeard)
        assertEquals("Nicht gehört", Labels.state("archived"))
        assertEquals(library.items[0], TimelineJson.parseItem(TimelineJson.encodeItem(library.items[0])))
    }
}

class ProgramClockTest {
    private fun item(id: String, seq: Int, minutes: Double) = TimelineItem(id, seq, "s", "Show", "2026-09-28T08:00:00Z", "ready", minutes)

    @Test fun startTimesFollowTheListFromNowWithThePlayingItemFirst() {
        val items = listOf(item("a", 1, 2.0), item("b", 2, 4.0), item("c", 3, 60.0))
        val now = java.time.Instant.parse("2026-09-28T08:00:00Z")
        val ordered = ProgramClock.playingOrder(items, "b")
        assertEquals(listOf("b", "a", "c"), ordered.map { it.id })
        val starts = ProgramClock.startTimes(ordered, now, "b", 90_000)
        assertEquals(now, starts["b"])
        assertEquals(now.plusSeconds(90), starts["a"])
        assertEquals(now.plusSeconds(90 + 120), starts["c"])
        // Nothing playing: the list starts now.
        assertEquals(now.plusSeconds(120), ProgramClock.startTimes(items, now, null, null)["b"])
        // Still playing but no longer listed: the next item waits for its end, not «now».
        assertEquals(now.plusSeconds(380), ProgramClock.startTimes(items, now, "gone", 380_000)["a"])
    }

    @Test fun movingKeepsThePlayingItemFirst() {
        val items = listOf(item("b", 2, 4.0), item("a", 1, 2.0), item("c", 3, 60.0))
        assertEquals(listOf("b", "c", "a"), ProgramClock.move(items, 2, 1, "b").map { it.id })
        assertEquals(items, ProgramClock.move(items, 1, 0, "b"))
        assertEquals(listOf("a", "b", "c"), ProgramClock.move(items, 1, 0, null).map { it.id })
    }

    @Test fun playNextAndShiftKeepThePlayingItemFirst() {
        val items = listOf(item("a", 1, 2.0), item("b", 2, 4.0), item("c", 3, 6.0), item("d", 4, 1.0))
        assertEquals(listOf("b", "d", "a", "c"), ProgramClock.playNext(items, "d", "b").map { it.id })
        assertEquals(listOf("d", "a", "b", "c"), ProgramClock.playNext(items, "d", null).map { it.id })
        assertEquals(listOf("b", "c", "a", "d"), ProgramClock.shift(items, "a", 1, "b").map { it.id })
        // The playing item cannot be passed, and unknown items change nothing.
        assertEquals(listOf("b", "a", "c", "d"), ProgramClock.shift(items, "a", -1, "b").map { it.id })
        assertEquals(items, ProgramClock.shift(items, "x", 1, "b"))
    }

    @Test fun sectionsSplitNowNextAndLater() {
        val items = listOf(item("a", 1, 2.0), item("b", 2, 4.0), item("c", 3, 6.0))
        val playing = ProgramSections.of(items, "b")
        assertEquals("b", playing.now?.id)
        assertEquals("a", playing.next?.id)
        assertEquals(listOf("c"), playing.later.map { it.id })
        val idle = ProgramSections.of(items, null)
        assertEquals(null, idle.now)
        assertEquals("a", idle.next?.id)
        assertEquals(listOf("b", "c"), idle.later.map { it.id })
        assertEquals(ProgramSections(null, null, emptyList()), ProgramSections.of(emptyList(), "b"))
    }
}

class TranscriptTest {
    @Test fun readsLinesWithSpeakersSongsAndSources() {
        val transcript = TimelineJson.parseTranscript(
            """{"title":"Portishead","lines":[{"text":"Willkommen."},{"text":"Glory Box – Portishead","song":true},{"speaker":"Jonas","text":"Genau."}],
               "sources":[{"title":"Quelle","url":"https://example.org/a"}],"extra":1}""",
        )
        assertEquals("Portishead", transcript.title)
        assertEquals(listOf(false, true, false), transcript.lines.map { it.song })
        assertEquals("Jonas", transcript.lines[2].speaker)
        assertEquals("https://example.org/a", transcript.sources.single().url)
        assertEquals(null, transcript.quality)
        assertEquals(4.2, TimelineJson.parseTranscript("""{"title":"x","quality":{"overall":4.2,"hook":4,"notes":"gut"}}""").quality?.overall)
    }
}

class AppBuildTest {
    @Test fun offersOnlyNewerCompleteBuilds() {
        val build = AppBuild.parse("""{"versionCode":110,"versionName":"0.2.110","sha256":"${"a".repeat(64)}","size":6700000,"extra":true}""")
        assertTrue(build.newerThan(102))
        assertTrue(!build.newerThan(110))
        assertTrue(!build.copy(sha256 = "kaputt").newerThan(1))
        assertTrue(!build.copy(size = 0).newerThan(1))
    }
}

class BlockTest {
    @Test fun readsBlocksAndFailures() {
        val blocks = TimelineJson.parseBlocks(
            """{"blocks":[{"id":"wetter","name":"Wetter","description":"Heute und morgen","minutes":1,"music":false,"own":false},
               {"id":"kuenstler","name":"Künstler-Stunde","description":"Eine Band","minutes":60,"music":true,"own":false,
                "input":{"kind":"artist","label":"Künstler oder Band","example":"z. B. Portishead"}},{"id":"x","name":"X","description":"","new":1}]}""",
        )
        assertEquals(listOf("wetter", "kuenstler", "x"), blocks.map { it.id })
        assertEquals(null, blocks[0].input)
        assertEquals("Künstler oder Band", blocks[1].input?.label)
        val timeline = TimelineJson.parseResponse("""{"items":[],"failures":{"count":2,"latestError":"NO_SOURCES","latestAt":"2026-09-28T08:00:00Z"}}""")
        assertEquals(2, timeline.failures.count)
        assertEquals(0, TimelineJson.parseResponse("""{"items":[]}""").failures.count)
    }
}

class NoticeTrackerTest {
    private fun item(id: String, state: String, minutes: Double) = TimelineItem(id, 1, "s", "Show", "2026-09-28T08:00:00Z", state, minutes, title = id)

    @Test fun reportsLongProductionsThatBecameReadyAndNewFailuresOnly() {
        val tracker = NoticeTracker()
        val old = FailureSummary(1, "NO_SOURCES", "2026-09-28T07:00:00Z")
        // The first sync only records: nothing is reported.
        assertEquals(NoticeTracker.Notices(emptyList(), null), tracker.update(Timeline(listOf(item("hour", "voicing", 60.0), item("brief", "planned", 2.0)), failures = old)))
        val next = tracker.update(Timeline(listOf(item("hour", "ready", 60.0), item("brief", "ready", 2.0)), failures = old))
        assertEquals(listOf("hour"), next.ready.map { it.id })
        assertEquals(null, next.failure)
        val failed = FailureSummary(2, "REJECTED", "2026-09-28T08:05:00Z")
        val after = tracker.update(Timeline(listOf(item("hour", "ready", 60.0)), failures = failed))
        assertEquals(emptyList(), after.ready)
        assertEquals("REJECTED", after.failure?.latestError)
        assertEquals(null, tracker.update(Timeline(emptyList(), failures = failed)).failure)
    }
}

class NoticeStateTest {
    @Test fun aSavedTrackerContinuesWhereItStopped() {
        val first = NoticeTracker()
        first.update(Timeline(listOf(TimelineItem("hour", 1, "s", "Show", "2026-09-28T08:00:00Z", "voicing", 60.0))))
        val saved = NoticeState.parse(first.state.toJson())
        val second = NoticeTracker(saved)
        val notices = second.update(Timeline(listOf(TimelineItem("hour", 1, "s", "Show", "2026-09-28T08:00:00Z", "ready", 60.0))))
        assertEquals(listOf("hour"), notices.ready.map { it.id })
        assertEquals(NoticeState(), NoticeState.parse("kaputt"))
    }
}

class StationSoundTest {
    private fun item(id: String, music: Boolean) = TimelineItem(id, 1, if (music) "_musik" else "s", "Show", "2026-09-29T08:00:00Z", "ready", 3.0,
        audioUrl = if (music) null else "api/timeline/$id/audio",
        parts = if (music) listOf(TimelinePart(kind = "track", spotifyUri = "spotify:track:1", title = "T", artist = "A", durationMs = 1000)) else emptyList())

    private fun news(id: String) = item(id, false).copy(showId = "_block:schlagzeilen")

    @Test
    fun identPrecedesSpeechAfterMusicOnly() {
        val sounds = StationSounds(identUrl = "api/sounds/ident.wav")
        val steps = StationSound.withSounds(listOf(item("a", false), item("b", true), item("c", false)), sounds, before = item("x", true), stationName = "Radio")
        assertEquals(listOf("a#ident", "a", "b#0", "c#ident", "c"), steps.map { it.mediaId })
        assertFalse(steps.first().last)
        // The jingle already names the item it leads into, with the station beneath.
        assertEquals(steps[1].title to "Radio", steps.first().title to steps.first().subtitle)
        assertEquals(listOf("a", "b#0", "c"), StationSound.withSounds(listOf(item("a", false), item("b", true), item("c", false)), StationSounds(), item("x", true)).map { it.mediaId })
    }

    @Test
    fun liveTransitionBeforeEverySpokenItemAndOpenerBeforeNews() {
        val sounds = StationSounds(identUrls = listOf("api/sounds/ident/0.wav", "api/sounds/ident/1.wav"), newsUrl = "api/sounds/news.wav", linkerUrl = "api/linker")
        val steps = StationSound.withSounds(listOf(item("a", false), item("b", true), news("c"), item("d", false)), sounds, before = null)
        assertEquals(listOf("a#link", "a", "b#0", "c#link", "c#news", "c", "d#link", "d"), steps.map { it.mediaId })
        val urls = steps.filterIsInstance<SpeechStep>().associate { it.mediaId to it.audioUrl }
        assertEquals("api/linker?next=a", urls["a#link"])
        assertEquals("api/linker?after=b&next=c", urls["c#link"])
        assertEquals("api/linker?after=c&next=d", urls["d#link"])
        assertTrue(steps.filter { it.mediaId.contains('#') && !it.mediaId.contains("#0") }.none { it.last })
        // After music the jingle comes first; each item keeps its variant.
        val afterMusic = StationSound.withSounds(listOf(item("e", false)), sounds, before = item("x", true))
        assertEquals(listOf("e#ident", "e#link", "e"), afterMusic.map { it.mediaId })
        assertEquals(sounds.identFor("e"), (afterMusic.first() as SpeechStep).audioUrl)
        assertEquals(sounds.identFor("e"), sounds.identFor("e"))
    }

    @Test
    fun hourSignalOncePerHourEarlyOnly() {
        val signal = HourSignal(startHour = 7)
        assertFalse(signal.due(7, 55))
        assertTrue(signal.due(8, 2))
        assertFalse(signal.due(8, 10))
        assertFalse(signal.due(9, 35))
        assertFalse(signal.due(9, 40))
    }
}

class LooksTest {
    @Test
    fun everyItemBelongsToOneOfFiveRubrics() {
        fun item(showId: String, music: Boolean = false, surprise: Boolean = false) = TimelineItem("i", 1, showId, "S", "2026-09-29T08:00:00Z", "ready", 2.0, surprise = surprise,
            parts = if (music) listOf(TimelinePart(kind = "track", spotifyUri = "spotify:track:1")) else emptyList())
        assertEquals(Look(Kind.MUSIC, "🎶"), Looks.of(item("_musik", music = true)))
        assertEquals(Look(Kind.NEWS, "☀️"), Looks.of(item("_block:wetter")))
        assertEquals(Kind.SPECIAL, Looks.of(item("_block:zufallsfund", surprise = true)).kind)
        assertEquals(Kind.SPECIAL, Looks.of(item("eigene-stunde", surprise = true)).kind)
        assertEquals(Kind.MUSIC, Looks.of(item("eigene-stunde", music = true)).kind)
        assertEquals(Kind.DISCOVER, Looks.of(item("entdecken")).kind)
        assertEquals(Kind.SPECIAL, Looks.ofBlock(BlockView("ueberraschung", "Überraschung", "")).kind)
        assertEquals(Kind.STORY, Looks.ofBlock(BlockView("mitmach", "Mitmach-Geschichte", "")).kind)
        assertEquals(Kind.NEWS, Looks.ofBlock(BlockView("weltpresse", "Weltpresse", "")).kind)
        assertEquals(Kind.MUSIC, Looks.ofBlock(BlockView("show:x", "X", "", music = true)).kind)
        assertEquals(5, Kind.entries.size)
        assertEquals(0xFF16171B.toInt(), Kind.STORY.onArgb.toInt())
    }
}

class CatalogTest {
    private val blocks = listOf(
        BlockView("morgen", "Morgenbriefing", "Datum, Wetter und Schlagzeilen"),
        BlockView("weltpresse", "Weltpresse", "Wie die Welt über ein Thema berichtet"),
        BlockView("hintergrund", "Hintergrund", "Zwei Stimmen ordnen ein Thema ein"),
        BlockView("musik", "Musikblock", "30 Minuten Musik", music = true),
        BlockView("song", "Song", "Ein Song", music = true),
        BlockView("mitmach", "Mitmach-Geschichte", "Du entscheidest"),
        BlockView("ueberraschung", "Überraschung", "Etwas Unerwartetes"),
    )

    @Test fun rubricsKeepAllFiveTabsAndPutFavouritesFirst() {
        val rubrics = Catalog.rubrics(blocks, favorites = setOf("weltpresse"))
        assertEquals(Kind.entries.toList(), rubrics.map { it.first })
        assertEquals(listOf("weltpresse", "morgen"), rubrics[0].second.map { it.id })
        // A single song is not in the catalog: it has its own button.
        assertEquals(listOf("musik"), rubrics[2].second.map { it.id })
    }

    @Test fun searchIgnoresCaseAndUmlauts() {
        assertEquals(listOf("ueberraschung"), Catalog.search(blocks, "uberrasch").map { it.id })
        assertEquals(listOf("morgen"), Catalog.search(blocks, "WETTER datum").map { it.id })
        assertEquals(listOf("mitmach"), Catalog.search(blocks, "geschichten").map { it.id })
        assertEquals(listOf("hintergrund", "weltpresse"), Catalog.search(blocks, "thema", favorites = setOf("hintergrund")).map { it.id })
        assertEquals(emptyList<BlockView>(), Catalog.search(blocks, "  "))
    }

    @Test fun forYouMixesTimeOfDayFavouritesHabitsAndSomethingNew() {
        val picks = ForYou.picks(blocks, hour = 7, weekday = 6, day = 0, usage = mapOf("musik" to 5, "hintergrund" to 3, "weltpresse" to 1), favorites = setOf("mitmach"))
        assertEquals(listOf("morgen" to "MORGENS", "mitmach" to "FAVORIT", "musik" to "OFT", "hintergrund" to "OFT"), picks.map { it.block.id to it.why })
        val evening = ForYou.picks(blocks, hour = 20, weekday = 2, day = 1, usage = mapOf("musik" to 1), favorites = emptySet())
        assertEquals("musik" to "ABENDS", evening.first().let { it.block.id to it.why })
        assertTrue(evening.any { it.why == "NEU" })
        assertEquals(ForYou.LIMIT, evening.size)
        assertEquals(evening.size, evening.map { it.block.id }.distinct().size)
    }

    @Test fun forYouOnlySuggestsWhatTheStationOffers() {
        val picks = ForYou.picks(blocks.take(2), hour = 21, weekday = 7, day = 3, usage = mapOf("kuenstler" to 9), favorites = setOf("rueckblick"))
        assertEquals(setOf("morgen", "weltpresse"), picks.map { it.block.id }.toSet())
    }

    @Test fun momentNamesDayAndPart() {
        assertEquals("Samstagmorgen", ForYou.moment(7, 6))
        assertEquals("Montagnachmittag", ForYou.moment(15, 1))
        assertEquals("Sonntagnacht", ForYou.moment(23, 7))
    }

    @Test fun headlineSplitsAtTheFirstBreak() {
        assertEquals("Kernfusion" to "Was der Durchbruch bedeutet", Headline.split("Kernfusion: Was der Durchbruch bedeutet"))
        assertEquals("Massive Attack" to "Teardrop", Headline.split("Massive Attack – Teardrop"))
        assertEquals("Musik nach deinem Geschmack" to null, Headline.split("Musik nach deinem Geschmack"))
    }
}

class SeriesTest {
    @Test fun episodesShowTheirSeriesAndProgress() {
        val item = TimelineJson.parse("""{"items":[{"id":"e1","seq":1,"showId":"_series:s1","showName":"Die Drachen-Saga · Folge 2/5","plannedAt":"2026-10-01T08:00:00Z","state":"ready","estimatedMinutes":6,"series":{"id":"s1","episode":2,"total":5,"kind":"geschichte"}}]}""").single()
        assertEquals(SeriesRef("s1", 2, 5, "geschichte"), item.series)
        assertEquals("📖", Looks.of(item).icon)
        assertEquals("📚", Looks.of(item.copy(series = item.series!!.copy(kind = "wissen"))).icon)
        val list = TimelineJson.parseSeries("""{"series":[{"id":"s1","title":"Die Drachen-Saga","kind":"geschichte","state":"active","episodes":["A","B","C"],"scheduled":2},{"id":"s2","title":"Mond","state":"done","episodes":["A","B","C"],"scheduled":3},{"id":"s3","title":"Netz","state":"stopped","episodes":["A","B"],"scheduled":1}]}""")
        assertEquals(listOf("Folge 2 von 3", "Alle 3 Folgen gehört", "Beendet nach Folge 1"), list.map { it.progress })
        assertTrue(list[0].active && list[0].story)
        assertFalse(list[1].active)
    }

    @Test fun seriesAreNotDayPlanBlocks() {
        assertEquals(null, DayPlan.scheduleId(BlockView("serie", "Wissensserie", "")))
        assertEquals(null, DayPlan.scheduleId(BlockView("geschichte", "Fortsetzungsgeschichte", "")))
        assertEquals("_block:hintergrund", DayPlan.scheduleId(BlockView("hintergrund", "Hintergrund", "")))
    }

    @Test fun seriesErrorsSayWhatToDo() {
        assertTrue(AccessDiagnosis.message(409, null, """{"error":"gemini_not_configured"}""").contains("GEMINI_API_KEY"))
        assertTrue(AccessDiagnosis.message(502, null, """{"error":"series_outline_failed"}""").contains("nochmals"))
        assertEquals("Google meldet zur Stimme: Gemini TTS 400: Voice is not ready",
            AccessDiagnosis.message(502, null, """{"error":"voice_failed","detail":"Gemini TTS 400: Voice is not ready"}"""))
    }
}

class FamilyTest {
    private val body = """{"me":"tom","members":[
        {"key":"owner","name":"Papa","nowPlaying":"Kernfusion erklärt","lastSeen":"2026-10-01T07:55:00Z","avatarUrl":"api/family/avatar/owner?v=17"},
        {"key":"lea","name":"Lea","kids":true,"lastSeen":"2026-09-28T20:00:00Z"},
        {"key":"tom","name":"Tom","me":true}],
      "messages":[{"id":1,"from":"owner","fromName":"Papa","kind":"text","text":"Hallo!","at":"2026-10-01T07:58:00Z"},
        {"id":2,"from":"owner","fromName":"Papa","to":"lea","toName":"Lea","kind":"share","text":"Die Drachen-Saga","at":"2026-10-01T07:59:00Z"},
        {"id":3,"from":"owner","fromName":"Papa","to":"lea","toName":"Lea","kind":"greeting","text":"Schlaf gut!","at":"2026-10-01T08:00:00Z"}],
      "unread":2}"""

    @Test fun membersStatusAndWhatCanBeShared() {
        val family = Family.parse(body)
        val now = java.time.Instant.parse("2026-10-01T08:00:00Z")
        assertEquals(listOf("Papa", "Lea"), family.others.map { it.name })
        assertEquals(listOf("api/family/avatar/owner?v=17", null, null), family.members.map { it.avatarUrl })
        assertEquals("P", family.members[0].initial)
        assertEquals("hört gerade «Kernfusion erklärt»", family.members[0].status(now))
        assertEquals("zuletzt aktiv vor 2 Tagen", family.members[1].status(now))
        assertEquals("noch nie zugehört", family.members[2].status(now))
        // Tom is not the owner: Lea's station only takes what Papa shares.
        assertEquals(listOf("owner"), family.shareTargets().map { it.key })
        assertTrue(family.canListenAlong(family.members[0]))
        assertFalse(family.canListenAlong(family.members[1]))
        assertEquals(listOf("Lea"), family.copy(me = "owner", members = family.members.map { it.copy(me = it.key == "owner") }).shareTargets().map { it.name }.filter { it == "Lea" })
        val asLea = family.copy(me = "lea", members = family.members.map { it.copy(me = it.key == "lea") })
        assertFalse(asLea.canListenAlong(asLea.members[0])) // a child takes nothing from others
    }

    @Test fun messagesReadAsWhatHappened() {
        val messages = Family.parse(body).messages
        assertEquals(listOf("Hallo!", "hat «Die Drachen-Saga» mit Lea geteilt", "grüsst Lea im Radio: «Schlaf gut!»"), messages.map { it.line })
        assertEquals(listOf("", "🎧", "💌"), messages.map { it.icon })
        val now = java.time.Instant.parse("2026-10-01T08:00:00Z")
        assertEquals("gerade eben", ago(now.minusSeconds(30), now))
        assertEquals("vor 5 Min.", ago(now.minusSeconds(300), now))
        assertEquals("vor 3 Std.", ago(now.minusSeconds(3 * 3600), now))
        assertEquals("gestern", ago(now.minusSeconds(30 * 3600), now))
    }

    @Test fun aNewFamilyMessageIsNotifiedOnce() {
        val timeline = { id: Long? -> TimelineJson.parseResponse("""{"items":[]${id?.let { ""","family":{"unread":1,"latest":{"id":$it,"line":"Papa: Hallo!"}}""" } ?: ""}}""") }
        val tracker = NoticeTracker()
        assertEquals(null, tracker.update(timeline(5)).message) // the first sync only records
        assertEquals(null, tracker.update(timeline(5)).message)
        assertEquals("Papa: Hallo!", tracker.update(timeline(6)).message?.line)
        assertEquals(null, NoticeTracker(tracker.state).update(timeline(6)).message) // shared state: not twice
        assertEquals(null, tracker.update(timeline(null)).message)
        assertEquals(null, TimelineJson.parseResponse("""{"items":[]}""").family)
    }
}

class MitmachenTest {
    private val now = java.time.Instant.parse("2026-10-01T12:00:00Z")
    private val choice = StoryChoice("Wohin?", listOf(ChoiceOption("Höhle", "🕳️"), ChoiceOption("See", "🌊")))
    private val quiz = Quiz("Welcher Planet?", listOf("Mars", "Jupiter", "Venus"))
    private fun item(id: String, seq: Int, state: String, updatedAt: String? = null, choice: StoryChoice? = null, quiz: Quiz? = null) =
        TimelineItem(id = id, seq = seq, showId = "_series:a", showName = "Fini", plannedAt = "2026-10-01T08:00:00Z", state = state,
            estimatedMinutes = 6.0, updatedAt = updatedAt, choice = choice, quiz = quiz)

    @Test fun showsThePlayingItemFirstThenTheNewestRecentlyHeardOneThatWaits() {
        val playing = item("p", 5, "ready", quiz = quiz)
        val heard = listOf(
            item("old", 1, "played", "2026-10-01T02:00:00Z", choice = choice),
            item("a", 2, "played", "2026-10-01T10:00:00Z", choice = choice),
            item("b", 3, "played", "2026-10-01T11:00:00Z", quiz = quiz.copy(answered = 1, correct = 1)),
            item("c", 4, "ready", choice = choice),
        )
        assertEquals("p", Mitmachen.pending(playing, heard, now)?.id)
        assertEquals("a", Mitmachen.pending(item("x", 9, "ready"), heard, now)?.id)
        assertEquals(null, Mitmachen.pending(null, heard.filter { it.id != "a" }, now)?.id)
        assertFalse(choice.copy(picked = 0).open)
        assertEquals("C", Mitmachen.letter(2))
    }

    @Test fun parsesTheTimelineAlbumAndAnswers() {
        val timeline = TimelineJson.parseResponse("""{"items":[{"id":"i","seq":1,"showId":"s","showName":"S","plannedAt":"x","state":"played","estimatedMinutes":2,
            "choice":{"question":"Wohin?","options":[{"label":"Höhle","emoji":"🕳️"},{"label":"See","emoji":"🌊"}],"picked":1},
            "quiz":{"question":"Q?","options":["a","b","c"],"answered":0,"correct":2}}],"play":{"stickers":3,"kids":true,"ask":true}}""")
        assertEquals(1, timeline.items[0].choice?.picked)
        assertEquals(2, timeline.items[0].quiz?.correct)
        assertEquals(PlaySummary(3, kids = true, ask = true), timeline.play)
        assertTrue(timeline.play.album)
        assertFalse(TimelineJson.parseResponse("""{"items":[]}""").play.album)
        val album = Mitmachen.parseAlbum("""{"total":2,"count":1,"stickers":[{"id":"fuchs","emoji":"🦊","name":"Fuchs","at":"2026-10-01T08:00:00Z"},{"id":"eule","emoji":"🦉","name":"Eule"}]}""")
        assertEquals(listOf(true, false), album.stickers.map { it.owned })
        val result = Mitmachen.parseResult("""{"right":true,"correct":1,"sticker":{"id":"eule","emoji":"🦉","name":"Eule"}}""")
        assertEquals("Eule", result.sticker?.name)
        assertEquals(true, result.right)
    }

    @Test fun storyCardsMakeTheSubject() {
        assertEquals("Hauptfigur: ein schlauer Fuchs · Ort: im Zauberwald · Art: mit einem Rätsel · Nina spielt selbst mit",
            StoryCards.subject(StoryCards.heroes[0], StoryCards.places[2], StoryCards.kinds[1], "Nina"))
        assertEquals("Ort: am Meer", StoryCards.subject(null, StoryCards.places[1], null, " "))
    }
}

class ReadingTest {
    @Test fun parsesFollowsBookmarksAndAnswers() {
        val follows = Reading.parseFollows("""{"topics":[{"id":1,"topic":"Kernfusion","createdAt":"x"}],"max":1}""")
        assertEquals("Kernfusion", follows.topics.single().topic)
        assertTrue(follows.full)
        val bookmarks = Reading.parseBookmarks("""{"bookmarks":[{"itemId":"a","title":"Kernfusion","showName":"Hintergrund","sources":[{"title":"SRF","url":"https://srf.ch/a"}],"at":"x"}]}""")
        assertEquals("Meine Leseliste aus dem Radio\n\n• Kernfusion (Hintergrund)\n  SRF: https://srf.ch/a", Reading.shareText(bookmarks))
        assertEquals("i2", Reading.parseAnswer("""{"itemId":"i2","text":"Weil …"}""").itemId)
        assertEquals("Für Konzerte fehlt dein Spotify-Hörprofil (Studio → Spotify verbinden).", Labels.error("NO_ARTISTS"))
    }

    @Test fun takesATopicFromAnItem() {
        val item = TimelineItem(id = "i", seq = 1, showId = "_block:nachfrage", showName = "Nachgefragt", plannedAt = "x", state = "ready",
            estimatedMinutes = 1.0, title = "Nachgefragt: Wie lange lief der Reaktor?")
        assertEquals("Wie lange lief der Reaktor?", Reading.topicOf(item))
        assertEquals("Kernfusion", Reading.topicOf(item.copy(title = "Kernfusion")))
    }
}

class FeaturesTest {
    @Test fun parsesTheCatalogAndSummarises() {
        val catalog = Features.parse("""{"features":[{"id":"review","name":"Wochenrückblick","enabled":true},{"id":"places","name":"Ortsgeschichten","enabled":false}],
            "blocks":[{"id":"wetter","name":"Wetter","visible":false},{"id":"morgen","name":"Morgenbriefing"}]}""")
        assertTrue(catalog.on("review"))
        assertFalse(catalog.on("places"))
        assertEquals("1 von 2 an · 1 Baustein ausgeblendet", catalog.summary)
        assertEquals("Langenthal, Bern", Features.parsePlace("""{"place":"Langenthal, Bern","itemId":"i"}""").place)
    }

    @Test fun reportsANewPlaceOnlyAfterMovingAndWaiting() {
        val melchnau = Fix(47.1834, 7.8521, 0)
        val langenthal = Fix(47.2153, 7.7945, 15 * 60_000)
        assertTrue(PlaceTrigger.shouldReport(null, melchnau))
        assertEquals(5.5, PlaceTrigger.distanceKm(melchnau, langenthal), 0.5)
        assertTrue(PlaceTrigger.shouldReport(melchnau, langenthal))
        assertFalse(PlaceTrigger.shouldReport(melchnau, langenthal.copy(atMs = 5 * 60_000))) // too soon
        assertFalse(PlaceTrigger.shouldReport(melchnau, Fix(47.19, 7.86, 30 * 60_000))) // barely moved
    }
}

class StationEditingTest {
    private val config = kotlinx.serialization.json.Json.parseToJsonElement("""
        {"version":1,"name":"R","timezone":"Europe/Zurich","horizonMinutes":20,
         "feeds":[{"id":"srf","name":"SRF","url":"https://srf.example/rss"}],
         "shows":[
           {"id":"kurz","name":"Kurzbeitrag","enabled":true,"format":"brief","feedIds":["srf"],"targetMinutes":2,"verification":"strict","instructions":"","voiceId":"gemini_Kore"},
           {"id":"block","name":"Abendblock","enabled":false,"format":"music_block","feedIds":[],"targetMinutes":30,"verification":"off","groups":[{"name":"Ruhig","playlists":["abc"],"taste":"Jazz"},{"name":"Laut","playlists":[],"taste":"Rock"}],"triggers":{"blockStart":true}}
         ],
         "schedule":[{"id":"a","days":[1],"from":"06:00","to":"09:00","showIds":["kurz","_block:morgen"]},{"id":"b","days":[1],"from":"20:00","to":"22:00","showIds":["block"]}],
         "agents":{"writer":{"temperature":0.7}}}
    """).jsonObject
    private val writer = AgentInfo("writer", "Beiträge", "Autorin", "", "Kennzeichne Unsicherheit.", "", 0.4, trial = true)
    private val jury = AgentInfo("jury", "Beiträge", "Jury", "", "Streng.", "", 0.1, optional = true, threshold = 3.5)

    @Test fun showsKeepWhatTheAppDoesNotEdit() {
        val draft = StationDraft(config)
        val kurz = draft.shows.first()
        assertEquals("feeds", kurz.sourceMode)
        val saved = draft.withShow(kurz.copy(name = "Kurz und gut", minutes = 9)).shows.first()
        assertEquals("Kurz und gut", saved.name)
        assertEquals(2, saved.minutes) // within the brief's 1–2 minutes
        assertEquals("gemini_Kore", saved.raw["voiceId"]?.jsonPrimitive?.content)
        val block = draft.shows[1]
        assertEquals(listOf("abc"), block.playlists)
        val groups = draft.withShow(block.copy(playlists = listOf("abc", " def "), taste = "Soul")).shows[1].raw["groups"] as kotlinx.serialization.json.JsonArray
        assertEquals(2, groups.size)
        assertEquals("Soul", groups[0].jsonObject["taste"]?.jsonPrimitive?.content)
        assertEquals("Rock", groups[1].jsonObject["taste"]?.jsonPrimitive?.content)
    }

    @Test fun formatChangesFitTheNewLimits() {
        val show = Show.new(ShowFormat.BRIEF, listOf("kurzbeitrag")).copy(subject = "x")
        assertEquals("kurzbeitrag-2", show.id)
        val hour = show.withFormat(ShowFormat.ARTIST)
        assertEquals(20, hour.minutes)
        assertEquals("", hour.subject)
        val json = hour.copy(subject = "Portishead").toJson()
        assertEquals("Portishead", json["artist"]?.jsonPrimitive?.content)
        assertEquals("gemini", json["textProvider"]?.jsonPrimitive?.content)
        assertEquals("web", json["sourceMode"]?.jsonPrimitive?.content)
        assertEquals(null, json["tools"])
        assertEquals("kunstler-stunde", uniqueId("Künstler-Stunde", emptyList()))
    }

    @Test fun removingAShowCleansTheDayPlan() {
        val draft = StationDraft(config).removeShow("block")
        assertEquals(listOf("kurz"), draft.shows.map { it.id })
        val schedule = draft.config["schedule"] as kotlinx.serialization.json.JsonArray
        assertEquals(1, schedule.size)
        // A fresh document with a changed day plan keeps it; only the removed show leaves it.
        val fresh = kotlinx.serialization.json.JsonObject(config.toMutableMap().apply {
            put("schedule", kotlinx.serialization.json.Json.parseToJsonElement("""[{"id":"c","days":[2],"from":"10:00","to":"11:00","showIds":["block","kurz"]}]"""))
        })
        val merged = draft.mergeInto(fresh)
        val slot = (merged["schedule"] as kotlinx.serialization.json.JsonArray)[0].jsonObject
        assertEquals("c", slot["id"]?.jsonPrimitive?.content)
        assertEquals(listOf("kurz"), (slot["showIds"] as kotlinx.serialization.json.JsonArray).map { it.jsonPrimitive.content })
    }

    @Test fun feedsAreHttpsAndLeaveTheirShows() {
        val draft = StationDraft(config)
        assertEquals(null, draft.addFeed("Blog", "http://insecure.example/rss"))
        val added = draft.addFeed("", "https://blog.example/feed.xml")!!
        assertEquals("blog.example", added.feeds.last().name)
        val removed = draft.removeFeed("srf")
        assertTrue(removed.feeds.isEmpty())
        assertEquals(emptyList<String>(), removed.shows.first().feedIds)
    }

    @Test fun agentsKeepOnlyTheOwnersChanges() {
        val draft = StationDraft(config)
        assertEquals(0.7, draft.agent("writer").temperature)
        val back = draft.withAgent(writer, AgentSettings(temperature = 0.4))
        assertEquals(null, back.agents["writer"])
        assertEquals(null, back.config["agents"])
        val off = back.withAgent(jury, AgentSettings(enabled = false, threshold = 3.5))
        assertEquals(AgentSettings(enabled = false), off.agent("jury"))
        val preset = AgentPreset("p", "P", "", mapOf("writer" to AgentSettings(instructions = "Kurz.")))
        val styled = off.applyPreset(preset)
        assertEquals(preset, styled.activePreset(listOf(preset)))
        assertEquals(AgentSettings(enabled = false), styled.agent("jury"))
        assertEquals(null, styled.standardAgents().config["agents"])
        assertEquals(null, styled.resetAgent("writer").activePreset(listOf(preset)))
    }

    @Test fun parsesAgentsInsightsAndProfile() {
        val (agents, presets) = StationDraft.parseAgents("""{"agents":[{"id":"jury","group":"Beiträge","name":"Jury","description":"d","instructions":"i","contract":"c","temperature":0.1,"optional":true,"threshold":3.5,"trial":true}],"presets":[{"id":"x","name":"X","description":"","agents":{"writer":{"instructions":"a","temperature":0.5}}}]}""")
        assertEquals(3.5, agents.single().threshold)
        assertEquals(AgentSettings(instructions = "a", temperature = 0.5), presets.single().agents["writer"])
        val insights = Insights.parse("""{"reasons":[{"reason":"long","label":"Zu lang","count":3,"active":true}],"notes":["Kürzer"],"quality":[{"showId":"a","showName":"A","overall":4,"createdAt":"2026-10-02T08:00:00Z"},{"showId":"a","showName":"A","overall":3,"createdAt":"2026-10-02T09:00:00Z"},{"showId":"a","showName":"A","overall":5,"createdAt":"2026-10-01T09:00:00Z"}],"changes":[],
            "usage":{"days":[{"day":"2026-10-02","generations":5,"ttsCharacters":900,"models":[{"provider":"gemini","model":"gemini-3.8-flash-tts","calls":4,"inputTokens":10,"outputTokens":0},{"provider":"gemini","model":"gemini-3.8-flash-tts:abgelehnt","calls":1,"inputTokens":0,"outputTokens":0}]}],"limits":{"generations":24,"ttsCharacters":12000},"speech":{"model":"m","liteModel":"l","dailyRequests":100}},"timezone":"Europe/Zurich"}""")
        assertEquals(listOf("2026-10-01" to 5.0, "2026-10-02" to 3.5), insights.qualityByDay)
        assertEquals(4, insights.days.single().speechRequests)
        assertEquals(24, insights.generationLimit)
        assertEquals(100, insights.speechRequestLimit)
        assertEquals(ListeningProfile(true, listOf("Portishead")), ListeningProfile.parse("""{"connected":true,"artists":["Portishead"]}"""))
    }

    @Test fun warnsOnceADailyLimitIsNearlyUsed() {
        assertNull(Budget(listOf(10, 24), listOf(2000, 12000)).warning())
        assertEquals("Tageslimit fast erreicht: Produktionen 83 %. Danach wartet die Produktion bis morgen.", Budget(listOf(20, 24), listOf(2000, 12000)).warning())
        val timeline = TimelineJson.parseResponse("""{"items":[],"budget":{"generations":[24,24],"speech":[11000,12000]}}""")
        assert(timeline.budget!!.warning()!!.contains("Sprachausgabe 92 %"))
    }

    @Test fun readsWhatIsNewInABuild() {
        val build = AppBuild.parse("""{"versionCode":7,"versionName":"0.2.7","sha256":"${"a".repeat(64)}","size":10,"notes":["Dunkler Modus","Diagnose"]}""")
        assertEquals(listOf("Dunkler Modus", "Diagnose"), build.notes)
        assertEquals(emptyList(), AppBuild.parse("""{"versionCode":7,"versionName":"0.2.7","sha256":"${"a".repeat(64)}","size":10}""").notes)
    }
}
