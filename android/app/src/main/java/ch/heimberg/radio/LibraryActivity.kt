package ch.heimberg.radio

import android.content.Intent
import android.os.Bundle
import android.widget.Button
import android.widget.LinearLayout
import android.widget.TextView
import androidx.appcompat.app.AppCompatActivity
import androidx.lifecycle.lifecycleScope
import ch.heimberg.radio.core.TimelineJson
import kotlinx.coroutines.launch
import java.time.Instant
import java.time.LocalDate
import java.time.ZoneId
import java.time.format.DateTimeFormatter
import java.util.Locale

/**
 * The archive: new, unheard and heard productions that can still be played, grouped by day. Tapping one
 * hands it back to the main screen, which plays it right away; the program continues afterwards.
 */
class LibraryActivity : AppCompatActivity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        val connection = RadioSettings(this).connection() ?: run { finish(); return }
        setContentView(R.layout.activity_library)
        findViewById<Button>(R.id.back).setOnClickListener { finish() }
        val intro = findViewById<TextView>(R.id.intro)
        val list = findViewById<LinearLayout>(R.id.items)
        val zone = ZoneId.systemDefault()
        val time = DateTimeFormatter.ofPattern("HH:mm").withZone(zone)
        val day = DateTimeFormatter.ofPattern("EEEE, d. MMMM", Locale.GERMAN)

        lifecycleScope.launch {
            val library = runCatching { ApiClient(connection).library() }.getOrElse {
                intro.text = it.message ?: getString(R.string.connection_failed)
                return@launch
            }
            intro.text = getString(if (library.items.isEmpty()) R.string.archive_empty else R.string.archive_intro, library.retentionDays)
            val today = LocalDate.now(zone)
            var lastDay: LocalDate? = null
            for (item in library.items.filter { it.hasAudio }) {
                val planned = runCatching { Instant.parse(item.plannedAt) }.getOrNull()
                val date = planned?.atZone(zone)?.toLocalDate()
                if (date != null && date != lastDay) {
                    lastDay = date
                    val label = when (date) {
                        today -> getString(R.string.today)
                        today.minusDays(1) -> getString(R.string.yesterday)
                        else -> day.format(date)
                    }
                    list.addView(layoutInflater.inflate(R.layout.item_day, list, false).apply { (this as TextView).text = label })
                }
                list.addView(TimelineRows.inflate(layoutInflater, list, item, planned?.let(time::format) ?: "", playing = false) { chosen ->
                    setResult(RESULT_OK, Intent().putExtra(EXTRA_ITEM, TimelineJson.encodeItem(chosen)))
                    finish()
                })
            }
        }
    }

    companion object {
        const val EXTRA_ITEM = "item"
    }
}
