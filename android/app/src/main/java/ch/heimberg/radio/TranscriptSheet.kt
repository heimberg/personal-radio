package ch.heimberg.radio

import android.content.Intent
import android.net.Uri
import androidx.compose.animation.animateColorAsState
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.interaction.collectIsDraggedAsState
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.itemsIndexed
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.FilledTonalButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.ModalBottomSheet
import androidx.compose.material3.Text
import androidx.compose.material3.rememberModalBottomSheetState
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
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.SpanStyle
import androidx.compose.ui.text.buildAnnotatedString
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.withStyle
import androidx.compose.ui.unit.dp
import ch.heimberg.radio.core.Kind
import ch.heimberg.radio.core.Transcript

/**
 * «Text»: what is said in an item, as a sheet over the app. While the item plays, the line being read is
 * marked and kept in view (estimated from the position, for spoken items); scrolling by hand stops the
 * following until «Zur aktuellen Stelle». Sources open in the browser.
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun TranscriptSheet(state: RadioState, actions: RadioActions) {
    val itemId = state.transcriptFor ?: return
    val close = { state.transcriptFor = null; state.transcript = null; state.transcriptError = null }
    ModalBottomSheet(onDismissRequest = close, sheetState = rememberModalBottomSheetState(skipPartiallyExpanded = true), containerColor = Nocturne.surface) {
        val transcript = state.transcript
        Column(Modifier.fillMaxWidth().fillMaxHeight(0.92f)) {
            Text(
                transcript?.title ?: state.open.firstOrNull { it.id == itemId }?.displayTitle ?: state.title,
                style = MaterialTheme.typography.titleLarge, modifier = Modifier.padding(horizontal = 20.dp).semantics { heading() },
            )
            when {
                state.transcriptError != null -> Column(Modifier.padding(20.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                    Text(state.transcriptError ?: "", style = MaterialTheme.typography.bodyMedium, color = Nocturne.danger)
                    FilledTonalButton(onClick = { actions.loadTranscript(itemId) }) { Text("Erneut laden") }
                }
                transcript == null -> TranscriptPlaceholder()
                else -> TranscriptBody(transcript, itemId, state)
            }
        }
    }
}

@Composable
internal fun TranscriptBody(transcript: Transcript, itemId: String, state: RadioState) {
    val context = LocalContext.current
    val list = rememberLazyListState()
    // The line being read: only while this item plays its speech (not a jingle or transition).
    val playing = state.currentItemId == itemId && !state.inSound && state.partDurationMs > 0
    val current = if (playing) transcript.lineAt(state.partPositionMs.toDouble() / state.partDurationMs) else null
    var following by remember(itemId) { mutableStateOf(true) }
    val dragged by list.interactionSource.collectIsDraggedAsState()
    LaunchedEffect(dragged) { if (dragged) following = false }
    // Header rows come first in the list, so the line's row is two further down.
    LaunchedEffect(current, following) {
        if (current != null && following) list.animateScrollToItem(current + HEADER_ROWS, scrollOffset = -160)
    }
    Box {
        LazyColumn(state = list, modifier = Modifier.fillMaxWidth(), contentPadding = androidx.compose.foundation.layout.PaddingValues(start = 20.dp, end = 20.dp, bottom = 32.dp)) {
            item {
                val notes = when {
                    transcript.lines.isEmpty() -> "Für diesen Beitrag gibt es keinen Text."
                    else -> transcript.quality?.line() ?: ""
                }
                if (notes.isNotBlank()) Text(notes, style = MaterialTheme.typography.bodySmall, color = Nocturne.muted, modifier = Modifier.padding(top = 4.dp))
            }
            item {
                if (playing && current == null && !transcript.followable) {
                    Text("Bei Sendungen mit Musik läuft der Text nicht mit.", style = MaterialTheme.typography.bodySmall, color = Nocturne.faint, modifier = Modifier.padding(top = 4.dp))
                }
            }
            itemsIndexed(transcript.lines) { index, line ->
                val marked = index == current
                val back by animateColorAsState(if (marked) Nocturne.surfaceHigh else Color.Transparent, label = "line")
                val text = buildAnnotatedString {
                    if (line.song) withStyle(SpanStyle(color = Nocturne.kindLabel(Kind.MUSIC))) { append("♪  ${line.text}") }
                    else {
                        line.speaker?.let { withStyle(SpanStyle(fontWeight = FontWeight.Bold)) { append("$it: ") } }
                        append(line.text)
                    }
                }
                Text(
                    text, style = MaterialTheme.typography.bodyLarge, color = if (current != null && !marked) Nocturne.muted else Nocturne.text,
                    modifier = Modifier.padding(top = 10.dp).fillMaxWidth().clip(RoundedCornerShape(10.dp)).background(back).padding(horizontal = 8.dp, vertical = 4.dp),
                )
            }
            if (transcript.sources.isNotEmpty()) {
                item { Text("QUELLEN", style = Kicker, color = Nocturne.muted, modifier = Modifier.padding(top = 24.dp, bottom = 4.dp)) }
                itemsIndexed(transcript.sources) { _, source ->
                    val uri = Uri.parse(source.url)
                    val opens = uri.scheme == "https"
                    Column(
                        Modifier.fillMaxWidth().clip(RoundedCornerShape(10.dp))
                            .clickable(enabled = opens) { context.startActivity(Intent(Intent.ACTION_VIEW, uri)) }
                            .padding(horizontal = 8.dp, vertical = 8.dp),
                    ) {
                        Text(source.title.ifBlank { uri.host ?: source.url }, style = MaterialTheme.typography.bodyMedium, color = if (opens) Nocturne.kindLabel(Kind.DISCOVER) else Nocturne.text)
                        uri.host?.let { Text(it, style = MaterialTheme.typography.bodySmall, color = Nocturne.muted) }
                    }
                }
            }
        }
        if (current != null && !following) {
            Row(Modifier.align(Alignment.BottomCenter).padding(bottom = 16.dp)) {
                FilledTonalButton(onClick = { following = true }) { Text("Zur aktuellen Stelle") }
            }
        }
    }
}

/** While the text loads: grey bars in the shape of the lines to come. */
@Composable
private fun TranscriptPlaceholder() {
    Column(Modifier.padding(horizontal = 20.dp, vertical = 12.dp), verticalArrangement = Arrangement.spacedBy(14.dp)) {
        repeat(6) { index -> SkeletonLines(if (index % 3 == 2) 2 else 3) }
    }
}

private const val HEADER_ROWS = 2
