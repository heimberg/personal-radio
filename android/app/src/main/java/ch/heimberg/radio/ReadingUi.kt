package ch.heimberg.radio

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ExperimentalLayoutApi
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.AssistChip
import androidx.compose.material3.InputChip
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import ch.heimberg.radio.core.Bookmark

/** «Dranbleiben»: the topic to follow, suggested from an item and editable. */
@Composable
fun FollowDialog(state: RadioState, actions: RadioActions) {
    val suggestion = state.followDraft ?: return
    var topic by remember(suggestion) { mutableStateOf(suggestion) }
    AlertDialog(
        onDismissRequest = { state.followDraft = null },
        title = { Text("Dranbleiben") },
        text = {
            Column {
                Text("Das Radio schaut jeden Tag nach, ob es dazu Neues gibt, und meldet sich nur dann – mit dem, was seit dem letzten Mal passiert ist.",
                    style = MaterialTheme.typography.bodySmall, color = Nocturne.muted)
                Spacer(Modifier.height(8.dp))
                OutlinedTextField(value = topic, onValueChange = { topic = it.take(120) }, singleLine = true, label = { Text("Thema") },
                    placeholder = { Text("z. B. Kernfusion") }, modifier = Modifier.fillMaxWidth())
            }
        },
        confirmButton = { TextButton(onClick = { actions.follow(topic) }, enabled = topic.trim().length >= 2) { Text("Dranbleiben") } },
        dismissButton = { TextButton(onClick = { state.followDraft = null }) { Text("Abbrechen") } },
        containerColor = Nocturne.surface,
    )
}

/** In «Programm»: the followed topics (✕ stops following) and one more. */
@OptIn(ExperimentalLayoutApi::class)
@Composable
fun FollowedTopics(state: RadioState, actions: RadioActions) {
    val follows = state.follows
    Column(Modifier.padding(horizontal = 16.dp)) {
        if (follows.topics.isEmpty()) {
            Text("Lange drücken auf einen Beitrag → «Dranbleiben»: das Radio meldet sich, wenn es zum Thema Neues gibt.",
                style = MaterialTheme.typography.bodySmall, color = Nocturne.muted, modifier = Modifier.padding(horizontal = 4.dp))
        }
        FlowRow(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            for (topic in follows.topics) {
                InputChip(selected = false, onClick = { actions.unfollow(topic.id) }, label = { Text("📌 ${topic.topic}  ✕", maxLines = 1, overflow = TextOverflow.Ellipsis) })
            }
            if (!follows.full) AssistChip(onClick = { actions.suggestFollow("") }, label = { Text("+ Thema") })
        }
    }
}

/** «Archiv» as reading list: what was kept with «Merken», with its sources to open and the whole list to share. */
@Composable
fun ReadingListEntry(bookmark: Bookmark, actions: RadioActions) {
    Column(
        Modifier
            .padding(horizontal = 16.dp, vertical = 4.dp)
            .fillMaxWidth()
            .clip(RoundedCornerShape(18.dp))
            .background(Nocturne.surface)
            .padding(start = 14.dp, top = 12.dp, bottom = 8.dp, end = 4.dp),
    ) {
        Row(verticalAlignment = Alignment.CenterVertically) {
            Column(Modifier.weight(1f)) {
                Text(bookmark.title, style = MaterialTheme.typography.titleSmall, maxLines = 2, overflow = TextOverflow.Ellipsis)
                if (bookmark.showName.isNotBlank()) Text(bookmark.showName, style = MaterialTheme.typography.bodySmall, color = Nocturne.muted)
            }
            TextButton(onClick = { actions.removeBookmark(bookmark.itemId) }) { Text("✕", color = Nocturne.muted) }
        }
        if (bookmark.sources.isEmpty()) Text("Ohne Weblinks", style = MaterialTheme.typography.bodySmall, color = Nocturne.faint, modifier = Modifier.padding(vertical = 4.dp))
        for (source in bookmark.sources) {
            Text("↗ ${source.title}", style = MaterialTheme.typography.bodyMedium, color = Nocturne.accentLight, maxLines = 1, overflow = TextOverflow.Ellipsis,
                modifier = Modifier.fillMaxWidth().clickable { actions.openSource(source.url) }.padding(vertical = 6.dp, horizontal = 2.dp))
        }
    }
}
