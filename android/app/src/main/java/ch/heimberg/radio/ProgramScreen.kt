package ch.heimberg.radio

import androidx.compose.foundation.ExperimentalFoundationApi
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
    PullToRefreshBox(isRefreshing = state.refreshing, onRefresh = actions::refresh, modifier = Modifier.fillMaxSize().padding(padding)) {
        LazyColumn(Modifier.fillMaxSize(), contentPadding = PaddingValues(bottom = 96.dp)) {
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
            sections.next?.let { next -> item(key = next.id) { SwipeRow(next, state, actions) } }
            items(sections.later, key = { it.id }) { SwipeRow(it, state, actions) }
            if (state.open.size > 1) {
                item(key = "hint") {
                    Text(
                        "Antippen: sofort hören · lange drücken: verschieben und mehr · nach links wischen: entfernen (rückgängig machbar)",
                        style = MaterialTheme.typography.bodySmall, color = Nocturne.faint, modifier = Modifier.padding(horizontal = 20.dp, vertical = 12.dp),
                    )
                }
            }
            val running = state.series.filter { it.active }
            if (running.isNotEmpty()) {
                section("Serien")
                items(running, key = { "series-${it.id}" }) { SeriesRow(it, actions) }
            }
            section("Dranbleiben")
            item(key = "follows") { FollowedTopics(state, actions) }
        }
        // Everything new goes in here: blocks, «Für dich», a song, a topic to follow.
        InsertButton(onClick = { state.catalogOpen = true }, modifier = Modifier.align(Alignment.BottomEnd).padding(16.dp))
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
            Text("$ready bereit · ${state.open.size} geplant", style = MaterialTheme.typography.bodySmall, color = Nocturne.muted)
        }
        LazyRow(contentPadding = PaddingValues(horizontal = 16.dp, vertical = 8.dp), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            item { AssistChip(onClick = actions::openDayPlan, label = { Text("🗓  Tagesplan") }) }
            item { AssistChip(onClick = actions::shuffle, label = { Text("🔀  Mischen") }, enabled = state.open.size > 1) }
            item { AssistChip(onClick = actions::plan, label = { Text("⚡  Jetzt planen") }) }
        }
    }
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

@Composable
private fun Failures(state: RadioState, actions: RadioActions) {
    val failures = state.failures
    val latest = failures.latestError?.let { error ->
        " · zuletzt " + (failures.latestAt?.let { runCatching { clock.format(Instant.parse(it)) + ": " }.getOrNull() } ?: "") + Labels.error(error)
    } ?: ""
    Banner("⚠ ${failures.count} fehlgeschlagen$latest", Nocturne.danger) {
        Row {
            TextButton(onClick = actions::retry) { Text("Erneut versuchen") }
            TextButton(onClick = actions::cleanup) { Text("Aufräumen") }
        }
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

/** The playing item: its time in red, «läuft», and its progress. */
@Composable
private fun NowRow(item: TimelineItem, state: RadioState, actions: RadioActions) {
    Box(Modifier.padding(horizontal = 16.dp, vertical = 4.dp)) {
        ItemRow(item, state.starts[item.id], onTap = { state.tab = Tab.LISTEN }, onLongPress = { state.actionsFor = item }, live = true, progress = state.progress)
    }
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun SwipeRow(item: TimelineItem, state: RadioState, actions: RadioActions) {
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
    ) { ItemRow(item, state.starts[item.id], onTap = { if (item.isPlayable) actions.play(item) else state.actionsFor = item }, onLongPress = { state.actionsFor = item }) }
}

/**
 * One row of the program or the archive: the time big, the rubric as a bar as long as the item, its name,
 * the title and what it is. [live]: what plays now, with its [progress].
 */
@OptIn(ExperimentalFoundationApi::class)
@Composable
fun ItemRow(
    item: TimelineItem, start: Instant?, onTap: () -> Unit, onLongPress: () -> Unit,
    timeLabel: String? = null, live: Boolean = false, progress: Float? = null,
) {
    val look = Looks.of(item)
    val color = Nocturne.kind(look.kind)
    Column(
        Modifier
            .fillMaxWidth()
            .clip(RoundedCornerShape(16.dp))
            .background(Nocturne.surface)
            .then(if (live) Modifier.border(2.dp, color, RoundedCornerShape(16.dp)) else Modifier)
            .combinedClickable(onClick = onTap, onLongClick = onLongPress)
            .padding(start = 12.dp, end = 10.dp, top = 10.dp, bottom = 10.dp),
    ) {
        Row(verticalAlignment = Alignment.Top) {
            Column(Modifier.width(58.dp)) {
                Text(timeLabel ?: start?.let(clock::format) ?: "", style = display(22), color = if (live) Nocturne.live else Nocturne.text, maxLines = 1)
                Text(if (live) "läuft" else Labels.state(item.state), style = MaterialTheme.typography.labelSmall, color = Nocturne.muted, maxLines = 1, modifier = Modifier.padding(top = 3.dp))
            }
            val barHeight = (14 + item.estimatedMinutes * 4).toInt().coerceIn(30, 84).dp
            Box(Modifier.width(6.dp).height(barHeight).background(color, RoundedCornerShape(3.dp)))
            Spacer(Modifier.width(12.dp))
            Column(Modifier.weight(1f)) {
                RubricLabel(look.kind)
                Text(item.displayTitle, style = MaterialTheme.typography.titleSmall, maxLines = 2, overflow = TextOverflow.Ellipsis)
                Text(meta(item), style = MaterialTheme.typography.bodySmall, color = Nocturne.muted, maxLines = 1, overflow = TextOverflow.Ellipsis)
                item.error?.let { Text(Labels.error(it), style = MaterialTheme.typography.bodySmall, color = Nocturne.danger, maxLines = 2) }
            }
            item.coverUrl?.let {
                Spacer(Modifier.width(8.dp))
                Cover(look, it, 40.dp)
            }
            Spacer(Modifier.width(6.dp))
            StateIcon(item)
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
