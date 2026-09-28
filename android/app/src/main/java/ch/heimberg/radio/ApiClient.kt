package ch.heimberg.radio

import ch.heimberg.radio.core.AccessDiagnosis
import ch.heimberg.radio.core.AppBuild
import ch.heimberg.radio.core.BlockView
import ch.heimberg.radio.core.Connection
import ch.heimberg.radio.core.Feedback
import ch.heimberg.radio.core.Library
import ch.heimberg.radio.core.Timeline
import ch.heimberg.radio.core.TimelineItem
import ch.heimberg.radio.core.TimelineJson
import ch.heimberg.radio.core.Transcript
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import org.json.JSONObject
import java.net.HttpURLConnection
import java.net.URL

class ApiException(val status: Int, message: String) : Exception(message)

/** Talks to the private Worker with the Access service token on every request. */
class ApiClient(private val connection: Connection) {

    data class ShowOption(val id: String, val name: String, val format: String)

    suspend fun timeline(): List<TimelineItem> = response().items

    /** The timeline plus the public Spotify client ID, when the Worker has one. */
    suspend fun response(peek: Boolean = false): Timeline = withContext(Dispatchers.IO) {
        // A peek (the background check for notifications) does not count as listening on the server.
        TimelineJson.parseResponse(request("GET", if (peek) "api/timeline?peek=1" else "api/timeline"))
    }

    /** Productions that can still be heard, newest first. */
    suspend fun library(): Library = withContext(Dispatchers.IO) { TimelineJson.parseLibrary(request("GET", "api/library")) }

    /** Plans and queues production right away instead of waiting for the next cron tick. */
    suspend fun plan() { withContext(Dispatchers.IO) { request("POST", "api/timeline/plan") } }

    /** Configured show choices for the native "produce now" dialog. */
    suspend fun shows(): List<ShowOption> = withContext(Dispatchers.IO) {
        val shows = JSONObject(request("GET", "api/station")).getJSONObject("config").getJSONArray("shows")
        (0 until shows.length()).mapNotNull { index ->
            val item = shows.optJSONObject(index) ?: return@mapNotNull null
            val id = item.optString("id").takeIf(String::isNotBlank) ?: return@mapNotNull null
            ShowOption(id, item.optString("name", id), item.optString("format"))
        }
    }

    /** Starts one selected show outside the program clock; a subject is valid for music hours only. */
    suspend fun produceNow(show: ShowOption, subject: String) {
        val payload = if (subject.isBlank()) null else JSONObject().put("subject", subject.trim()).toString()
        withContext(Dispatchers.IO) { request("POST", "api/shows/${show.id}/produce", payload) }
    }

    /** A new order for all open items; a stale order (the program changed) is refused with 409. */
    suspend fun arrange(order: List<String>) {
        val body = JSONObject().put("order", org.json.JSONArray(order)).toString()
        withContext(Dispatchers.IO) { request("POST", "api/timeline/arrange", body) }
    }

    /** The newest build CI published for in-app updates, or null when there is none. */
    suspend fun latestApp(): AppBuild? = withContext(Dispatchers.IO) {
        try { AppBuild.parse(request("GET", "api/app/latest")) } catch (error: ApiException) { if (error.status == 404) null else throw error }
    }

    /** Streams a binary response (the APK) into [file]. */
    fun download(path: String, file: java.io.File) {
        val http = URL(connection.resolve(path)).openConnection() as HttpURLConnection
        try {
            http.connectTimeout = 15_000
            http.readTimeout = 60_000
            http.instanceFollowRedirects = false
            connection.headers().forEach { (name, value) -> http.setRequestProperty(name, value) }
            val status = http.responseCode
            if (status !in 200..299) throw ApiException(status, AccessDiagnosis.message(status, http.getHeaderField("Location"), ""))
            http.inputStream.use { input -> file.outputStream().use { input.copyTo(it) } }
        } finally {
            http.disconnect()
        }
    }

    /** The text of an item and its sources, for reading along. */
    suspend fun transcript(itemId: String): Transcript = withContext(Dispatchers.IO) { TimelineJson.parseTranscript(request("GET", "api/timeline/$itemId/script")) }

    /** Ready-made building blocks and the owner's own shows. */
    suspend fun blocks(): List<BlockView> = withContext(Dispatchers.IO) { TimelineJson.parseBlocks(request("GET", "api/blocks")) }

    /** Adds a block right after [after] (what is playing); [subject] is the one optional word. */
    suspend fun addBlock(blockId: String, subject: String, after: String?) {
        val body = JSONObject().apply {
            if (subject.isNotBlank()) put("subject", subject.trim())
            if (after != null) put("after", after)
        }.toString()
        withContext(Dispatchers.IO) { request("POST", "api/blocks/${java.net.URLEncoder.encode(blockId, "UTF-8")}/add", body) }
    }

    /** Retires failed productions and starts waiting ones again. */
    suspend fun retry() { withContext(Dispatchers.IO) { request("POST", "api/timeline/retry") } }

    /** Deletes a production from the archive (or takes it out of the program). */
    suspend fun delete(itemId: String) { withContext(Dispatchers.IO) { request("POST", "api/timeline/$itemId/delete") } }

    suspend fun send(feedback: Feedback) {
        withContext(Dispatchers.IO) { request("POST", "api/timeline/${feedback.itemId}/feedback", feedback.toJson()) }
    }

    private fun request(method: String, path: String, body: String? = null): String {
        val http = URL(connection.resolve(path)).openConnection() as HttpURLConnection
        try {
            http.requestMethod = method
            http.connectTimeout = 15_000
            http.readTimeout = 30_000
            // Access answers an invalid token with a redirect to its login page; treat that as rejected.
            http.instanceFollowRedirects = false
            connection.headers().forEach { (name, value) -> http.setRequestProperty(name, value) }
            http.setRequestProperty("Accept", "application/json")
            // The Worker only accepts writes whose Origin is its own.
            if (method != "GET") http.setRequestProperty("Origin", connection.origin)
            if (body != null) {
                http.doOutput = true
                http.setRequestProperty("Content-Type", "application/json")
                http.outputStream.use { it.write(body.toByteArray(Charsets.UTF_8)) }
            } else if (method != "GET") {
                http.setFixedLengthStreamingMode(0)
            }
            val status = http.responseCode
            val text = (if (status in 200..299) http.inputStream else http.errorStream)?.bufferedReader()?.use { it.readText() } ?: ""
            if (status !in 200..299) throw ApiException(status, AccessDiagnosis.message(status, http.getHeaderField("Location"), text))
            return text
        } finally {
            http.disconnect()
        }
    }
}
