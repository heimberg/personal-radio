package ch.heimberg.radio.core

import kotlin.test.Test
import kotlin.test.assertEquals
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
    }

    @Test fun queueFollowsTheProgramOrderAndSkipsWhatWasPlayed() {
        val queue = ProgramQueue()
        val items = TimelineJson.parse(body)
        assertEquals(listOf("a"), queue.upcoming(items, false, null).map { it.id })
        val later = items.map { if (it.id == "b") it.copy(state = "ready", audioUrl = "api/timeline/b/audio") else it }
        assertEquals(listOf("a", "b"), queue.upcoming(later, false, null).map { it.id })
        // Reordered in the cockpit: the new order wins.
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
    fun kindsFollowTheWebCockpit() {
        fun item(showId: String, music: Boolean = false, surprise: Boolean = false) = TimelineItem("i", 1, showId, "S", "2026-09-29T08:00:00Z", "ready", 2.0, surprise = surprise,
            parts = if (music) listOf(TimelinePart(kind = "track", spotifyUri = "spotify:track:1")) else emptyList())
        assertEquals(Look(Kind.MUSIC, "🎶"), Looks.of(item("_musik", music = true)))
        assertEquals(Look(Kind.WEATHER, "☀️"), Looks.of(item("_block:wetter")))
        assertEquals(Kind.SURPRISE, Looks.of(item("_block:zufallsfund", surprise = true)).kind)
        assertEquals(Kind.MUSIC, Looks.of(item("eigene-stunde", music = true)).kind)
        assertEquals(Kind.DISCOVER, Looks.of(item("entdecken")).kind)
        assertEquals(Kind.SURPRISE, Looks.ofBlock(BlockView("ueberraschung", "Überraschung", "")).kind)
        assertEquals(Kind.MUSIC, Looks.ofBlock(BlockView("show:x", "X", "", music = true)).kind)
        assertEquals(0xFFD06BD8.toInt(), Kind.MUSIC.argb.toInt())
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
    }
}
