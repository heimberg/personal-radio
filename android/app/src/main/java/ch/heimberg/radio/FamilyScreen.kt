package ch.heimberg.radio

import androidx.compose.foundation.background
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
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import ch.heimberg.radio.core.Family
import ch.heimberg.radio.core.FamilyMember
import ch.heimberg.radio.core.FamilyMessage
import ch.heimberg.radio.core.ago
import kotlinx.coroutines.delay
import java.time.Instant

/**
 * «Familie»: who is there and what they hear (greet them, listen along), then the family chat. Items are
 * shared from their menu in «Programm» or «Archiv». The tab refreshes itself every few seconds while open.
 */
@Composable
fun FamilyScreen(state: RadioState, actions: RadioActions, padding: PaddingValues) {
    LaunchedEffect(Unit) {
        while (true) {
            actions.loadFamily()
            delay(10_000)
        }
    }
    val family = state.family
    Column(Modifier.fillMaxSize().padding(padding).imePadding()) {
        if (family == null) {
            Text("Familie wird geladen …", style = MaterialTheme.typography.bodyMedium, color = Nocturne.muted, modifier = Modifier.padding(20.dp))
            return@Column
        }
        val list = rememberLazyListState()
        LaunchedEffect(family.messages.size) { if (family.messages.isNotEmpty()) list.animateScrollToItem(family.members.size + family.messages.size + 1) }
        LazyColumn(Modifier.weight(1f).fillMaxWidth(), state = list, contentPadding = PaddingValues(bottom = 12.dp)) {
            item(key = "head") {
                Column(Modifier.padding(start = 20.dp, end = 20.dp, top = 18.dp, bottom = 8.dp)) {
                    Text("Familie", style = MaterialTheme.typography.headlineSmall)
                    Text("Beiträge teilst du über ihr Menü im Programm oder Archiv.", style = MaterialTheme.typography.bodySmall, color = Nocturne.muted)
                }
            }
            items(family.members, key = { "member-${it.key}" }) { MemberRow(it, family, actions, state) }
            item(key = "chat") {
                Text("CHAT", style = MaterialTheme.typography.labelSmall, color = Nocturne.accentLight, modifier = Modifier.padding(start = 20.dp, top = 18.dp, bottom = 6.dp))
            }
            if (family.messages.isEmpty()) {
                item(key = "empty") {
                    Text("Noch keine Nachrichten. Schreib die erste!", style = MaterialTheme.typography.bodyMedium, color = Nocturne.muted, modifier = Modifier.padding(horizontal = 20.dp))
                }
            }
            items(family.messages, key = { "message-${it.id}" }) { MessageRow(it, it.from == family.me) }
        }
        Row(Modifier.fillMaxWidth().padding(horizontal = 12.dp, vertical = 8.dp), verticalAlignment = Alignment.CenterVertically) {
            OutlinedTextField(
                value = state.familyDraft, onValueChange = { state.familyDraft = it.take(500) },
                placeholder = { Text("Nachricht an alle") }, maxLines = 4, modifier = Modifier.weight(1f),
            )
            Spacer(Modifier.width(8.dp))
            TextButton(onClick = actions::sendMessage, enabled = state.familyDraft.isNotBlank() && !state.familySending) { Text("Senden") }
        }
    }
    state.greetFor?.let { member -> GreetDialog(member, state, actions) }
}

@Composable
private fun MemberRow(member: FamilyMember, family: Family, actions: RadioActions, state: RadioState) {
    Row(
        Modifier
            .padding(horizontal = 16.dp, vertical = 4.dp)
            .fillMaxWidth()
            .clip(RoundedCornerShape(18.dp))
            .background(Nocturne.surface)
            .padding(start = 12.dp, top = 10.dp, bottom = 10.dp, end = 4.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Box(Modifier.size(40.dp).clip(CircleShape).background(if (member.me) Nocturne.accent else Nocturne.surfaceHigh), contentAlignment = Alignment.Center) {
            Text(member.initial, style = MaterialTheme.typography.titleMedium, color = if (member.me) Nocturne.bg else Nocturne.text)
        }
        Spacer(Modifier.width(12.dp))
        Column(Modifier.weight(1f)) {
            Text(member.name + if (member.me) " (du)" else "", style = MaterialTheme.typography.titleSmall)
            Text(member.status(Instant.now()), style = MaterialTheme.typography.bodySmall, color = if (member.nowPlaying != null) Nocturne.accentLight else Nocturne.muted,
                maxLines = 2, overflow = TextOverflow.Ellipsis)
        }
        if (!member.me) {
            Column(horizontalAlignment = Alignment.End) {
                if (family.canListenAlong(member)) TextButton(onClick = { actions.listenAlong(member) }) { Text("🎧 Auch hören") }
                TextButton(onClick = { state.greetFor = member }) { Text("💌 Gruss") }
            }
        }
    }
}

/** One chat message: own ones on the right; shares and greetings with their icon. */
@Composable
private fun MessageRow(message: FamilyMessage, mine: Boolean) {
    Row(Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 3.dp), horizontalArrangement = if (mine) Arrangement.End else Arrangement.Start) {
        Column(
            Modifier
                .widthIn(max = 300.dp)
                .clip(RoundedCornerShape(16.dp))
                .background(if (mine) Nocturne.accent.copy(alpha = 0.25f) else Nocturne.surface)
                .padding(horizontal = 12.dp, vertical = 8.dp),
        ) {
            val time = runCatching { ago(Instant.parse(message.at), Instant.now()) }.getOrDefault("")
            Text(if (mine) "Du · $time" else "${message.fromName} · $time", style = MaterialTheme.typography.labelSmall, color = Nocturne.muted)
            Text(listOf(message.icon, message.line).filter { it.isNotEmpty() }.joinToString(" "), style = MaterialTheme.typography.bodyMedium)
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
