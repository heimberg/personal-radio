package ch.heimberg.radio

import ch.heimberg.radio.core.Looks
import ch.heimberg.radio.core.Kind
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.lazy.LazyRow
import androidx.compose.ui.res.painterResource
import androidx.compose.material3.IconButton
import androidx.compose.material3.Icon
import androidx.compose.material3.FilterChip
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.rememberSwipeToDismissBoxState
import androidx.compose.material3.SwipeToDismissBoxValue
import androidx.compose.material3.SwipeToDismissBox
import androidx.compose.runtime.setValue
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.pulltorefresh.PullToRefreshBox
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.style.TextAlign
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

/** «Archiv»: productions that can still be heard, by day; filter by rubric, search, tap to hear, swipe to delete, long press for more. */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun ArchiveScreen(state: RadioState, actions: RadioActions, padding: PaddingValues) {
    val items = state.archive
    var kindFilter by rememberSaveable { mutableStateOf<Kind?>(null) }
    var query by rememberSaveable { mutableStateOf("") }
    // Opening the tab brings the archive up to date.
    LaunchedEffect(Unit) { actions.loadArchive() }
    PullToRefreshBox(isRefreshing = state.archiveRefreshing, onRefresh = actions::loadArchive, modifier = Modifier.fillMaxSize().padding(padding)) {
        LazyColumn(Modifier.fillMaxSize(), contentPadding = PaddingValues(bottom = 24.dp)) {
            item(key = "head") {
                Column(Modifier.padding(start = 20.dp, end = 20.dp, top = 18.dp)) {
                    ScreenTitle("Archiv")
                    // The productions, or the reading list (what was kept with «Merken»).
                    Row(Modifier.padding(top = 10.dp), verticalAlignment = Alignment.CenterVertically) {
                        Segments(
                            listOf("Gehört", "🔖 Leseliste · ${state.bookmarks.size}"), if (state.readingList) 1 else 0,
                            Modifier.weight(1f),
                        ) { state.readingList = it == 1 }
                        if (state.readingList && state.bookmarks.isNotEmpty()) TextButton(onClick = actions::shareReading) { Text("Teilen") }
                    }
                    Text(
                        if (state.readingList) { if (state.bookmarks.isEmpty()) "Noch nichts gemerkt. Im Player oder im Menü eines Beitrags: «Merken»." else "" }
                        else state.archiveNote,
                        style = MaterialTheme.typography.bodySmall, color = Nocturne.muted, modifier = Modifier.padding(vertical = 6.dp),
                    )
                    if (!state.readingList && items == null && state.archiveNote.isBlank()) SkeletonRows(5, "Archiv")
                }
            }
            if (state.readingList) {
                items(state.bookmarks, key = { "bookmark-${it.itemId}" }) { ReadingListEntry(it, actions) }
                return@LazyColumn
            }
            // Filter by rubric and search in titles and shows.
            item(key = "filter") { ArchiveFilter(items.orEmpty(), kindFilter, query, { kindFilter = it }, { query = it }) }
            val shown = items.orEmpty().filter { item ->
                (kindFilter == null || Looks.of(item).kind == kindFilter) &&
                    (query.isBlank() || item.displayTitle.contains(query.trim(), ignoreCase = true) || item.showName.contains(query.trim(), ignoreCase = true))
            }
            if (items != null && shown.isEmpty() && items.isNotEmpty()) {
                item(key = "none") { Text("Nichts gefunden.", style = MaterialTheme.typography.bodyMedium, color = Nocturne.muted, modifier = Modifier.padding(20.dp)) }
            }
            for ((date, group) in byDay(shown)) {
                item(key = "day-$date") {
                    Row(Modifier.fillMaxWidth().padding(start = 20.dp, end = 20.dp, top = 22.dp, bottom = 8.dp), verticalAlignment = Alignment.Bottom) {
                        Text(dayLabel(date), style = display(24), color = Nocturne.text)
                        Spacer(Modifier.width(10.dp))
                        Text("${group.size} ${if (group.size == 1) "Beitrag" else "Beiträge"}", style = Kicker, color = Nocturne.muted, modifier = Modifier.padding(bottom = 3.dp))
                    }
                }
                items(group, key = { "archive-${it.id}" }) { item ->
                    // Swiping to the left deletes, with «Rückgängig» for a few seconds.
                    val swipe = rememberSwipeToDismissBoxState(confirmValueChange = { value ->
                        if (value == SwipeToDismissBoxValue.EndToStart) { actions.delete(item); true } else false
                    })
                    SwipeToDismissBox(
                        state = swipe, enableDismissFromStartToEnd = false,
                        // Neighbours glide together when one is deleted or comes back with «Rückgängig».
                        modifier = Modifier.animateItem().padding(horizontal = 16.dp, vertical = 4.dp),
                        backgroundContent = {
                            Box(
                                Modifier.fillMaxSize().clip(RoundedCornerShape(16.dp)).background(Nocturne.danger.copy(alpha = 0.18f)).padding(horizontal = 20.dp),
                                contentAlignment = Alignment.CenterEnd,
                            ) { Text("Löschen", style = MaterialTheme.typography.labelLarge, color = Nocturne.danger) }
                        },
                    ) {
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

/** Rubric chips (only those the archive has) and a search field. */
@Composable
private fun ArchiveFilter(items: List<TimelineItem>, kind: Kind?, query: String, onKind: (Kind?) -> Unit, onQuery: (String) -> Unit) {
    if (items.isEmpty()) return
    val kinds = Kind.entries.filter { k -> items.any { Looks.of(it).kind == k } }
    Column(Modifier.padding(top = 4.dp)) {
        OutlinedTextField(
            value = query, onValueChange = { onQuery(it.take(60)) }, singleLine = true,
            placeholder = { Text("Im Archiv suchen") },
            leadingIcon = { Icon(painterResource(R.drawable.ic_search), null, Modifier.size(18.dp)) },
            trailingIcon = { if (query.isNotEmpty()) IconButton(onClick = { onQuery("") }) { Icon(painterResource(R.drawable.ic_x), "Suche leeren", Modifier.size(18.dp)) } },
            shape = RoundedCornerShape(14.dp),
            modifier = Modifier.padding(horizontal = 16.dp).fillMaxWidth(),
        )
        if (kinds.size > 1) {
            LazyRow(contentPadding = PaddingValues(horizontal = 16.dp, vertical = 6.dp), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                item { FilterChip(selected = kind == null, onClick = { onKind(null) }, label = { Text("Alle") }) }
                items(kinds) { k ->
                    FilterChip(selected = kind == k, onClick = { onKind(if (kind == k) null else k) }, label = { Text(k.label) },
                        leadingIcon = { Box(Modifier.size(10.dp).clip(CircleShape).background(Nocturne.kind(k))) })
                }
            }
        }
    }
}

/** Two or more choices side by side; the chosen one is filled with ink. */
@Composable
fun Segments(labels: List<String>, selected: Int, modifier: Modifier = Modifier, onSelect: (Int) -> Unit) {
    Row(
        modifier.clip(RoundedCornerShape(14.dp)).background(Nocturne.surfaceHigh).padding(4.dp),
        horizontalArrangement = Arrangement.spacedBy(4.dp),
    ) {
        labels.forEachIndexed { index, label ->
            val on = index == selected
            Text(
                label, style = MaterialTheme.typography.labelLarge, color = if (on) Nocturne.bg else Nocturne.text,
                textAlign = TextAlign.Center, maxLines = 1,
                modifier = Modifier
                    .weight(1f)
                    .clip(RoundedCornerShape(10.dp))
                    .background(if (on) Nocturne.accent else Color.Transparent)
                    .clickable { onSelect(index) }
                    .padding(vertical = 10.dp),
            )
        }
    }
}
