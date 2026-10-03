package ch.heimberg.radio

import androidx.compose.animation.animateColorAsState
import androidx.compose.animation.core.animateFloatAsState
import androidx.compose.animation.core.tween
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.interaction.MutableInteractionSource
import androidx.compose.foundation.interaction.collectIsPressedAsState
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxWithConstraints
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
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.remember
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.draw.drawBehind
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.rememberTextMeasurer
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import ch.heimberg.radio.core.Headline
import ch.heimberg.radio.core.Looks
import ch.heimberg.radio.core.Moods
import ch.heimberg.radio.core.TimelineItem
import java.time.ZoneId
import java.time.format.DateTimeFormatter

private val clock = DateTimeFormatter.ofPattern("HH:mm").withZone(ZoneId.systemDefault())

/** «Hören»: the player in full and what comes right after it with «Anders»; the building blocks are in «Programm». */
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
        Spacer(Modifier.height(10.dp))
        PlayerCard(state, actions)
        MitmachenCard(state, actions)
        PlayRow(state, actions)
        state.sections.next?.let { NextCard(it, state, actions) }
    }
}

@Composable
private fun Header(state: RadioState) {
    Row(Modifier.fillMaxWidth().padding(start = 20.dp, end = 20.dp, top = 20.dp, bottom = 12.dp), verticalAlignment = Alignment.CenterVertically) {
        Text("PERSONAL RADIO", style = display(26), letterSpacing = 0.5.sp, modifier = Modifier.weight(1f), maxLines = 1)
        StatusChip(state)
    }
}

/** «LIVE» with a red dot while audio plays, otherwise one word for the state; the sleep timer when it is set. */
@Composable
private fun StatusChip(state: RadioState) {
    val text = when {
        state.sleepLabel != null -> "🌙 ${state.sleepLabel}"
        state.live -> "LIVE"
        state.phase == Phase.ENDED -> "WARTET"
        else -> state.phase.label.uppercase()
    }
    val dot by animateColorAsState(if (state.live) Nocturne.live else Nocturne.faint, tween(400), label = "live")
    Row(
        Modifier.background(Nocturne.text, RoundedCornerShape(6.dp)).padding(horizontal = 10.dp, vertical = 6.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Box(Modifier.size(7.dp).background(dot, CircleShape))
        Spacer(Modifier.width(6.dp))
        Text(text, style = Kicker.copy(letterSpacing = 1.sp), color = Nocturne.bg, maxLines = 1)
    }
}

/** «Heute»: one tap leans the rest of the day; a second tap on the same chip returns to the plan. */
@Composable
private fun MoodChips(state: RadioState, actions: RadioActions) {
    LazyRow(contentPadding = PaddingValues(horizontal = 16.dp), horizontalArrangement = Arrangement.spacedBy(8.dp), verticalAlignment = Alignment.CenterVertically) {
        item { Text("HEUTE", style = Kicker, color = Nocturne.muted, modifier = Modifier.padding(start = 4.dp, end = 2.dp)) }
        items(Moods.ALL, key = { it.id }) { mood ->
            val selected = state.mood == mood.id
            FilterChip(
                selected = selected,
                onClick = { actions.setMood(if (selected) null else mood.id) },
                label = { Text("${mood.icon}  ${mood.label}") },
                colors = FilterChipDefaults.filterChipColors(selectedContainerColor = Nocturne.text, selectedLabelColor = Nocturne.bg),
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
    // A slim note, and only when music is coming within the hour.
    if (state.spotifyNeeded && state.musicSoon) {
        val music = Nocturne.kind(ch.heimberg.radio.core.Kind.MUSIC)
        Row(
            Modifier
                .padding(horizontal = 16.dp, vertical = 4.dp)
                .fillMaxWidth()
                .background(music.copy(alpha = 0.12f), RoundedCornerShape(14.dp))
                .border(1.dp, music.copy(alpha = 0.35f), RoundedCornerShape(14.dp))
                .padding(start = 14.dp, end = 4.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Icon(painterResource(R.drawable.ic_spotify), null, Modifier.size(16.dp), tint = music)
            Spacer(Modifier.width(10.dp))
            Text("Bald Musik – Spotify ist nicht verbunden.", style = MaterialTheme.typography.bodySmall, modifier = Modifier.weight(1f))
            TextButton(onClick = actions::connectSpotify, enabled = !state.spotifyBusy) { Text("Verbinden") }
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

/**
 * On air: a big card filled with the rubric's colour, the title set big and condensed, the album or rings
 * in the corner, and the progress as swaying bars. Below it the controls in ink.
 */
@Composable
private fun PlayerCard(state: RadioState, actions: RadioActions) {
    val look = state.look
    if (!state.hasMedia) return StartState(state, actions)
    val tint by animateColorAsState(Nocturne.kind(look?.kind), tween(600), label = "kind")
    val ink by animateColorAsState(Nocturne.onKind(look?.kind), tween(600), label = "ink")
    val (head, rest) = Headline.split(state.title)
    Column(
        Modifier
            .padding(horizontal = 16.dp)
            .fillMaxWidth()
            .clip(RoundedCornerShape(22.dp))
            .background(tint)
            .clickable(enabled = state.currentItemId != null) { actions.transcript() }
            .drawBehind {
                // Rings to the right, like the station's mark.
                val center = Offset(size.width - 30.dp.toPx(), size.height * 0.36f)
                for (ring in listOf(30, 65, 100, 128)) drawCircle(ink.copy(alpha = 0.3f), radius = ring.dp.toPx(), center = center, style = Stroke(2.dp.toPx()))
            }
            .padding(22.dp),
    ) {
        Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.Top) {
            Text(
                // The show's name only when it says more than the title below.
                listOfNotNull(look?.kind?.label, state.show.ifBlank { null }?.takeUnless { it.equals(head, ignoreCase = true) })
                    .joinToString(" · ").uppercase(),
                style = Kicker.copy(fontSize = 13.sp, letterSpacing = 1.sp), color = ink, maxLines = 2, overflow = TextOverflow.Ellipsis, modifier = Modifier.weight(1f),
            )
            if (state.coverUrl != null) {
                Spacer(Modifier.width(12.dp))
                Cover(look, state.coverUrl, 96.dp)
            }
        }
        Spacer(Modifier.height(if (state.coverUrl != null) 24.dp else 96.dp))
        HeadTitle(head.uppercase(), ink)
        rest?.let {
            Spacer(Modifier.height(10.dp))
            Text(it, style = MaterialTheme.typography.bodyLarge.copy(fontSize = 17.sp, lineHeight = 22.sp), color = ink, maxLines = 3, overflow = TextOverflow.Ellipsis)
        }
        Spacer(Modifier.height(18.dp))
        Waveform(state.progress, state.live, ink, Modifier.fillMaxWidth().height(24.dp), rest = ink.copy(alpha = 0.3f))
        Row(Modifier.fillMaxWidth().padding(top = 6.dp)) {
            Text(time(state.positionMs), style = MaterialTheme.typography.labelMedium, color = ink)
            Spacer(Modifier.weight(1f))
            Text(if (state.durationMs > 0) "−" + time((state.durationMs - state.positionMs).coerceAtLeast(0)) else "", style = MaterialTheme.typography.labelMedium, color = ink)
        }
    }
    Row(Modifier.fillMaxWidth().padding(horizontal = 24.dp, vertical = 12.dp), horizontalArrangement = Arrangement.SpaceBetween, verticalAlignment = Alignment.CenterVertically) {
        RoundIcon(R.drawable.ic_thumbs_down, "Weniger davon") { actions.rate(false) }
        PlayButton(state, actions, 78.dp)
        RoundIcon(R.drawable.ic_skip_forward, "Weiter") { actions.next() }
        RoundIcon(R.drawable.ic_thumbs_up, "Mehr davon") { actions.rate(true) }
    }
    // Five small actions: they scroll sideways on a narrow screen.
    Row(Modifier.fillMaxWidth().horizontalScroll(rememberScrollState()).padding(horizontal = 8.dp)) {
        SmallAction(R.drawable.ic_info, "Text") { actions.transcript() }
        SmallAction(R.drawable.ic_question, "Nachfragen") { actions.askAbout() }
        SmallAction(R.drawable.ic_plus_circle, "Mehr dazu") { actions.deepen() }
        val marked = state.bookmarked(state.currentItemId)
        SmallAction(if (marked) R.drawable.ic_bookmark_fill else R.drawable.ic_bookmark, if (marked) "Gemerkt" else "Merken", highlighted = marked) { actions.toggleBookmark() }
        SmallAction(R.drawable.ic_moon, if (state.sleepLabel != null) "Timer an" else "Schlafen", highlighted = state.sleepLabel != null) { state.sleepOpen = true }
    }
}

/**
 * The title big and condensed: short ones very big, longer ones smaller, and never so big that a word
 * breaks in the middle («ORTSGESCHICHT-E»): the size shrinks until the longest word fits on one line.
 */
@Composable
private fun HeadTitle(text: String, ink: Color) {
    BoxWithConstraints(Modifier.fillMaxWidth()) {
        val measurer = rememberTextMeasurer()
        val width = constraints.maxWidth
        val size = remember(text, width) {
            val longest = text.split(' ').maxByOrNull { it.length } ?: text
            var size = if (text.length <= 12) 72 else if (text.length <= 24) 52 else 38
            while (size > 22 && measurer.measure(longest, display(size), softWrap = false, maxLines = 1).size.width > width) size -= 2
            size
        }
        Text(text, style = display(size), color = ink, maxLines = 4, overflow = TextOverflow.Ellipsis)
    }
}

/** The round ink button: play or pause; it grows a little while it is pressed. */
@Composable
private fun PlayButton(state: RadioState, actions: RadioActions, extent: Dp) {
    val press = remember { MutableInteractionSource() }
    val pressed by press.collectIsPressedAsState()
    val scale by animateFloatAsState(if (pressed) 0.92f else 1f, tween(120), label = "press")
    Box(
        Modifier
            .size(extent)
            .graphicsLayer { scaleX = scale; scaleY = scale }
            .clip(CircleShape)
            .background(Nocturne.accent)
            .clickable(interactionSource = press, indication = null) { actions.togglePlay() }
            .semantics { contentDescription = if (state.playWhenReady) "Pause" else "Hören" },
        contentAlignment = Alignment.Center,
    ) {
        Icon(painterResource(if (state.playWhenReady) R.drawable.ic_pause else R.drawable.ic_play), null, Modifier.size(extent * 0.36f), tint = Nocturne.bg)
    }
}

/**
 * Before anything plays: an ink card with what is ready and what comes first, and one big «Jetzt hören».
 * The rating buttons wait until there is something to rate.
 */
@Composable
private fun StartState(state: RadioState, actions: RadioActions) {
    val first = state.sections.next ?: state.open.firstOrNull()
    val ready = state.readyCount
    val firstKind = first?.let { Looks.of(it).kind }
    Column(
        Modifier
            .padding(horizontal = 16.dp)
            .fillMaxWidth()
            .clip(RoundedCornerShape(22.dp))
            .background(Nocturne.text)
            .padding(22.dp),
    ) {
        Text(if (ready > 0) "BEREIT" else "IN ARBEIT", style = Kicker.copy(fontSize = 13.sp), color = Nocturne.bg.copy(alpha = 0.7f))
        Spacer(Modifier.height(40.dp))
        Text(
            (if (ready > 0) "Dein Programm ist bereit" else "Dein Programm entsteht").uppercase(),
            style = display(52), color = Nocturne.bg,
        )
        Spacer(Modifier.height(10.dp))
        Text(
            when {
                ready > 0 && first != null -> "$ready ${if (ready == 1) "Beitrag" else "Beiträge"} fertig · als Erstes: ${first.displayTitle}"
                first != null -> "Der erste Beitrag wird gerade produziert – das dauert ein paar Minuten."
                else -> "Tippe auf «Jetzt hören», dann plant und produziert der Server dein Programm."
            },
            style = MaterialTheme.typography.bodyLarge, color = Nocturne.bg.copy(alpha = 0.85f), maxLines = 3, overflow = TextOverflow.Ellipsis,
        )
        Spacer(Modifier.height(20.dp))
        Row(
            Modifier
                .fillMaxWidth()
                .height(56.dp)
                .clip(RoundedCornerShape(999.dp))
                .background(firstKind?.let { Nocturne.kind(it) } ?: Nocturne.bg)
                .clickable { actions.togglePlay() },
            horizontalArrangement = Arrangement.Center,
            verticalAlignment = Alignment.CenterVertically,
        ) {
            val ink = firstKind?.let { Nocturne.onKind(it) } ?: Nocturne.text
            Icon(painterResource(R.drawable.ic_play), null, Modifier.size(20.dp), tint = ink)
            Spacer(Modifier.width(10.dp))
            Text(if (state.playWhenReady) "Startet gleich …" else "Jetzt hören", style = MaterialTheme.typography.titleMedium, color = ink)
        }
    }
}

@Composable
private fun RoundIcon(icon: Int, label: String, onClick: () -> Unit) {
    IconButton(onClick = onClick, modifier = Modifier.size(48.dp).background(Nocturne.surfaceHigh, CircleShape)) {
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

/** «Gleich»: the next item on its rubric's colour, with its start time; «Anders» puts something different in its place. */
@Composable
private fun NextCard(item: TimelineItem, state: RadioState, actions: RadioActions) {
    val look = Looks.of(item)
    val ink = Nocturne.onKind(look.kind)
    Row(
        Modifier
            .padding(horizontal = 16.dp, vertical = 12.dp)
            .fillMaxWidth()
            .clip(RoundedCornerShape(18.dp))
            .background(Nocturne.kind(look.kind))
            .clickable { if (item.isPlayable) actions.play(item) else state.actionsFor = item }
            .padding(start = 14.dp, end = 10.dp, top = 12.dp, bottom = 12.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        state.starts[item.id]?.let {
            Text(clock.format(it), style = display(22), color = ink)
            Spacer(Modifier.width(12.dp))
        }
        Column(Modifier.weight(1f)) {
            Text("GLEICH · ${look.kind.label.uppercase()}", style = Kicker.copy(fontSize = 11.sp, letterSpacing = 1.sp), color = ink.copy(alpha = 0.85f), maxLines = 1)
            Text(item.displayTitle, style = MaterialTheme.typography.titleSmall, color = ink, maxLines = 2, overflow = TextOverflow.Ellipsis)
        }
        Spacer(Modifier.width(8.dp))
        Row(
            Modifier
                .clip(RoundedCornerShape(999.dp))
                .background(ink.copy(alpha = 0.18f))
                .clickable { actions.swap(item) }
                .padding(horizontal = 12.dp, vertical = 8.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Icon(painterResource(R.drawable.ic_dice), null, Modifier.size(16.dp), tint = ink)
            Spacer(Modifier.width(6.dp))
            Text("Anders", style = MaterialTheme.typography.labelLarge, color = ink)
        }
    }
}

fun time(ms: Long): String {
    val seconds = ms / 1000
    return "${seconds / 60}:${(seconds % 60).toString().padStart(2, '0')}"
}
