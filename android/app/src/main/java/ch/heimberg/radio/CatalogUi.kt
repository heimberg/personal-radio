package ch.heimberg.radio

import androidx.compose.animation.animateContentSize
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxWithConstraints
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.LazyListScope
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.ModalBottomSheet
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.OutlinedTextFieldDefaults
import androidx.compose.material3.Text
import androidx.compose.material3.rememberModalBottomSheetState
import androidx.compose.runtime.Composable
import androidx.compose.runtime.remember
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.draw.shadow
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.intl.LocaleList
import androidx.compose.ui.text.rememberTextMeasurer
import androidx.compose.ui.text.style.Hyphens
import androidx.compose.ui.text.style.LineBreak
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import ch.heimberg.radio.core.BlockView
import ch.heimberg.radio.core.Catalog
import ch.heimberg.radio.core.ForYou
import ch.heimberg.radio.core.Kind
import ch.heimberg.radio.core.Looks
import java.time.LocalDateTime
import kotlin.math.roundToInt

/** Short tab names, so five fit side by side. */
private fun Kind.short(): String = if (this == Kind.STORY) "GESCH." else label.uppercase()

/**
 * «＋ Einfügen»: the one place to add something to the program. «Für dich» on top, then a song or a topic
 * to follow, then every building block in five rubrics, with a search and ⭐ favourites. A tap puts the
 * block at the end of the program (or asks for its word first).
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun CatalogSheet(state: RadioState, actions: RadioActions) {
    if (!state.catalogOpen) return
    val close = { state.catalogOpen = false; state.catalogQuery = "" }
    val insert = { block: BlockView -> close(); actions.chooseBlock(block) }
    val sheet = rememberModalBottomSheetState(skipPartiallyExpanded = true)
    ModalBottomSheet(onDismissRequest = close, sheetState = sheet, containerColor = Nocturne.bg, dragHandle = null) {
        Column(Modifier.fillMaxWidth().fillMaxHeight(0.95f).imePadding()) {
            Row(Modifier.fillMaxWidth().padding(start = 20.dp, end = 16.dp, top = 18.dp), verticalAlignment = Alignment.CenterVertically) {
                Column(Modifier.weight(1f)) {
                    ScreenTitle("Einfügen")
                    Text("Kommt ans Ende des Programms", style = MaterialTheme.typography.bodySmall, color = Nocturne.muted)
                }
                IconButton(onClick = close, modifier = Modifier.size(44.dp).background(Nocturne.surfaceHigh, CircleShape)) {
                    Icon(painterResource(R.drawable.ic_x), "Schliessen", Modifier.size(18.dp), tint = Nocturne.text)
                }
            }
            OutlinedTextField(
                value = state.catalogQuery, onValueChange = { state.catalogQuery = it.take(60) }, singleLine = true,
                placeholder = { Text("Was möchtest du hören?") },
                leadingIcon = { Icon(painterResource(R.drawable.ic_search), null, Modifier.size(18.dp), tint = Nocturne.muted) },
                trailingIcon = {
                    if (state.catalogQuery.isNotEmpty()) {
                        IconButton(onClick = { state.catalogQuery = "" }) { Icon(painterResource(R.drawable.ic_x), "Suche leeren", Modifier.size(16.dp), tint = Nocturne.muted) }
                    }
                },
                shape = RoundedCornerShape(14.dp),
                colors = OutlinedTextFieldDefaults.colors(
                    focusedBorderColor = Nocturne.text, unfocusedBorderColor = Nocturne.text,
                    focusedContainerColor = Nocturne.surface, unfocusedContainerColor = Nocturne.surface,
                ),
                modifier = Modifier.fillMaxWidth().padding(start = 20.dp, end = 20.dp, top = 14.dp),
            )
            val query = state.catalogQuery.trim()
            LazyColumn(contentPadding = PaddingValues(bottom = 32.dp)) {
                if (query.isNotEmpty()) {
                    blocks(Catalog.search(state.blocks, query, state.favorites), state, actions, insert, showRubric = true, empty = "Nichts gefunden – versuch ein anderes Wort.")
                    return@LazyColumn
                }
                item(key = "for-you") { ForYouPicks(state, insert) }
                item(key = "quick") {
                    Row(Modifier.fillMaxWidth().padding(start = 20.dp, end = 20.dp, top = 12.dp), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                        QuickAction(R.drawable.ic_music_notes, "Ein Song", Modifier.weight(1f)) { close(); actions.addSong() }
                        QuickAction(R.drawable.ic_push_pin, "Thema verfolgen", Modifier.weight(1f)) { close(); actions.suggestFollow("") }
                    }
                }
                val rubrics = Catalog.rubrics(state.blocks, state.favorites)
                item(key = "tabs") {
                    Column {
                        Text("ALLE BAUSTEINE", style = Kicker, color = Nocturne.muted, modifier = Modifier.padding(start = 20.dp, top = 22.dp))
                        RubricTabs(rubrics.map { it.first to it.second.size }, state.catalogRubric) { state.catalogRubric = it }
                    }
                }
                val kind = state.catalogRubric
                item(key = "rubric") {
                    Row(Modifier.padding(start = 20.dp, end = 20.dp, top = 16.dp, bottom = 2.dp), verticalAlignment = Alignment.Bottom) {
                        Text(kind.label.uppercase(), style = display(28), color = Nocturne.kindLabel(kind))
                        Spacer(Modifier.width(10.dp))
                        Text(kind.hint, style = MaterialTheme.typography.bodyMedium, color = Nocturne.muted, modifier = Modifier.padding(bottom = 3.dp))
                    }
                }
                blocks(rubrics.first { it.first == kind }.second, state, actions, insert, showRubric = false, empty = "In dieser Rubrik ist gerade nichts eingeschaltet – unter Studio › Funktionen.")
            }
        }
    }
}

/** «Für dich · Samstagmorgen»: four blocks for now, from the time of day, favourites and habits. */
@Composable
private fun ForYouPicks(state: RadioState, insert: (BlockView) -> Unit) {
    val now = LocalDateTime.now()
    val picks = remember(state.blocks, state.usage, state.favorites, now.hour, now.dayOfYear) {
        ForYou.picks(state.blocks, now.hour, now.dayOfWeek.value, now.dayOfYear, state.usage, state.favorites)
    }
    if (picks.isEmpty()) return
    Column {
        Text(
            "FÜR DICH · ${ForYou.moment(now.hour, now.dayOfWeek.value).uppercase()}", style = Kicker, color = Nocturne.muted,
            modifier = Modifier.padding(start = 20.dp, end = 20.dp, top = 18.dp),
        )
        Row(Modifier.fillMaxWidth().padding(start = 20.dp, end = 20.dp, top = 8.dp), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            for (pick in picks) {
                PickTile(pick.block.name, pick.why, Looks.ofBlock(pick.block).kind, Modifier.weight(1f)) { insert(pick.block) }
            }
            // Fewer than four: the tiles keep their width.
            repeat(ForYou.LIMIT - picks.size) { Spacer(Modifier.weight(1f)) }
        }
    }
}

/** A white button with an icon and a word, for what is not a block: a song, a topic to follow. */
@Composable
private fun QuickAction(icon: Int, label: String, modifier: Modifier = Modifier, onClick: () -> Unit) {
    Row(
        modifier
            .height(48.dp)
            .clip(RoundedCornerShape(14.dp))
            .background(Nocturne.surface)
            .border(1.dp, Nocturne.divider, RoundedCornerShape(14.dp))
            .clickable(onClick = onClick)
            .padding(horizontal = 14.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Icon(painterResource(icon), null, Modifier.size(20.dp), tint = Nocturne.text)
        Spacer(Modifier.width(8.dp))
        Text(label, style = MaterialTheme.typography.titleSmall, maxLines = 1, overflow = TextOverflow.Ellipsis)
    }
}

/** Five tabs side by side: the rubric's colour and how many blocks it has. */
@Composable
private fun RubricTabs(counts: List<Pair<Kind, Int>>, selected: Kind, onSelect: (Kind) -> Unit) {
    Row(Modifier.fillMaxWidth().padding(start = 20.dp, end = 20.dp, top = 14.dp), horizontalArrangement = Arrangement.spacedBy(6.dp)) {
        for ((kind, count) in counts) {
            val on = kind == selected
            val color = Nocturne.kind(kind)
            val ink = if (on) Nocturne.onKind(kind) else Nocturne.kindLabel(kind)
            Column(
                Modifier
                    .weight(1f)
                    .height(64.dp)
                    .clip(RoundedCornerShape(14.dp))
                    .background(if (on) color else Nocturne.surface)
                    .border(2.dp, color, RoundedCornerShape(14.dp))
                    .clickable { onSelect(kind) },
                horizontalAlignment = Alignment.CenterHorizontally,
                verticalArrangement = Arrangement.Center,
            ) {
                Text("$count", style = display(20), color = ink)
                Text(kind.short(), fontSize = 10.sp, fontWeight = FontWeight.Bold, letterSpacing = 0.5.sp, color = ink, maxLines = 1)
            }
        }
    }
}

private fun LazyListScope.blocks(
    blocks: List<BlockView>, state: RadioState, actions: RadioActions, insert: (BlockView) -> Unit, showRubric: Boolean, empty: String,
) {
    if (blocks.isEmpty()) {
        item(key = "empty") { Text(empty, style = MaterialTheme.typography.bodyMedium, color = Nocturne.muted, modifier = Modifier.padding(20.dp)) }
        return
    }
    items(blocks, key = { it.id }) { block ->
        Box(Modifier.padding(start = 20.dp, end = 20.dp, top = 8.dp)) {
            BlockCard(block, favorite = block.id in state.favorites, showRubric = showRubric, onStar = { actions.toggleFavorite(block) }) { insert(block) }
        }
    }
}

/** One block: its icon on the rubric's colour, name, what it is and how long, and the ⭐. */
@Composable
private fun BlockCard(block: BlockView, favorite: Boolean, showRubric: Boolean, onStar: () -> Unit, onTap: () -> Unit) {
    val look = Looks.ofBlock(block)
    Row(
        Modifier
            .fillMaxWidth()
            .clip(RoundedCornerShape(16.dp))
            .background(Nocturne.surface)
            .border(1.dp, Nocturne.divider, RoundedCornerShape(16.dp))
            .clickable(onClick = onTap)
            .padding(start = 12.dp, top = 12.dp, bottom = 12.dp, end = 4.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        KindBadge(look.icon, look.kind, 46.dp)
        Spacer(Modifier.width(12.dp))
        Column(Modifier.weight(1f)) {
            if (showRubric) RubricLabel(look.kind)
            Text(if (block.music) "${block.name} ♫" else block.name, style = MaterialTheme.typography.titleMedium, maxLines = 1, overflow = TextOverflow.Ellipsis)
            val minutes = block.minutes.roundToInt().takeIf { it > 0 }?.let { " · $it Min." } ?: ""
            Text(block.description + minutes, style = MaterialTheme.typography.bodyMedium, color = Nocturne.muted, maxLines = 2, overflow = TextOverflow.Ellipsis)
        }
        IconButton(onClick = onStar) {
            Icon(
                painterResource(if (favorite) R.drawable.ic_star_fill else R.drawable.ic_star),
                if (favorite) "Aus den Favoriten" else "Zu den Favoriten",
                Modifier.size(22.dp), tint = if (favorite) Color(Kind.STORY.argb) else Nocturne.faint,
            )
        }
    }
}

/** The ink button «＋ Einfügen» at the bottom of «Programm»: the one way to add something. */
@Composable
fun InsertButton(onClick: () -> Unit, modifier: Modifier = Modifier, expanded: Boolean = true) {
    Row(
        modifier
            .shadow(8.dp, RoundedCornerShape(999.dp))
            .height(56.dp)
            .clip(RoundedCornerShape(999.dp))
            .background(Nocturne.accent)
            .clickable(onClick = onClick)
            .semantics { contentDescription = "Einfügen" }
            .animateContentSize()
            .padding(start = if (expanded) 18.dp else 16.dp, end = if (expanded) 22.dp else 16.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Icon(painterResource(R.drawable.ic_plus), null, Modifier.size(24.dp), tint = Nocturne.bg)
        // While the list scrolls down it shrinks to its ＋, so it covers less; scrolling up brings the word back.
        if (expanded) {
            Spacer(Modifier.width(8.dp))
            Text("Einfügen", style = MaterialTheme.typography.titleMedium, color = Nocturne.bg)
        }
    }
}

/** A square «Für dich» tile, filled with the rubric's colour: why it is suggested, and the block's name. */
@Composable
fun PickTile(name: String, why: String, kind: Kind, modifier: Modifier = Modifier, onClick: () -> Unit) {
    val ink = Nocturne.onKind(kind)
    Column(
        modifier
            .height(92.dp)
            .clip(RoundedCornerShape(16.dp))
            .background(Nocturne.kind(kind))
            .clickable(onClick = onClick)
            .padding(10.dp),
        verticalArrangement = Arrangement.SpaceBetween,
    ) {
        Text(why, fontSize = 10.sp, fontWeight = FontWeight.Bold, letterSpacing = 0.5.sp, color = ink.copy(alpha = 0.85f), maxLines = 1)
        // The longest word fits on one line: the name shrinks rather than breaking «MUSIKBLOC/K»; a word too
        // long even then is hyphenated where German allows («WOCHEN-/RÜCKBLICK»).
        BoxWithConstraints(Modifier.fillMaxWidth()) {
            val title = name.uppercase()
            val measurer = rememberTextMeasurer()
            val longest = title.split(' ', '-').maxByOrNull { it.length } ?: title
            val style = remember(title, maxWidth) {
                (15 downTo 13).firstNotNullOfOrNull { size -> display(size).takeIf { measurer.measure(longest, it, maxLines = 1).size.width <= constraints.maxWidth } }
                    ?: display(13).copy(hyphens = Hyphens.Auto, lineBreak = LineBreak.Paragraph, localeList = LocaleList("de-CH"))
            }
            Text(title, style = style, color = ink, maxLines = 3, overflow = TextOverflow.Ellipsis)
        }
    }
}
