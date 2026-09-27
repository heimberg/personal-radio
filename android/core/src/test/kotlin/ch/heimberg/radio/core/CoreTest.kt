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

    @Test fun queueHandsOutEachReadySegmentOnceInProgramOrder() {
        val queue = ProgramQueue()
        val items = TimelineJson.parse(body)
        assertEquals(listOf("a"), queue.takeNew(items).map { it.id })
        assertEquals(emptyList(), queue.takeNew(items).map { it.id })
        val later = items.map { if (it.id == "b") it.copy(state = "ready", audioUrl = "api/timeline/b/audio") else it }
        assertEquals(listOf("b"), queue.takeNew(later).map { it.id })
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
