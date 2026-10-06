package ch.heimberg.radio.core

import kotlinx.serialization.Serializable
import kotlinx.serialization.json.Json
import java.net.URI
import java.net.URLDecoder

/** Who an invitation is for: family (chat, sharing), a child (a child's station) or a guest (own station only). */
enum class ListenerKind(val wire: String, val label: String, val hint: String) {
    FAMILY("family", "Familie", "Eigener Sender, dazu Chat, Teilen und Grüsse in der Familie"),
    KIDS("kids", "Kind", "Kindersender: altersgerechte Texte und Musik, Mitmachen und Sticker"),
    GUEST("guest", "Gast", "Nur ein eigener Sender, ohne Familie");

    companion object {
        fun of(wire: String): ListenerKind = entries.firstOrNull { it.wire == wire } ?: GUEST
    }
}

/**
 * An invitation as typed or opened: the code (16 characters, as XXXX-XXXX-XXXX-XXXX) and, when it came as a
 * link, the radio's address.
 */
data class JoinLink(val code: String, val baseUrl: String?) {
    companion object {
        private val CODE = Regex("[A-Za-z0-9]{4}(?:[\\s-]*[A-Za-z0-9]{4}){3}")

        /** A join link (`https://…/join?code=…`), the app link (`personal-radio://join?code=…&url=…`) or just the code. */
        fun parse(text: String): JoinLink? {
            val trimmed = text.trim()
            if (trimmed.isEmpty()) return null
            val uri = runCatching { URI(trimmed) }.getOrNull()
            if (uri?.scheme != null && uri.rawQuery != null) {
                val query = uri.rawQuery.split('&').mapNotNull { part ->
                    val (key, value) = part.split('=', limit = 2).takeIf { it.size == 2 } ?: return@mapNotNull null
                    key to URLDecoder.decode(value, Charsets.UTF_8)
                }.toMap()
                val code = query["code"]?.let(::normalize) ?: return null
                val base = when (uri.scheme.lowercase()) {
                    "https" -> if (uri.path?.trimEnd('/') == "/join" && uri.host != null) "https://${uri.rawAuthority}" else null
                    "personal-radio" -> query["url"]?.takeIf { it.startsWith("https://") }?.trimEnd('/')
                    else -> null
                }
                return if (uri.scheme.lowercase() == "https" && base == null) null else JoinLink(code, base)
            }
            return CODE.matchEntire(trimmed)?.let { normalize(it.value) }?.let { JoinLink(it, null) }
        }

        /** Upper case in groups of four; null unless it is 16 letters and digits. */
        fun normalize(code: String): String? {
            val plain = code.uppercase().filter { it.isLetterOrDigit() }
            return if (plain.length == 16 && plain.all { it in 'A'..'Z' || it in '0'..'9' }) plain.chunked(4).joinToString("-") else null
        }
    }
}

/** What redeeming a code returns: the radio's address and this phone's own Access service token. */
@Serializable
data class JoinResult(val baseUrl: String, val clientId: String, val clientSecret: String, val name: String = "")

@Serializable
data class Invite(val id: String, val name: String, val kind: String, val expiresAt: String, val usedAt: String? = null, val expired: Boolean = false) {
    val listenerKind: ListenerKind get() = ListenerKind.of(kind)
}

@Serializable
data class UsageCount(val generations: Int = 0, val characters: Int = 0)

/** An estimate of the provider costs in francs: today and the last 30 days. */
@Serializable
data class CostSpan(val today: Double = 0.0, val month: Double = 0.0) {
    /** «heute ca. CHF 0.40 · 30 Tage ca. CHF 6.20» */
    fun line(): String = "heute ca. ${chf(today)} · 30 Tage ca. ${chf(month)}"

    companion object {
        fun chf(value: Double): String = "CHF " + String.format(java.util.Locale.ROOT, "%.2f", value)
    }
}

/** A monthly budget in francs and what has been spent against it since the first of the month. */
@Serializable
data class MoneyBudget(val limit: Double = 0.0, val spent: Double = 0.0) {
    val share: Double get() = if (limit > 0) spent / limit else 0.0
    val usedUp: Boolean get() = limit > 0 && spent >= limit

    /** «Budget: CHF 3.20 von CHF 5.00 im Monat (64 %)» */
    fun line(): String = "Budget: ${CostSpan.chf(spent)} von ${CostSpan.chf(limit)} im Monat (${Math.round(share * 100)} %)"
}

/** What a station used today and in the last seven days, and what it probably cost. */
@Serializable
data class StationUsage(val today: UsageCount = UsageCount(), val week: UsageCount = UsageCount(), val costs: CostSpan? = null, val budget: MoneyBudget? = null) {
    /** «Heute 4 von 6 · 7 Tage 30 Produktionen» */
    fun line(limit: Int): String = "Heute ${today.generations} von $limit · 7 Tage ${week.generations} Produktionen"

    /** One short line for the list: «heute 4 von 24 · CHF 0.40». */
    fun compact(limit: Int): String = listOfNotNull("heute ${today.generations} von $limit", costs?.let { CostSpan.chf(it.today) }).joinToString(" · ")
}

@Serializable
data class InvitedListener(
    val key: String, val name: String, val kind: String, val since: String? = null, val removable: Boolean = false,
    val limit: Int = 0, val ownLimit: Int? = null, val usage: StationUsage = StationUsage(),
) {
    val listenerKind: ListenerKind get() = ListenerKind.of(kind)
}

@Serializable
data class OwnStation(val limit: Int = 0, val usage: StationUsage = StationUsage())

/** `GET /api/invites`: whether invitations work on this Worker, the invitations and who listens. */
@Serializable
data class InviteOverview(
    val ready: Boolean = false, val invites: List<Invite> = emptyList(), val listeners: List<InvitedListener> = emptyList(), val own: OwnStation? = null,
    /** The budget for every station together, if set. */
    val serverBudget: MoneyBudget? = null,
    /** Productions a day once a budget is used up. */
    val budgetFloor: Int = 4,
) {
    /** Still waiting to be used, newest first. */
    val open: List<Invite> get() = invites.filter { it.usedAt == null && !it.expired }

    companion object {
        private val json = Json { ignoreUnknownKeys = true }
        fun parse(body: String): InviteOverview = json.decodeFromString(body)
        fun joined(body: String): JoinResult = json.decodeFromString(body)
        fun created(body: String): CreatedInvite = json.decodeFromString(body)
    }
}

/** A new invitation: its code and the link to send (shown once; the server keeps only a hash). */
@Serializable
data class CreatedInvite(val id: String, val code: String, val link: String, val expiresAt: String) {
    fun message(name: String, station: String?): String =
        "Hallo $name! Ich lade dich zu meinem Radio${station?.let { " «$it»" } ?: ""} ein. Öffne diesen Link auf deinem Android-Handy, " +
            "dort gibt es die App und den Knopf zum Beitreten:\n$link\n\nFalls nötig, der Code: $code (gilt eine Woche, einmal)."
}
