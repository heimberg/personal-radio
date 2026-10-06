package ch.heimberg.radio

import java.util.Locale
import java.time.format.DateTimeFormatter
import java.time.ZoneId
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.OutlinedTextFieldDefaults
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import ch.heimberg.radio.core.Family
import ch.heimberg.radio.core.FamilyMember
import ch.heimberg.radio.core.FamilyMessage
import ch.heimberg.radio.core.Kind
import coil.compose.AsyncImage
import java.time.Instant
import kotlinx.coroutines.delay

/**
 * «Familie»: who is there and what they hear (greet them, listen along), then the family chat. Items are
 * shared from their menu in «Programm» or «Archiv». The tab refreshes itself every few seconds while open.
 */
@Composable
fun FamilyScreen(state: RadioState, actions: RadioActions, padding: PaddingValues) {
    LaunchedEffect(Unit) {
        while (true) {
            actions.loadFamily()
            // Chat and «wer hört was» every half minute; sending a message reloads at once.
            delay(30_000)
        }
    }
    val family = state.family
    Column(Modifier.fillMaxSize().padding(padding).imePadding()) {
        if (family == null) {
            SkeletonRows(4, "Familie", Modifier.padding(20.dp))
            return@Column
        }
        val list = rememberLazyListState()
        // The list is anchored at the bottom like a chat (reverseLayout: the first item is the lowest), so the
        // newest message stays above the input even when the space shrinks (mini player, keyboard).
        LaunchedEffect(family.messages.size) { if (family.messages.isNotEmpty()) list.animateScrollToItem(0) }
        LazyColumn(Modifier.weight(1f).fillMaxWidth(), state = list, reverseLayout = true, contentPadding = PaddingValues(bottom = 12.dp)) {
            for (entry in chatEntries(family.messages, Instant.now()).asReversed()) when (entry) {
                is ChatEntry.Day -> item(key = "day-${entry.label}-${entry.firstId}") { DayDivider(entry.label) }
                is ChatEntry.Message -> item(key = "message-${entry.message.id}") {
                    Box(Modifier.animateItem()) { MessageRow(entry, entry.message.from == family.me, family.members.firstOrNull { it.key == entry.message.from }, actions) }
                }
            }
            if (family.messages.isEmpty()) {
                item(key = "empty") {
                    Text("Noch keine Nachrichten. Schreib die erste!", style = MaterialTheme.typography.bodyMedium, color = Nocturne.muted, modifier = Modifier.padding(horizontal = 20.dp))
                }
            }
            item(key = "chat") {
                Text("CHAT", style = Kicker, color = Nocturne.muted, modifier = Modifier.padding(start = 20.dp, top = 22.dp, bottom = 6.dp))
            }
            val members = family.members.withIndex().toList().asReversed()
            items(members, key = { "member-${it.value.key}" }) { (index, member) -> MemberRow(member, MEMBER_KINDS[index % MEMBER_KINDS.size], family, actions, state) }
            item(key = "head") {
                Column(Modifier.padding(start = 20.dp, end = 20.dp, top = 18.dp, bottom = 8.dp)) {
                    ScreenTitle("Familie")
                    Text("Beiträge teilst du über ihr Menü im Programm oder Archiv.", style = MaterialTheme.typography.bodySmall, color = Nocturne.muted)
                }
            }
        }
        Row(Modifier.fillMaxWidth().padding(horizontal = 12.dp, vertical = 8.dp), verticalAlignment = Alignment.CenterVertically) {
            OutlinedTextField(
                value = state.familyDraft, onValueChange = { state.familyDraft = it.take(500) },
                placeholder = { Text("Nachricht an alle") }, maxLines = 4, modifier = Modifier.weight(1f),
                shape = RoundedCornerShape(22.dp),
                colors = OutlinedTextFieldDefaults.colors(
                    focusedBorderColor = Nocturne.text, unfocusedBorderColor = Nocturne.divider,
                    focusedContainerColor = Nocturne.surface, unfocusedContainerColor = Nocturne.surface,
                ),
            )
            Spacer(Modifier.width(8.dp))
            val canSend = state.familyDraft.isNotBlank() && !state.familySending
            Text(
                "Senden", style = MaterialTheme.typography.labelLarge, color = Nocturne.bg,
                modifier = Modifier
                    .clip(RoundedCornerShape(999.dp))
                    .background(if (canSend) Nocturne.accent else Nocturne.faint)
                    .clickable(enabled = canSend, onClick = actions::sendMessage)
                    .padding(horizontal = 18.dp, vertical = 14.dp),
            )
        }
    }
    state.greetFor?.let { member -> GreetDialog(member, state, actions) }
    if (state.avatarMenuOpen) AvatarMenu(family?.self, state, actions)
}

/** One's own profile picture: from the gallery, a new photo, or none. */
@Composable
private fun AvatarMenu(self: FamilyMember?, state: RadioState, actions: RadioActions) {
    AlertDialog(
        onDismissRequest = { state.avatarMenuOpen = false },
        title = { Text("Profilbild") },
        text = {
            Column {
                Text("Alle in der Familie sehen es. Es bleibt auf deinem Radio-Server.", style = MaterialTheme.typography.bodySmall, color = Nocturne.muted)
                Spacer(Modifier.size(8.dp))
                TextButton(onClick = actions::chooseAvatar) { IconText(R.drawable.ic_image, "Foto auswählen") }
                TextButton(onClick = actions::takeAvatar) { IconText(R.drawable.ic_camera, "Foto aufnehmen") }
                if (self?.avatarUrl != null) TextButton(onClick = actions::removeAvatar) { IconText(R.drawable.ic_trash, "Entfernen", Nocturne.danger) }
            }
        },
        confirmButton = { TextButton(onClick = { state.avatarMenuOpen = false }) { Text("Abbrechen") } },
        containerColor = Nocturne.surface,
    )
}

/** Each member has a colour of their own, from the rubrics; one's own card is ink. */
private val MEMBER_KINDS = listOf(Kind.DISCOVER, Kind.MUSIC, Kind.SPECIAL, Kind.STORY, Kind.NEWS)

/** A member as a slim card in their colour: picture, name, what they hear, and «Auch hören» and «Gruss». */
@Composable
private fun MemberRow(member: FamilyMember, kind: Kind, family: Family, actions: RadioActions, state: RadioState) {
    val color = if (member.me) Nocturne.text else Nocturne.kind(kind)
    val ink = if (member.me) Nocturne.bg else Nocturne.onKind(kind)
    Row(
        Modifier
            .padding(horizontal = 16.dp, vertical = 4.dp)
            .fillMaxWidth()
            .clip(RoundedCornerShape(18.dp))
            .background(color)
            .padding(horizontal = 12.dp, vertical = 10.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        // One's own picture: a tap changes it.
        Avatar(member, 40.dp, actions, Modifier.then(if (member.me) Modifier.clickable { state.avatarMenuOpen = true } else Modifier))
        Spacer(Modifier.width(12.dp))
        Column(Modifier.weight(1f)) {
            Text((member.name + if (member.me) " (du)" else "").uppercase(), style = display(18), color = ink, maxLines = 1, overflow = TextOverflow.Ellipsis)
            val status = when {
                member.me && state.avatarBusy -> "Profilbild wird gespeichert …"
                member.me && member.avatarUrl == null -> "Tippe auf den Kreis für ein Profilbild"
                else -> (if (member.nowPlaying != null) "▶ " else "") + member.status(Instant.now())
            }
            Text(status, style = MaterialTheme.typography.bodySmall, color = ink.copy(alpha = 0.85f), maxLines = 1, overflow = TextOverflow.Ellipsis)
        }
        if (!member.me) {
            if (family.canListenAlong(member)) {
                Pill("🎧", ink) { actions.listenAlong(member) }
                Spacer(Modifier.width(6.dp))
            }
            Pill("💌 Gruss", ink) { state.greetFor = member }
        }
    }
}

/** A small button on a coloured card: the card's text colour, lightly filled. */
@Composable
private fun Pill(label: String, ink: Color, onClick: () -> Unit) {
    Text(
        label, style = MaterialTheme.typography.labelLarge, color = ink,
        modifier = Modifier
            .clip(RoundedCornerShape(999.dp))
            .background(ink.copy(alpha = 0.18f))
            .clickable(onClick = onClick)
            .padding(horizontal = 14.dp, vertical = 8.dp),
    )
}

/** A member's profile picture, or the first letter of their name on a round badge. */
@Composable
fun Avatar(member: FamilyMember, extent: Dp, actions: RadioActions, modifier: Modifier = Modifier) {
    Box(modifier.size(extent).clip(CircleShape).background(if (member.me) Nocturne.bg else Nocturne.surface), contentAlignment = Alignment.Center) {
        Text(member.initial, style = display(if (extent >= 40.dp) 22 else 14), color = Nocturne.text)
        member.avatarUrl?.let { url ->
            AsyncImage(model = actions.workerImage(url), contentDescription = member.name, contentScale = ContentScale.Crop, modifier = Modifier.matchParentSize())
        }
    }
}

/** The chat as it is shown: a divider per day, and runs of one sender with the name on the first and the picture on the last. */
private sealed interface ChatEntry {
    data class Day(val label: String, val firstId: Long) : ChatEntry
    data class Message(val message: FamilyMessage, val first: Boolean, val last: Boolean, val time: String) : ChatEntry
}

private val chatClock = DateTimeFormatter.ofPattern("HH:mm").withZone(ZoneId.systemDefault())
private val chatDate = DateTimeFormatter.ofPattern("EEEE, d. MMMM", Locale.GERMAN)

private fun chatEntries(messages: List<FamilyMessage>, now: Instant): List<ChatEntry> {
    val zone = ZoneId.systemDefault()
    val today = now.atZone(zone).toLocalDate()
    val at = messages.map { runCatching { Instant.parse(it.at) }.getOrNull() }
    val day = at.map { it?.atZone(zone)?.toLocalDate() }
    val entries = mutableListOf<ChatEntry>()
    for ((index, message) in messages.withIndex()) {
        val date = day[index]
        if (index == 0 || date != day[index - 1]) {
            val label = when {
                date == null -> "Früher"
                date == today -> "Heute"
                date == today.minusDays(1) -> "Gestern"
                date.isAfter(today.minusDays(7)) -> date.format(DateTimeFormatter.ofPattern("EEEE", Locale.GERMAN))
                else -> date.format(chatDate)
            }
            entries += ChatEntry.Day(label, message.id)
        }
        val sameAsBefore = index > 0 && messages[index - 1].from == message.from && day[index - 1] == date
        val sameAsAfter = index < messages.size - 1 && messages[index + 1].from == message.from && day[index + 1] == date
        entries += ChatEntry.Message(message, first = !sameAsBefore, last = !sameAsAfter, time = at[index]?.let(chatClock::format) ?: "")
    }
    return entries
}

@Composable
private fun DayDivider(label: String) {
    Text(label, style = MaterialTheme.typography.labelSmall, color = Nocturne.muted, textAlign = TextAlign.Center,
        modifier = Modifier.fillMaxWidth().padding(top = 12.dp, bottom = 4.dp))
}

/** One chat message: own ones on the right; others' with their name on the first of a run and their picture on the last. */
@Composable
private fun MessageRow(entry: ChatEntry.Message, mine: Boolean, sender: FamilyMember?, actions: RadioActions) {
    val message = entry.message
    Row(Modifier.fillMaxWidth().padding(start = 16.dp, end = 16.dp, top = if (entry.first) 4.dp else 1.dp, bottom = 1.dp),
        horizontalArrangement = if (mine) Arrangement.End else Arrangement.Start, verticalAlignment = Alignment.Bottom) {
        if (!mine) {
            if (entry.last && sender != null) Avatar(sender, 28.dp, actions) else Spacer(Modifier.width(28.dp))
            Spacer(Modifier.width(6.dp))
        }
        Column(
            Modifier
                .widthIn(max = 300.dp)
                .clip(RoundedCornerShape(16.dp))
                .background(if (mine) Nocturne.text else Nocturne.surface)
                .then(if (mine) Modifier else Modifier.border(1.dp, Nocturne.divider, RoundedCornerShape(16.dp)))
                .padding(horizontal = 12.dp, vertical = 7.dp),
        ) {
            if (!mine && entry.first) Text(message.fromName, style = MaterialTheme.typography.labelSmall, color = Nocturne.muted)
            Row(verticalAlignment = Alignment.Bottom) {
                Text(listOf(message.icon, message.line).filter { it.isNotEmpty() }.joinToString(" "), style = MaterialTheme.typography.bodyMedium,
                    color = if (mine) Nocturne.bg else Nocturne.text, modifier = Modifier.weight(1f, fill = false))
                Spacer(Modifier.width(8.dp))
                Text(entry.time, style = MaterialTheme.typography.labelSmall, color = if (mine) Nocturne.bg.copy(alpha = 0.6f) else Nocturne.faint)
            }
        }
    }
}

/** A greeting the host reads in the other person's next live transition. */
@Composable
private fun GreetDialog(member: FamilyMember, state: RadioState, actions: RadioActions) {
    var text by remember(member.key) { mutableStateOf("") }
    AlertDialog(
        onDismissRequest = { state.greetFor = null },
        title = { Text("Gruss an ${member.name}") },
        text = {
            Column {
                Text("Die Moderation liest ihn im nächsten Übergang in ${member.name}s Radio vor. Er steht auch im Chat.",
                    style = MaterialTheme.typography.bodySmall, color = Nocturne.muted)
                Spacer(Modifier.size(8.dp))
                OutlinedTextField(value = text, onValueChange = { text = it.take(200) }, placeholder = { Text("z. B. Schlaf gut und bis morgen!") }, maxLines = 4)
            }
        },
        confirmButton = {
            TextButton(onClick = { state.greetFor = null; actions.greet(member, text) }, enabled = text.isNotBlank()) { Text("Senden") }
        },
        dismissButton = { TextButton(onClick = { state.greetFor = null }) { Text("Abbrechen") } },
        containerColor = Nocturne.surface,
    )
}
