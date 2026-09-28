package ch.heimberg.radio

import android.content.res.ColorStateList
import android.view.LayoutInflater
import android.view.View
import android.view.ViewGroup
import android.widget.ImageView
import android.widget.TextView
import androidx.core.content.ContextCompat
import ch.heimberg.radio.core.Labels
import ch.heimberg.radio.core.TimelineItem

/**
 * One row of the program list or the archive: time, title, show, state and Spotify songs. A row with
 * [onPlay] can be tapped to hear the item right away.
 */
object TimelineRows {
    fun inflate(inflater: LayoutInflater, parent: ViewGroup, item: TimelineItem, time: String, playing: Boolean, onPlay: ((TimelineItem) -> Unit)?): View {
        val row = inflater.inflate(R.layout.item_timeline, parent, false)
        val context = row.context
        val accent = ContextCompat.getColor(context, R.color.accent_300)
        row.findViewById<TextView>(R.id.time).text = time
        row.findViewById<TextView>(R.id.title).apply {
            text = item.displayTitle
            if (playing) setTextColor(accent)
        }
        val tracks = item.parts.count { it.isTrack }.takeIf { it > 0 }?.let { " · " + context.getString(R.string.spotify_tracks, it) } ?: ""
        row.findViewById<TextView>(R.id.meta).text = "${item.showName} · ${Labels.state(item.state)}$tracks"
        item.error?.let { error ->
            row.findViewById<TextView>(R.id.error).apply {
                text = Labels.error(error)
                visibility = View.VISIBLE
            }
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
            if (playing || onPlay != null || item.state == "ready") imageTintList = ColorStateList.valueOf(accent)
        }
        if (onPlay != null) {
            row.contentDescription = context.getString(R.string.play_item, item.displayTitle)
            row.setOnClickListener { onPlay(item) }
        }
        return row
    }
}
