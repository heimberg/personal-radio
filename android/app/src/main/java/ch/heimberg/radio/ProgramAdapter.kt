package ch.heimberg.radio

import android.annotation.SuppressLint
import android.view.LayoutInflater
import android.view.MotionEvent
import android.view.View
import android.view.ViewGroup
import androidx.recyclerview.widget.ItemTouchHelper
import androidx.recyclerview.widget.RecyclerView
import ch.heimberg.radio.core.ProgramClock
import ch.heimberg.radio.core.TimelineItem
import java.time.Instant
import java.time.ZoneId
import java.time.format.DateTimeFormatter

/**
 * The program list: the playing item first, then what comes next. Rows are moved with the finger on
 * their handle; the playing item stays in place. Start times are computed from now on, so they always
 * say when an item would begin if playback went on.
 */
class ProgramAdapter(
    private val onPlay: (TimelineItem) -> Unit,
    /** Called once when a drag ends with a new order. */
    private val onArranged: (List<TimelineItem>) -> Unit,
) : RecyclerView.Adapter<ProgramAdapter.Row>() {
    class Row(view: View) : RecyclerView.ViewHolder(view)

    var items: List<TimelineItem> = emptyList()
        private set
    private var currentId: String? = null
    private var starts: Map<String, Instant> = emptyMap()
    private var dragging = false
    private var orderBeforeDrag: List<String>? = null
    private var lastRemainingMs: Long? = null
    private val time = DateTimeFormatter.ofPattern("HH:mm").withZone(ZoneId.systemDefault())

    /** True while the owner moves a row; the list is not replaced from the server meanwhile. */
    val busy: Boolean get() = dragging

    val touchHelper = ItemTouchHelper(object : ItemTouchHelper.SimpleCallback(ItemTouchHelper.UP or ItemTouchHelper.DOWN, 0) {
        override fun getMovementFlags(recyclerView: RecyclerView, holder: RecyclerView.ViewHolder): Int =
            if (items.getOrNull(holder.bindingAdapterPosition)?.id == currentId) 0 else super.getMovementFlags(recyclerView, holder)

        override fun onMove(recyclerView: RecyclerView, from: RecyclerView.ViewHolder, to: RecyclerView.ViewHolder): Boolean {
            val moved = ProgramClock.move(items, from.bindingAdapterPosition, to.bindingAdapterPosition, currentId)
            if (moved === items) return false
            items = moved
            notifyItemMoved(from.bindingAdapterPosition, to.bindingAdapterPosition)
            return true
        }

        override fun onSelectedChanged(holder: RecyclerView.ViewHolder?, actionState: Int) {
            super.onSelectedChanged(holder, actionState)
            if (actionState == ItemTouchHelper.ACTION_STATE_DRAG) {
                dragging = true
                orderBeforeDrag = items.map { it.id }
            }
        }

        override fun clearView(recyclerView: RecyclerView, holder: RecyclerView.ViewHolder) {
            super.clearView(recyclerView, holder)
            dragging = false
            val changed = orderBeforeDrag != null && orderBeforeDrag != items.map { it.id }
            orderBeforeDrag = null
            if (changed) {
                // Times follow the new order right away; the server confirms it.
                recyclerView.post { refreshTimes(lastRemainingMs) }
                onArranged(items)
            }
        }

        override fun onSwiped(holder: RecyclerView.ViewHolder, direction: Int) = Unit
        override fun isLongPressDragEnabled() = true
    })

    /** New items from the server, in playing order; ignored while a row is being moved. */
    @SuppressLint("NotifyDataSetChanged")
    fun submit(program: List<TimelineItem>, playing: String?, remainingMs: Long?) {
        if (dragging) return
        currentId = playing
        items = ProgramClock.playingOrder(program, playing)
        lastRemainingMs = remainingMs
        starts = ProgramClock.startTimes(items, Instant.now(), currentId, remainingMs)
        notifyDataSetChanged()
    }

    /** Recomputes the start times from now (called every minute and after a move). */
    @SuppressLint("NotifyDataSetChanged")
    fun refreshTimes(remainingMs: Long?) {
        if (dragging) return
        lastRemainingMs = remainingMs
        starts = ProgramClock.startTimes(items, Instant.now(), currentId, remainingMs)
        notifyDataSetChanged()
    }

    override fun getItemCount() = items.size

    override fun onCreateViewHolder(parent: ViewGroup, viewType: Int) =
        Row(LayoutInflater.from(parent.context).inflate(R.layout.item_timeline, parent, false))

    @SuppressLint("ClickableViewAccessibility")
    override fun onBindViewHolder(holder: Row, position: Int) {
        val item = items[position]
        val playing = item.id == currentId
        val label = if (playing) holder.itemView.context.getString(R.string.now_playing_short) else starts[item.id]?.let(time::format) ?: ""
        TimelineRows.bind(holder.itemView, item, label, playing, if (item.isPlayable && !playing) onPlay else null)
        holder.itemView.findViewById<View>(R.id.handle).apply {
            visibility = if (playing) View.INVISIBLE else View.VISIBLE
            setOnTouchListener { _, event ->
                if (event.actionMasked == MotionEvent.ACTION_DOWN) touchHelper.startDrag(holder)
                false
            }
        }
    }
}
