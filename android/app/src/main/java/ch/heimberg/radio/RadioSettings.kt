package ch.heimberg.radio

import android.content.Context
import ch.heimberg.radio.core.Connection

/** Worker address and Access service token, kept in the app's private storage. */
class RadioSettings(context: Context) {
    private val prefs = context.getSharedPreferences("radio", Context.MODE_PRIVATE)

    val baseUrl: String get() = prefs.getString(KEY_URL, "") ?: ""
    val clientId: String get() = prefs.getString(KEY_ID, "") ?: ""
    val clientSecret: String get() = prefs.getString(KEY_SECRET, "") ?: ""

    /** The owner allowed this app to control Spotify once; the button then leaves the main screen. */
    var spotifyLinked: Boolean
        get() = prefs.getBoolean(KEY_SPOTIFY, false)
        set(value) { prefs.edit().putBoolean(KEY_SPOTIFY, value).apply() }

    fun connection(): Connection? = runCatching { Connection.create(baseUrl, clientId, clientSecret) }.getOrNull()

    fun save(connection: Connection) {
        prefs.edit()
            .putString(KEY_URL, connection.baseUrl)
            .putString(KEY_ID, connection.clientId)
            .putString(KEY_SECRET, connection.clientSecret)
            // A new connection asks for Spotify again, which is also the way to repair a lost permission.
            .putBoolean(KEY_SPOTIFY, false)
            .apply()
    }

    private companion object {
        const val KEY_URL = "baseUrl"
        const val KEY_ID = "clientId"
        const val KEY_SECRET = "clientSecret"
        const val KEY_SPOTIFY = "spotifyLinked"
    }
}

/** The catalog's favourites and how often each block was inserted: only on this phone, for «Für dich». */
class CatalogPrefs(context: Context) {
    private val prefs = context.getSharedPreferences("catalog", Context.MODE_PRIVATE)

    var favorites: Set<String>
        get() = prefs.getStringSet(KEY_FAVORITES, emptySet())?.toSet() ?: emptySet()
        set(value) { prefs.edit().putStringSet(KEY_FAVORITES, value).apply() }

    val usage: Map<String, Int>
        get() = prefs.all.mapNotNull { (key, value) -> if (key.startsWith(USE) && value is Int) key.removePrefix(USE) to value else null }.toMap()

    /** Counts one insertion of [blockId]; returns the new counts. */
    fun used(blockId: String): Map<String, Int> {
        prefs.edit().putInt(USE + blockId, prefs.getInt(USE + blockId, 0) + 1).apply()
        return usage + (blockId to prefs.getInt(USE + blockId, 0))
    }

    private companion object {
        const val KEY_FAVORITES = "favorites"
        const val USE = "use:"
    }
}

/** Tips the app shows once, and how it looks: only on this phone. */
class UiHints(context: Context) {
    private val prefs = context.getSharedPreferences("hints", Context.MODE_PRIVATE)

    var programSeen: Boolean
        get() = prefs.getBoolean("program", false)
        set(value) { prefs.edit().putBoolean("program", value).apply() }

    /** Light or dark: 0 follows the system, 1 always light, 2 always dark. */
    var appearance: Int
        get() = prefs.getInt("appearance", 0).coerceIn(0, 2)
        set(value) { prefs.edit().putInt("appearance", value.coerceIn(0, 2)).apply() }

    /** The same as AppCompat's night mode, for every screen of the app (Compose and views). */
    val nightMode: Int get() = when (appearance) {
        1 -> androidx.appcompat.app.AppCompatDelegate.MODE_NIGHT_NO
        2 -> androidx.appcompat.app.AppCompatDelegate.MODE_NIGHT_YES
        else -> androidx.appcompat.app.AppCompatDelegate.MODE_NIGHT_FOLLOW_SYSTEM
    }
}
