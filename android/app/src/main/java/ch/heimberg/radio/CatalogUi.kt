package ch.heimberg.radio

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
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
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import ch.heimberg.radio.core.BlockView
import ch.heimberg.radio.core.Catalog
import ch.heimberg.radio.core.Kind
import ch.heimberg.radio.core.Looks
import kotlin.math.roundToInt

/** Short tab names, so five fit side by side. */
private fun Kind.short(): String = if (this == Kind.STORY) "GESCH." else label.uppercase()

/**
 * «＋ Einfügen»: every building block the station offers, in five rubrics, with a search and ⭐ favourites.
 * A tap puts the block at the end of the program (or asks for its word first).
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun CatalogSheet(state: RadioState, actions: RadioActions) {
    if (!state.catalogOpen) return
    val close = { state.catalogOpen = false; state.catalogQuery = "" }
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
            if (query.isNotEmpty()) {
                val found = Catalog.search(state.blocks, query, state.favorites)
                BlockList(found, state, actions, close, showRubric = true, empty = "Nichts gefunden – versuch ein anderes Wort.")
            } else {
                val rubrics = Catalog.rubrics(state.blocks, state.favorites)
                RubricTabs(rubrics.map { it.first to it.second.size }, state.catalogRubric) { state.catalogRubric = it }
                val kind = state.catalogRubric
                Row(Modifier.padding(start = 20.dp, end = 20.dp, top = 16.dp), verticalAlignment = Alignment.Bottom) {
                    Text(kind.label.uppercase(), style = display(28), color = Nocturne.kindLabel(kind))
                    Spacer(Modifier.width(10.dp))
                    Text(kind.hint, style = MaterialTheme.typography.bodyMedium, color = Nocturne.muted, modifier = Modifier.padding(bottom = 3.dp))
                }
                BlockList(rubrics.first { it.first == kind }.second, state, actions, close, showRubric = false, empty = "In dieser Rubrik ist gerade nichts eingeschaltet – unter Studio › Funktionen.")
            }
        }
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

@Composable
private fun BlockList(blocks: List<BlockView>, state: RadioState, actions: RadioActions, close: () -> Unit, showRubric: Boolean, empty: String) {
    if (blocks.isEmpty()) {
        Text(empty, style = MaterialTheme.typography.bodyMedium, color = Nocturne.muted, modifier = Modifier.padding(20.dp))
        return
    }
    LazyColumn(contentPadding = PaddingValues(start = 20.dp, end = 20.dp, top = 10.dp, bottom = 32.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
        items(blocks, key = { it.id }) { block ->
            BlockCard(block, favorite = block.id in state.favorites, showRubric = showRubric, onStar = { actions.toggleFavorite(block) }) {
                close()
                actions.chooseBlock(block)
            }
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

/** The ink pill «＋ Einfügen» that opens the catalog. */
@Composable
fun InsertPill(onClick: () -> Unit, modifier: Modifier = Modifier) {
    Row(
        modifier
            .height(40.dp)
            .clip(RoundedCornerShape(999.dp))
            .background(Nocturne.accent)
            .clickable(onClick = onClick)
            .padding(horizontal = 16.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Icon(painterResource(R.drawable.ic_plus), null, Modifier.size(16.dp), tint = Nocturne.bg)
        Spacer(Modifier.width(6.dp))
        Text("Einfügen", style = MaterialTheme.typography.labelLarge.copy(fontWeight = FontWeight.Bold), color = Nocturne.bg)
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
        Text(name.uppercase(), style = display(15), color = ink, maxLines = 3, overflow = TextOverflow.Ellipsis)
    }
}
