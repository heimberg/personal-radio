package ch.heimberg.radio

import android.content.Intent
import android.os.Bundle
import android.widget.Button
import android.widget.EditText
import android.widget.TextView
import androidx.appcompat.app.AppCompatActivity
import androidx.lifecycle.lifecycleScope
import ch.heimberg.radio.core.Connection
import ch.heimberg.radio.core.JoinLink
import kotlinx.coroutines.launch
import java.net.URI

/**
 * Connecting the app: by invitation (a link or code; the server makes this phone its own token) or by hand
 * with the Worker address and an Access service token. Saved only after a successful test.
 */
class SetupActivity : AppCompatActivity() {
    private lateinit var invite: EditText
    private lateinit var message: TextView

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContentView(R.layout.activity_setup)
        val settings = RadioSettings(this)
        invite = findViewById(R.id.invite)
        message = findViewById(R.id.setup_message)
        val url = findViewById<EditText>(R.id.base_url).apply { setText(settings.baseUrl) }
        val id = findViewById<EditText>(R.id.client_id).apply { setText(settings.clientId) }
        val secret = findViewById<EditText>(R.id.client_secret).apply { setText(settings.clientSecret) }
        val save = findViewById<Button>(R.id.save)
        val join = findViewById<Button>(R.id.join)

        save.setOnClickListener {
            val connection = try {
                Connection.create(url.text.toString(), id.text.toString(), secret.text.toString())
            } catch (error: IllegalArgumentException) {
                message.text = error.message
                return@setOnClickListener
            }
            connect(connection, save)
        }

        join.setOnClickListener {
            val link = JoinLink.parse(invite.text.toString()) ?: run { message.text = getString(R.string.invite_invalid); return@setOnClickListener }
            val base = link.baseUrl ?: url.text.toString().trim().trimEnd('/').takeIf { it.startsWith("https://") }
                ?: run { message.text = getString(R.string.invite_needs_address); return@setOnClickListener }
            join.isEnabled = false
            message.text = getString(R.string.joining)
            lifecycleScope.launch {
                runCatching { ApiClient.join(base, link.code) }
                    .onSuccess { joined ->
                        val connection = runCatching { Connection.create(joined.baseUrl, joined.clientId, joined.clientSecret) }.getOrNull()
                        if (connection == null) message.text = getString(R.string.connection_failed) else connect(connection, join)
                    }
                    .onFailure { message.text = it.message ?: getString(R.string.connection_failed) }
                join.isEnabled = true
            }
        }
        showInvite(intent)
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        showInvite(intent)
    }

    /**
     * An invitation opened from the join page: filled in, but joined only on a tap, with the address shown,
     * so a link from elsewhere cannot connect the app to a foreign server unnoticed.
     */
    private fun showInvite(intent: Intent?) {
        val data = intent?.data?.toString() ?: return
        val link = JoinLink.parse(data) ?: return
        invite.setText(data)
        val host = link.baseUrl?.let { runCatching { URI(it).host }.getOrNull() }
        message.text = listOfNotNull(
            host?.let { "Einladung von $it. Tippe auf «Beitreten»." },
            if (RadioSettings(this).connection() != null) getString(R.string.invite_replaces) else null,
        ).joinToString("\n")
    }

    /** Tests [connection] with the program, then keeps it and opens the radio. */
    private fun connect(connection: Connection, button: Button) {
        button.isEnabled = false
        message.text = getString(R.string.testing)
        lifecycleScope.launch {
            runCatching { ApiClient(connection).timeline() }
                .onSuccess {
                    RadioSettings(this@SetupActivity).save(connection)
                    // The playback service reads the connection when it starts.
                    stopService(Intent(this@SetupActivity, PlaybackService::class.java))
                    startActivity(Intent(this@SetupActivity, MainActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_CLEAR_TOP))
                    finish()
                }
                .onFailure { message.text = it.message ?: getString(R.string.connection_failed) }
            button.isEnabled = true
        }
    }
}
