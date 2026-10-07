package ch.heimberg.radio

import androidx.compose.material3.FilledTonalButton
import androidx.compose.foundation.Canvas
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.ExperimentalLayoutApi
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.FilterChip
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.ModalBottomSheet
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Slider
import androidx.compose.material3.Switch
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
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
import androidx.compose.ui.geometry.CornerRadius
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import ch.heimberg.radio.core.CostSpan
import ch.heimberg.radio.core.MoneyBudget
import ch.heimberg.radio.core.AgentInfo
import ch.heimberg.radio.core.AgentSettings
import ch.heimberg.radio.core.Insights
import ch.heimberg.radio.core.Kind
import ch.heimberg.radio.core.Show
import ch.heimberg.radio.core.ShowFormat
import kotlin.math.roundToInt

/** «Sendungen»: the owner's shows with a switch each; a tap opens the editor, «+» adds one. */
@OptIn(ExperimentalLayoutApi::class)
@Composable
fun ShowsContent(state: RadioState, actions: RadioActions) {
    val draft = state.station ?: return
    Text(
        "Sendungen kommen immer wieder: Eingeschaltete plant das Radio von selbst ins Programm ein, ausgeschaltete pausieren. " +
            "Antippen öffnet eine Sendung zum Bearbeiten. Einzelne Beiträge holst du dagegen im Programm mit «＋ Einfügen».",
        style = MaterialTheme.typography.bodySmall, color = Nocturne.muted,
    )
    if (draft.shows.isEmpty()) Text("Noch keine Sendungen.", style = MaterialTheme.typography.bodyMedium, color = Nocturne.muted)
    for (show in draft.shows) {
        Row(
            Modifier.fillMaxWidth().clip(RoundedCornerShape(12.dp)).background(Nocturne.bg).clickable(onClickLabel = "Bearbeiten") { state.showEdit = show }
                .padding(start = 12.dp, end = 4.dp, top = 8.dp, bottom = 8.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Column(Modifier.weight(1f)) {
                Text(show.name.ifBlank { "Ohne Namen" }, style = MaterialTheme.typography.titleSmall, maxLines = 1, overflow = TextOverflow.Ellipsis,
                    color = if (show.enabled) Nocturne.text else Nocturne.muted)
                Text(show.summary, style = MaterialTheme.typography.bodySmall, color = Nocturne.muted, maxLines = 2, overflow = TextOverflow.Ellipsis)
            }
            Text("›", style = MaterialTheme.typography.titleLarge, color = Nocturne.muted, modifier = Modifier.padding(horizontal = 8.dp))
            Switch(checked = show.enabled, onCheckedChange = { actions.editStation(draft.withShow(show.copy(enabled = it))) },
                modifier = Modifier.semantics { contentDescription = "${show.name}: ${if (show.enabled) "läuft" else "pausiert"}" })
        }
    }
    Text("NEUE SENDUNG", style = Kicker, color = Nocturne.muted, modifier = Modifier.padding(top = 4.dp))
    Text("Kurzbeitrag und Dialog sind Wortbeiträge zu deinen Themen. Die Stunden und der Musikblock bringen vor allem Musik: " +
        "eine Stunde zu einem Künstler, einem Genre oder einem Thema, der Block Songs am Stück.",
        style = MaterialTheme.typography.bodySmall, color = Nocturne.muted)
    FlowRow(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
        for (format in ShowFormat.entries) {
            OutlinedButton(onClick = { state.showEdit = Show.new(format, draft.shows.map { it.id }) }) { Text("+ ${format.label}") }
        }
    }
}

/** «Feeds»: RSS or Atom sources for shows with «Meine Feeds». */
@Composable
fun FeedsContent(state: RadioState, actions: RadioActions) {
    val draft = state.station ?: return
    var name by remember { mutableStateOf("") }
    var url by remember { mutableStateOf("") }
    Text("Quellen für Sendungen mit «Meine Feeds». Nur HTTPS-Adressen.", style = MaterialTheme.typography.bodySmall, color = Nocturne.muted)
    if (draft.feeds.isEmpty()) Text("Noch keine Feeds.", style = MaterialTheme.typography.bodyMedium, color = Nocturne.muted)
    for (feed in draft.feeds) {
        Row(verticalAlignment = Alignment.CenterVertically) {
            Column(Modifier.weight(1f)) {
                Text(feed.name, style = MaterialTheme.typography.titleSmall)
                Text(feed.url, style = MaterialTheme.typography.bodySmall, color = Nocturne.muted, maxLines = 1, overflow = TextOverflow.Ellipsis)
            }
            TextButton(onClick = { actions.editStation(draft.removeFeed(feed.id)) }) { Text("✕", color = Nocturne.muted) }
        }
    }
    OutlinedTextField(value = name, onValueChange = { name = it.take(80) }, label = { Text("Name") }, singleLine = true, modifier = Modifier.fillMaxWidth())
    OutlinedTextField(value = url, onValueChange = { url = it.take(2048) }, label = { Text("Adresse (https://…)") }, singleLine = true, modifier = Modifier.fillMaxWidth())
    Button(onClick = {
        val next = draft.addFeed(name, url)
        if (next == null) state.say("Die Adresse muss mit https:// beginnen (höchstens 30 Feeds).")
        else { actions.editStation(next); name = ""; url = "" }
    }, enabled = url.isNotBlank()) { Text("Feed hinzufügen") }
}

/** «Redaktion»: style presets, then every agent; a tap opens its instructions. */
@OptIn(ExperimentalLayoutApi::class)
@Composable
fun AgentsContent(state: RadioState, actions: RadioActions) {
    LaunchedEffect(Unit) { actions.loadAgents() }
    val draft = state.station ?: return
    if (state.agentInfo.isEmpty()) return SkeletonRows(4, "Redaktion")
    Text("STIL-VORLAGEN", style = Kicker, color = Nocturne.muted)
    Text("Ein Tipp setzt Anweisungen und Schreibweise mehrerer Agenten. Gespeichert wird mit «Speichern».", style = MaterialTheme.typography.bodySmall, color = Nocturne.muted)
    val active = draft.activePreset(state.agentPresets)
    FlowRow(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
        FilterChip(selected = draft.agents.isEmpty(), onClick = { actions.editStation(draft.standardAgents()) }, label = { Text("Standard") })
        for (preset in state.agentPresets) {
            FilterChip(selected = active?.id == preset.id, onClick = { actions.editStation(draft.applyPreset(preset)) }, label = { Text(preset.name) })
        }
    }
    for ((group, agents) in state.agentInfo.groupBy { it.group }) {
        Text(group.uppercase(), style = Kicker, color = Nocturne.muted, modifier = Modifier.padding(top = 6.dp))
        for (agent in agents) {
            val own = draft.agent(agent.id)
            Row(
                Modifier.fillMaxWidth().clip(RoundedCornerShape(12.dp)).background(Nocturne.bg).clickable { state.agentEdit = agent }
                    .padding(start = 12.dp, end = 4.dp, top = 8.dp, bottom = 8.dp),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                Column(Modifier.weight(1f)) {
                    Text(agent.name + if (!own.empty) "  · angepasst" else "", style = MaterialTheme.typography.titleSmall)
                    Text(agent.description, style = MaterialTheme.typography.bodySmall, color = Nocturne.muted, maxLines = 2, overflow = TextOverflow.Ellipsis)
                }
                if (agent.optional) Switch(checked = own.enabled != false, onCheckedChange = { actions.editStation(draft.withAgent(agent, AgentSettings(enabled = it))) })
            }
        }
    }
}

/** «Qualität»: the jury's average per day and what the owner complained about. */
@Composable
fun QualityContent(state: RadioState, actions: RadioActions) {
    LaunchedEffect(Unit) { actions.loadInsights() }
    val insights = state.insights ?: return SkeletonLines(4, "Auswertung")
    val days = insights.qualityByDay
    if (days.isEmpty()) {
        Text("Noch keine Noten. Sobald die Jury Beiträge bewertet, erscheint hier der Verlauf der letzten 30 Tage.", style = MaterialTheme.typography.bodySmall, color = Nocturne.muted)
    } else {
        val average = insights.quality.map { it.overall }.average()
        Text("★ ${"%.1f".format(average)} im Schnitt · ${insights.quality.size} Bewertungen", style = MaterialTheme.typography.titleSmall)
        QualityBars(days, insights.changes.toSet())
        if (insights.changes.isNotEmpty()) Text("Senkrechte Linie: Tag, an dem du die Redaktion geändert hast.", style = MaterialTheme.typography.bodySmall, color = Nocturne.muted)
    }
    if (insights.weakShows.isNotEmpty()) {
        Text("UNTER DER LATTE (${"%.1f".format(insights.juryBar)})", style = Kicker, color = Nocturne.muted, modifier = Modifier.padding(top = 6.dp))
        for (show in insights.weakShows) {
            Column(Modifier.fillMaxWidth().padding(vertical = 4.dp)) {
                Text("${show.showName} · ★ ${"%.1f".format(show.average)} aus ${show.count}", style = MaterialTheme.typography.titleSmall)
                for (note in show.notes) Text("«$note»", style = MaterialTheme.typography.bodySmall, color = Nocturne.muted, maxLines = 3, overflow = TextOverflow.Ellipsis)
                Text("Vorschlag: ${show.hint}", style = MaterialTheme.typography.bodySmall)
            }
        }
    }
    Text("WAS DU BEMÄNGELT HAST", style = Kicker, color = Nocturne.muted, modifier = Modifier.padding(top = 6.dp))
    if (insights.reasons.isEmpty()) Text("Nichts. Mit 👎 und einem Grund lernt das Radio, was dich stört.", style = MaterialTheme.typography.bodySmall, color = Nocturne.muted)
    for (reason in insights.reasons) {
        Text("${reason.label} · ${reason.count}×" + if (reason.active) "  – wirkt auf die Redaktion" else "", style = MaterialTheme.typography.bodyMedium,
            color = if (reason.active) Nocturne.text else Nocturne.muted)
    }
    if (insights.reasons.isNotEmpty()) TextButton(onClick = actions::clearReasons) { Text("Zurücksetzen") }
}

/** One bar per day, from 1 to 5 stars; days the agents changed get a line. */
@Composable
private fun QualityBars(days: List<Pair<String, Double>>, changes: Set<String>) {
    val bar = Nocturne.kind(Kind.SPECIAL)
    val line = Nocturne.text
    Canvas(Modifier.fillMaxWidth().height(96.dp)) {
        val gap = 3.dp.toPx()
        val width = ((size.width - gap * (days.size - 1)) / days.size).coerceAtMost(28.dp.toPx())
        days.forEachIndexed { index, (day, mark) ->
            val left = index * (width + gap)
            val height = (mark.coerceIn(1.0, 5.0) / 5.0 * size.height).toFloat()
            drawRoundRect(bar, Offset(left, size.height - height), Size(width, height), CornerRadius(3.dp.toPx()))
            if (day in changes) drawLine(line, Offset(left - gap / 2, 0f), Offset(left - gap / 2, size.height), strokeWidth = 2.dp.toPx())
        }
    }
}

/** «Verbrauch»: today against the daily limits, then the last two weeks. */
/** The date of a copy in words: «4. Oktober 2026», «… (vor dem Wiederherstellen)». */
object Backups {
    private val format = java.time.format.DateTimeFormatter.ofPattern("d. MMMM yyyy", java.util.Locale.GERMAN)
    fun label(name: String): String {
        val date = runCatching { java.time.LocalDate.parse(name.take(10)).format(format) }.getOrDefault(name)
        return if (name.endsWith("-vorher")) "$date (vor dem Wiederherstellen)" else date
    }
}

/** «Sicherungen»: weekly copies of the settings; one can be brought back, and what is there now is kept too. */
@Composable
fun BackupsContent(state: RadioState, actions: RadioActions) {
    LaunchedEffect(Unit) { actions.loadBackups() }
    Text("Jeden Sonntag sichert der Server Sender, Sendungen, Tagesplan, Redaktion und Feeds. Die letzten acht Sicherungen bleiben.",
        style = MaterialTheme.typography.bodySmall, color = Nocturne.muted)
    FilledTonalButton(onClick = actions::backupNow) { Text("Jetzt sichern") }
    val backups = state.backups ?: return SkeletonRows(3, "Sicherungen")
    if (backups.isEmpty()) Text("Noch keine Sicherung.", style = MaterialTheme.typography.bodyMedium)
    for (name in backups) {
        Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
            Text(Backups.label(name), style = MaterialTheme.typography.bodyMedium, modifier = Modifier.weight(1f))
            TextButton(onClick = { state.restoreAsk = name }) { Text("Wiederherstellen") }
        }
    }
    state.restoreAsk?.let { name ->
        AlertDialog(
            onDismissRequest = { state.restoreAsk = null },
            title = { Text("Sicherung vom ${Backups.label(name)} wiederherstellen?") },
            text = { Text("Sender, Sendungen, Tagesplan, Redaktion und Feeds werden auf diesen Stand gesetzt. Der jetzige Stand wird vorher gesichert, du kannst also zurück.") },
            confirmButton = { TextButton(onClick = { actions.restoreBackup(name) }) { Text("Wiederherstellen") } },
            dismissButton = { TextButton(onClick = { state.restoreAsk = null }) { Text("Abbrechen") } },
            containerColor = Nocturne.surface,
        )
    }
}

/** «Diagnose»: what went wrong lately – the step, the show, the reason and when – newest first. */
@Composable
fun DiagnosticsContent(state: RadioState, actions: RadioActions) {
    LaunchedEffect(Unit) { actions.loadDiagnostics() }
    val errors = state.diagnostics ?: return SkeletonLines(5, "Diagnose")
    Text("Die letzten Fehler von Produktionen, Übergängen und der Warteschlange (30 Tage).", style = MaterialTheme.typography.bodySmall, color = Nocturne.muted)
    if (errors.isEmpty()) return Text("Keine Fehler – alles läuft.", style = MaterialTheme.typography.bodyMedium)
    val shows = state.station?.shows.orEmpty().associate { it.id to it.name }
    val clock = java.time.format.DateTimeFormatter.ofPattern("d.M. HH:mm").withZone(java.time.ZoneId.systemDefault())
    for (error in errors) {
        Column(Modifier.fillMaxWidth().padding(vertical = 4.dp)) {
            val at = runCatching { clock.format(java.time.Instant.parse(error.at)) }.getOrDefault("")
            val show = error.showId?.let { shows[it] ?: it.removePrefix("_block:").removePrefix("_series:").replaceFirstChar(Char::uppercase) }
            Text(listOfNotNull(at, error.stageLabel, show).joinToString(" · "), style = MaterialTheme.typography.labelMedium, color = Nocturne.muted)
            Text(ch.heimberg.radio.core.Labels.error(error.message), style = MaterialTheme.typography.bodyMedium)
        }
    }
    TextButton(onClick = actions::loadDiagnostics) { Text("Neu laden") }
}

@Composable
fun UsageContent(state: RadioState, actions: RadioActions) {
    LaunchedEffect(Unit) { actions.loadInsights() }
    val insights = state.insights ?: return SkeletonLines(4, "Auswertung")
    val today = insights.days.firstOrNull()
    if (today == null) return Text("Noch kein Verbrauch.", style = MaterialTheme.typography.bodySmall, color = Nocturne.muted)
    Meter("Produktionen heute", today.generations, insights.generationLimit)
    insights.costs?.let { costs ->
        Row(Modifier.fillMaxWidth().padding(top = 6.dp)) {
            Text(if (insights.wholeServer) "Kosten, alle Sender" else "Kosten", style = MaterialTheme.typography.bodyMedium, modifier = Modifier.weight(1f))
            Text("${CostSpan.chf(costs.today)} heute", style = MaterialTheme.typography.titleSmall)
        }
        Text("30 Tage ca. ${CostSpan.chf(costs.month)} · geschätzt aus den Tokens und Listenpreisen, die Rechnung des Anbieters gilt",
            style = MaterialTheme.typography.bodySmall, color = Nocturne.muted)
        BudgetRow(insights.budget, if (insights.wholeServer) "server" else null, "Monatsbudget, alle Sender", insights.budgetFloor, actions)
    }
    if (insights.byShow.isNotEmpty()) {
        Text("Letzte 7 Tage nach Sendung", style = MaterialTheme.typography.titleSmall, modifier = Modifier.padding(top = 8.dp))
        for ((show, count) in insights.byShow) {
            Row(Modifier.fillMaxWidth()) {
                Text(show, style = MaterialTheme.typography.bodyMedium, modifier = Modifier.weight(1f), maxLines = 1)
                Text("$count", style = MaterialTheme.typography.bodyMedium, color = Nocturne.muted)
            }
        }
    }
    Meter("Sprachzeichen heute", today.ttsCharacters, insights.speechLimit)
    if (insights.speechRequestLimit > 0) Meter("Sprachanfragen heute", today.speechRequests, insights.speechRequestLimit)
    Text("LETZTE TAGE", style = Kicker, color = Nocturne.muted, modifier = Modifier.padding(top = 6.dp))
    for (day in insights.days.take(14)) {
        Row {
            Text(day.day.substring(8, 10).trimStart('0') + "." + day.day.substring(5, 7).trimStart('0') + ".", style = MaterialTheme.typography.bodySmall, modifier = Modifier.width(52.dp))
            Text("${day.generations} Produktionen · ${day.ttsCharacters} Zeichen · ${day.models.sumOf { it.calls }} Aufrufe", style = MaterialTheme.typography.bodySmall, color = Nocturne.muted)
        }
    }
}

@Composable
private fun Meter(label: String, value: Int, limit: Int) {
    val share = if (limit > 0) (value.toFloat() / limit).coerceIn(0f, 1f) else 0f
    val color = if (share >= 0.9f) Nocturne.kind(Kind.NEWS) else Nocturne.text
    Column {
        Row {
            Text(label, style = MaterialTheme.typography.bodyMedium, modifier = Modifier.weight(1f))
            Text(if (limit > 0) "$value von $limit" else "$value", style = MaterialTheme.typography.titleSmall, color = color)
        }
        Canvas(Modifier.fillMaxWidth().height(6.dp).padding(top = 2.dp)) {
            drawRoundRect(Nocturne.divider, cornerRadius = CornerRadius(3.dp.toPx()))
            drawRoundRect(color, size = Size(size.width * share, size.height), cornerRadius = CornerRadius(3.dp.toPx()))
        }
    }
}

/** «Spotify-Hörprofil»: whose top artists shape the music picks; connecting opens Spotify's login. */
@Composable
fun ListeningContent(state: RadioState, actions: RadioActions) {
    LaunchedEffect(Unit) { actions.loadListening() }
    val profile = state.listening ?: return SkeletonLines(2, "Hörprofil")
    if (profile.connected) {
        Text(
            if (profile.artists.isEmpty()) "Verbunden. Deine Top-Künstler werden beim nächsten Song geladen."
            else "Die Songauswahl orientiert sich an dem, was du hörst: ${profile.artists.take(12).joinToString(", ")}${if (profile.artists.size > 12) " …" else ""}",
            style = MaterialTheme.typography.bodyMedium,
        )
        TextButton(onClick = actions::disconnectListening) { Text("Trennen", color = Nocturne.danger) }
    } else {
        Text("Verbinde dein Spotify-Konto, damit die Songauswahl deine meistgehörten Künstler kennt. Gelesen werden nur deine Top-Künstler und, für Musikblöcke, deine Playlists. Die Anmeldung öffnet sich im Browser; danach zurück in die App.",
            style = MaterialTheme.typography.bodySmall, color = Nocturne.muted)
        Button(onClick = actions::connectListening) { Text("Mit Spotify verbinden") }
    }
}

/** The sheets of the station cards: a show's editor and an agent's instructions. */
@Composable
fun StationSheets(state: RadioState, actions: RadioActions) {
    state.showEdit?.let { ShowEditor(it, state, actions) }
    state.agentEdit?.let { AgentEditor(it, state, actions) }
}

@OptIn(ExperimentalMaterial3Api::class, ExperimentalLayoutApi::class)
@Composable
private fun ShowEditor(initial: Show, state: RadioState, actions: RadioActions) {
    val draft = state.station ?: return
    var show by remember(initial.id) { mutableStateOf(initial) }
    var confirmDelete by remember { mutableStateOf(false) }
    val exists = draft.shows.any { it.id == initial.id }
    val close = { state.showEdit = null }
    ModalBottomSheet(onDismissRequest = close, sheetState = rememberModalBottomSheetState(skipPartiallyExpanded = true), containerColor = Nocturne.bg) {
        Column(
            Modifier.fillMaxWidth().fillMaxHeight(0.92f).imePadding().verticalScroll(rememberScrollState()).padding(start = 20.dp, end = 20.dp, bottom = 32.dp),
            verticalArrangement = Arrangement.spacedBy(10.dp),
        ) {
            Text((if (exists) "Sendung" else "Neue Sendung").uppercase(), style = display(32))
            OutlinedTextField(show.name, { show = show.copy(name = it.take(80)) }, label = { Text("Name") }, singleLine = true, modifier = Modifier.fillMaxWidth())
            Row(verticalAlignment = Alignment.CenterVertically) {
                Text(if (show.enabled) "Aktiv" else "Pausiert", style = MaterialTheme.typography.bodyLarge, modifier = Modifier.weight(1f))
                Switch(checked = show.enabled, onCheckedChange = { show = show.copy(enabled = it) })
            }
            Text("FORMAT", style = Kicker, color = Nocturne.muted)
            FlowRow(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                for (format in ShowFormat.entries) FilterChip(selected = show.format == format, onClick = { show = show.withFormat(format) }, label = { Text(format.label) })
            }
            val format = show.format
            Text("Länge: ${show.minutes} Min. (${format.minMinutes}–${format.maxMinutes})", style = MaterialTheme.typography.bodyMedium)
            val step = if (format.spoken) 1 else 5
            Slider(
                value = show.minutes.toFloat(), onValueChange = { show = show.copy(minutes = (it / step).roundToInt() * step) },
                valueRange = format.minMinutes.toFloat()..format.maxMinutes.toFloat(),
                steps = ((format.maxMinutes - format.minMinutes) / step - 1).coerceAtLeast(0),
            )
            format.subjectLabel?.let { (label, example) ->
                OutlinedTextField(show.subject, { show = show.copy(subject = it.take(200)) }, label = { Text(label) }, placeholder = { Text(example) },
                    supportingText = { Text("Leer lassen: die KI wählt aus deinen Interessen.") }, singleLine = true, modifier = Modifier.fillMaxWidth())
            }
            if (format.spoken) {
                Text("QUELLEN", style = Kicker, color = Nocturne.muted)
                Segments(listOf("Websuche", "Meine Feeds"), if (show.sourceMode == "feeds") 1 else 0, Modifier.fillMaxWidth()) {
                    show = show.copy(sourceMode = if (it == 1) "feeds" else "web")
                }
                if (show.sourceMode == "feeds") {
                    if (draft.feeds.isEmpty()) Text("Noch keine Feeds – in der Karte «Feeds» hinzufügen.", style = MaterialTheme.typography.bodySmall, color = Nocturne.muted)
                    FlowRow(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                        for (feed in draft.feeds) {
                            val on = feed.id in show.feedIds
                            FilterChip(selected = on, onClick = { show = show.copy(feedIds = if (on) show.feedIds - feed.id else show.feedIds + feed.id) }, label = { Text(feed.name) })
                        }
                    }
                } else {
                    OutlinedTextField(show.researchPrompt, { show = show.copy(researchPrompt = it.take(1000)) }, label = { Text("Recherche-Auftrag") },
                        placeholder = { Text("z. B. Eine aktuelle, wenig bekannte Entwicklung zu meinen Interessen") }, minLines = 2, modifier = Modifier.fillMaxWidth())
                }
                Text("LIVE-INFOS", style = Kicker, color = Nocturne.muted)
                FlowRow(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    for ((tool, label) in Show.TOOLS) {
                        val on = tool in show.tools
                        FilterChip(selected = on, onClick = { show = show.copy(tools = if (on) show.tools - tool else show.tools + tool) }, label = { Text(label) })
                    }
                }
                Text("FAKTENCHECK", style = Kicker, color = Nocturne.muted)
                FlowRow(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    for ((id, label) in Show.VERIFICATION) FilterChip(selected = show.verification == id, onClick = { show = show.copy(verification = id) }, label = { Text(label) })
                }
            }
            if (format == ShowFormat.BLOCK) {
                OutlinedTextField(show.playlists.joinToString("\n"), { text -> show = show.copy(playlists = text.split('\n').take(5)) }, label = { Text("Spotify-Playlists (ein Link pro Zeile)") },
                    supportingText = { Text("Ohne Playlist wählt die KI nach dem Geschmack.") }, minLines = 2, modifier = Modifier.fillMaxWidth())
                OutlinedTextField(show.taste, { show = show.copy(taste = it.take(500)) }, label = { Text("Geschmack") }, placeholder = { Text("z. B. ruhiger Jazz, Neo-Soul") }, modifier = Modifier.fillMaxWidth())
            }
            OutlinedTextField(show.instructions, { show = show.copy(instructions = it.take(2000)) }, label = { Text("Anweisungen an die Redaktion") },
                placeholder = { Text("Stil, Schwerpunkte, was vermieden werden soll") }, minLines = 3, modifier = Modifier.fillMaxWidth())
            Row(horizontalArrangement = Arrangement.spacedBy(8.dp), verticalAlignment = Alignment.CenterVertically) {
                if (exists) TextButton(onClick = { confirmDelete = true }) { Text("Löschen", color = Nocturne.danger) }
                Spacer(Modifier.weight(1f))
                TextButton(onClick = close) { Text("Abbrechen") }
                Button(onClick = { actions.editStation(draft.withShow(show)); close() }, enabled = show.name.isNotBlank()) { Text("Übernehmen") }
            }
            Text("Gespeichert wird mit «Speichern» oben im Studio.", style = MaterialTheme.typography.bodySmall, color = Nocturne.muted)
        }
    }
    if (confirmDelete) {
        AlertDialog(
            onDismissRequest = { confirmDelete = false },
            title = { Text("«${initial.name}» löschen?") },
            text = { Text("Die Sendung verschwindet auch aus dem Tagesplan. Gehörte Beiträge bleiben im Archiv.") },
            confirmButton = { TextButton(onClick = { confirmDelete = false; actions.editStation(draft.removeShow(initial.id)); close() }) { Text("Löschen", color = Nocturne.danger) } },
            dismissButton = { TextButton(onClick = { confirmDelete = false }) { Text("Abbrechen") } },
            containerColor = Nocturne.surface,
        )
    }
}

private val TRIAL_ERRORS = mapOf(
    "NO_ITEM" to "Noch kein fertiger Beitrag im Programm, an dem sich das testen lässt.",
    "NOT_CONFIGURED" to "Dafür ist auf dem Server kein Sprachmodell eingerichtet.",
)

@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun AgentEditor(agent: AgentInfo, state: RadioState, actions: RadioActions) {
    val draft = state.station ?: return
    val own = draft.agent(agent.id)
    val set = { change: AgentSettings -> actions.editStation(draft.withAgent(agent, change)) }
    ModalBottomSheet(onDismissRequest = { state.agentEdit = null }, sheetState = rememberModalBottomSheetState(skipPartiallyExpanded = true), containerColor = Nocturne.bg) {
        Column(
            Modifier.fillMaxWidth().fillMaxHeight(0.92f).imePadding().verticalScroll(rememberScrollState()).padding(start = 20.dp, end = 20.dp, bottom = 32.dp),
            verticalArrangement = Arrangement.spacedBy(10.dp),
        ) {
            Text(agent.name.uppercase(), style = display(32))
            Text(agent.description, style = MaterialTheme.typography.bodyMedium, color = Nocturne.muted)
            if (agent.optional) {
                Row(verticalAlignment = Alignment.CenterVertically) {
                    Text(if (own.enabled != false) "An" else "Aus", style = MaterialTheme.typography.bodyLarge, modifier = Modifier.weight(1f))
                    Switch(checked = own.enabled != false, onCheckedChange = { set(AgentSettings(enabled = it)) })
                }
            }
            OutlinedTextField(
                own.instructions ?: agent.instructions, { set(AgentSettings(instructions = it.take(3000))) },
                label = { Text("Anweisungen") }, minLines = 4, modifier = Modifier.fillMaxWidth(),
                supportingText = { Text(if (agent.id == "verifier") "Zusätzliche Hinweise. Sie können die Prüfung verschärfen, aber nicht lockern." else "Stil, Schwerpunkte, Kriterien – in eigenen Worten.") },
            )
            val temperature = own.temperature ?: agent.temperature
            Text("Schreibweise: ${if (temperature <= 0.2) "genau" else if (temperature >= 0.7) "frei" else "ausgewogen"} (${(temperature * 100).roundToInt()} %)", style = MaterialTheme.typography.bodyMedium)
            Slider(value = temperature.toFloat(), onValueChange = { set(AgentSettings(temperature = (it * 20).roundToInt() / 20.0)) }, valueRange = 0f..1f, steps = 19)
            agent.threshold?.let { shipped ->
                val threshold = own.threshold ?: shipped
                Text("Latte für die Auswertung: ★ ${"%.1f".format(threshold)}", style = MaterialTheme.typography.bodyMedium)
                Text("Die Hinweise der Jury setzt die Schlussredaktion bei jedem Beitrag um. Die Latte zeigt unter «Qualität», welche Sendungen regelmässig darunter liegen.",
                    style = MaterialTheme.typography.bodySmall, color = Nocturne.muted)
                Slider(value = threshold.toFloat(), onValueChange = { set(AgentSettings(threshold = (it * 2).roundToInt() / 2.0)) }, valueRange = 1f..5f, steps = 7)
            }
            Column(Modifier.fillMaxWidth().clip(RoundedCornerShape(12.dp)).border(1.dp, Nocturne.divider, RoundedCornerShape(12.dp)).padding(12.dp)) {
                Text("WAS FEST BLEIBT", style = Kicker, color = Nocturne.muted)
                Text(agent.contract, style = MaterialTheme.typography.bodySmall, color = Nocturne.muted)
            }
            Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                TextButton(onClick = { actions.editStation(draft.resetAgent(agent.id)) }, enabled = !own.empty) { Text("Standard wiederherstellen") }
                Spacer(Modifier.weight(1f))
                if (agent.trial) {
                    val running = state.trials.containsKey(agent.id) && state.trials[agent.id] == null
                    Button(
                        onClick = { actions.trialAgent(agent) }, enabled = !running && !(agent.optional && own.enabled == false),
                        colors = ButtonDefaults.buttonColors(containerColor = Nocturne.text, contentColor = Nocturne.bg),
                    ) { Text(if (running) "Probelauf läuft …" else "Probelauf") }
                }
            }
            state.trials[agent.id]?.let { trial ->
                if (!trial.ok) {
                    Text((trial.error?.let { TRIAL_ERRORS[it] } ?: "Der Probelauf ist fehlgeschlagen.") + (trial.detail?.let { " ($it)" } ?: ""), style = MaterialTheme.typography.bodySmall, color = Nocturne.danger)
                } else {
                    Text(if (trial.itemTitle.isBlank()) "Nichts wurde geplant oder gespeichert" else "Am Beitrag «${trial.itemTitle}» · nichts wurde gespeichert",
                        style = MaterialTheme.typography.bodySmall, color = Nocturne.muted)
                    TrialSide("BISHER", trial.before)
                    TrialSide("MIT DIESEN EINSTELLUNGEN", trial.after)
                }
            }
        }
    }
}

@Composable
private fun TrialSide(label: String, side: Pair<String, Double?>?) {
    if (side == null) return
    Column(Modifier.fillMaxWidth().clip(RoundedCornerShape(12.dp)).background(Nocturne.surface).padding(12.dp)) {
        Text(label + (side.second?.let { " · ★ ${"%.1f".format(it)}" } ?: ""), style = Kicker, color = Nocturne.muted)
        if (side.first.isNotBlank()) Text(side.first, style = MaterialTheme.typography.bodyMedium)
    }
}

/**
 * A monthly budget in francs: what is spent against it, and (with [station], for the owner) a dialog to set,
 * change or remove it. Once used up, the station makes only [floor] productions a day until the month ends.
 */
@Composable
private fun BudgetRow(budget: MoneyBudget?, station: String?, title: String, floor: Int, actions: RadioActions) {
    var editing by remember { mutableStateOf(false) }
    Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
        Text(budget?.line() ?: "Kein Monatsbudget", style = MaterialTheme.typography.bodySmall,
            color = if (budget?.let { it.share >= 0.8 } == true) Nocturne.kind(Kind.NEWS) else Nocturne.muted, modifier = Modifier.weight(1f))
        if (station != null) TextButton(onClick = { editing = true }) { Text(if (budget == null) "Budget setzen" else "Ändern") }
    }
    if (!editing || station == null) return
    var text by remember { mutableStateOf(budget?.limit?.let { String.format(java.util.Locale.ROOT, "%.2f", it) } ?: "") }
    val value = text.replace(',', '.').toDoubleOrNull()?.takeIf { it in 0.5..10_000.0 }
    AlertDialog(
        onDismissRequest = { editing = false },
        title = { Text(title) },
        text = {
            Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                OutlinedTextField(text, { text = it.take(8) }, label = { Text("CHF pro Monat") }, singleLine = true,
                    keyboardOptions = androidx.compose.foundation.text.KeyboardOptions(keyboardType = androidx.compose.ui.text.input.KeyboardType.Decimal))
                Text("Gezählt ab dem Ersten des Monats, geschätzt aus den Tokens. Bei 80 % kommt eine Warnung; ist es aufgebraucht, macht der Sender bis Monatsende höchstens $floor Beiträge am Tag.",
                    style = MaterialTheme.typography.bodySmall, color = Nocturne.muted)
            }
        },
        confirmButton = { TextButton(onClick = { actions.setBudget(station, value); editing = false }, enabled = value != null) { Text("Speichern") } },
        dismissButton = {
            Row {
                if (budget != null) TextButton(onClick = { actions.setBudget(station, null); editing = false }) { Text("Entfernen", color = Nocturne.danger) }
                TextButton(onClick = { editing = false }) { Text("Abbrechen") }
            }
        },
        containerColor = Nocturne.surface,
    )
}

/**
 * One station in «Hören mit», compact: name, today's productions and costs, and a thin bar for its budget.
 * A tap shows the rest (seven days, 30 days of costs, the budget to set); «Verwalten» limits or removes.
 */
@Composable
private fun ListenerRow(
    name: String, kind: String, usage: ch.heimberg.radio.core.StationUsage, limit: Int, station: String, budgetTitle: String, floor: Int,
    actions: RadioActions, manage: (() -> Unit)? = null,
) {
    var open by remember(station) { mutableStateOf(false) }
    Column(Modifier.fillMaxWidth().clip(RoundedCornerShape(14.dp)).clickable { open = !open }.padding(vertical = 6.dp)) {
        Row(verticalAlignment = Alignment.CenterVertically) {
            Column(Modifier.weight(1f)) {
                Text(name, style = MaterialTheme.typography.bodyMedium)
                Text(usage.compact(limit), style = MaterialTheme.typography.bodySmall, color = Nocturne.muted, maxLines = 1, overflow = TextOverflow.Ellipsis)
            }
            if (manage != null) TextButton(onClick = manage) { Text("Verwalten") }
            Text(if (open) "▴" else "▾", color = Nocturne.muted, modifier = Modifier.padding(start = 4.dp))
        }
        usage.budget?.let { budget ->
            val color = if (budget.share >= 0.8) Nocturne.kind(Kind.NEWS) else Nocturne.text
            Canvas(Modifier.fillMaxWidth().height(4.dp).padding(top = 2.dp).semantics { contentDescription = budget.line() }) {
                drawRoundRect(Nocturne.divider, cornerRadius = CornerRadius(2.dp.toPx()))
                drawRoundRect(color, size = Size(size.width * budget.share.toFloat().coerceIn(0f, 1f), size.height), cornerRadius = CornerRadius(2.dp.toPx()))
            }
        }
        if (open) {
            Text(kind, style = MaterialTheme.typography.bodySmall, color = Nocturne.muted, modifier = Modifier.padding(top = 4.dp))
            Text(usage.line(limit), style = MaterialTheme.typography.bodySmall, color = Nocturne.muted)
            usage.costs?.let { Text("Kosten ${it.line()}", style = MaterialTheme.typography.bodySmall, color = Nocturne.muted) }
            BudgetRow(usage.budget, station, budgetTitle, floor, actions)
        }
    }
}

/** Shows the station's usage at a glance for the card summary. */
fun usageSummary(insights: Insights?): String {
    val today = insights?.days?.firstOrNull() ?: return "Produktionen, Sprache und Aufrufe pro Tag"
    return "Heute ${today.generations} von ${insights.generationLimit} Produktionen"
}

/**
 * «Einladen»: a name and who it is for, then the share sheet sends the link. Open invitations can be
 * withdrawn; whoever joined by invitation can lose their access again (their token is revoked at once).
 */
@OptIn(ExperimentalLayoutApi::class)
@Composable
fun InvitesContent(state: RadioState, actions: RadioActions) {
    LaunchedEffect(Unit) { actions.loadInvites() }
    var name by remember { mutableStateOf("") }
    var kind by remember { mutableStateOf(ch.heimberg.radio.core.ListenerKind.FAMILY) }
    val overview = state.invites
    if (overview != null && !overview.ready) {
        Text("Einladungen sind auf dem Server noch nicht eingerichtet: Es fehlen CF_ACCOUNT_ID und CF_ACCESS_API_TOKEN und die Access-Ausnahme für /join (siehe Anleitung).",
            style = MaterialTheme.typography.bodySmall, color = Nocturne.muted)
    }
    Text("Jede eingeladene Person bekommt einen eigenen Sender auf deinem Server. Ihre Produktionen zählen zu deinen Kosten; jede hat ihre eigenen Tageslimits.",
        style = MaterialTheme.typography.bodySmall, color = Nocturne.muted)
    OutlinedTextField(name, { name = it.take(30) }, label = { Text("Name") }, singleLine = true, modifier = Modifier.fillMaxWidth())
    FlowRow(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
        for (option in ch.heimberg.radio.core.ListenerKind.entries) {
            FilterChip(selected = kind == option, onClick = { kind = option }, label = { Text(option.label) })
        }
    }
    Text(kind.hint, style = MaterialTheme.typography.bodySmall, color = Nocturne.muted)
    FilledTonalButton(
        onClick = { actions.createInvite(name.trim(), kind); name = "" },
        enabled = name.trim().length >= 2 && overview?.ready != false,
    ) { Text("Einladung erstellen und senden") }
    if (overview == null) return SkeletonRows(3, "Hörerliste")
    val date = java.time.format.DateTimeFormatter.ofPattern("d.M.").withZone(java.time.ZoneId.systemDefault())
    val day = { at: String? -> at?.let { runCatching { date.format(java.time.Instant.parse(it)) }.getOrNull() } ?: "" }
    if (overview.open.isNotEmpty()) {
        Text("Offene Einladungen", style = MaterialTheme.typography.titleSmall, modifier = Modifier.padding(top = 8.dp))
        for (invite in overview.open) {
            Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
                Column(Modifier.weight(1f)) {
                    Text(invite.name, style = MaterialTheme.typography.bodyMedium)
                    Text("${invite.listenerKind.label} · gültig bis ${day(invite.expiresAt)}", style = MaterialTheme.typography.bodySmall, color = Nocturne.muted)
                }
                TextButton(onClick = { actions.deleteInvite(invite.id) }) { Text("Zurückziehen") }
            }
        }
    }
    Text("Hören mit", style = MaterialTheme.typography.titleSmall, modifier = Modifier.padding(top = 8.dp))
    overview.own?.let { own ->
        ListenerRow("Du", "Besitzer", own.usage, own.limit, "own", "Monatsbudget, dein Sender", overview.budgetFloor, actions)
    }
    if (overview.listeners.isEmpty()) Text("Noch niemand – nur du.", style = MaterialTheme.typography.bodyMedium)
    for (listener in overview.listeners) {
        val kind = listOfNotNull(listener.listenerKind.label, listener.since?.let { "seit ${day(it)}" }, if (!listener.removable) "im Worker eingetragen" else null).joinToString(" · ")
        ListenerRow(listener.name.replaceFirstChar(Char::uppercase), kind, listener.usage, listener.limit, listener.key, "Monatsbudget, ${listener.name}", overview.budgetFloor, actions,
            manage = if (listener.removable) ({ state.removeListenerAsk = listener }) else null)
    }
    state.removeListenerAsk?.let { listener ->
        var erase by remember(listener.key) { mutableStateOf(false) }
        var limit by remember(listener.key) { mutableStateOf(listener.limit) }
        AlertDialog(
            onDismissRequest = { state.removeListenerAsk = null },
            title = { Text(listener.name) },
            text = {
                Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                    Text("Produktionen pro Tag", style = MaterialTheme.typography.titleSmall)
                    Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                        TextButton(onClick = { limit = (limit - 2).coerceAtLeast(1) }) { Text("−") }
                        Text("$limit", style = MaterialTheme.typography.titleMedium)
                        TextButton(onClick = { limit = (limit + 2).coerceAtMost(500) }) { Text("+") }
                        TextButton(onClick = { actions.setListenerLimit(listener.key, limit); state.removeListenerAsk = null }, enabled = limit != listener.limit) { Text("Speichern") }
                    }
                    Text("Entfernen: Die App von ${listener.name} kommt sofort nicht mehr auf dein Radio. Für einen neuen Zugang braucht es eine neue Einladung.",
                        style = MaterialTheme.typography.bodySmall, color = Nocturne.muted)
                    Row(verticalAlignment = Alignment.CenterVertically) {
                        androidx.compose.material3.Checkbox(checked = erase, onCheckedChange = { erase = it })
                        Text("Auch alle Daten löschen (Programm, Audio, Einstellungen, Nachrichten)", style = MaterialTheme.typography.bodySmall)
                    }
                }
            },
            confirmButton = { TextButton(onClick = { actions.removeListener(listener.key, erase) }) { Text(if (erase) "Entfernen und löschen" else "Entfernen") } },
            dismissButton = { TextButton(onClick = { state.removeListenerAsk = null }) { Text("Abbrechen") } },
            containerColor = Nocturne.surface,
        )
    }
}

/**
 * «Entwickler: KI-Aufrufe»: every call to Gemini, ASK or Mistral of the last two days, newest first –
 * station, purpose, model, time and tokens; a tap shows what went out and what came back.
 */
@OptIn(ExperimentalLayoutApi::class)
@Composable
fun LlmCallsContent(state: RadioState, actions: RadioActions) {
    LaunchedEffect(Unit) { if (state.llmCalls == null) actions.loadLlmCalls() }
    Text("Alle Stationen auf deinem Server. Prompts und Antworten sind gekürzt; Audio steht nur als Grösse da.",
        style = MaterialTheme.typography.bodySmall, color = Nocturne.muted)
    FlowRow(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
        FilterChip(selected = !state.llmFailedOnly, onClick = { state.llmFailedOnly = false; actions.loadLlmCalls() }, label = { Text("Alle") })
        FilterChip(selected = state.llmFailedOnly, onClick = { state.llmFailedOnly = true; actions.loadLlmCalls() }, label = { Text("Nur Fehler") })
        TextButton(onClick = { actions.loadLlmCalls() }) { Text("Neu laden") }
    }
    val calls = state.llmCalls ?: return SkeletonRows(6, "KI-Aufrufe")
    if (calls.isEmpty()) return Text(if (state.llmFailedOnly) "Keine Fehler." else "Noch keine Aufrufe.", style = MaterialTheme.typography.bodyMedium)
    val clock = java.time.format.DateTimeFormatter.ofPattern("d.M. HH:mm:ss").withZone(java.time.ZoneId.systemDefault())
    for (call in calls) {
        Column(Modifier.fillMaxWidth().clickable { state.llmCallOpen = call }.padding(vertical = 6.dp)) {
            val at = runCatching { clock.format(java.time.Instant.parse(call.at)) }.getOrDefault(call.at)
            Text(listOfNotNull(at, call.station, call.model).joinToString(" · "), style = MaterialTheme.typography.labelMedium, color = if (call.failed) Nocturne.kind(Kind.NEWS) else Nocturne.muted)
            Text(call.purpose, style = MaterialTheme.typography.bodyMedium, maxLines = 2, overflow = TextOverflow.Ellipsis)
            Text(listOfNotNull(if (call.failed) "Fehler ${call.status}" else null, call.meta).joinToString(" · "), style = MaterialTheme.typography.bodySmall, color = Nocturne.muted)
        }
    }
    if (calls.size % 50 == 0) TextButton(onClick = { actions.loadLlmCalls(more = true) }) { Text("Ältere laden") }
    state.llmCallOpen?.let { call ->
        val clipboard = androidx.compose.ui.platform.LocalClipboardManager.current
        AlertDialog(
            onDismissRequest = { state.llmCallOpen = null },
            title = { Text("${call.model} · ${call.meta}", style = MaterialTheme.typography.titleSmall) },
            text = {
                androidx.compose.foundation.text.selection.SelectionContainer {
                    Column(Modifier.heightIn(max = 520.dp).verticalScroll(rememberScrollState())) {
                        Text("ANFRAGE", style = Kicker, color = Nocturne.muted)
                        Text(call.request.ifBlank { "–" }, style = MaterialTheme.typography.bodySmall.copy(fontFamily = androidx.compose.ui.text.font.FontFamily.Monospace))
                        Text("ANTWORT${if (call.failed) " (HTTP ${call.status})" else ""}", style = Kicker, color = Nocturne.muted, modifier = Modifier.padding(top = 12.dp))
                        Text(call.response.ifBlank { "–" }, style = MaterialTheme.typography.bodySmall.copy(fontFamily = androidx.compose.ui.text.font.FontFamily.Monospace))
                    }
                }
            },
            confirmButton = { TextButton(onClick = { state.llmCallOpen = null }) { Text("Schliessen") } },
            dismissButton = {
                TextButton(onClick = {
                    clipboard.setText(androidx.compose.ui.text.AnnotatedString("${call.model} ${call.at}\n\n${call.request}\n\n---\n\n${call.response}"))
                    state.say("Kopiert.")
                }) { Text("Kopieren") }
            },
            containerColor = Nocturne.surface,
        )
    }
}
