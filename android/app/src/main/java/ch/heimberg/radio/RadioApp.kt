package ch.heimberg.radio

import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.foundation.gestures.detectVerticalDragGestures
import androidx.activity.compose.BackHandler
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Badge
import androidx.compose.material3.BadgedBox
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.LinearProgressIndicator
import androidx.compose.material3.ListItem
import androidx.compose.material3.ListItemDefaults
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.ModalBottomSheet
import androidx.compose.material3.NavigationBar
import androidx.compose.material3.NavigationBarItem
import androidx.compose.material3.NavigationBarItemDefaults
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Snackbar
import androidx.compose.material3.SnackbarDuration
import androidx.compose.material3.SnackbarHost
import androidx.compose.material3.SnackbarHostState
import androidx.compose.material3.SnackbarResult
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import ch.heimberg.radio.core.FeedbackReason
import ch.heimberg.radio.core.Looks
import ch.heimberg.radio.core.Reading
import ch.heimberg.radio.core.TimelineItem

/** Longer messages get «Details» and show two lines on screen. */
private const val LONG_MESSAGE = 90

/** The app: four tabs, a mini player above them, and the dialogs the screens open. */
@Composable
fun RadioApp(state: RadioState, actions: RadioActions, version: String) {
    val snackbar = remember { SnackbarHostState() }
    // Messages stay short on screen; a long one (an error with Spotify's words) opens in full on «Details».
    LaunchedEffect(state.message) {
        val message = state.message ?: return@LaunchedEffect
        val long = message.text.length > LONG_MESSAGE
        val result = snackbar.showSnackbar(
            message.text, actionLabel = message.action ?: if (long) "Details" else null,
            duration = if (long && message.action == null) SnackbarDuration.Long else SnackbarDuration.Short,
        )
        if (result == SnackbarResult.ActionPerformed) message.onAction?.invoke() ?: run { state.detail = message.text }
    }
    // Back closes the day plan, then returns to «Hören»; from there it leaves the app.
    BackHandler(enabled = state.tab != Tab.LISTEN) {
        if (state.tab == Tab.PROGRAM && state.dayPlanOpen) actions.closeDayPlan() else state.tab = Tab.LISTEN
    }
    Scaffold(
        containerColor = Nocturne.bg,
        snackbarHost = {
            SnackbarHost(snackbar) { data ->
                Snackbar(
                    modifier = Modifier.padding(horizontal = 12.dp),
                    action = data.visuals.actionLabel?.let { label -> { TextButton(onClick = data::performAction) { Text(label, color = Color(0xFF9DBBF2)) } } },
                    containerColor = Nocturne.text, contentColor = Nocturne.bg,
                ) { Text(data.visuals.message, maxLines = 2, overflow = TextOverflow.Ellipsis) }
            }
        },
        bottomBar = {
            Column {
                if (state.tab != Tab.LISTEN && state.hasMedia) MiniPlayer(state, actions)
                Box(Modifier.fillMaxWidth().height(1.dp).background(Nocturne.divider))
                NavigationBar(containerColor = Nocturne.surface, tonalElevation = 0.dp) {
                    // «Familie» appears once there are other listeners on the Worker.
                    for (tab in Tab.entries.filter { it != Tab.FAMILY || state.familyEnabled }) {
                        NavigationBarItem(
                            selected = state.tab == tab,
                            onClick = { state.tab = tab },
                            icon = {
                                val unread = if (tab == Tab.FAMILY) state.familyUnread else 0
                                BadgedBox(badge = { if (unread > 0) Badge { Text("$unread") } }) { Icon(painterResource(tab.icon), null, Modifier.size(20.dp)) }
                            },
                            label = { Text(tab.label) },
                            colors = NavigationBarItemDefaults.colors(
                                selectedIconColor = Nocturne.bg, selectedTextColor = Nocturne.text,
                                indicatorColor = Nocturne.accent, unselectedIconColor = Nocturne.faint, unselectedTextColor = Nocturne.faint,
                            ),
                        )
                    }
                }
            }
        },
    ) { padding ->
        when (state.tab) {
            Tab.LISTEN -> ListenScreen(state, actions, padding)
            Tab.PROGRAM -> if (state.dayPlanOpen) DayPlanScreen(state, actions, padding) else ProgramScreen(state, actions, padding)
            Tab.ARCHIVE -> ArchiveScreen(state, actions, padding)
            Tab.FAMILY -> FamilyScreen(state, actions, padding)
            Tab.STUDIO -> StudioScreen(state, actions, version, padding)
        }
    }
    Dialogs(state, actions)
    DayPlanDialogs(state, actions)
    MitmachenDialogs(state, actions)
    FollowDialog(state, actions)
    CatalogSheet(state, actions)
}

/** What plays, on every tab but «Hören», with how far it is; a tap or a swipe up opens the player. */
@Composable
private fun MiniPlayer(state: RadioState, actions: RadioActions) {
    val look = state.look
    val color = Nocturne.kind(look?.kind)
    // A swipe up opens the player, like a tap.
    Column(Modifier.background(Nocturne.surface).pointerInput(Unit) {
        detectVerticalDragGestures { _, drag -> if (drag < -12f) state.tab = Tab.LISTEN }
    }) {
        LinearProgressIndicator(
            progress = { state.progress }, color = color, trackColor = Nocturne.divider, drawStopIndicator = {},
            modifier = Modifier.fillMaxWidth().height(3.dp),
        )
        Row(
            Modifier.fillMaxWidth().clickable { state.tab = Tab.LISTEN }.padding(start = 16.dp, end = 8.dp, top = 8.dp, bottom = 8.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Cover(look, state.coverUrl, 40.dp)
            Spacer(Modifier.width(12.dp))
            Column(Modifier.weight(1f)) {
                Text(state.title.ifBlank { "Personal Radio" }, style = MaterialTheme.typography.titleSmall, maxLines = 1, overflow = TextOverflow.Ellipsis)
                Text(state.show.ifBlank { state.status }, style = MaterialTheme.typography.bodySmall, color = Nocturne.muted, maxLines = 1, overflow = TextOverflow.Ellipsis)
            }
            IconButton(onClick = actions::togglePlay) {
                Icon(painterResource(if (state.playWhenReady) R.drawable.ic_pause else R.drawable.ic_play), if (state.playWhenReady) "Pause" else "Hören", tint = Nocturne.text)
            }
            IconButton(onClick = actions::next) { Icon(painterResource(R.drawable.ic_skip_forward), "Weiter", tint = Nocturne.text) }
        }
    }
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun Dialogs(state: RadioState, actions: RadioActions) {
    state.detail?.let { text ->
        AlertDialog(
            onDismissRequest = { state.detail = null },
            text = { Text(text, style = MaterialTheme.typography.bodyMedium) },
            confirmButton = { TextButton(onClick = { state.detail = null }) { Text("Schliessen") } },
            containerColor = Nocturne.surface,
        )
    }
    state.reasonFor?.let { itemId ->
        ChoiceDialog("Warum weniger?", FeedbackReason.entries.map { it.label }, dismiss = "Egal", onDismiss = { state.reasonFor = null }) { index ->
            state.reasonFor = null
            actions.reason(itemId, FeedbackReason.entries[index])
        }
    }
    if (state.sleepOpen) {
        val choices = listOf(15, 30, 60, PlaybackService.SLEEP_END_OF_ITEM, 0)
        val labels = choices.map { if (it == PlaybackService.SLEEP_END_OF_ITEM) "Nach diesem Beitrag" else if (it == 0) "Aus" else "$it Minuten" }
        ChoiceDialog("Einschlaf-Timer", labels, dismiss = "Abbrechen", onDismiss = { state.sleepOpen = false }) { index ->
            state.sleepOpen = false
            actions.sleep(choices[index])
        }
    }
    state.blockAsk?.let { block ->
        val input = block.input
        var word by rememberSaveable(block.id) { mutableStateOf("") }
        AlertDialog(
            onDismissRequest = { state.blockAsk = null },
            title = { Text(block.name) },
            text = {
                OutlinedTextField(
                    value = word, onValueChange = { word = it.take(200) }, singleLine = true,
                    label = { Text(input?.label ?: "Worüber?") }, placeholder = { Text(input?.example ?: "") },
                )
            },
            confirmButton = { TextButton(onClick = { state.blockAsk = null; actions.addBlock(block, word.trim()) }) { Text("Hinzufügen") } },
            dismissButton = { TextButton(onClick = { state.blockAsk = null; actions.addBlock(block, "") }) { Text("KI wählt") } },
            containerColor = Nocturne.surface,
        )
    }
    state.deleteAsk?.let { item ->
        AlertDialog(
            onDismissRequest = { state.deleteAsk = null },
            title = { Text("«${item.displayTitle}» löschen?") },
            text = { Text("Die Produktion und ihr Audio werden endgültig entfernt.") },
            confirmButton = { TextButton(onClick = { state.deleteAsk = null; actions.delete(item) }) { Text("Löschen", color = Nocturne.danger) } },
            dismissButton = { TextButton(onClick = { state.deleteAsk = null }) { Text("Abbrechen") } },
            containerColor = Nocturne.surface,
        )
    }
    state.actionsFor?.let { item ->
        ModalBottomSheet(onDismissRequest = { state.actionsFor = null }, containerColor = Nocturne.surface) {
            ItemActions(item, state, actions)
        }
    }
}

/** Options of one item: in the program to hear, move, swap or take out; in the archive to read or delete. */
@Composable
private fun ItemActions(item: TimelineItem, state: RadioState, actions: RadioActions) {
    val look = Looks.of(item)
    val close = { state.actionsFor = null }
    Row(Modifier.padding(start = 20.dp, end = 20.dp, bottom = 8.dp), verticalAlignment = Alignment.CenterVertically) {
        Cover(look, item.coverUrl, 44.dp)
        Spacer(Modifier.width(12.dp))
        Column {
            Text(item.displayTitle, style = MaterialTheme.typography.titleMedium, maxLines = 2, overflow = TextOverflow.Ellipsis)
            Text(item.showName, style = MaterialTheme.typography.bodySmall, color = Nocturne.muted)
        }
    }
    val playing = item.id == state.currentItemId
    val options = buildList<Pair<String, () -> Unit>> {
        if (!playing && (item.isPlayable || (!item.isOpen && item.hasAudio))) add("▶  Jetzt hören" to { actions.play(item); state.tab = Tab.LISTEN })
        if (item.isOpen && !playing) {
            if (state.sections.next?.id != item.id) add("⏭  Als Nächstes" to { actions.playNext(item) })
            add("↑  Nach vorne" to { actions.shift(item, -1) })
            add("↓  Nach hinten" to { actions.shift(item, 1) })
            add((if (item.surprise) "🎲  Andere Überraschung" else "🎲  Anders – eine Überraschung stattdessen") to { actions.swap(item) })
        }
        if (item.state != "planned") add("📄  Text und Quellen" to { actions.transcript(item) })
        // Spoken items: a question about it, the reading list, and following its topic.
        if (item.state != "planned" && item.state != "voicing" && !item.hasMusic && item.showId != "_musik") {
            add("❓  Nachfragen" to { actions.askAbout(item) })
            add((if (state.bookmarked(item.id)) "🔖  Von der Leseliste nehmen" else "🔖  Merken") to { actions.toggleBookmark(item) })
            add("📌  Dranbleiben" to { actions.suggestFollow(Reading.topicOf(item)) })
        }
        // Produced items can go to the family: a copy lands in their program.
        if (item.state != "planned" && item.state != "voicing" && item.hasAudio) {
            for (member in state.family?.shareTargets().orEmpty()) add("🎧  Teilen mit ${member.name}" to { actions.share(item, member) })
        }
        if (item.isOpen && !playing) add("✕  Aus dem Programm nehmen" to { actions.remove(item) })
        if (!item.isOpen) add("🗑  Löschen" to { state.deleteAsk = item })
    }
    for ((label, run) in options) {
        ListItem(
            headlineContent = { Text(label) },
            colors = ListItemDefaults.colors(containerColor = Nocturne.surface),
            modifier = Modifier.clickable { close(); run() },
        )
    }
    Spacer(Modifier.height(24.dp))
}

@Composable
private fun ChoiceDialog(title: String, labels: List<String>, dismiss: String, onDismiss: () -> Unit, onChoose: (Int) -> Unit) {
    AlertDialog(
        onDismissRequest = onDismiss,
        title = { Text(title) },
        text = {
            Column {
                labels.forEachIndexed { index, label ->
                    Text(label, style = MaterialTheme.typography.bodyLarge, modifier = Modifier.fillMaxWidth().clickable { onChoose(index) }.padding(vertical = 12.dp))
                }
            }
        },
        confirmButton = { TextButton(onClick = onDismiss) { Text(dismiss) } },
        containerColor = Nocturne.surface,
    )
}
