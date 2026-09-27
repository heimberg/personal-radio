package ch.heimberg.radio

import android.content.Context
import ch.heimberg.radio.core.Connection

/** Worker address and Access service token, kept in the app's private storage. */
class RadioSettings(context: Context) {
    private val prefs = context.getSharedPreferences("radio", Context.MODE_PRIVATE)

    val baseUrl: String get() = prefs.getString(KEY_URL, "") ?: ""
    val clientId: String get() = prefs.getString(KEY_ID, "") ?: ""
    val clientSecret: String get() = prefs.getString(KEY_SECRET, "") ?: ""

    fun connection(): Connection? = runCatching { Connection.create(baseUrl, clientId, clientSecret) }.getOrNull()

    fun save(connection: Connection) {
        prefs.edit()
            .putString(KEY_URL, connection.baseUrl)
            .putString(KEY_ID, connection.clientId)
            .putString(KEY_SECRET, connection.clientSecret)
            .apply()
    }

    private companion object {
        const val KEY_URL = "baseUrl"
        const val KEY_ID = "clientId"
        const val KEY_SECRET = "clientSecret"
    }
}
