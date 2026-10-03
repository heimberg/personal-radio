package ch.heimberg.radio.core

import java.text.Normalizer
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.booleanOrNull
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.doubleOrNull
import kotlinx.serialization.json.jsonObject

/**
 * A show format as the studio offers it. Name and lengths come from the server (`GET /api/formats`, the
 * same limits its config check uses) once [adopt] has read them; until then the values built in here apply.
 */
enum class ShowFormat(val id: String, private val builtInLabel: String, private val builtInMin: Int, private val builtInMax: Int, private val builtInDefault: Int, val subject: String? = null) {
    BRIEF("brief", "Kurzbeitrag", 1, 2, 2),
    PODCAST("podcast", "Dialog", 2, 10, 5),
    ARTIST("artist_hour", "Künstler-Stunde", 20, 90, 60, "artist"),
    GENRE("genre_hour", "Genre-Stunde", 20, 90, 60, "genre"),
    THEME("theme_hour", "Themen-Stunde", 20, 90, 60, "theme"),
    BLOCK("music_block", "Musikblock", 10, 120, 30);

    private val served: Served? get() = Served.formats[id]
    val label: String get() = served?.label ?: builtInLabel
    val minMinutes: Int get() = served?.min ?: builtInMin
    val maxMinutes: Int get() = served?.max ?: builtInMax
    val defaultMinutes: Int get() = served?.default ?: builtInDefault

    val musicHour: Boolean get() = subject != null
    val spoken: Boolean get() = this == BRIEF || this == PODCAST

    /** What the subject field asks for, with an example. */
    val subjectLabel: Pair<String, String>? get() = when (subject) {
        "artist" -> "Künstler oder Band" to "z. B. Portishead"
        "genre" -> "Genre oder Szene" to "z. B. Krautrock"
        "theme" -> "Thema" to "z. B. Der Mond"
        else -> null
    }

    companion object {
        fun of(id: String): ShowFormat = entries.firstOrNull { it.id == id } ?: BRIEF

        /** Takes the formats the server sent; an entry that is unknown or does not add up keeps the built-in values. */
        fun adopt(body: String) {
            val list = runCatching { Json.parseToJsonElement(body).jsonObject["formats"] as? JsonArray }.getOrNull() ?: return
            Served.formats = list.mapNotNull { element ->
                val f = element as? JsonObject ?: return@mapNotNull null
                fun number(key: String) = (f[key] as? JsonPrimitive)?.doubleOrNull?.toInt()
                val id = (f["id"] as? JsonPrimitive)?.contentOrNull ?: return@mapNotNull null
                val min = number("minMinutes") ?: return@mapNotNull null
                val max = number("maxMinutes") ?: return@mapNotNull null
                val default = number("defaultMinutes") ?: return@mapNotNull null
                if (entries.none { it.id == id } || min < 1 || default !in min..max) return@mapNotNull null
                id to Served((f["label"] as? JsonPrimitive)?.contentOrNull?.ifBlank { null }, min, max, default)
            }.toMap()
        }
    }
}

/** A format's name and lengths as the server sent them. */
private class Served(val label: String?, val min: Int, val max: Int, val default: Int) {
    companion object {
        @Volatile var formats: Map<String, Served> = emptyMap()
    }
}

/**
 * One of the owner's shows, with the fields the app edits. [raw] keeps everything else the show has
 * (voice, music block groups and triggers, production mode …), so saving never loses a setting the app
 * does not show.
 */
data class Show(
    val id: String,
    val name: String,
    val enabled: Boolean,
    val format: ShowFormat,
    val minutes: Int,
    val instructions: String = "",
    /** `web` (Google search) or `feeds`. */
    val sourceMode: String = "web",
    val researchPrompt: String = "",
    val feedIds: List<String> = emptyList(),
    /** `strict`, `light` or `off`. */
    val verification: String = "strict",
    /** Music hours: the fixed artist, genre or theme; blank lets the AI choose. */
    val subject: String = "",
    /** Live information: `clock`, `weather`, `headlines`. */
    val tools: List<String> = emptyList(),
    /** Music blocks: the first group's playlists (links or IDs) and taste. */
    val playlists: List<String> = emptyList(),
    val taste: String = "",
    val raw: JsonObject = JsonObject(emptyMap()),
) {
    /** One line for the list: format, length and what it is about. */
    val summary: String get() = listOfNotNull(
        format.label, "$minutes Min.",
        subject.ifBlank { null },
        if (format.spoken) (if (sourceMode == "feeds") "Feeds" else "Websuche") else null,
    ).joinToString(" · ")

    /** Another format: the length moves into its limits, and what only the old format had is dropped. */
    fun withFormat(next: ShowFormat): Show = copy(
        format = next, minutes = minutes.coerceIn(next.minMinutes, next.maxMinutes),
        subject = if (next.subject != null && next.subject == format.subject) subject else "",
        sourceMode = if (next.spoken) sourceMode else "web",
        verification = if (next == ShowFormat.BLOCK) "off" else if (next.musicHour && verification == "strict") "light" else verification,
    )

    /** The show as the Worker stores it: [raw] with the edited fields written over it. */
    fun toJson(): JsonObject {
        val dropped = setOf("artist", "genre", "theme", "tracks", "talkSeconds", "production", "groups", "switchAfterTracks", "switchAfterMinutes", "triggers")
        val keep = raw.filterKeys { key ->
            when {
                key !in dropped -> true
                format.musicHour -> key in setOf("tracks", "talkSeconds", "production")
                format == ShowFormat.BLOCK -> key in setOf("groups", "switchAfterTracks", "switchAfterMinutes", "triggers", "talkSeconds")
                else -> false
            }
        }
        return JsonObject(keep.toMutableMap().apply {
            put("id", JsonPrimitive(id)); put("name", JsonPrimitive(name.trim().take(80).ifBlank { format.label }))
            put("enabled", JsonPrimitive(enabled)); put("format", JsonPrimitive(format.id))
            put("targetMinutes", JsonPrimitive(minutes.coerceIn(format.minMinutes, format.maxMinutes)))
            put("instructions", JsonPrimitive(instructions.take(2000)))
            put("researchPrompt", JsonPrimitive(researchPrompt.take(1000)))
            put("sourceMode", JsonPrimitive(if (format.spoken) sourceMode else "web"))
            put("feedIds", JsonArray((if (format.spoken && sourceMode == "feeds") feedIds else emptyList()).map(::JsonPrimitive)))
            put("verification", JsonPrimitive(verification))
            // Dialogs, music hours and blocks are written by Gemini only.
            if (!format.spoken || format == ShowFormat.PODCAST) put("textProvider", JsonPrimitive("gemini"))
            if (format.spoken) put("tools", JsonArray(tools.map(::JsonPrimitive))) else remove("tools")
            format.subject?.let { key -> if (subject.isBlank()) remove(key) else put(key, JsonPrimitive(subject.trim().take(200))) }
            if (format == ShowFormat.BLOCK) {
                val groups = (raw["groups"] as? JsonArray)?.mapNotNull { it as? JsonObject }.orEmpty()
                val first = (groups.firstOrNull() ?: JsonObject(mapOf("name" to JsonPrimitive("Mein Geschmack")))).toMutableMap().apply {
                    put("playlists", JsonArray(playlists.map { JsonPrimitive(it.trim()) }.filter { it.content.isNotEmpty() }))
                    put("taste", JsonPrimitive(taste.take(500)))
                }
                put("groups", JsonArray(listOf(JsonObject(first)) + groups.drop(1)))
            }
        })
    }

    companion object {
        val TOOLS = listOf("clock" to "Datum und Uhrzeit", "weather" to "Wetter", "headlines" to "Schlagzeilen")
        val VERIFICATION = listOf("strict" to "Streng: jede Aussage belegt", "light" to "Leicht", "off" to "Aus")

        fun of(show: JsonObject): Show {
            val format = ShowFormat.of(show.text("format"))
            val group = (show["groups"] as? JsonArray)?.firstOrNull() as? JsonObject
            return Show(
                id = show.text("id"), name = show.text("name"), enabled = show.flag("enabled", false), format = format,
                minutes = (show["targetMinutes"] as? JsonPrimitive)?.doubleOrNull?.toInt() ?: format.defaultMinutes,
                instructions = show.text("instructions"), sourceMode = show.text("sourceMode").ifBlank { "feeds" },
                researchPrompt = show.text("researchPrompt"), feedIds = show.list("feedIds"),
                verification = show.text("verification").ifBlank { "strict" },
                subject = format.subject?.let { show.text(it) } ?: "", tools = show.list("tools"),
                playlists = group?.list("playlists").orEmpty(), taste = group?.text("taste").orEmpty(), raw = show,
            )
        }

        /** A new show of [format], with an ID none of [taken] has. */
        fun new(format: ShowFormat, taken: Collection<String>): Show = Show(
            id = uniqueId(format.label, taken), name = format.label, enabled = true, format = format, minutes = format.defaultMinutes,
            verification = if (format == ShowFormat.BLOCK) "off" else if (format.musicHour) "light" else "strict",
        )
    }
}

data class Feed(val id: String, val name: String, val url: String)

/** One of the editorial agents (`GET /api/agents`), with what ships and what stays fixed. */
data class AgentInfo(
    val id: String, val group: String, val name: String, val description: String, val instructions: String, val contract: String,
    val temperature: Double, val optional: Boolean = false, val threshold: Double? = null, val trial: Boolean = false,
)

/** The owner's changes to one agent; null fields keep the shipped value. */
data class AgentSettings(val instructions: String? = null, val temperature: Double? = null, val enabled: Boolean? = null, val threshold: Double? = null) {
    val empty: Boolean get() = instructions == null && temperature == null && enabled == null && threshold == null
}

/** A style preset: one tap sets several agents. */
data class AgentPreset(val id: String, val name: String, val description: String, val agents: Map<String, AgentSettings>)

/**
 * The parts of the station the app edits besides [StudioSettings]: shows, feeds and the editorial agents.
 * It works on the stored document as JSON and changes only these parts; references stay consistent
 * (a removed show leaves the day plan, a removed feed leaves its shows).
 */
data class StationDraft(val config: JsonObject) {
    val shows: List<Show> get() = (config["shows"] as? JsonArray)?.mapNotNull { (it as? JsonObject)?.let(Show::of) }.orEmpty()
    val feeds: List<Feed> get() = (config["feeds"] as? JsonArray)?.mapNotNull { element ->
        (element as? JsonObject)?.let { Feed(it.text("id"), it.text("name"), it.text("url")) }
    }.orEmpty()
    val agents: Map<String, AgentSettings> get() = (config["agents"] as? JsonObject)?.mapValues { (_, value) -> settingsOf(value as? JsonObject) }.orEmpty()

    /** Adds [show] or replaces the one with its ID. */
    fun withShow(show: Show): StationDraft {
        val list = shows.map { if (it.id == show.id) show else it }.let { if (it.any { s -> s.id == show.id }) it else it + show }
        return copy(config = config.with("shows", JsonArray(list.map(Show::toJson))))
    }

    /** Removes the show and its places in the day plan; a time window left empty goes too. */
    fun removeShow(id: String): StationDraft = copy(config = withoutShowsIn(config.with("shows", JsonArray(shows.filter { it.id != id }.map(Show::toJson))), setOf(id)))

    /** Adds a feed (HTTPS only); returns null when the address is not HTTPS or the list is full. */
    fun addFeed(name: String, url: String): StationDraft? {
        val address = url.trim()
        if (!address.startsWith("https://") || address.length < 12 || feeds.size >= 30) return null
        val feed = Feed(uniqueId(name.ifBlank { "feed" }, feeds.map { it.id }), name.trim().ifBlank { address.removePrefix("https://").substringBefore('/') }.take(80), address)
        return copy(config = config.with("feeds", JsonArray((feeds + feed).map(::feedJson))))
    }

    /** Removes the feed and takes it out of every show. */
    fun removeFeed(id: String): StationDraft {
        val next = config.with("feeds", JsonArray(feeds.filter { it.id != id }.map(::feedJson)))
        return copy(config = next.with("shows", JsonArray(shows.map { it.copy(feedIds = it.feedIds - id).toJson() })))
    }

    fun agent(id: String): AgentSettings = agents[id] ?: AgentSettings()

    /** Changes one agent; only what differs from [info]'s shipped values is kept. */
    fun withAgent(info: AgentInfo, change: AgentSettings): StationDraft {
        val merged = agent(info.id).let {
            AgentSettings(
                instructions = change.instructions ?: it.instructions, temperature = change.temperature ?: it.temperature,
                enabled = change.enabled ?: it.enabled, threshold = change.threshold ?: it.threshold,
            )
        }
        val clean = AgentSettings(
            instructions = merged.instructions?.takeIf { it.trim() != info.instructions },
            temperature = merged.temperature?.takeIf { Math.abs(it - info.temperature) > 1e-9 },
            enabled = merged.enabled?.takeIf { !it },
            threshold = merged.threshold?.takeIf { it != info.threshold },
        )
        return withAgents(if (clean.empty) agents - info.id else agents + (info.id to clean))
    }

    /** Back to the shipped agent. */
    fun resetAgent(id: String): StationDraft = withAgents(agents - id)

    /** The preset's agents get exactly its settings; the others keep the owner's. */
    fun applyPreset(preset: AgentPreset): StationDraft = withAgents(agents + preset.agents)

    /** All agents as shipped. */
    fun standardAgents(): StationDraft = withAgents(emptyMap())

    /** The preset whose settings are all in place. */
    fun activePreset(presets: List<AgentPreset>): AgentPreset? = presets.firstOrNull { preset -> preset.agents.all { (id, settings) -> agents[id] == settings } }

    private fun withAgents(next: Map<String, AgentSettings>): StationDraft =
        copy(config = if (next.isEmpty()) JsonObject(config - "agents") else config.with("agents", JsonObject(next.mapValues { (_, value) -> settingsJson(value) })))

    /**
     * Writes the draft's shows, feeds and agents into [fresh], the settings as stored right now: the day
     * plan there may have changed meanwhile, so only references to shows that no longer exist are removed.
     */
    fun mergeInto(fresh: JsonObject): JsonObject {
        var next = fresh.with("shows", config["shows"] ?: JsonArray(emptyList())).with("feeds", config["feeds"] ?: JsonArray(emptyList()))
        next = config["agents"]?.let { next.with("agents", it) } ?: JsonObject(next - "agents")
        val gone = ((fresh["shows"] as? JsonArray)?.mapNotNull { (it as? JsonObject)?.text("id") }.orEmpty()).toSet() - shows.map { it.id }.toSet()
        return withoutShowsIn(next, gone)
    }

    companion object {
        private val json = Json { ignoreUnknownKeys = true }

        /** `GET /api/agents`: the agents and the style presets. */
        fun parseAgents(body: String): Pair<List<AgentInfo>, List<AgentPreset>> {
            val root = json.parseToJsonElement(body).jsonObject
            val agents = (root["agents"] as? JsonArray)?.mapNotNull { element ->
                val a = element as? JsonObject ?: return@mapNotNull null
                AgentInfo(
                    a.text("id"), a.text("group"), a.text("name"), a.text("description"), a.text("instructions"), a.text("contract"),
                    (a["temperature"] as? JsonPrimitive)?.doubleOrNull ?: 0.4, a.flag("optional", false),
                    (a["threshold"] as? JsonPrimitive)?.doubleOrNull, a.flag("trial", false),
                )
            }.orEmpty()
            val presets = (root["presets"] as? JsonArray)?.mapNotNull { element ->
                val p = element as? JsonObject ?: return@mapNotNull null
                AgentPreset(p.text("id"), p.text("name"), p.text("description"),
                    (p["agents"] as? JsonObject)?.mapValues { (_, value) -> settingsOf(value as? JsonObject) }.orEmpty())
            }.orEmpty()
            return agents to presets
        }

        private fun settingsOf(value: JsonObject?): AgentSettings = AgentSettings(
            instructions = (value?.get("instructions") as? JsonPrimitive)?.takeIf { it.isString }?.content,
            temperature = (value?.get("temperature") as? JsonPrimitive)?.doubleOrNull,
            enabled = (value?.get("enabled") as? JsonPrimitive)?.booleanOrNull,
            threshold = (value?.get("threshold") as? JsonPrimitive)?.doubleOrNull,
        )

        private fun settingsJson(settings: AgentSettings): JsonObject = JsonObject(buildMap {
            settings.instructions?.let { put("instructions", JsonPrimitive(it.take(3000))) }
            settings.temperature?.let { put("temperature", JsonPrimitive(Math.round(it * 100) / 100.0)) }
            settings.enabled?.let { put("enabled", JsonPrimitive(it)) }
            settings.threshold?.let { put("threshold", JsonPrimitive(it)) }
        })

        private fun feedJson(feed: Feed): JsonObject = JsonObject(mapOf("id" to JsonPrimitive(feed.id), "name" to JsonPrimitive(feed.name), "url" to JsonPrimitive(feed.url)))

        /** Takes [ids] out of every time window of the day plan; a window left without anything goes. */
        private fun withoutShowsIn(config: JsonObject, ids: Set<String>): JsonObject {
            if (ids.isEmpty()) return config
            val slots = (config["schedule"] as? JsonArray)?.mapNotNull { element ->
                val slot = element as? JsonObject ?: return@mapNotNull null
                val left = slot.list("showIds").filter { it !in ids }
                if (left.isEmpty()) null else slot.with("showIds", JsonArray(left.map(::JsonPrimitive)))
            } ?: return config
            return config.with("schedule", JsonArray(slots))
        }
    }
}

/** A slug of [base] (lower case, ASCII, dashes) that none of [taken] has. */
fun uniqueId(base: String, taken: Collection<String>): String {
    val slug = Normalizer.normalize(base.lowercase(), Normalizer.Form.NFKD).replace(Regex("\\p{M}+"), "")
        .replace(Regex("[^a-z0-9]+"), "-").trim('-').take(30).ifBlank { "eintrag" }
    if (slug !in taken) return slug
    var n = 2
    while ("$slug-$n" in taken) n++
    return "$slug-$n"
}

private fun JsonObject.with(key: String, value: JsonElement): JsonObject = JsonObject(toMutableMap().apply { put(key, value) })
private fun JsonObject.text(key: String): String = (this[key] as? JsonPrimitive)?.takeIf { it.isString }?.content ?: ""
private fun JsonObject.flag(key: String, default: Boolean): Boolean = (this[key] as? JsonPrimitive)?.booleanOrNull ?: default
private fun JsonObject.list(key: String): List<String> =
    (this[key] as? JsonArray)?.mapNotNull { (it as? JsonPrimitive)?.takeIf { value -> value.isString }?.content } ?: emptyList()

/** `GET /api/insights`, the parts the app shows: usage per day, the jury's marks and the owner's complaints. */
data class Insights(
    val days: List<UsageDay> = emptyList(),
    val generationLimit: Int = 0,
    val speechLimit: Int = 0,
    val speechRequestLimit: Int = 0,
    val quality: List<QualityMark> = emptyList(),
    val reasons: List<Reason> = emptyList(),
    val notes: List<String> = emptyList(),
    val changes: List<String> = emptyList(),
) {
    data class UsageDay(val day: String, val generations: Int, val ttsCharacters: Int, val models: List<ModelUse>) {
        /** Speech requests: the calls to the speech models. */
        val speechRequests: Int get() = models.filter { "tts" in it.model && !it.model.endsWith(":abgelehnt") }.sumOf { it.calls }
    }
    data class ModelUse(val model: String, val calls: Int, val inputTokens: Long, val outputTokens: Long)
    data class QualityMark(val day: String, val showName: String, val overall: Double)
    data class Reason(val label: String, val count: Int, val active: Boolean)

    /** The jury's average per day, oldest first. */
    val qualityByDay: List<Pair<String, Double>> get() = quality.groupBy { it.day }.toSortedMap()
        .map { (day, marks) -> day to Math.round(marks.sumOf { it.overall } / marks.size * 10) / 10.0 }

    companion object {
        private val json = Json { ignoreUnknownKeys = true }

        fun parse(body: String): Insights {
            val root = json.parseToJsonElement(body).jsonObject
            val usage = root["usage"] as? JsonObject
            val limits = usage?.get("limits") as? JsonObject
            val number = { obj: JsonObject?, key: String -> (obj?.get(key) as? JsonPrimitive)?.doubleOrNull ?: 0.0 }
            return Insights(
                days = (usage?.get("days") as? JsonArray)?.mapNotNull { element ->
                    val d = element as? JsonObject ?: return@mapNotNull null
                    UsageDay(d.text("day"), number(d, "generations").toInt(), number(d, "ttsCharacters").toInt(),
                        (d["models"] as? JsonArray)?.mapNotNull { m ->
                            (m as? JsonObject)?.let { ModelUse(it.text("model"), number(it, "calls").toInt(), number(it, "inputTokens").toLong(), number(it, "outputTokens").toLong()) }
                        }.orEmpty())
                }.orEmpty(),
                generationLimit = number(limits, "generations").toInt(), speechLimit = number(limits, "ttsCharacters").toInt(),
                speechRequestLimit = number(usage?.get("speech") as? JsonObject, "dailyRequests").toInt(),
                quality = (root["quality"] as? JsonArray)?.mapNotNull { element ->
                    val q = element as? JsonObject ?: return@mapNotNull null
                    QualityMark(q.text("createdAt").take(10), q.text("showName"), number(q, "overall"))
                }.orEmpty(),
                reasons = (root["reasons"] as? JsonArray)?.mapNotNull { element ->
                    (element as? JsonObject)?.let { Reason(it.text("label"), number(it, "count").toInt(), it.flag("active", false)) }
                }.orEmpty(),
                notes = (root["notes"] as? JsonArray)?.mapNotNull { (it as? JsonPrimitive)?.takeIf { p -> p.isString }?.content }.orEmpty(),
                changes = (root["changes"] as? JsonArray)?.mapNotNull { (it as? JsonObject)?.text("at")?.take(10) }.orEmpty(),
            )
        }
    }
}

/** `GET /api/spotify/profile`: whether the listening profile is connected and its top artists. */
data class ListeningProfile(val connected: Boolean, val artists: List<String>) {
    companion object {
        fun parse(body: String): ListeningProfile {
            val root = Json.parseToJsonElement(body) as? JsonObject ?: return ListeningProfile(false, emptyList())
            if (root["connected"] is JsonNull) return ListeningProfile(false, emptyList())
            return ListeningProfile((root["connected"] as? JsonPrimitive)?.booleanOrNull ?: false, root.list("artists"))
        }
    }
}
