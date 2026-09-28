package ch.heimberg.radio

import android.content.Intent
import android.os.Bundle
import android.widget.Button
import android.widget.LinearLayout
import android.widget.TextView
import android.widget.Toast
import androidx.appcompat.app.AlertDialog
import androidx.appcompat.app.AppCompatActivity
import androidx.lifecycle.lifecycleScope
import ch.heimberg.radio.core.TimelineItem
import ch.heimberg.radio.core.TimelineJson
import kotlinx.coroutines.launch
import java.time.Instant
import java.time.LocalDate
import java.time.ZoneId
import java.time.format.DateTimeFormatter
import java.util.Locale

/**
 * The archive: new, unheard and heard productions that can still be played, grouped by day. Tapping one
 * hands it back to the main screen, which plays it right away; a long press deletes it.
 */
class LibraryActivity : AppCompatActivity() {
    private lateinit var api: ApiClient
    private lateinit var intro: TextView
    private lateinit var list: LinearLayout
    private val zone = ZoneId.systemDefault()
    private val time = DateTimeFormatter.ofPattern("HH:mm").withZone(zone)
    private val day = DateTimeFormatter.ofPattern("EEEE, d. MMMM", Locale.GERMAN)

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        val connection = RadioSettings(this).connection() ?: run { finish(); return }
        api = ApiClient(connection)
        setContentView(R.layout.activity_library)
        findViewById<Button>(R.id.back).setOnClickListener { finish() }
        intro = findViewById(R.id.intro)
        list = findViewById(R.id.items)
        load()
    }

    private fun load() {
        lifecycleScope.launch {
            val library = runCatching { api.library() }.getOrElse {
                intro.text = it.message ?: getString(R.string.connection_failed)
                return@launch
            }
            val items = library.items.filter { it.hasAudio }
            intro.text = if (items.isEmpty()) getString(R.string.archive_empty)
            else getString(R.string.archive_intro, library.retentionDays) + " " + getString(R.string.archive_hint_delete)
            list.removeAllViews()
            val today = LocalDate.now(zone)
            var lastDay: LocalDate? = null
            for (item in items) {
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
                val row = TimelineRows.inflate(layoutInflater, list, item, planned?.let(time::format) ?: "", playing = false) { chosen ->
                    setResult(RESULT_OK, Intent().putExtra(EXTRA_ITEM, TimelineJson.encodeItem(chosen)))
                    finish()
                }
                row.setOnLongClickListener { confirmDelete(item); true }
                list.addView(row)
            }
        }
    }

    private fun confirmDelete(item: TimelineItem) {
        AlertDialog.Builder(this)
            .setTitle(getString(R.string.delete_title, item.displayTitle))
            .setMessage(R.string.delete_message)
            .setNegativeButton(android.R.string.cancel, null)
            .setPositiveButton(R.string.delete) { _, _ ->
                lifecycleScope.launch {
                    val result = runCatching { api.delete(item.id) }
                    Toast.makeText(this@LibraryActivity, result.fold({ getString(R.string.deleted) }, { it.message ?: getString(R.string.connection_failed) }), Toast.LENGTH_SHORT).show()
                    load()
                }
            }
            .show()
    }

    companion object {
        const val EXTRA_ITEM = "item"
    }
}
