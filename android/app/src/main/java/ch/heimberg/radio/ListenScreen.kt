package ch.heimberg.radio

import androidx.compose.animation.animateColorAsState
import androidx.compose.animation.core.tween
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyRow
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.FilledTonalButton
import androidx.compose.material3.FilterChip
import androidx.compose.material3.FilterChipDefaults
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.lerp
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import ch.heimberg.radio.core.BlockView
import ch.heimberg.radio.core.Looks
import ch.heimberg.radio.core.Moods
import ch.heimberg.radio.core.TimelineItem
import java.time.ZoneId
import java.time.format.DateTimeFormatter

private val clock = DateTimeFormatter.ofPattern("HH:mm").withZone(ZoneId.systemDefault())

/** «Hören»: the player in full, what comes right after it with «Anders», and the building blocks. */
@Composable
fun ListenScreen(state: RadioState, actions: RadioActions, padding: PaddingValues) {
    Column(
        Modifier
            .verticalScroll(rememberScrollState())
            .padding(padding)
            .padding(bottom = 24.dp),
    ) {
        Header(state)
        MoodChips(state, actions)
        Banners(state, actions)
        PlayerCard(state, actions)
        state.sections.next?.let { NextCard(it, state, actions) }
        Blocks(state.blocks, actions)
    }
}

@Composable
private fun Header(state: RadioState) {
    Row(Modifier.padding(horizontal = 20.dp, vertical = 14.dp), verticalAlignment = Alignment.CenterVertically) {
        val dot by animateColorAsState(if (state.live) Nocturne.accent else Nocturne.faint, tween(400), label = "live")
        Box(Modifier.size(8.dp).background(dot, CircleShape))
        Spacer(Modifier.width(10.dp))
        Text("personal radio", style = MaterialTheme.typography.titleMedium)
        Text(".", style = MaterialTheme.typography.titleMedium, color = Nocturne.accent)
        Spacer(Modifier.width(16.dp))
        Text(
            state.sleepLabel ?: state.status, style = MaterialTheme.typography.bodySmall, color = Nocturne.muted, maxLines = 1,
            overflow = TextOverflow.Ellipsis, textAlign = TextAlign.End, modifier = Modifier.weight(1f),
        )
    }
}

/** «Heute»: one tap leans the rest of the day; a second tap on the same chip returns to the plan. */
@Composable
private fun MoodChips(state: RadioState, actions: RadioActions) {
    LazyRow(contentPadding = PaddingValues(horizontal = 16.dp), horizontalArrangement = Arrangement.spacedBy(8.dp), verticalAlignment = Alignment.CenterVertically) {
        item { Text("HEUTE", style = MaterialTheme.typography.labelSmall, color = Nocturne.accentLight, modifier = Modifier.padding(start = 4.dp, end = 2.dp)) }
        items(Moods.ALL, key = { it.id }) { mood ->
            val selected = state.mood == mood.id
            FilterChip(
                selected = selected,
                onClick = { actions.setMood(if (selected) null else mood.id) },
                label = { Text("${mood.icon}  ${mood.label}") },
                colors = FilterChipDefaults.filterChipColors(selectedContainerColor = Nocturne.accentDeep, selectedLabelColor = Nocturne.text),
            )
        }
    }
}

/** Connection problems, a waiting update and the one-time Spotify permission. */
@Composable
private fun Banners(state: RadioState, actions: RadioActions) {
    state.connectionError?.let { Banner(it, Nocturne.danger) }
    state.update?.let { build ->
        Banner(state.updateNote.ifBlank { "Version ${build.versionName} ist bereit." }, Nocturne.accent) {
            FilledTonalButton(onClick = actions::installUpdate, enabled = !state.updating) { Text("Update installieren") }
        }
    }
    if (state.spotifyNeeded) {
        Banner("Einmal erlauben, dann laufen Musikstunden mit Spotify.", Nocturne.kind(ch.heimberg.radio.core.Kind.MUSIC)) {
            FilledTonalButton(onClick = actions::connectSpotify, enabled = !state.spotifyBusy) {
                Icon(painterResource(R.drawable.ic_spotify), null, Modifier.size(16.dp))
                Spacer(Modifier.width(8.dp))
                Text("Spotify verbinden")
            }
        }
    }
}

@Composable
fun Banner(text: String, color: Color, action: (@Composable () -> Unit)? = null) {
    Column(
        Modifier
            .padding(horizontal = 16.dp, vertical = 6.dp)
            .fillMaxWidth()
            .background(color.copy(alpha = 0.14f), RoundedCornerShape(16.dp))
            .border(1.dp, color.copy(alpha = 0.4f), RoundedCornerShape(16.dp))
            .padding(14.dp),
    ) {
        Text(text, style = MaterialTheme.typography.bodyMedium)
        if (action != null) {
            Spacer(Modifier.height(10.dp))
            action()
        }
    }
}

@Composable
private fun PlayerCard(state: RadioState, actions: RadioActions) {
    val look = state.look
    val tint by animateColorAsState(Nocturne.kind(look?.kind), tween(600), label = "kind")
    Column(
        Modifier
            .padding(horizontal = 16.dp, vertical = 8.dp)
            .fillMaxWidth()
            .clip(RoundedCornerShape(28.dp))
            .background(Brush.verticalGradient(listOf(lerp(Nocturne.bgGlow, tint, 0.34f), Nocturne.bgGlow, Nocturne.surface)))
            .border(1.dp, tint.copy(alpha = 0.45f), RoundedCornerShape(28.dp))
            .padding(20.dp),
        horizontalAlignment = Alignment.CenterHorizontally,
    ) {
        Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
            if (look != null) KindChip("${look.icon}  ${look.kind.label}", look.kind)
            Spacer(Modifier.weight(1f))
            Text(if (state.live) "LIVE" else "", style = MaterialTheme.typography.labelSmall, color = tint)
        }
        Orb(state.live, tint, Modifier.padding(vertical = 12.dp).size(190.dp))
        Text(
            state.title.ifBlank { "Noch nichts eingeschaltet" }, style = MaterialTheme.typography.headlineMedium, textAlign = TextAlign.Center,
            maxLines = 3, overflow = TextOverflow.Ellipsis,
            modifier = Modifier.clickable(enabled = state.currentItemId != null) { actions.transcript() },
        )
        if (state.show.isNotBlank()) {
            Spacer(Modifier.height(4.dp))
            Text(state.show, style = MaterialTheme.typography.bodyMedium, color = Nocturne.muted, textAlign = TextAlign.Center)
        }
        Spacer(Modifier.height(18.dp))
        Waveform(state.progress, state.live, tint, Modifier.fillMaxWidth().height(28.dp))
        Row(Modifier.fillMaxWidth().padding(top = 6.dp)) {
            Text(time(state.positionMs), style = MaterialTheme.typography.bodySmall, color = Nocturne.muted)
            Spacer(Modifier.weight(1f))
            Text(if (state.durationMs > 0) time(state.durationMs) else "", style = MaterialTheme.typography.bodySmall, color = Nocturne.muted)
        }
        Row(Modifier.fillMaxWidth().padding(top = 10.dp), horizontalArrangement = Arrangement.SpaceEvenly, verticalAlignment = Alignment.CenterVertically) {
            RoundIcon(R.drawable.ic_thumbs_down, "Weniger davon") { actions.rate(false) }
            Box(
                Modifier
                    .size(76.dp)
                    .clip(CircleShape)
                    .background(Brush.linearGradient(listOf(Nocturne.accent, tint)))
                    .clickable { actions.togglePlay() }
                    .semantics { contentDescription = if (state.playWhenReady) "Pause" else "Hören" },
                contentAlignment = Alignment.Center,
            ) {
                Icon(painterResource(if (state.playWhenReady) R.drawable.ic_pause else R.drawable.ic_play), null, Modifier.size(30.dp), tint = Nocturne.bg)
            }
            RoundIcon(R.drawable.ic_skip_forward, "Weiter") { actions.next() }
            RoundIcon(R.drawable.ic_thumbs_up, "Mehr davon") { actions.rate(true) }
        }
        Row(Modifier.fillMaxWidth().padding(top = 12.dp), horizontalArrangement = Arrangement.SpaceEvenly) {
            SmallAction(R.drawable.ic_info, "Text") { actions.transcript() }
            SmallAction(R.drawable.ic_plus_circle, "Mehr dazu") { actions.deepen() }
            SmallAction(R.drawable.ic_moon, if (state.sleepLabel != null) "Timer an" else "Schlafen", highlighted = state.sleepLabel != null) { state.sleepOpen = true }
        }
    }
}

@Composable
private fun RoundIcon(icon: Int, label: String, onClick: () -> Unit) {
    IconButton(onClick = onClick, modifier = Modifier.size(52.dp).border(1.dp, Nocturne.divider, CircleShape)) {
        Icon(painterResource(icon), label, Modifier.size(20.dp), tint = Nocturne.text)
    }
}

@Composable
private fun SmallAction(icon: Int, label: String, highlighted: Boolean = false, onClick: () -> Unit) {
    TextButton(onClick = onClick) {
        Icon(painterResource(icon), null, Modifier.size(16.dp), tint = if (highlighted) Nocturne.accentLight else Nocturne.muted)
        Spacer(Modifier.width(6.dp))
        Text(label, color = if (highlighted) Nocturne.accentLight else Nocturne.muted, style = MaterialTheme.typography.labelMedium)
    }
}

/** «Gleich»: the next item with its start time; «Anders» puts something different in its place. */
@Composable
private fun NextCard(item: TimelineItem, state: RadioState, actions: RadioActions) {
    val look = Looks.of(item)
    Row(
        Modifier
            .padding(horizontal = 16.dp, vertical = 8.dp)
            .fillMaxWidth()
            .kindTile(look.kind, RoundedCornerShape(20.dp), glow = 0.22f)
            .clickable { if (item.isPlayable) actions.play(item) else state.actionsFor = item }
            .padding(14.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        KindBadge(look.icon, look.kind, 44.dp)
        Spacer(Modifier.width(12.dp))
        Column(Modifier.weight(1f)) {
            Text(
                "GLEICH" + (state.starts[item.id]?.let { " · ${clock.format(it)}" } ?: ""),
                style = MaterialTheme.typography.labelSmall, color = Nocturne.kindLabel(look.kind),
            )
            Text(item.displayTitle, style = MaterialTheme.typography.titleSmall, maxLines = 2, overflow = TextOverflow.Ellipsis)
            Text(item.showName, style = MaterialTheme.typography.bodySmall, color = Nocturne.muted, maxLines = 1, overflow = TextOverflow.Ellipsis)
        }
        Spacer(Modifier.width(8.dp))
        OutlinedButton(onClick = { actions.swap(item) }, contentPadding = PaddingValues(horizontal = 12.dp)) {
            Icon(painterResource(R.drawable.ic_dice), null, Modifier.size(16.dp))
            Spacer(Modifier.width(6.dp))
            Text("Anders")
        }
    }
}

/** The building blocks: one tap puts one next into the program. */
@Composable
private fun Blocks(blocks: List<BlockView>, actions: RadioActions) {
    if (blocks.isEmpty()) return
    Text("Einfügen", style = MaterialTheme.typography.titleMedium, modifier = Modifier.padding(start = 20.dp, top = 18.dp))
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

fun time(ms: Long): String {
    val seconds = ms / 1000
    return "${seconds / 60}:${(seconds % 60).toString().padStart(2, '0')}"
}
