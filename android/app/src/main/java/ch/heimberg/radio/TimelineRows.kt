package ch.heimberg.radio

import android.content.res.ColorStateList
import android.view.LayoutInflater
import android.view.View
import android.view.ViewGroup
import android.widget.ImageView
import android.widget.TextView
import androidx.core.content.ContextCompat
import ch.heimberg.radio.core.Labels
import ch.heimberg.radio.core.Looks
import ch.heimberg.radio.core.TimelineItem

/**
 * One row of the program list or the archive: time, title, show, state and Spotify songs. A row with
 * [onPlay] can be tapped to hear the item right away. [bind] resets everything, so recycled rows are clean.
 */
object TimelineRows {
    fun inflate(inflater: LayoutInflater, parent: ViewGroup, item: TimelineItem, time: String, playing: Boolean, onPlay: ((TimelineItem) -> Unit)?): View =
        inflater.inflate(R.layout.item_timeline, parent, false).also { bind(it, item, time, playing, onPlay) }

    fun bind(row: View, item: TimelineItem, time: String, playing: Boolean, onPlay: ((TimelineItem) -> Unit)?) {
        val context = row.context
        val accent = ContextCompat.getColor(context, R.color.accent_300)
        row.findViewById<TextView>(R.id.time).text = time
        val look = Looks.of(item)
        row.findViewById<View>(R.id.kind_bar).setBackgroundColor(KindStyle.color(look.kind, context))
        row.findViewById<TextView>(R.id.kind_icon).apply {
            text = look.icon
            background = KindStyle.badge(context, look.kind, cornerDp = 15f)
        }
        row.findViewById<TextView>(R.id.kind_label).apply {
            text = look.kind.label
            setTextColor(KindStyle.label(context, look.kind))
        }
        row.findViewById<TextView>(R.id.title).apply {
            text = item.displayTitle
            setTextColor(if (playing) accent else ContextCompat.getColor(context, R.color.text))
        }
        val tracks = item.parts.count { it.isTrack }.takeIf { it > 0 }?.let { " · " + context.getString(R.string.spotify_tracks, it) } ?: ""
        row.findViewById<TextView>(R.id.meta).text = "${item.showName} · ${Labels.state(item.state)}$tracks"
        row.findViewById<TextView>(R.id.error).apply {
            text = item.error?.let(Labels::error) ?: ""
            visibility = if (item.error != null) View.VISIBLE else View.GONE
        }
        row.findViewById<ImageView>(R.id.state).apply {
            setImageResource(
                when {
                    playing -> R.drawable.ic_waveform
                    onPlay != null -> R.drawable.ic_play
                    item.state == "ready" -> R.drawable.ic_check_circle
                    item.state == "voicing" -> R.drawable.ic_waveform
                    else -> R.drawable.ic_clock
                },
            )
            val highlighted = playing || onPlay != null || item.state == "ready"
            imageTintList = ColorStateList.valueOf(ContextCompat.getColor(context, if (highlighted) R.color.accent_300 else R.color.neutral_500))
        }
        if (onPlay != null) {
            row.contentDescription = context.getString(R.string.play_item, item.displayTitle)
            row.setOnClickListener { onPlay(item) }
        } else {
            row.contentDescription = null
            row.setOnClickListener(null)
            row.isClickable = false
        }
    }
}
