package ch.heimberg.radio

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
import ch.heimberg.radio.core.ago
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
            Text("Familie wird geladen …", style = MaterialTheme.typography.bodyMedium, color = Nocturne.muted, modifier = Modifier.padding(20.dp))
            return@Column
        }
        val list = rememberLazyListState()
        // The list is anchored at the bottom like a chat (reverseLayout: the first item is the lowest), so the
        // newest message stays above the input even when the space shrinks (mini player, keyboard).
        LaunchedEffect(family.messages.size) { if (family.messages.isNotEmpty()) list.animateScrollToItem(0) }
        LazyColumn(Modifier.weight(1f).fillMaxWidth(), state = list, reverseLayout = true, contentPadding = PaddingValues(bottom = 12.dp)) {
            items(family.messages.asReversed(), key = { "message-${it.id}" }) { message ->
                MessageRow(message, message.from == family.me, family.members.firstOrNull { it.key == message.from }, actions)
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
                TextButton(onClick = actions::chooseAvatar) { Text("🖼  Foto auswählen") }
                TextButton(onClick = actions::takeAvatar) { Text("📷  Foto aufnehmen") }
                if (self?.avatarUrl != null) TextButton(onClick = actions::removeAvatar) { Text("✕  Entfernen", color = Nocturne.danger) }
            }
        },
        confirmButton = { TextButton(onClick = { state.avatarMenuOpen = false }) { Text("Abbrechen") } },
        containerColor = Nocturne.surface,
    )
}

/** Each member has a colour of their own, from the rubrics; one's own card is ink. */
private val MEMBER_KINDS = listOf(Kind.DISCOVER, Kind.MUSIC, Kind.SPECIAL, Kind.STORY, Kind.NEWS)

/** A member as a card in their colour: picture, name big, what they hear, and «Auch hören» and «Gruss». */
@Composable
private fun MemberRow(member: FamilyMember, kind: Kind, family: Family, actions: RadioActions, state: RadioState) {
    val color = if (member.me) Nocturne.text else Nocturne.kind(kind)
    val ink = if (member.me) Nocturne.bg else Nocturne.onKind(kind)
    Column(
        Modifier
            .padding(horizontal = 16.dp, vertical = 5.dp)
            .fillMaxWidth()
            .clip(RoundedCornerShape(20.dp))
            .background(color)
            .padding(14.dp),
    ) {
        Row(verticalAlignment = Alignment.CenterVertically) {
            // One's own picture: a tap changes it.
            Avatar(member, 48.dp, actions, Modifier.then(if (member.me) Modifier.clickable { state.avatarMenuOpen = true } else Modifier))
            Spacer(Modifier.width(12.dp))
            Column(Modifier.weight(1f)) {
                Text((member.name + if (member.me) " (du)" else "").uppercase(), style = display(24), color = ink, maxLines = 1, overflow = TextOverflow.Ellipsis)
                if (member.me && state.avatarBusy) Text("Profilbild wird gespeichert …", style = MaterialTheme.typography.bodySmall, color = ink.copy(alpha = 0.8f))
                else if (member.me && member.avatarUrl == null) Text("Tippe auf den Kreis für ein Profilbild", style = MaterialTheme.typography.bodySmall, color = ink.copy(alpha = 0.8f))
                Text(
                    (if (member.nowPlaying != null) "▶ " else "") + member.status(Instant.now()),
                    style = MaterialTheme.typography.bodyMedium, color = ink, maxLines = 2, overflow = TextOverflow.Ellipsis,
                )
            }
        }
        if (!member.me) {
            Row(Modifier.padding(top = 10.dp), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                if (family.canListenAlong(member)) Pill("🎧 Auch hören", ink) { actions.listenAlong(member) }
                Pill("💌 Gruss", ink) { state.greetFor = member }
            }
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

/** One chat message: own ones on the right; others' with their picture; shares and greetings with their icon. */
@Composable
private fun MessageRow(message: FamilyMessage, mine: Boolean, sender: FamilyMember?, actions: RadioActions) {
    Row(Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 3.dp), horizontalArrangement = if (mine) Arrangement.End else Arrangement.Start,
        verticalAlignment = Alignment.Bottom) {
        if (!mine && sender != null) {
            Avatar(sender, 28.dp, actions)
            Spacer(Modifier.width(6.dp))
        }
        Column(
            Modifier
                .widthIn(max = 300.dp)
                .clip(RoundedCornerShape(16.dp))
                .background(if (mine) Nocturne.text else Nocturne.surface)
                .then(if (mine) Modifier else Modifier.border(1.dp, Nocturne.divider, RoundedCornerShape(16.dp)))
                .padding(horizontal = 12.dp, vertical = 8.dp),
        ) {
            val time = runCatching { ago(Instant.parse(message.at), Instant.now()) }.getOrDefault("")
            Text(if (mine) "Du · $time" else "${message.fromName} · $time", style = MaterialTheme.typography.labelSmall, color = if (mine) Nocturne.bg.copy(alpha = 0.7f) else Nocturne.muted)
            Text(listOf(message.icon, message.line).filter { it.isNotEmpty() }.joinToString(" "), style = MaterialTheme.typography.bodyMedium, color = if (mine) Nocturne.bg else Nocturne.text)
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
