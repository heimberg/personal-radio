package ch.heimberg.radio.core

import java.net.URI

/**
 * Where the private Worker runs and the Cloudflare Access service token the app authenticates with.
 * Every request carries the token headers; audio URLs from the API are resolved against the base URL
 * and must stay on the same origin, so the token is never sent to another host.
 */
class Connection private constructor(private val base: URI, val clientId: String, val clientSecret: String) {
    val baseUrl: String get() = base.toString()
    val origin: String get() = "${base.scheme}://${base.rawAuthority}"
    val host: String get() = base.host

    fun resolve(path: String): String {
        val resolved = base.resolve(path)
        require(resolved.scheme == base.scheme && resolved.rawAuthority == base.rawAuthority) { "Pfad verlässt den Radio-Server: $path" }
        return resolved.toString()
    }

    fun headers(): Map<String, String> = mapOf("CF-Access-Client-Id" to clientId, "CF-Access-Client-Secret" to clientSecret)

    companion object {
        /** Validates the owner's input; the message is shown in the setup screen. */
        fun create(baseUrl: String, clientId: String, clientSecret: String): Connection {
            val trimmed = baseUrl.trim()
            val uri = try { URI(if (trimmed.endsWith("/")) trimmed else "$trimmed/") } catch (error: Exception) {
                throw IllegalArgumentException("Adresse ist keine gültige URL.")
            }
            require(uri.scheme == "https" && !uri.host.isNullOrBlank()) { "Adresse muss mit https:// beginnen." }
            require(uri.rawUserInfo == null && uri.rawQuery == null && uri.rawFragment == null) { "Adresse ohne Benutzer, Parameter oder #-Teil angeben." }
            require(clientId.trim().isNotEmpty() && clientSecret.trim().isNotEmpty()) { "Client-ID und Client-Secret des Service-Tokens angeben." }
            return Connection(uri, clientId.trim(), clientSecret.trim())
        }
    }
}
