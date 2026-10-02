package ch.heimberg.radio

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.FilterChip
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.pulltorefresh.PullToRefreshBox
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import ch.heimberg.radio.core.TimelineItem
import java.time.Instant
import java.time.LocalDate
import java.time.ZoneId
import java.time.format.DateTimeFormatter
import java.util.Locale

private val zone = ZoneId.systemDefault()
private val clock = DateTimeFormatter.ofPattern("HH:mm").withZone(zone)
private val day = DateTimeFormatter.ofPattern("EEEE, d. MMMM", Locale.GERMAN)

/** «Archiv»: productions that can still be heard, by day. Tap to hear, long press for text or delete. */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun ArchiveScreen(state: RadioState, actions: RadioActions, padding: PaddingValues) {
    val items = state.archive
    // Opening the tab brings the archive up to date.
    LaunchedEffect(Unit) { actions.loadArchive() }
    PullToRefreshBox(isRefreshing = state.archiveRefreshing, onRefresh = actions::loadArchive, modifier = Modifier.fillMaxSize().padding(padding)) {
        LazyColumn(Modifier.fillMaxSize(), contentPadding = PaddingValues(bottom = 24.dp)) {
            item(key = "head") {
                Column(Modifier.padding(start = 20.dp, end = 20.dp, top = 18.dp)) {
                    Text("Archiv", style = MaterialTheme.typography.headlineSmall)
                    // The productions, or the reading list (what was kept with «Merken»).
                    Row(Modifier.padding(top = 6.dp), horizontalArrangement = Arrangement.spacedBy(8.dp), verticalAlignment = Alignment.CenterVertically) {
                        FilterChip(selected = !state.readingList, onClick = { state.readingList = false }, label = { Text("Gehört") })
                        FilterChip(selected = state.readingList, onClick = { state.readingList = true }, label = { Text("🔖 Leseliste · ${state.bookmarks.size}") })
                        if (state.readingList && state.bookmarks.isNotEmpty()) TextButton(onClick = actions::shareReading) { Text("Teilen") }
                    }
                    Text(
                        if (state.readingList) { if (state.bookmarks.isEmpty()) "Noch nichts gemerkt. Im Player oder im Menü eines Beitrags: «Merken»." else "" }
                        else state.archiveNote.ifBlank { if (items == null) "Archiv wird geladen …" else "" },
                        style = MaterialTheme.typography.bodySmall, color = Nocturne.muted, modifier = Modifier.padding(vertical = 6.dp),
                    )
                }
            }
            if (state.readingList) {
                items(state.bookmarks, key = { "bookmark-${it.itemId}" }) { ReadingListEntry(it, actions) }
                return@LazyColumn
            }
            for ((date, group) in byDay(items.orEmpty())) {
                item(key = "day-$date") {
                    Text(dayLabel(date), style = MaterialTheme.typography.labelSmall, color = Nocturne.accentLight, modifier = Modifier.padding(start = 20.dp, top = 16.dp, bottom = 6.dp))
                }
                items(group, key = { "archive-${it.id}" }) { item ->
                    Box(Modifier.padding(horizontal = 16.dp, vertical = 4.dp)) {
                        ItemRow(
                            item, null, timeLabel = planned(item)?.let(clock::format) ?: "",
                            onTap = { actions.play(item); state.tab = Tab.LISTEN },
                            onLongPress = { state.actionsFor = item },
                        )
                    }
                }
            }
        }
    }
}

private fun planned(item: TimelineItem): Instant? = runCatching { Instant.parse(item.plannedAt) }.getOrNull()

private fun byDay(items: List<TimelineItem>): List<Pair<LocalDate?, List<TimelineItem>>> {
    val groups = LinkedHashMap<LocalDate?, MutableList<TimelineItem>>()
    for (item in items) groups.getOrPut(planned(item)?.atZone(zone)?.toLocalDate()) { mutableListOf() }.add(item)
    return groups.map { (date, group) -> date to group }
}

private fun dayLabel(date: LocalDate?): String {
    val today = LocalDate.now(zone)
    return when (date) {
        null -> "OHNE DATUM"
        today -> "HEUTE"
        today.minusDays(1) -> "GESTERN"
        else -> day.format(date).uppercase(Locale.GERMAN)
    }
}
