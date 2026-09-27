package ch.heimberg.radio.core

import kotlin.test.Test
import kotlin.test.assertEquals
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
}
