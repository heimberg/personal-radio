package ch.heimberg.radio

import androidx.compose.foundation.ExperimentalFoundationApi
import androidx.compose.foundation.background
import androidx.compose.foundation.combinedClickable
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
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
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import ch.heimberg.radio.core.BlockView
import ch.heimberg.radio.core.Labels
import ch.heimberg.radio.core.Looks
import ch.heimberg.radio.core.TimelineItem
import java.time.Instant
import java.time.ZoneId
import java.time.format.DateTimeFormatter

private val clock = DateTimeFormatter.ofPattern("HH:mm").withZone(ZoneId.systemDefault())

/**
 * «Programm»: the building blocks to insert, then «Jetzt · Gleich · Später». Tap: hear it now (or its options); long press: options;
 * swipe to the left: out of the program.
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun ProgramScreen(state: RadioState, actions: RadioActions, padding: PaddingValues) {
    val sections = state.sections
    PullToRefreshBox(isRefreshing = state.refreshing, onRefresh = actions::refresh, modifier = Modifier.fillMaxSize().padding(padding)) {
        LazyColumn(Modifier.fillMaxSize(), contentPadding = PaddingValues(bottom = 24.dp)) {
            item(key = "head") { ProgramHead(state, actions) }
            if (state.blocks.isNotEmpty()) item(key = "blocks") { Blocks(state.blocks, actions) }
            if (state.failures.count > 0) item(key = "failures") { Failures(state, actions) }
            if (state.open.isEmpty()) {
                item(key = "empty") {
                    Text(
                        if (state.loaded) "Noch nichts geplant. «Jetzt planen» startet die Produktion." else "Programm wird geladen …",
                        style = MaterialTheme.typography.bodyMedium, color = Nocturne.muted, modifier = Modifier.padding(20.dp),
                    )
                }
            }
            sections.now?.let { now ->
                section("Jetzt")
                item(key = now.id) { NowRow(now, state) }
            }
            sections.next?.let { next ->
                section("Gleich")
                item(key = next.id) { SwipeRow(next, state, actions) }
            }
            if (sections.later.isNotEmpty()) {
                section("Später")
                items(sections.later, key = { it.id }) { SwipeRow(it, state, actions) }
            }
            if (state.open.size > 1) {
                item(key = "hint") {
                    Text(
                        "Antippen: sofort hören · lange drücken: verschieben und mehr · nach links wischen: entfernen",
                        style = MaterialTheme.typography.bodySmall, color = Nocturne.faint, modifier = Modifier.padding(20.dp),
                    )
                }
            }
        }
    }
}

private fun LazyListScope.section(title: String) {
    item(key = "section-$title") {
        Text(title.uppercase(), style = MaterialTheme.typography.labelSmall, color = Nocturne.accentLight, modifier = Modifier.padding(start = 20.dp, top = 18.dp, bottom = 6.dp))
    }
}

@Composable
private fun ProgramHead(state: RadioState, actions: RadioActions) {
    val ready = state.open.count { it.state == "ready" }
    Column {
        Column(Modifier.padding(start = 20.dp, end = 20.dp, top = 18.dp)) {
            Text("Programm", style = MaterialTheme.typography.headlineSmall)
            Text("$ready bereit · ${state.open.size} geplant", style = MaterialTheme.typography.bodySmall, color = Nocturne.muted)
        }
        LazyRow(contentPadding = PaddingValues(horizontal = 16.dp, vertical = 10.dp), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            item { AssistChip(onClick = actions::openDayPlan, label = { Text("🗓  Tagesplan") }) }
            item { AssistChip(onClick = actions::shuffle, label = { Text("🔀  Mischen") }, enabled = state.open.size > 1) }
            item { AssistChip(onClick = actions::addSong, label = { Text("♫  Song anhängen") }) }
            item { AssistChip(onClick = actions::plan, label = { Text("⚡  Jetzt planen") }) }
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

/** The playing item: highlighted, with its progress. */
@Composable
private fun NowRow(item: TimelineItem, state: RadioState) {
    val look = Looks.of(item)
    Column(
        Modifier
            .padding(horizontal = 16.dp, vertical = 4.dp)
            .fillMaxWidth()
            .kindTile(look.kind, RoundedCornerShape(18.dp), glow = 0.35f)
            .padding(14.dp),
    ) {
        Row(verticalAlignment = Alignment.CenterVertically) {
            Cover(look, state.coverUrl.takeIf { item.id == state.currentItemId } ?: item.coverUrl, 48.dp)
            Spacer(Modifier.width(12.dp))
            Column(Modifier.weight(1f)) {
                Text(item.displayTitle, style = MaterialTheme.typography.titleSmall, maxLines = 2, overflow = TextOverflow.Ellipsis)
                Text(meta(item), style = MaterialTheme.typography.bodySmall, color = Nocturne.muted, maxLines = 1, overflow = TextOverflow.Ellipsis)
            }
        }
        Spacer(Modifier.height(10.dp))
        LinearProgressIndicator(
            progress = { state.progress }, color = Nocturne.kind(look.kind), trackColor = Nocturne.faint.copy(alpha = 0.4f),
            modifier = Modifier.fillMaxWidth().height(3.dp).clip(RoundedCornerShape(2.dp)),
        )
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
                Modifier.fillMaxSize().clip(RoundedCornerShape(18.dp)).background(Nocturne.danger.copy(alpha = 0.25f)).padding(horizontal = 20.dp),
                contentAlignment = Alignment.CenterEnd,
            ) { Text("Entfernen", style = MaterialTheme.typography.labelLarge, color = Nocturne.danger) }
        },
    ) { ItemRow(item, state.starts[item.id], onTap = { if (item.isPlayable) actions.play(item) else state.actionsFor = item }, onLongPress = { state.actionsFor = item }) }
}

/** One row of the program or the archive: time, kind, title, show and state. */
@OptIn(ExperimentalFoundationApi::class)
@Composable
fun ItemRow(item: TimelineItem, start: Instant?, onTap: () -> Unit, onLongPress: () -> Unit, timeLabel: String? = null) {
    val look = Looks.of(item)
    Row(
        Modifier
            .fillMaxWidth()
            .clip(RoundedCornerShape(18.dp))
            .background(Nocturne.surface)
            .combinedClickable(onClick = onTap, onLongClick = onLongPress)
            .padding(horizontal = 12.dp, vertical = 12.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Box(Modifier.width(3.dp).height(40.dp).background(Nocturne.kind(look.kind), RoundedCornerShape(2.dp)))
        Spacer(Modifier.width(10.dp))
        Text(timeLabel ?: start?.let(clock::format) ?: "", style = MaterialTheme.typography.labelMedium, color = Nocturne.text, modifier = Modifier.width(42.dp))
        Cover(look, item.coverUrl, 40.dp)
        Spacer(Modifier.width(10.dp))
        Column(Modifier.weight(1f)) {
            Text(look.kind.label.uppercase(), style = MaterialTheme.typography.labelSmall, color = Nocturne.kindLabel(look.kind))
            Text(item.displayTitle, style = MaterialTheme.typography.titleSmall, maxLines = 2, overflow = TextOverflow.Ellipsis)
            Text(meta(item), style = MaterialTheme.typography.bodySmall, color = Nocturne.muted, maxLines = 1, overflow = TextOverflow.Ellipsis)
            item.error?.let { Text(Labels.error(it), style = MaterialTheme.typography.bodySmall, color = Nocturne.danger, maxLines = 2) }
        }
        Spacer(Modifier.width(6.dp))
        StateIcon(item)
    }
}

@Composable
private fun StateIcon(item: TimelineItem) {
    val (icon, color) = when {
        item.isPlayable || (!item.isOpen && item.hasAudio) -> R.drawable.ic_play to Nocturne.accentLight
        item.state == "voicing" -> R.drawable.ic_waveform to Nocturne.accentLight
        item.state == "ready" -> R.drawable.ic_check_circle to Nocturne.accentLight
        else -> R.drawable.ic_clock to Nocturne.faint
    }
    Icon(painterResource(icon), Labels.state(item.state), Modifier.size(18.dp), tint = color)
}

private fun meta(item: TimelineItem): String {
    val tracks = item.parts.count { it.isTrack }.takeIf { it > 0 }?.let { " · $it Songs" } ?: ""
    val surprise = if (item.surprise) " · 🎲" else ""
    return "${item.showName} · ${Labels.state(item.state)}$tracks$surprise"
}

/** The building blocks: one tap puts one next into the program. */
@Composable
private fun Blocks(blocks: List<BlockView>, actions: RadioActions) {
    if (blocks.isEmpty()) return
    Text("Einfügen", style = MaterialTheme.typography.titleMedium, modifier = Modifier.padding(start = 20.dp, top = 8.dp))
    Text("Antippen – kommt als Nächstes.", style = MaterialTheme.typography.bodySmall, color = Nocturne.muted, modifier = Modifier.padding(start = 20.dp, bottom = 8.dp))
    LazyRow(contentPadding = PaddingValues(horizontal = 16.dp), horizontalArrangement = Arrangement.spacedBy(10.dp)) {
        items(blocks, key = { it.id }) { block ->
            val look = Looks.ofBlock(block)
            Column(
                Modifier
                    .width(148.dp)
                    .height(132.dp)
                    .clip(RoundedCornerShape(18.dp))
                    .kindTile(look.kind, RoundedCornerShape(18.dp))
                    .clickable { actions.chooseBlock(block) }
                    .padding(12.dp),
            ) {
                KindBadge(look.icon, look.kind)
                Spacer(Modifier.height(8.dp))
                Text(if (block.music) "${block.name} ♫" else block.name, style = MaterialTheme.typography.titleSmall, maxLines = 1, overflow = TextOverflow.Ellipsis)
                Text(block.description, style = MaterialTheme.typography.bodySmall, color = Nocturne.muted, maxLines = 2, overflow = TextOverflow.Ellipsis)
            }
        }
    }
}
