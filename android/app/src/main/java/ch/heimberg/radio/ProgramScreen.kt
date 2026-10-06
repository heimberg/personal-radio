package ch.heimberg.radio

import androidx.compose.foundation.ExperimentalFoundationApi
import sh.calvin.reorderable.rememberReorderableLazyListState
import sh.calvin.reorderable.ReorderableItem
import androidx.compose.ui.draw.shadow
import android.view.HapticFeedbackConstants
import androidx.compose.ui.platform.LocalView
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.ui.platform.LocalContext
import androidx.compose.material3.IconButton
import androidx.compose.foundation.clickable
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.combinedClickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.LazyListScope
import androidx.compose.foundation.lazy.LazyRow
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.AssistChip
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.LinearProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.SwipeToDismissBox
import androidx.compose.material3.SwipeToDismissBoxValue
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.pulltorefresh.PullToRefreshBox
import androidx.compose.material3.rememberSwipeToDismissBoxState
import androidx.compose.runtime.Composable
import androidx.compose.runtime.derivedStateOf
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import ch.heimberg.radio.core.BlockView
import ch.heimberg.radio.core.Labels
import ch.heimberg.radio.core.Looks
import ch.heimberg.radio.core.SeriesInfo
import ch.heimberg.radio.core.TimelineItem
import java.time.Instant
import java.time.ZoneId
import java.time.format.DateTimeFormatter
import kotlin.math.roundToInt

private val clock = DateTimeFormatter.ofPattern("HH:mm").withZone(ZoneId.systemDefault())

/**
 * «Programm»: the Sendeplan as one list in the rubrics' colours, with tools to arrange it at the top and
 * one button, «＋ Einfügen», for everything new. Tap: hear it now (or its options); long press: options;
 * swipe to the left: out of the program.
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun ProgramScreen(state: RadioState, actions: RadioActions, padding: PaddingValues) {
    val sections = state.sections
    val context = LocalContext.current
    val view = LocalView.current
    val hints = remember { UiHints(context) }
    var showTip by remember { mutableStateOf(!hints.programSeen) }
    // Drag and drop: the coming items in a local order while a handle is dragged; on release it is saved.
    val coming = listOfNotNull(sections.next) + sections.later
    var order by remember { mutableStateOf(coming) }
    var dragging by remember { mutableStateOf(false) }
    if (!dragging && order.map { it.id } != coming.map { it.id }) order = coming
    val list = rememberLazyListState()
    val reorder = rememberReorderableLazyListState(list) { from, to ->
        val fromAt = order.indexOfFirst { it.id == from.key }
        val toAt = order.indexOfFirst { it.id == to.key }
        if (fromAt >= 0 && toAt >= 0) order = order.toMutableList().apply { add(toAt, removeAt(fromAt)) }
    }
    PullToRefreshBox(isRefreshing = state.refreshing, onRefresh = actions::refresh, modifier = Modifier.fillMaxSize().padding(padding)) {
        LazyColumn(Modifier.fillMaxSize(), state = list, contentPadding = PaddingValues(bottom = 96.dp)) {
            item(key = "head") { ProgramHead(state, actions) }
            if (state.failures.count > 0) item(key = "failures") { Failures(state, actions) }
            val planned = listOfNotNull(sections.now, sections.next) + sections.later
            item(key = "plan-head") { PlanHead(planned) }
            if (state.open.isEmpty()) {
                item(key = "empty") {
                    Text(
                        if (state.loaded) "Noch nichts geplant. «Jetzt planen» startet die Produktion." else "Programm wird geladen …",
                        style = MaterialTheme.typography.bodyMedium, color = Nocturne.muted, modifier = Modifier.padding(20.dp),
                    )
                }
            }
            sections.now?.let { now -> item(key = now.id) { NowRow(now, state, actions) } }
            items(order, key = { it.id }) { item ->
                ReorderableItem(reorder, key = item.id) { moving ->
                    val handle = Modifier.draggableHandle(
                        onDragStarted = { dragging = true; view.performHapticFeedback(HapticFeedbackConstants.GESTURE_START) },
                        onDragStopped = {
                            dragging = false
                            view.performHapticFeedback(HapticFeedbackConstants.GESTURE_END)
                            actions.reorder(listOfNotNull(sections.now?.id) + order.map { it.id })
                        },
                    )
                    SwipeRow(item, state, actions, handle, lifted = moving)
                }
            }
            item(key = "outlook") { Outlook(state) }
            // The gestures are told once; «OK» hides the tip for good.
            if (showTip && state.open.size > 1) {
                item(key = "hint") { Tip("Antippen: sofort hören · ⠿ ziehen: verschieben · lange drücken: mehr · nach links wischen: entfernen") { showTip = false; hints.programSeen = true } }
            }
            val running = state.series.filter { it.active }
            if (running.isNotEmpty()) {
                section("Serien")
                items(running, key = { "series-${it.id}" }) { SeriesRow(it, actions) }
            }
            // Followed topics only when there are some; following one starts from «＋ Einfügen» or a long press.
            if (state.follows.topics.isNotEmpty()) {
                section("Dranbleiben")
                item(key = "follows") { FollowedTopics(state, actions) }
            }
        }
        // Everything new goes in here: blocks, «Für dich», a song, a topic to follow.
        val expanded by remember { derivedStateOf { list.firstVisibleItemIndex == 0 || !list.lastScrolledForward } }
        InsertButton(onClick = { state.catalogOpen = true }, modifier = Modifier.align(Alignment.BottomEnd).padding(16.dp), expanded = expanded)
    }
}

private fun LazyListScope.section(title: String) {
    item(key = "section-$title") {
        Text(title.uppercase(), style = Kicker, color = Nocturne.muted, modifier = Modifier.padding(start = 20.dp, top = 22.dp, bottom = 8.dp))
    }
}

@Composable
private fun ProgramHead(state: RadioState, actions: RadioActions) {
    val ready = state.open.count { it.state == "ready" }
    Column {
        Column(Modifier.padding(start = 20.dp, end = 20.dp, top = 20.dp)) {
            ScreenTitle("Programm")
            Text(listOfNotNull("$ready bereit".takeIf { ready > 0 }, "${state.open.size - ready} in Arbeit".takeIf { state.open.size > ready }).joinToString(" · ").ifEmpty { "Nichts geplant" }, style = MaterialTheme.typography.bodySmall, color = Nocturne.muted)
        }
        LazyRow(contentPadding = PaddingValues(horizontal = 16.dp, vertical = 8.dp), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            item { ToolChip(R.drawable.ic_calendar, "Tagesplan", onClick = actions::openDayPlan) }
            item { ToolChip(R.drawable.ic_shuffle, "Mischen", enabled = state.open.size > 1, onClick = actions::shuffle) }
            item { ToolChip(R.drawable.ic_lightning, "Jetzt planen", onClick = actions::plan) }
        }
    }
}

@Composable
private fun ToolChip(icon: Int, label: String, enabled: Boolean = true, onClick: () -> Unit) {
    AssistChip(onClick = onClick, enabled = enabled, label = { Text(label) },
        leadingIcon = { Icon(painterResource(icon), null, Modifier.size(18.dp), tint = Nocturne.text) })
}

/** «Sendeplan» with a bar of what comes, each rubric as long as its minutes. */
@Composable
private fun PlanHead(planned: List<TimelineItem>) {
    Row(Modifier.fillMaxWidth().padding(start = 20.dp, end = 20.dp, top = 24.dp, bottom = 8.dp), verticalAlignment = Alignment.CenterVertically) {
        Text("SENDEPLAN", style = Kicker, color = Nocturne.muted)
        Spacer(Modifier.width(10.dp))
        Row(Modifier.weight(1f).height(8.dp).clip(RoundedCornerShape(4.dp)), horizontalArrangement = Arrangement.spacedBy(2.dp)) {
            for (item in planned.take(24)) {
                Box(Modifier.weight(item.estimatedMinutes.toFloat().coerceAtLeast(1f)).fillMaxHeight().background(Nocturne.kind(Looks.of(item).kind)))
            }
            if (planned.isEmpty()) Box(Modifier.weight(1f).fillMaxHeight().background(Nocturne.divider))
        }
    }
}

/** Failures as one slim line: a tap shows the details, «Nochmal» retries, ✕ clears them. */
@Composable
private fun Failures(state: RadioState, actions: RadioActions) {
    val failures = state.failures
    val at = failures.latestAt?.let { runCatching { clock.format(Instant.parse(it)) }.getOrNull() }
    val reason = failures.latestError?.let(Labels::error)
    Row(
        Modifier
            .padding(horizontal = 16.dp, vertical = 6.dp)
            .fillMaxWidth()
            .clip(RoundedCornerShape(14.dp))
            .background(Nocturne.danger.copy(alpha = 0.10f))
            .clickable {
                state.detail = (if (failures.count == 1) "1 Beitrag ist fehlgeschlagen." else "${failures.count} Beiträge sind fehlgeschlagen.") + (reason?.let { "\n\nZuletzt${at?.let { " um $it" } ?: ""}: $it" } ?: "") +
                    "\n\n«Nochmal» produziert sie neu, ✕ räumt sie weg."
            }
            .padding(start = 14.dp, end = 2.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Icon(painterResource(R.drawable.ic_warning_circle), null, Modifier.size(16.dp), tint = Nocturne.danger)
        Spacer(Modifier.width(10.dp))
        Text("${failures.count} fehlgeschlagen" + (reason?.let { " · $it" } ?: ""), style = MaterialTheme.typography.bodySmall, color = Nocturne.text,
            maxLines = 1, overflow = TextOverflow.Ellipsis, modifier = Modifier.weight(1f))
        TextButton(onClick = actions::retry) { Text("Nochmal") }
        IconButton(onClick = actions::cleanup) { Icon(painterResource(R.drawable.ic_x), "Aufräumen", Modifier.size(16.dp), tint = Nocturne.muted) }
    }
}

/** A tip shown once, with «OK» to hide it for good. */
@Composable
private fun Tip(text: String, onDone: () -> Unit) {
    Row(Modifier.padding(start = 20.dp, end = 8.dp, top = 8.dp), verticalAlignment = Alignment.CenterVertically) {
        Icon(painterResource(R.drawable.ic_lightbulb), null, Modifier.size(16.dp), tint = Nocturne.muted)
        Spacer(Modifier.width(8.dp))
        Text(text, style = MaterialTheme.typography.bodySmall, color = Nocturne.muted, modifier = Modifier.weight(1f))
        TextButton(onClick = onDone) { Text("OK") }
    }
}

/** Below the list: why it is short and what happens next, so an empty program never looks broken. */
@Composable
private fun Outlook(state: RadioState) {
    if (!state.loaded) return
    val (icon, text) = when {
        state.open.isEmpty() -> return
        !state.playWhenReady -> R.drawable.ic_pause_circle to "Pausiert – das Radio plant weiter, sobald du wieder hörst."
        state.open.count { it.state == "ready" } < state.open.size -> R.drawable.ic_hourglass to "Weitere Beiträge sind in Arbeit und erscheinen hier, sobald sie fertig sind."
        else -> R.drawable.ic_radio to "Das Radio plant laufend nach deinem Tagesplan weiter."
    }
    Row(Modifier.padding(horizontal = 20.dp, vertical = 10.dp), verticalAlignment = Alignment.CenterVertically) {
        Icon(painterResource(icon), null, Modifier.size(16.dp), tint = Nocturne.muted)
        Spacer(Modifier.width(8.dp))
        Text(text, style = MaterialTheme.typography.bodySmall, color = Nocturne.muted)
    }
}

/** A running series: its title, how far it is and the next episode; «Beenden» asks first. */
@Composable
private fun SeriesRow(series: SeriesInfo, actions: RadioActions) {
    var confirm by remember { mutableStateOf(false) }
    val look = Looks.ofBlock(BlockView(id = if (series.story) "geschichte" else "serie", name = series.title, description = ""))
    Row(
        Modifier
            .padding(horizontal = 16.dp, vertical = 4.dp)
            .fillMaxWidth()
            .clip(RoundedCornerShape(16.dp))
            .background(Nocturne.surface)
            .padding(start = 12.dp, top = 10.dp, bottom = 10.dp, end = 4.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        KindBadge(look.icon, look.kind, 40.dp)
        Spacer(Modifier.width(12.dp))
        Column(Modifier.weight(1f)) {
            Text(series.title, style = MaterialTheme.typography.titleSmall, maxLines = 1, overflow = TextOverflow.Ellipsis)
            val current = series.episodes.getOrNull((series.scheduled - 1).coerceAtLeast(0))
            Text(series.progress + (current?.let { " · «$it»" } ?: ""), style = MaterialTheme.typography.bodySmall, color = Nocturne.muted, maxLines = 1, overflow = TextOverflow.Ellipsis)
        }
        TextButton(onClick = { confirm = true }) { Text("Beenden") }
    }
    if (confirm) {
        AlertDialog(
            onDismissRequest = { confirm = false },
            title = { Text("«${series.title}» beenden?") },
            text = { Text("Es kommen keine weiteren Folgen, und die nächste geplante Folge verschwindet aus dem Programm. Gehörte Folgen bleiben im Archiv.") },
            confirmButton = { TextButton(onClick = { confirm = false; actions.stopSeries(series) }) { Text("Beenden") } },
            dismissButton = { TextButton(onClick = { confirm = false }) { Text("Weiterhören") } },
        )
    }
}

/** The playing item: its time in red, «läuft» or «pausiert», and its progress. */
@Composable
private fun NowRow(item: TimelineItem, state: RadioState, actions: RadioActions) {
    Box(Modifier.padding(horizontal = 16.dp, vertical = 4.dp)) {
        ItemRow(item, state.starts[item.id], onTap = { state.tab = Tab.LISTEN }, onLongPress = { state.actionsFor = item }, live = true,
            progress = state.progress, liveLabel = if (state.playWhenReady) "läuft" else "pausiert")
    }
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun SwipeRow(item: TimelineItem, state: RadioState, actions: RadioActions, handle: Modifier, lifted: Boolean) {
    val swipe = rememberSwipeToDismissBoxState(confirmValueChange = { value ->
        if (value == SwipeToDismissBoxValue.EndToStart) {
            actions.remove(item)
            true
        } else false
    })
    SwipeToDismissBox(
        state = swipe,
        enableDismissFromStartToEnd = false,
        modifier = Modifier.padding(horizontal = 16.dp, vertical = 4.dp),
        backgroundContent = {
            Box(
                Modifier.fillMaxSize().clip(RoundedCornerShape(16.dp)).background(Nocturne.danger.copy(alpha = 0.18f)).padding(horizontal = 20.dp),
                contentAlignment = Alignment.CenterEnd,
            ) { Text("Entfernen", style = MaterialTheme.typography.labelLarge, color = Nocturne.danger) }
        },
    ) {
        ItemRow(item, state.starts[item.id], onTap = { if (item.isPlayable) actions.play(item) else state.actionsFor = item }, onLongPress = { state.actionsFor = item },
            handle = handle, lifted = lifted)
    }
}

/**
 * One row of the program or the archive: the time big, the rubric as a bar as long as the item, its name,
 * the title and what it is. [live]: what plays now, with its [progress].
 */
@OptIn(ExperimentalFoundationApi::class)
@Composable
fun ItemRow(
    item: TimelineItem, start: Instant?, onTap: () -> Unit, onLongPress: () -> Unit,
    timeLabel: String? = null, live: Boolean = false, progress: Float? = null, liveLabel: String = "läuft",
    handle: Modifier? = null, lifted: Boolean = false,
) {
    val look = Looks.of(item)
    val color = Nocturne.kind(look.kind)
    Column(
        Modifier
            .fillMaxWidth()
            .then(if (lifted) Modifier.shadow(8.dp, RoundedCornerShape(16.dp)) else Modifier)
            .clip(RoundedCornerShape(16.dp))
            .background(Nocturne.surface)
            .then(if (live) Modifier.border(2.dp, color, RoundedCornerShape(16.dp)) else Modifier)
            .combinedClickable(onClick = onTap, onLongClick = onLongPress)
            .padding(start = 12.dp, end = 10.dp, top = 10.dp, bottom = 10.dp),
    ) {
        Row(verticalAlignment = Alignment.Top) {
            // At least the width of «23:45»; with large system fonts the column grows instead of cutting the time.
            Column(Modifier.widthIn(min = 58.dp)) {
                Text(timeLabel ?: start?.let(clock::format) ?: "", style = display(22), color = if (live) Nocturne.live else Nocturne.text, maxLines = 1, softWrap = false)
                Text(if (live) liveLabel else if (item.state == "ready") "" else ch.heimberg.radio.core.ProductionStages.SPOKEN.firstOrNull { it.wire == item.stage }?.label ?: Labels.state(item.state), style = MaterialTheme.typography.labelSmall, color = Nocturne.muted, maxLines = 1, modifier = Modifier.padding(top = 3.dp))
            }
            val barHeight = (14 + item.estimatedMinutes * 4).toInt().coerceIn(30, 84).dp
            Spacer(Modifier.width(4.dp))
            Box(Modifier.width(6.dp).height(barHeight).background(color, RoundedCornerShape(3.dp)))
            Spacer(Modifier.width(12.dp))
            Column(Modifier.weight(1f)) {
                RubricLabel(look.kind)
                Text(item.displayTitle, style = MaterialTheme.typography.titleSmall, color = Nocturne.text, maxLines = 2, overflow = TextOverflow.Ellipsis)
                Text(meta(item), style = MaterialTheme.typography.bodySmall, color = Nocturne.muted, maxLines = 1, overflow = TextOverflow.Ellipsis)
                item.error?.let { Text(Labels.error(it), style = MaterialTheme.typography.bodySmall, color = Nocturne.danger, maxLines = 2) }
            }
            item.coverUrl?.let {
                Spacer(Modifier.width(8.dp))
                Cover(look, it, 40.dp)
            }
            Spacer(Modifier.width(6.dp))
            Column(horizontalAlignment = Alignment.CenterHorizontally) {
                StateIcon(item)
                // The handle reacts on touch: drag it to move the item.
                if (handle != null) {
                    Box(handle.padding(top = 6.dp).size(36.dp), contentAlignment = Alignment.Center) {
                        Icon(painterResource(R.drawable.ic_dots_six), "Verschieben", Modifier.size(22.dp), tint = Nocturne.faint)
                    }
                }
            }
        }
        if (progress != null) {
            Spacer(Modifier.height(10.dp))
            LinearProgressIndicator(
                progress = { progress }, color = color, trackColor = Nocturne.divider, drawStopIndicator = {},
                modifier = Modifier.fillMaxWidth().height(4.dp).clip(RoundedCornerShape(2.dp)),
            )
        }
    }
}

@Composable
private fun StateIcon(item: TimelineItem) {
    val (icon, color) = when {
        item.isPlayable || (!item.isOpen && item.hasAudio) -> R.drawable.ic_play to Nocturne.text
        item.state == "voicing" -> R.drawable.ic_waveform to Nocturne.accentLight
        item.state == "ready" -> R.drawable.ic_check_circle to Nocturne.text
        else -> R.drawable.ic_clock to Nocturne.faint
    }
    Icon(painterResource(icon), Labels.state(item.state), Modifier.size(18.dp), tint = color)
}

private fun meta(item: TimelineItem): String {
    val tracks = item.parts.count { it.isTrack }.takeIf { it > 0 }?.let { " · $it Songs" } ?: ""
    val surprise = if (item.surprise) " · 🎲" else ""
    val shared = item.sharedBy?.let { " · von $it" } ?: ""
    val minutes = item.estimatedMinutes.roundToInt().takeIf { it > 0 }?.let { " · $it Min." } ?: ""
    return "${item.showName}$minutes$tracks$surprise$shared"
}
