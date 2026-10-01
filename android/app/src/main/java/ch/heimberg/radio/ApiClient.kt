package ch.heimberg.radio

import ch.heimberg.radio.core.AccessDiagnosis
import ch.heimberg.radio.core.AppBuild
import ch.heimberg.radio.core.BlockView
import ch.heimberg.radio.core.Connection
import ch.heimberg.radio.core.DayPlan
import ch.heimberg.radio.core.Family
import ch.heimberg.radio.core.Feedback
import ch.heimberg.radio.core.FeedbackReason
import ch.heimberg.radio.core.Library
import ch.heimberg.radio.core.Place
import ch.heimberg.radio.core.SeriesInfo
import ch.heimberg.radio.core.StudioSettings
import ch.heimberg.radio.core.VoiceOption
import ch.heimberg.radio.core.Timeline
import ch.heimberg.radio.core.TimelineItem
import ch.heimberg.radio.core.TimelineJson
import ch.heimberg.radio.core.Transcript
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import org.json.JSONArray
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

    /** «Heute»: sets today's mood (until midnight), or clears it with null. */
    suspend fun setMood(id: String?) {
        withContext(Dispatchers.IO) { request("POST", "api/mood", JSONObject().put("mood", id ?: JSONObject.NULL).toString()) }
    }

    /** The day plan (time windows and surprise level) from the station settings. */
    suspend fun dayPlan(): DayPlan? = withContext(Dispatchers.IO) { DayPlan.parse(request("GET", "api/station")) }

    /**
     * Saves the day plan: the current settings are read again and only `schedule` and `surprise` are
     * replaced, so everything else (persona, shows, agents) stays exactly as the studio left it.
     */
    suspend fun saveDayPlan(plan: DayPlan) {
        withContext(Dispatchers.IO) {
            val config = JSONObject(request("GET", "api/station")).getJSONObject("config")
            config.put("schedule", JSONArray(plan.schedulesJson()))
            config.put("surprise", plan.surprise)
            request("PUT", "api/station", config.toString())
        }
    }

    /** The studio's settings; null while the station is not set up. */
    suspend fun studio(): StudioSettings? = withContext(Dispatchers.IO) { StudioSettings.parse(request("GET", "api/station")) }

    /**
     * Saves the studio: the current settings are read again and only the studio's fields replaced, so
     * shows, feeds, agents and the day plan stay exactly as they are.
     */
    suspend fun saveStudio(settings: StudioSettings) {
        withContext(Dispatchers.IO) {
            val config = StudioSettings.parseConfig(request("GET", "api/station"))
            request("PUT", "api/station", settings.mergeInto(config).toString())
        }
    }

    /** Own voices, the prebuilt ones, German library voices matching [search], and Mistral's. */
    suspend fun voices(search: String = ""): List<VoiceOption> = withContext(Dispatchers.IO) {
        StudioSettings.parseVoices(request("GET", "api/voices" + if (search.isBlank()) "" else "?search=" + java.net.URLEncoder.encode(search.trim(), "UTF-8")))
    }

    /** Designs a voice from a description ([gender] "female", "male" or null). */
    suspend fun designVoice(name: String, description: String, gender: String?): VoiceOption? = withContext(Dispatchers.IO) {
        val body = JSONObject().put("name", name).put("description", description)
        if (gender != null) body.put("gender", gender)
        StudioSettings.parseCreatedVoice(request("POST", "api/voices/design", body.toString()))
    }

    /** Clones a voice from a speech sample and the spoken consent, both WAV. */
    suspend fun cloneVoice(name: String, sample: ByteArray, consent: ByteArray): VoiceOption? = withContext(Dispatchers.IO) {
        val encode = { bytes: ByteArray -> android.util.Base64.encodeToString(bytes, android.util.Base64.NO_WRAP) }
        val body = JSONObject().put("name", name).put("source", encode(sample)).put("consent", encode(consent))
        StudioSettings.parseCreatedVoice(request("POST", "api/voices/clone", body.toString()))
    }

    suspend fun deleteVoice(id: String) { withContext(Dispatchers.IO) { request("DELETE", "api/voices/$id") } }

    suspend fun places(name: String): List<Place> = withContext(Dispatchers.IO) {
        StudioSettings.parsePlaces(request("GET", "api/places?name=" + java.net.URLEncoder.encode(name, "UTF-8")))
    }

    /** Where the voice sample for [voiceId] (spoken in [style]) is; the player sends the token itself. */
    fun previewUrl(voiceId: String, style: String): String =
        connection.resolve("api/voices/preview?voice=${java.net.URLEncoder.encode(voiceId, "UTF-8")}&style=${java.net.URLEncoder.encode(style, "UTF-8")}")

    fun headers(): Map<String, String> = connection.headers()

    /** An address on the Worker (e.g. a profile picture), for loading it with [headers]. */
    fun resolve(path: String): String = connection.resolve(path)

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
            if (status !in 200..299) {
                val text = runCatching { http.errorStream?.bufferedReader()?.use { it.readText().take(2000) } }.getOrNull() ?: ""
                throw ApiException(status, AccessDiagnosis.message(status, http.getHeaderField("Location"), text))
            }
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
    /** Adds a block at the end of the open program. */
    suspend fun addBlock(blockId: String, subject: String) {
        val body = JSONObject().apply {
            if (subject.isNotBlank()) put("subject", subject.trim())
            put("after", "end")
        }.toString()
        withContext(Dispatchers.IO) { request("POST", "api/blocks/${java.net.URLEncoder.encode(blockId, "UTF-8").replace("%3A", ":")}/add", body) }
    }

    /** Mixes the open program; the server adds songs between items where they are missing. */
    /** Running and recent series. */
    suspend fun series(): List<SeriesInfo> = withContext(Dispatchers.IO) { TimelineJson.parseSeries(request("GET", "api/series")) }

    /** Ends a series: no further episodes, the open one leaves the program. */
    suspend fun stopSeries(id: String) { withContext(Dispatchers.IO) { request("POST", "api/series/${java.net.URLEncoder.encode(id, "UTF-8")}/stop") } }

    suspend fun shuffle() { withContext(Dispatchers.IO) { request("POST", "api/timeline/shuffle") } }

    /** Picks one song and appends it to the program. */
    suspend fun addSong() { withContext(Dispatchers.IO) { request("POST", "api/shows/_musik/produce") } }

    /** Clears failed productions from the list. */
    suspend fun cleanup() { withContext(Dispatchers.IO) { request("POST", "api/timeline/cleanup") } }

    /** Retires failed productions and starts waiting ones again. */
    suspend fun retry() { withContext(Dispatchers.IO) { request("POST", "api/timeline/retry") } }

    // ── Family ────────────────────────────────────────────────────────────────────────────────

    suspend fun family(): Family = withContext(Dispatchers.IO) { Family.parse(request("GET", "api/family")) }

    suspend fun sendMessage(text: String) { withContext(Dispatchers.IO) { request("POST", "api/family/messages", JSONObject().put("text", text).toString()) } }

    suspend fun markRead(lastId: Long) { withContext(Dispatchers.IO) { request("POST", "api/family/read", JSONObject().put("lastId", lastId).toString()) } }

    /** Copies one of my produced items into [to]'s program. */
    suspend fun share(itemId: String, to: String) {
        withContext(Dispatchers.IO) { request("POST", "api/family/share", JSONObject().put("itemId", itemId).put("to", to).toString()) }
    }

    /** Puts what [member] hears right now into my program. */
    suspend fun listenAlong(member: String) { withContext(Dispatchers.IO) { request("POST", "api/family/listen", JSONObject().put("member", member).toString()) } }

    /** A greeting the host reads in [to]'s next live transition. */
    suspend fun greet(to: String, text: String) { withContext(Dispatchers.IO) { request("POST", "api/family/greet", JSONObject().put("to", to).put("text", text).toString()) } }

    /** My profile picture: a small JPEG, base64. */
    suspend fun setAvatar(image: String) { withContext(Dispatchers.IO) { request("PUT", "api/family/avatar", JSONObject().put("image", image).toString()) } }

    suspend fun removeAvatar() { withContext(Dispatchers.IO) { request("DELETE", "api/family/avatar") } }

    /** What I hear now, for «hört gerade» in the family. */
    suspend fun presence(itemId: String) { withContext(Dispatchers.IO) { request("POST", "api/family/presence", JSONObject().put("itemId", itemId).toString()) } }

    /** Deletes a production from the archive (or takes it out of the program). */
    suspend fun delete(itemId: String) { withContext(Dispatchers.IO) { request("POST", "api/timeline/$itemId/delete") } }

    /** A planned surprise gives way to a different one at the same place. */
    suspend fun swap(itemId: String) { withContext(Dispatchers.IO) { request("POST", "api/timeline/$itemId/swap") } }

    /** Takes an open item out of the program. */
    suspend fun remove(itemId: String) { withContext(Dispatchers.IO) { request("POST", "api/timeline/$itemId/remove") } }

    /** Orders a deeper follow-up to a spoken item; it is placed right after it. */
    suspend fun deepen(itemId: String) { withContext(Dispatchers.IO) { request("POST", "api/timeline/$itemId/more") } }

    suspend fun sendReason(itemId: String, reason: FeedbackReason) {
        withContext(Dispatchers.IO) { request("POST", "api/timeline/$itemId/reason", reason.toJson()) }
    }

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
