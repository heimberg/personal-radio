package ch.heimberg.radio

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ExperimentalLayoutApi
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.FilledTonalButton
import androidx.compose.material3.FilterChip
import androidx.compose.material3.FilterChipDefaults
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Switch
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.alpha
import androidx.compose.ui.draw.clip
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import ch.heimberg.radio.core.Mitmachen
import ch.heimberg.radio.core.StoryCards
import ch.heimberg.radio.core.TimelineItem

/** «Frag das Radio» and the sticker album, under the player; each only where the station offers it. */
@Composable
fun PlayRow(state: RadioState, actions: RadioActions) {
    val play = state.play
    if (!play.ask && !play.album) return
    Row(Modifier.padding(horizontal = 16.dp, vertical = 4.dp).fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(10.dp)) {
        if (play.ask) FilledTonalButton(onClick = { state.askOpen = true }, modifier = Modifier.weight(1f)) { IconText(R.drawable.ic_question, "Frag das Radio") }
        if (play.album) OutlinedButton(onClick = actions::openAlbum, modifier = Modifier.weight(1f)) { IconText(R.drawable.ic_sticker, "Sticker · ${play.stickers}") }
    }
}

/**
 * Mitmachen on «Hören»: how the story goes on (two big picture buttons), or the quiz question with A, B
 * and C – for what plays, or for something heard a little earlier that still waits for an answer.
 */
@Composable
fun MitmachenCard(state: RadioState, actions: RadioActions) {
    val item = state.mitmachen ?: return
    val sending = state.playSending == item.id
    Column(
        Modifier
            .padding(horizontal = 16.dp, vertical = 8.dp)
            .fillMaxWidth()
            .clip(RoundedCornerShape(24.dp))
            .background(Nocturne.accent.copy(alpha = 0.14f))
            .border(1.dp, Nocturne.accent.copy(alpha = 0.45f), RoundedCornerShape(24.dp))
            .padding(16.dp),
    ) {
        val choice = item.choice?.takeIf { it.open }
        val quiz = item.quiz?.takeIf { it.open }
        Text(if (choice != null) "DU ENTSCHEIDEST" else "QUIZ", style = MaterialTheme.typography.labelSmall, color = Nocturne.accentLight)
        Text(if (choice != null) choice.question else quiz?.question ?: "", style = MaterialTheme.typography.titleMedium, modifier = Modifier.padding(top = 2.dp, bottom = 10.dp))
        if (choice != null) {
            Row(horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                choice.options.forEachIndexed { index, option ->
                    BigChoice(option.emoji, option.label, enabled = !sending, modifier = Modifier.weight(1f)) { actions.choose(item, index) }
                }
            }
            Hint(item, "Die nächste Folge erzählt, was du wählst.")
        } else if (quiz != null) {
            quiz.options.forEachIndexed { index, option ->
                QuizAnswer(Mitmachen.letter(index), option, enabled = !sending) { actions.answer(item, index) }
            }
            Hint(item, "Eine richtige Antwort bringt einen Sticker.")
        }
    }
}

@Composable
private fun Hint(item: TimelineItem, text: String) {
    val from = if (item.isHeard) "Zu «${item.displayTitle}». " else ""
    Text(from + text, style = MaterialTheme.typography.bodySmall, color = Nocturne.muted, modifier = Modifier.padding(top = 8.dp))
}

@Composable
private fun BigChoice(emoji: String, label: String, enabled: Boolean, modifier: Modifier, onClick: () -> Unit) {
    Column(
        modifier
            .clip(RoundedCornerShape(18.dp))
            .background(Nocturne.surface)
            .clickable(enabled = enabled, onClick = onClick)
            .padding(vertical = 14.dp, horizontal = 8.dp),
        horizontalAlignment = Alignment.CenterHorizontally,
    ) {
        Text(emoji, fontSize = 40.sp)
        Spacer(Modifier.height(6.dp))
        Text(label, style = MaterialTheme.typography.titleSmall, textAlign = TextAlign.Center)
    }
}

@Composable
private fun QuizAnswer(letter: String, text: String, enabled: Boolean, onClick: () -> Unit) {
    Row(
        Modifier
            .padding(vertical = 4.dp)
            .fillMaxWidth()
            .clip(RoundedCornerShape(14.dp))
            .background(Nocturne.surface)
            .clickable(enabled = enabled, onClick = onClick)
            .padding(horizontal = 14.dp, vertical = 12.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Text(letter, style = MaterialTheme.typography.titleMedium, color = Nocturne.accentLight, fontWeight = FontWeight.Bold)
        Spacer(Modifier.width(12.dp))
        Text(text, style = MaterialTheme.typography.bodyLarge)
    }
}

/** The dialogs of Mitmachen: a question to the radio, the album, a new sticker, the picture cards of a story. */
@Composable
fun MitmachenDialogs(state: RadioState, actions: RadioActions) {
    if (state.askOpen) AskDialog(state, actions)
    if (state.albumOpen) AlbumDialog(state)
    state.newSticker?.let { sticker ->
        AlertDialog(
            onDismissRequest = { state.newSticker = null },
            title = { Text("Neuer Sticker!") },
            text = {
                Column(Modifier.fillMaxWidth(), horizontalAlignment = Alignment.CenterHorizontally) {
                    Text(sticker.emoji, fontSize = 72.sp)
                    Text(sticker.name, style = MaterialTheme.typography.titleLarge)
                }
            },
            confirmButton = { TextButton(onClick = { state.newSticker = null; actions.openAlbum() }) { Text("Ins Album") } },
            dismissButton = { TextButton(onClick = { state.newSticker = null }) { Text("Super") } },
            containerColor = Nocturne.surface,
        )
    }
    state.storyCardsFor?.let { block -> StoryCardsDialog(block, state, actions) }
}

/** «Frag das Radio» (answered in the next transition), or with [RadioState.askAbout] a question about one item (answered right after it). */
@Composable
private fun AskDialog(state: RadioState, actions: RadioActions) {
    val about = state.askAbout
    val close = { state.askOpen = false; state.askAbout = null }
    AlertDialog(
        onDismissRequest = close,
        title = { Text(if (about != null) "Nachfragen" else "Frag das Radio") },
        text = {
            Column {
                Text(
                    if (about != null) "Zu «${about.displayTitle}». Die Antwort kommt gleich nach diesem Beitrag, aus seinen Quellen (und wenn nötig einer kurzen Suche)."
                    else "Die Moderation beantwortet deine Frage im nächsten Übergang – mit deinem Namen. Die Familie sieht sie im Chat.",
                    style = MaterialTheme.typography.bodySmall, color = Nocturne.muted,
                )
                Spacer(Modifier.height(8.dp))
                OutlinedTextField(value = state.askDraft, onValueChange = { state.askDraft = it.take(if (about != null) 300 else 200) }, maxLines = 4,
                    placeholder = { Text(if (about != null) "z. B. Was heisst das für die Schweiz?" else "z. B. Warum ist der Himmel blau?") }, modifier = Modifier.fillMaxWidth())
                TextButton(onClick = actions::dictate) { IconText(R.drawable.ic_microphone, "Sprechen statt tippen") }
                if (state.asking && about != null) Text("Die Redaktion sucht die Antwort …", style = MaterialTheme.typography.bodySmall, color = Nocturne.accentLight)
            }
        },
        confirmButton = {
            TextButton(onClick = { if (about != null) actions.sendQuestion() else actions.ask() }, enabled = state.askDraft.trim().length >= 3 && !state.asking) { Text("Fragen") }
        },
        dismissButton = { TextButton(onClick = close) { Text("Abbrechen") } },
        containerColor = Nocturne.surface,
    )
}

@Composable
private fun AlbumDialog(state: RadioState) {
    val album = state.album
    AlertDialog(
        onDismissRequest = { state.albumOpen = false },
        title = { Text(if (album == null) "Sticker-Album" else "Sticker-Album · ${album.count} von ${album.total}") },
        text = {
            if (album == null) Text("Wird geladen …", color = Nocturne.muted)
            else Column(Modifier.heightIn(max = 460.dp).verticalScroll(rememberScrollState())) {
                Text("Sticker gibt es für richtige Quiz-Antworten, für deine Wahl in Mitmach-Geschichten und für jede Folge, die du bis zum Schluss hörst.",
                    style = MaterialTheme.typography.bodySmall, color = Nocturne.muted, modifier = Modifier.padding(bottom = 10.dp))
                for (row in album.stickers.chunked(5)) {
                    Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween) {
                        for (sticker in row) {
                            Column(Modifier.width(52.dp).padding(vertical = 6.dp).alpha(if (sticker.owned) 1f else 0.3f), horizontalAlignment = Alignment.CenterHorizontally) {
                                Box(Modifier.size(44.dp).clip(RoundedCornerShape(12.dp)).background(if (sticker.owned) Nocturne.surfaceHigh else Nocturne.bg),
                                    contentAlignment = Alignment.Center) { Text(if (sticker.owned) sticker.emoji else "?", fontSize = 26.sp) }
                                Text(if (sticker.owned) sticker.name else "", style = MaterialTheme.typography.labelSmall, color = Nocturne.muted, maxLines = 1)
                            }
                        }
                    }
                }
            }
        },
        confirmButton = { TextButton(onClick = { state.albumOpen = false }) { Text("Schliessen") } },
        containerColor = Nocturne.surface,
    )
}

/** A Mitmach-Geschichte from picture cards: a hero, a place, a kind of story, and oneself in it if wanted. */
@Composable
private fun StoryCardsDialog(block: ch.heimberg.radio.core.BlockView, state: RadioState, actions: RadioActions) {
    var hero by rememberSaveable { mutableStateOf<Int?>(null) }
    var place by rememberSaveable { mutableStateOf<Int?>(null) }
    var kind by rememberSaveable { mutableStateOf<Int?>(null) }
    var me by rememberSaveable { mutableStateOf(false) }
    val name = state.family?.self?.name
    AlertDialog(
        onDismissRequest = { state.storyCardsFor = null },
        title = { Text(block.name) },
        text = {
            Column(Modifier.verticalScroll(rememberScrollState())) {
                Text("Wähl aus, was in deiner Geschichte vorkommt. Am Ende jeder Folge entscheidest du, wie es weitergeht.",
                    style = MaterialTheme.typography.bodySmall, color = Nocturne.muted)
                CardRow("Wer?", StoryCards.heroes, hero) { hero = if (hero == it) null else it }
                CardRow("Wo?", StoryCards.places, place) { place = if (place == it) null else it }
                CardRow("Wie?", StoryCards.kinds, kind) { kind = if (kind == it) null else it }
                if (name != null) {
                    Row(Modifier.padding(top = 10.dp), verticalAlignment = Alignment.CenterVertically) {
                        Text("Ich spiele selbst mit", style = MaterialTheme.typography.bodyMedium, modifier = Modifier.weight(1f))
                        Switch(checked = me, onCheckedChange = { me = it })
                    }
                }
            }
        },
        confirmButton = {
            TextButton(onClick = {
                state.storyCardsFor = null
                actions.addBlock(block, StoryCards.subject(hero?.let(StoryCards.heroes::get), place?.let(StoryCards.places::get), kind?.let(StoryCards.kinds::get), if (me) name else null))
            }) { Text("Los geht's") }
        },
        dismissButton = { TextButton(onClick = { state.storyCardsFor = null }) { Text("Abbrechen") } },
        containerColor = Nocturne.surface,
    )
}

/** The cards of one question; they wrap onto the next line, so every label stays readable. */
@OptIn(ExperimentalLayoutApi::class)
@Composable
private fun CardRow(label: String, cards: List<StoryCards.Card>, selected: Int?, onPick: (Int) -> Unit) {
    Text(label, style = MaterialTheme.typography.labelMedium, color = Nocturne.accentLight, modifier = Modifier.padding(top = 12.dp, bottom = 4.dp))
    FlowRow(horizontalArrangement = Arrangement.spacedBy(6.dp)) {
        cards.forEachIndexed { index, card ->
            FilterChip(
                selected = selected == index, onClick = { onPick(index) },
                label = { Text("${card.emoji} ${card.label}", maxLines = 1, softWrap = false) },
                colors = FilterChipDefaults.filterChipColors(selectedContainerColor = Nocturne.accentDeep, selectedLabelColor = Nocturne.text),
            )
        }
    }
}
