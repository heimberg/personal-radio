package ch.heimberg.radio.core

import kotlinx.serialization.Serializable
import kotlinx.serialization.json.Json
import kotlin.math.asin
import kotlin.math.cos
import kotlin.math.pow
import kotlin.math.sin
import kotlin.math.sqrt

/** One thing the station does on its own, switched on or off in «Funktionen». */
@Serializable
data class FeatureView(val id: String, val name: String, val description: String = "", val cost: String = "", val enabled: Boolean = false)

/** A building block and whether the palette shows it. */
@Serializable
data class BlockToggle(val id: String, val name: String, val description: String = "", val visible: Boolean = true)

/** `GET /api/features`: the automatic features and every building block. */
@Serializable
data class FeatureCatalog(val features: List<FeatureView> = emptyList(), val blocks: List<BlockToggle> = emptyList()) {
    fun on(id: String): Boolean = features.firstOrNull { it.id == id }?.enabled == true
    /** «4 von 5 an · 2 Bausteine ausgeblendet» for the card. */
    val summary: String get() {
        val hidden = blocks.count { !it.visible }
        return "${features.count { it.enabled }} von ${features.size} an" + if (hidden > 0) " · $hidden ${if (hidden == 1) "Baustein" else "Bausteine"} ausgeblendet" else ""
    }
}

/** `POST /api/places/story`: the place, and its story's item – or why there is none. */
@Serializable
data class PlaceStory(val place: String? = null, val itemId: String? = null, val skipped: String? = null)

object Features {
    private val json = Json { ignoreUnknownKeys = true }
    fun parse(body: String): FeatureCatalog = json.decodeFromString(FeatureCatalog.serializer(), body)
    fun parsePlace(body: String): PlaceStory = json.decodeFromString(PlaceStory.serializer(), body)
}

/** A position the phone reported, and when. */
data class Fix(val latitude: Double, val longitude: Double, val atMs: Long)

/**
 * Ortsgeschichten: when to ask for the story of where the listener is – after moving at least [MIN_KM]
 * since the last report and at most once every [MIN_MINUTES]. The server tells each place only once a month.
 */
object PlaceTrigger {
    const val MIN_KM = 3.0
    const val MIN_MINUTES = 10L

    fun shouldReport(last: Fix?, current: Fix): Boolean =
        last == null || (current.atMs - last.atMs >= MIN_MINUTES * 60_000 && distanceKm(last, current) >= MIN_KM)

    fun distanceKm(a: Fix, b: Fix): Double {
        val rad = Math.PI / 180
        val dLat = (b.latitude - a.latitude) * rad
        val dLon = (b.longitude - a.longitude) * rad
        val h = sin(dLat / 2).pow(2) + cos(a.latitude * rad) * cos(b.latitude * rad) * sin(dLon / 2).pow(2)
        return 2 * 6371.0 * asin(sqrt(h))
    }
}
