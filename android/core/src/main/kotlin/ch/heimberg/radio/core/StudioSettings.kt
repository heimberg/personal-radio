package ch.heimberg.radio.core

import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.booleanOrNull
import kotlinx.serialization.json.doubleOrNull
import kotlinx.serialization.json.intOrNull
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive

/** Where the listener is, for weather and `{ort}`. */
data class Place(val name: String, val latitude: Double, val longitude: Double, val region: String = "", val country: String = "") {
    val label: String get() = listOf(name, region, country).filter { it.isNotBlank() }.joinToString(", ")
}

/**
 * A voice the host can speak with (`GET /api/voices`): [group] is `own` (designed or cloned), `standard`
 * (the prebuilt Gemini voices), `library` (German voices from Google's library) or `mistral`.
 */
data class VoiceOption(val id: String, val name: String, val group: String = "standard", val description: String = "") {
    val own: Boolean get() = group == "own"
}

/** The groups in the order the studio lists them. */
object VoiceGroups {
    val ORDER = listOf("own" to "Eigene Stimmen", "standard" to "Standard", "library" to "Bibliothek", "mistral" to "Mistral")

    /** The sentence Google requires the speaker to say before a voice is cloned (German). */
    const val CONSENT = "Ich bin der Eigentümer dieser Stimme und bin damit einverstanden, dass Google diese Stimme zur Erstellung eines synthetischen Stimmmodells verwendet."

    /** Something to read for the voice sample: varied sounds, calm pace, about 20 seconds. */
    const val SAMPLE = "Guten Morgen und herzlich willkommen. Heute erzähle ich dir, was die Welt bewegt: von neuen Entdeckungen im Weltraum über Musik, die man nicht verpassen sollte, bis zu Geschichten aus der Nachbarschaft. Mach es dir bequem, hol dir einen Kaffee – wir starten gemeinsam in den Tag."
}

/**
 * The settings the native studio edits: station and host, interests, music and station sound. Pure
 * functions, so every change is tested; [mergeInto] writes only these fields into the stored settings,
 * everything else (shows, feeds, agents, day plan) stays as it is.
 */
data class StudioSettings(
    val name: String = "",
    val hostName: String = "",
    val tone: String = "",
    val style: String = "",
    val voiceId: String? = null,
    val voiceStyle: String = "",
    val cohostName: String = "",
    val instructions: String = "",
    val place: Place? = null,
    val topics: List<String> = emptyList(),
    val interests: List<String> = emptyList(),
    val exploration: Int = 20,
    val between: Int = 1,
    val announce: Boolean = true,
    val taste: String = "",
    val ident: Boolean = true,
    val hourChange: Boolean = true,
    val linker: Boolean = true,
    val bed: Boolean = false,
) {
    fun toggleTopic(topic: String): StudioSettings = copy(topics = if (topic in topics) topics - topic else topics + topic)

    /** Adds an own interest; blank, duplicate (any case) or beyond 30 changes nothing. */
    fun addInterest(text: String): StudioSettings {
        val value = text.trim().take(48)
        if (value.isEmpty() || interests.size >= 30 || interests.any { it.equals(value, ignoreCase = true) }) return this
        return copy(interests = interests + value)
    }

    fun removeInterest(value: String): StudioSettings = copy(interests = interests - value)

    fun exploration(level: Int): StudioSettings = copy(exploration = (Math.round(level / 5f) * 5).coerceIn(0, 50))

    fun between(songs: Int): StudioSettings = copy(between = songs.coerceIn(0, 3))

    /** The settings as they go back to the Worker: [config] with these fields replaced. */
    fun mergeInto(config: JsonObject): JsonObject {
        val host = config.obj("host").edit {
            put("name", JsonPrimitive(hostName.trim().take(40)))
            put("tone", JsonPrimitive(tone.trim().take(160)))
            put("style", JsonPrimitive(style.trim().take(160)))
            put("instructions", JsonPrimitive(instructions.take(2000)))
            put("voiceStyle", JsonPrimitive(voiceStyle.trim().take(300)))
            put("cohostName", JsonPrimitive(cohostName.trim().take(40)))
            if (voiceId.isNullOrBlank()) remove("voiceId") else put("voiceId", JsonPrimitive(voiceId))
        }
        val profile = config.obj("profile").edit {
            put("topics", JsonArray(topics.map(::JsonPrimitive)))
            put("interests", JsonArray(interests.map(::JsonPrimitive)))
            put("exploration", JsonPrimitive(exploration))
        }
        val music = config.obj("music").edit {
            put("between", JsonPrimitive(between))
            put("announce", JsonPrimitive(announce))
            put("taste", JsonPrimitive(taste.take(500)))
        }
        val sounds = config.obj("sounds").edit {
            put("ident", JsonPrimitive(ident)); put("hourChange", JsonPrimitive(hourChange))
            put("linker", JsonPrimitive(linker)); put("musicBed", JsonPrimitive(bed))
        }
        return config.edit {
            put("name", JsonPrimitive(name.trim().take(60)))
            put("host", host); put("profile", profile); put("music", music); put("sounds", sounds)
            val where = place
            if (where == null) remove("location")
            else put("location", JsonObject(mapOf("name" to JsonPrimitive(where.name), "latitude" to JsonPrimitive(where.latitude), "longitude" to JsonPrimitive(where.longitude))))
        }
    }

    companion object {
        /** The three broad topics the planner knows; own interests go beside them. */
        val TOPICS = listOf("Technologie", "Wissenschaft", "Kultur")

        private val json = Json { ignoreUnknownKeys = true }

        /** Reads `GET /api/station`; null while the station is not set up. */
        fun parse(body: String): StudioSettings? {
            val config = json.parseToJsonElement(body).jsonObject["config"]?.takeIf { it !is JsonNull }?.jsonObject ?: return null
            return of(config)
        }

        fun of(config: JsonObject): StudioSettings {
            val host = config.obj("host")
            val profile = config.obj("profile")
            val music = config.obj("music")
            val sounds = config.obj("sounds")
            val location = config["location"]?.takeIf { it is JsonObject }?.jsonObject
            return StudioSettings(
                name = config.text("name"),
                hostName = host.text("name"), tone = host.text("tone"), style = host.text("style"),
                voiceId = host.text("voiceId").ifBlank { null }, voiceStyle = host.text("voiceStyle"),
                cohostName = host.text("cohostName"), instructions = host.text("instructions"),
                place = location?.let { spot ->
                    val lat = spot["latitude"]?.jsonPrimitive?.doubleOrNull
                    val lon = spot["longitude"]?.jsonPrimitive?.doubleOrNull
                    if (lat != null && lon != null) Place(spot.text("name"), lat, lon) else null
                },
                topics = profile.list("topics"), interests = profile.list("interests"),
                exploration = profile["exploration"]?.jsonPrimitive?.intOrNull ?: 20,
                between = music["between"]?.jsonPrimitive?.intOrNull ?: 1,
                announce = music.flag("announce", true), taste = music.text("taste"),
                ident = sounds.flag("ident", true), hourChange = sounds.flag("hourChange", true),
                linker = sounds.flag("linker", true), bed = sounds.flag("musicBed", false),
            )
        }

        /** `GET /api/places?name=`: matching places, best first. */
        fun parsePlaces(body: String): List<Place> =
            (json.parseToJsonElement(body).jsonObject["places"] as? JsonArray ?: JsonArray(emptyList())).mapNotNull { element ->
                val place = element as? JsonObject ?: return@mapNotNull null
                val lat = place["latitude"]?.jsonPrimitive?.doubleOrNull ?: return@mapNotNull null
                val lon = place["longitude"]?.jsonPrimitive?.doubleOrNull ?: return@mapNotNull null
                // Four decimals are about ten metres: enough for the weather, no more than needed.
                Place(place.text("name"), Math.round(lat * 10_000) / 10_000.0, Math.round(lon * 10_000) / 10_000.0, place.text("region"), place.text("country"))
            }

        /** `GET /api/voices`: the voices to choose from. */
        fun parseVoices(body: String): List<VoiceOption> =
            (json.parseToJsonElement(body).jsonObject["voices"] as? JsonArray ?: JsonArray(emptyList())).mapNotNull { element ->
                val voice = element as? JsonObject ?: return@mapNotNull null
                val id = voice.text("id").ifBlank { return@mapNotNull null }
                VoiceOption(id, voice.text("name").ifBlank { id }, voice.text("group").ifBlank { "standard" }, voice.text("description"))
            }

        /** `POST /api/voices/design|clone`: the new voice. */
        fun parseCreatedVoice(body: String): VoiceOption? {
            val voice = json.parseToJsonElement(body).jsonObject["voice"] as? JsonObject ?: return null
            val id = voice.text("id").ifBlank { return null }
            return VoiceOption(id, voice.text("name").ifBlank { id }, "own")
        }

        fun parseConfig(body: String): JsonObject = json.parseToJsonElement(body).jsonObject["config"]!!.jsonObject
    }
}

private fun JsonObject.obj(key: String): JsonObject = this[key] as? JsonObject ?: JsonObject(emptyMap())
private fun JsonObject.text(key: String): String = (this[key] as? JsonPrimitive)?.takeIf { it.isString }?.content ?: ""
private fun JsonObject.flag(key: String, default: Boolean): Boolean = (this[key] as? JsonPrimitive)?.booleanOrNull ?: default
private fun JsonObject.list(key: String): List<String> =
    (this[key] as? JsonArray)?.mapNotNull { (it as? JsonPrimitive)?.takeIf { value -> value.isString }?.content } ?: emptyList()
private fun JsonObject.edit(change: MutableMap<String, JsonElement>.() -> Unit): JsonObject = JsonObject(toMutableMap().apply(change))
