package ch.heimberg.radio.core

/**
 * Turns a refused request into a message that names the layer that refused it: Cloudflare Access
 * (answers with a redirect to its login or its own error page) or the Worker (answers with JSON and a
 * reason). Only settings are named, never token values.
 */
object AccessDiagnosis {
    private val reason = Regex("\"reason\"\\s*:\\s*\"([a-z_]+)\"")

    fun message(status: Int, location: String?, body: String): String {
        if (status in 300..399 || (status == 403 && !body.trimStart().startsWith("{"))) {
            val login = location?.contains("cloudflareaccess.com") == true || status == 403
            return if (login) ACCESS_REFUSED else "Weiterleitung statt Antwort – prüfe die Adresse (https://…workers.dev)."
        }
        if (status == 401) return when (reason.find(body)?.groupValues?.get(1)) {
            "service_token_not_allowed" -> "Access hat das Token angenommen, der Worker nicht: Die Client-ID muss im Worker in ACCESS_SERVICE_TOKEN_ID oder in LISTENERS stehen."
            "service_token_not_configured" -> "Im Worker fehlt ACCESS_SERVICE_TOKEN_ID (die Client-ID des Service-Tokens)."
            "no_access_token" -> "Die Anfrage kam ohne Access-Prüfung an: Liegt die Adresse hinter der Access-Anwendung?"
            "access_not_configured" -> "Im Worker fehlen ACCESS_TEAM_DOMAIN, ACCESS_AUD oder ALLOWED_EMAIL."
            else -> "Der Worker hat die Anmeldung abgelehnt (${reason.find(body)?.groupValues?.get(1) ?: "ohne Grund"})."
        }
        // A setting the Worker refused names the field and what it expects.
        if (status == 400) detail.find(body)?.groupValues?.get(1)?.let { return "Nicht gespeichert – $it" }
        // The Worker answers 404 with a reason when something is gone; only a bare 404 means a wrong address.
        if (status == 404) error.find(body)?.groupValues?.get(1)?.let { return gone(it) }
        return when (status) {
            403 -> "Anfrage abgelehnt (Origin). Prüfe, ob die Adresse genau die des Workers ist."
            404 -> "Adresse gefunden, aber kein Radio-Server dahinter."
            429 -> "Tageslimit erreicht."
            else -> "Server antwortet mit Fehler $status."
        }
    }

    private fun gone(code: String): String = when (code) {
        "not_found" -> "Diesen Beitrag gibt es nicht mehr – das Programm wird neu geladen."
        "audio_unavailable" -> "Der Ton dieses Beitrags ist nicht mehr gespeichert."
        "unknown_block" -> "Diesen Baustein gibt es nicht mehr."
        "unknown_show" -> "Diese Sendung gibt es nicht mehr."
        "not_configured" -> "Der Sender ist noch nicht eingerichtet."
        "spotify_not_configured" -> "Spotify ist im Worker nicht eingerichtet."
        else -> "Nicht gefunden ($code)."
    }

    private val error = Regex("\"error\"\\s*:\\s*\"([a-z_]{1,40})\"")
    private val detail = Regex("\"detail\"\\s*:\\s*\"([^\"]{1,300})\"")

    const val ACCESS_REFUSED = "Cloudflare Access lehnt das Token ab: Client-ID oder Client-Secret stimmt nicht, oder das Token fehlt in der Service-Auth-Regel der Access-Anwendung."
}
