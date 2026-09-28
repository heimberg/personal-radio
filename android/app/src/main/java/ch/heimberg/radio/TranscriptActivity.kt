package ch.heimberg.radio

import android.content.Context
import android.content.Intent
import android.graphics.Typeface
import android.net.Uri
import android.os.Bundle
import android.text.SpannableStringBuilder
import android.text.style.StyleSpan
import android.widget.Button
import android.widget.LinearLayout
import android.widget.TextView
import androidx.appcompat.app.AppCompatActivity
import androidx.core.content.ContextCompat
import androidx.core.text.inSpans
import androidx.lifecycle.lifecycleScope
import androidx.swiperefreshlayout.widget.SwipeRefreshLayout
import kotlinx.coroutines.launch

/** Reading along: the text of an item (dialogs by speaker, hours with their songs) and its sources as links. */
class TranscriptActivity : AppCompatActivity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        val connection = RadioSettings(this).connection() ?: run { finish(); return }
        val itemId = intent.getStringExtra(EXTRA_ITEM_ID) ?: run { finish(); return }
        setContentView(R.layout.activity_transcript)
        findViewById<Button>(R.id.back).setOnClickListener { finish() }
        findViewById<TextView>(R.id.title).text = intent.getStringExtra(EXTRA_TITLE) ?: ""
        val refresh = findViewById<SwipeRefreshLayout>(R.id.refresh)
        val load = {
            lifecycleScope.launch {
                show(runCatching { ApiClient(connection).transcript(itemId) })
                refresh.isRefreshing = false
            }
        }
        refresh.setColorSchemeResources(R.color.accent)
        refresh.setOnRefreshListener { load() }
        load()
    }

    private fun show(result: Result<ch.heimberg.radio.core.Transcript>) {
        val status = findViewById<TextView>(R.id.status)
        val lines = findViewById<LinearLayout>(R.id.lines)
        val sources = findViewById<LinearLayout>(R.id.sources)
        val transcript = result.getOrElse {
            status.text = it.message ?: getString(R.string.connection_failed)
            return
        }
        findViewById<TextView>(R.id.title).text = transcript.title
        status.text = if (transcript.lines.isEmpty()) getString(R.string.transcript_empty) else ""
        lines.removeAllViews()
        sources.removeAllViews()
        val space = resources.getDimensionPixelSize(R.dimen.space_3)
        for (line in transcript.lines) {
            lines.addView(TextView(this, null, 0, R.style.Widget_PersonalRadio_Text_Reading).apply {
                setPadding(0, space, 0, 0)
                text = when {
                    line.song -> "♪  ${line.text}".also { setTextColor(ContextCompat.getColor(context, R.color.accent_300)) }
                    line.speaker != null -> SpannableStringBuilder().inSpans(StyleSpan(Typeface.BOLD)) { append("${line.speaker}: ") }.append(line.text)
                    else -> line.text
                }
            })
        }
        findViewById<TextView>(R.id.sources_heading).visibility = if (transcript.sources.isEmpty()) android.view.View.GONE else android.view.View.VISIBLE
        for (source in transcript.sources) {
            val uri = Uri.parse(source.url)
            sources.addView(TextView(this, null, 0, R.style.Widget_PersonalRadio_Text_Reading).apply {
                setPadding(0, space, 0, 0)
                text = "${source.title.ifBlank { uri.host ?: source.url }}\n${uri.host ?: ""}"
                setTextColor(ContextCompat.getColor(context, R.color.accent_300))
                // Only web links open, in the browser.
                if (uri.scheme == "https") setOnClickListener { startActivity(Intent(Intent.ACTION_VIEW, uri)) }
            })
        }
    }

    companion object {
        private const val EXTRA_ITEM_ID = "itemId"
        private const val EXTRA_TITLE = "title"

        fun open(context: Context, itemId: String, title: String) {
            context.startActivity(Intent(context, TranscriptActivity::class.java).putExtra(EXTRA_ITEM_ID, itemId).putExtra(EXTRA_TITLE, title))
        }
    }
}
