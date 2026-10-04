package ch.heimberg.radio.core

import kotlinx.serialization.Serializable
import kotlinx.serialization.json.Json

/** `GET /api/app/latest`: the newest signed build CI published to the Worker. */
@Serializable
data class AppBuild(val versionCode: Long, val versionName: String, val sha256: String, val size: Long, val notes: List<String> = emptyList()) {
    /** Offered only when it is newer than what is installed and looks complete. */
    fun newerThan(installed: Long): Boolean = versionCode > installed && size > 0 && SHA256.matches(sha256)

    companion object {
        private val SHA256 = Regex("^[0-9a-f]{64}$")
        private val json = Json { ignoreUnknownKeys = true }
        fun parse(body: String): AppBuild = json.decodeFromString(serializer(), body)
    }
}
