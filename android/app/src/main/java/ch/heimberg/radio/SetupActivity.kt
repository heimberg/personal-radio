package ch.heimberg.radio

import android.content.Intent
import android.os.Bundle
import android.widget.Button
import android.widget.EditText
import android.widget.TextView
import androidx.appcompat.app.AppCompatActivity
import androidx.lifecycle.lifecycleScope
import ch.heimberg.radio.core.Connection
import kotlinx.coroutines.launch

/** One-time setup: Worker address and the Cloudflare Access service token. Saved only after a successful test. */
class SetupActivity : AppCompatActivity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContentView(R.layout.activity_setup)
        val settings = RadioSettings(this)
        val url = findViewById<EditText>(R.id.base_url).apply { setText(settings.baseUrl) }
        val id = findViewById<EditText>(R.id.client_id).apply { setText(settings.clientId) }
        val secret = findViewById<EditText>(R.id.client_secret).apply { setText(settings.clientSecret) }
        val message = findViewById<TextView>(R.id.setup_message)
        val save = findViewById<Button>(R.id.save)

        save.setOnClickListener {
            val connection = try {
                Connection.create(url.text.toString(), id.text.toString(), secret.text.toString())
            } catch (error: IllegalArgumentException) {
                message.text = error.message
                return@setOnClickListener
            }
            save.isEnabled = false
            message.text = getString(R.string.testing)
            lifecycleScope.launch {
                runCatching { ApiClient(connection).timeline() }
                    .onSuccess {
                        settings.save(connection)
                        // The playback service reads the connection when it starts.
                        stopService(Intent(this@SetupActivity, PlaybackService::class.java))
                        startActivity(Intent(this@SetupActivity, MainActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_CLEAR_TOP))
                        finish()
                    }
                    .onFailure { message.text = it.message ?: getString(R.string.connection_failed) }
                save.isEnabled = true
            }
        }
    }
}
