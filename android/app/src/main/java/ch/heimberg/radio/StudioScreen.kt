package ch.heimberg.radio

import androidx.compose.runtime.key
import androidx.activity.compose.BackHandler
import androidx.compose.animation.animateContentSize
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ExperimentalLayoutApi
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.KeyboardActions
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.AssistChip
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.FilledTonalButton
import androidx.compose.material3.FilterChip
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.InputChip
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.RadioButton
import androidx.compose.material3.Slider
import androidx.compose.material3.Switch
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.mutableStateListOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.draw.drawBehind
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import ch.heimberg.radio.core.Kind
import ch.heimberg.radio.core.StudioSettings
import ch.heimberg.radio.core.VoiceGroups

/**
 * «Studio»: every setting of the station – station and host, the voice with a sample, where you listen,
 * interests, music and station sound, then shows, feeds, the editorial team, quality, usage and the
 * Spotify listening profile. Changes stay local until «Speichern».
 */
@Composable
fun StudioScreen(state: RadioState, actions: RadioActions, version: String, padding: PaddingValues) {
    LaunchedEffect(Unit) { actions.loadStudio() }
    val settings = state.studio
    Column(Modifier.fillMaxSize().padding(padding)) {
        Row(Modifier.fillMaxWidth().padding(start = 20.dp, end = 8.dp, top = 6.dp), verticalAlignment = Alignment.CenterVertically) {
            ScreenTitle("Studio")
            Spacer(Modifier.weight(1f))
            Text(version, style = MaterialTheme.typography.bodySmall, color = Nocturne.faint)
            TextButton(onClick = actions::openConnection) { Text("Verbindung") }
        }
        if (state.studioDirty) SaveBar(state, actions)
        // A setting opens as its own page; back (or the arrow) returns to the overview.
        val page = state.studioCard
        BackHandler(enabled = page != null) { state.studioCard = null }
        if (page != null) {
            Row(Modifier.fillMaxWidth().padding(start = 4.dp, end = 16.dp), verticalAlignment = Alignment.CenterVertically) {
                IconButton(onClick = { state.studioCard = null }) { Icon(painterResource(R.drawable.ic_arrow_left), "Zurück zur Übersicht") }
                Text(PAGE_TITLES[page] ?: "", style = MaterialTheme.typography.titleLarge)
            }
        }
        Column(Modifier.weight(1f).verticalScroll(key(page) { rememberScrollState() }).padding(bottom = 24.dp)) {
            when {
                settings != null -> {
                    if (page == null) StationHero(settings, state)
                    Cards(settings, state, actions)
                }
                state.studioMissing -> FirstStart(state, actions)
                else -> Text("Einstellungen werden geladen …", style = MaterialTheme.typography.bodyMedium, color = Nocturne.muted, modifier = Modifier.padding(20.dp))
            }
            if (page == null) More(state, actions)
        }
    }
    VoiceDialogs(state, actions)
    StationSheets(state, actions)
}

@Composable
private fun SaveBar(state: RadioState, actions: RadioActions) {
    Row(
        Modifier.padding(horizontal = 16.dp, vertical = 6.dp).fillMaxWidth().clip(RoundedCornerShape(16.dp))
            .background(Nocturne.text).padding(start = 16.dp, end = 8.dp, top = 4.dp, bottom = 4.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Text("Noch nicht gespeichert", style = MaterialTheme.typography.bodyMedium, color = Nocturne.bg, modifier = Modifier.weight(1f))
        TextButton(onClick = actions::discardStudio, enabled = !state.studioSaving) { Text("Verwerfen", color = Nocturne.bg.copy(alpha = 0.8f)) }
        Button(
            onClick = actions::saveStudio, enabled = !state.studioSaving,
            colors = ButtonDefaults.buttonColors(containerColor = Nocturne.bg, contentColor = Nocturne.text),
        ) { Text(if (state.studioSaving) "Speichert …" else "Speichern") }
    }
}

/** The station at a glance, as an ink card like a magazine cover: its name big, who speaks and in which voice. */
@Composable
private fun StationHero(settings: StudioSettings, state: RadioState) {
    val voice = state.voices.firstOrNull { it.id == settings.voiceId }?.name ?: settings.voiceId ?: "Standardstimme"
    Column(
        Modifier.padding(horizontal = 16.dp, vertical = 8.dp).fillMaxWidth()
            .clip(RoundedCornerShape(22.dp))
            .background(Nocturne.text)
            .drawBehind {
                val center = Offset(size.width - 24.dp.toPx(), 24.dp.toPx())
                for (ring in listOf(24, 50, 78)) drawCircle(Nocturne.bg.copy(alpha = 0.18f), radius = ring.dp.toPx(), center = center, style = Stroke(1.5.dp.toPx()))
            }
            .padding(20.dp),
    ) {
        Text("DEIN SENDER", style = Kicker, color = Nocturne.bg.copy(alpha = 0.7f))
        Spacer(Modifier.height(28.dp))
        Text(settings.name.ifBlank { "Dein Radio" }.uppercase(), style = display(40), color = Nocturne.bg, maxLines = 2, overflow = TextOverflow.Ellipsis)
        Spacer(Modifier.height(6.dp))
        Text(
            listOfNotNull(settings.hostName.ifBlank { null }?.let { "mit $it" }, voice.substringBefore(" ("), settings.place?.name).joinToString(" · "),
            style = MaterialTheme.typography.bodyMedium, color = Nocturne.bg.copy(alpha = 0.8f), maxLines = 2, overflow = TextOverflow.Ellipsis,
        )
    }
}

@Composable
private fun Cards(settings: StudioSettings, state: RadioState, actions: RadioActions) {
    val edit = actions::editStudio
    // What the station does on its own and which blocks the palette shows: one place for all of it.
    if (state.studioCard == null) Text("EINSTELLUNGEN", style = Kicker, color = Nocturne.muted, modifier = Modifier.padding(start = 20.dp, top = 14.dp, bottom = 4.dp))
    Card("funktionen", R.drawable.ic_puzzle, Kind.SPECIAL, "Funktionen", state.features?.summary ?: "Was das Radio von selbst macht, und die Bausteine", state) { FeaturesContent(state, actions) }
    Card("sender", R.drawable.ic_microphone, Kind.NEWS, "Sender und Moderation", "${settings.name} · ${settings.hostName} · ${settings.tone}", state) {
        Field("Name des Senders", settings.name) { edit(settings.copy(name = it.take(60))) }
        Field("Moderation", settings.hostName) { edit(settings.copy(hostName = it.take(40))) }
        Field("Tonfall", settings.tone, hint = "z. B. ruhig, neugierig, präzise") { edit(settings.copy(tone = it.take(160))) }
        Field("Stil", settings.style, hint = "z. B. persönliches Hintergrundradio") { edit(settings.copy(style = it.take(160))) }
        Field("Co-Moderation in Dialogen", settings.cohostName) { edit(settings.copy(cohostName = it.take(40))) }
        Field("Anweisungen an die Moderation", settings.instructions, hint = "Gilt für alle Sendungen.", lines = 3) { edit(settings.copy(instructions = it.take(2000))) }
    }
    val voiceName = state.voices.firstOrNull { it.id == settings.voiceId }?.name ?: settings.voiceId ?: "Standard"
    Card("stimme", R.drawable.ic_user_sound, Kind.MUSIC, "Stimme", voiceName, state) {
        Text("Antippen wählt die Stimme, ▶ spielt eine Hörprobe mit deinem Sendernamen.", style = MaterialTheme.typography.bodySmall, color = Nocturne.muted)
        Field("Sprechstil", settings.voiceStyle, hint = "Gemini-Stimmen folgen ihm, z. B. «warm, lebendig, mit hörbarem Lächeln».", lines = 2) { edit(settings.copy(voiceStyle = it.take(300))) }
        Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            FilledTonalButton(onClick = { state.designOpen = true }) { IconText(R.drawable.ic_sparkle, "Entwerfen") }
            FilledTonalButton(onClick = { state.cloneOpen = true }) { IconText(R.drawable.ic_microphone, "Meine Stimme") }
        }
        VoiceSearch(state, actions)
        // Which voice the list sets: the host's, or the co-host's in dialogs such as «Hintergrund».
        val cohost = state.voiceForCohost
        Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            FilterChip(selected = !cohost, onClick = { state.voiceForCohost = false }, label = { Text("Moderation") })
            FilterChip(selected = cohost, onClick = { state.voiceForCohost = true }, label = { Text("Zweite Stimme (Dialoge)") })
        }
        if (cohost) Text("In Dialogen spricht die Moderation mit ihrer Stimme, «${settings.cohostName.ifBlank { "die Co-Moderation" }}» mit dieser. Standardstimmen klingen im Dialog am natürlichsten.", style = MaterialTheme.typography.bodySmall, color = Nocturne.muted)
        val current = if (cohost) settings.cohostVoiceId else settings.voiceId
        val choose = { id: String? -> edit(if (cohost) settings.copy(cohostVoiceId = id) else settings.copy(voiceId = id)) }
        VoiceRow("Voreinstellung des Servers", selected = current == null, previewing = false, onPreview = null) { choose(null) }
        if (state.voices.isEmpty()) Text("Stimmen werden geladen …", style = MaterialTheme.typography.bodySmall, color = Nocturne.muted)
        for ((group, label) in VoiceGroups.ORDER) {
            val voices = state.voices.filter { it.group == group }
            if (voices.isEmpty()) continue
            Text(label.uppercase(), style = Kicker, color = Nocturne.muted, modifier = Modifier.padding(top = 6.dp))
            for (voice in voices) {
                // Dialogs use Gemini voices only; Mistral voices stay out of the second voice.
                if (cohost && !voice.id.startsWith("gemini_")) continue
                VoiceRow(
                    voice.name, selected = voice.id == current, previewing = state.previewing == voice.id,
                    onPreview = { actions.previewVoice(voice.id) }, detail = voice.description,
                    onDelete = if (voice.own) ({ state.voiceDeleteAsk = voice }) else null,
                ) { choose(voice.id) }
            }
        }
    }
    Card("ort", R.drawable.ic_map_pin, Kind.DISCOVER, "Wo du hörst", settings.place?.name ?: "Noch kein Ort – ohne Ort kein Wetter", state) { PlacePicker(settings, state, actions) }
    val interests = settings.topics + settings.interests
    Card("interessen", R.drawable.ic_sparkle, Kind.STORY, "Interessen", if (interests.isEmpty()) "Noch keine" else interests.take(4).joinToString(", ") + if (interests.size > 4) " und ${interests.size - 4} weitere" else "", state) {
        Interests(settings, actions)
    }
    val songs = when (settings.between) { 0 -> "Keine Songs zwischen Beiträgen"; 1 -> "1 Song zwischen Beiträgen"; else -> "${settings.between} Songs zwischen Beiträgen" }
    Card("musik", R.drawable.ic_music_notes, Kind.MUSIC, "Musik", songs + if (settings.taste.isNotBlank()) " · ${settings.taste.take(40)}" else "", state) {
        Text(if (settings.between == 0) "Songs zwischen Beiträgen: aus" else songs, style = MaterialTheme.typography.bodyMedium)
        Slider(value = settings.between.toFloat(), onValueChange = { edit(settings.between(Math.round(it))) }, valueRange = 0f..3f, steps = 2)
        Field("Musikgeschmack", settings.taste, hint = "Genres, Künstler, Stimmungen – so konkret wie möglich.", lines = 2) { edit(settings.copy(taste = it.take(500))) }
        Toggle("Kurze Ansage vor jedem Song", null, settings.announce) { edit(settings.copy(announce = it)) }
        Text("Dein Spotify-Hörprofil verbindest du unten unter «Spotify-Hörprofil».", style = MaterialTheme.typography.bodySmall, color = Nocturne.muted)
    }
    val sounds = listOf(settings.ident, settings.hourChange, settings.linker, settings.bed).count { it }
    Card("sound", R.drawable.ic_speaker, Kind.NEWS, "Stationssound", "$sounds von 4 an", state) {
        Toggle("Jingles", "Zwischen Musik und Wort, der Opener vor den Nachrichten", settings.ident) { edit(settings.copy(ident = it)) }
        Toggle("Zeitzeichen zur vollen Stunde", "Mit der gesprochenen Zeitansage", settings.hourChange) { edit(settings.copy(hourChange = it)) }
        Toggle("Live-Übergänge", "Die Moderation verbindet die Beiträge kurz vor der Sendung", settings.linker) { edit(settings.copy(linker = it)) }
        Toggle("Klangteppich", "Leise Musik unter kurzen Moderationen", settings.bed) { edit(settings.copy(bed = it)) }
    }
    if (state.isHost) {
        val open = state.invites?.open?.size ?: 0
        val listening = state.invites?.listeners?.size
        Card("einladen", R.drawable.ic_users, Kind.STORY, "Einladen", when {
            listening == null -> "Familie, Kinder oder Gäste mit eigenem Sender"
            else -> "$listening Hörer${if (open > 0) " · $open offen" else ""}"
        }, state) { InvitesContent(state, actions) }
        Card("entwickler", R.drawable.ic_sparkle, Kind.SPECIAL, "Entwickler: KI-Aufrufe", "Jeder Aufruf der letzten zwei Tage, mit Prompt und Antwort", state) { LlmCallsContent(state, actions) }
    }
    val station = state.station
    if (station != null) {
        if (state.studioCard == null) Text("PROGRAMM UND REDAKTION", style = Kicker, color = Nocturne.muted, modifier = Modifier.padding(start = 20.dp, top = 18.dp, bottom = 4.dp))
        Card("sendungen", R.drawable.ic_radio, Kind.DISCOVER, "Sendungen", "${station.shows.count { it.enabled }} aktiv von ${station.shows.size}", state) { ShowsContent(state, actions) }
        Card("feeds", R.drawable.ic_newspaper, Kind.NEWS, "Feeds", if (station.feeds.isEmpty()) "Keine" else station.feeds.joinToString(", ") { it.name }, state) { FeedsContent(state, actions) }
        val changed = station.agents.size
        Card("redaktion", R.drawable.ic_pen_nib, Kind.STORY, "Redaktion", if (changed == 0) "Alle Agenten wie ausgeliefert" else "$changed ${if (changed == 1) "Agent" else "Agenten"} angepasst", state) { AgentsContent(state, actions) }
        Card("qualitaet", R.drawable.ic_star, Kind.SPECIAL, "Qualität", "Noten der Jury und was du bemängelt hast", state) { QualityContent(state, actions) }
        Card("sicherungen", R.drawable.ic_rewind, Kind.STORY, "Sicherungen", "Jeden Sonntag, die letzten acht – wiederherstellbar", state) { BackupsContent(state, actions) }
        Card("diagnose", R.drawable.ic_warning_circle, Kind.NEWS, "Diagnose", "Die letzten Fehler und ihr Grund", state) { DiagnosticsContent(state, actions) }
        Card("verbrauch", R.drawable.ic_chart_bar, Kind.DISCOVER, "Verbrauch", usageSummary(state.insights), state) { UsageContent(state, actions) }
        Card("spotify", R.drawable.ic_headphones, Kind.MUSIC, "Spotify-Hörprofil", when (state.listening?.connected) { true -> "Verbunden"; false -> "Nicht verbunden"; null -> "Deine Top-Künstler für die Songauswahl" }, state) { ListeningContent(state, actions) }
    }
}

/** The titles of the setting pages, for the bar above an open page. */
private val PAGE_TITLES = mapOf(
    "funktionen" to "Funktionen", "sender" to "Sender und Moderation", "stimme" to "Stimme", "ort" to "Wo du hörst",
    "interessen" to "Interessen", "musik" to "Musik", "sound" to "Stationssound", "sendungen" to "Sendungen", "feeds" to "Feeds",
    "redaktion" to "Redaktion", "qualitaet" to "Qualität", "verbrauch" to "Verbrauch", "diagnose" to "Diagnose", "sicherungen" to "Sicherungen", "spotify" to "Spotify-Hörprofil",
)

/**
 * One setting: in the overview a row with its icon on a rubric colour and a one-line summary; a tap opens it
 * as its own page (the same [id] in [RadioState.studioCard]), which shows only its content.
 */
@Composable
private fun Card(id: String, icon: Int, kind: Kind, title: String, summary: String, state: RadioState, content: @Composable () -> Unit) {
    val page = state.studioCard
    if (page == id) {
        Column(Modifier.padding(start = 16.dp, end = 16.dp, top = 4.dp), verticalArrangement = Arrangement.spacedBy(10.dp)) { content() }
        return
    }
    if (page != null) return
    val shape = RoundedCornerShape(18.dp)
    Row(
        Modifier.padding(horizontal = 16.dp, vertical = 4.dp).fillMaxWidth().clip(shape)
            .background(Nocturne.surface)
            .border(1.dp, Nocturne.divider, shape)
            .clickable { state.studioCard = id }
            .padding(start = 12.dp, end = 14.dp, top = 12.dp, bottom = 12.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        KindBadge(icon, kind, 40.dp)
        Spacer(Modifier.width(12.dp))
        Column(Modifier.weight(1f)) {
            Text(title, style = MaterialTheme.typography.titleMedium)
            Text(summary, style = MaterialTheme.typography.bodySmall, color = Nocturne.muted, maxLines = 1, overflow = TextOverflow.Ellipsis)
        }
        Text("›", style = MaterialTheme.typography.titleLarge, color = Nocturne.muted)
    }
}

@Composable
private fun Field(label: String, value: String, hint: String? = null, lines: Int = 1, onChange: (String) -> Unit) {
    OutlinedTextField(
        value = value, onValueChange = onChange, label = { Text(label) },
        supportingText = hint?.let { { Text(it) } }, singleLine = lines == 1, minLines = lines,
        modifier = Modifier.fillMaxWidth(),
    )
}

@Composable
private fun Toggle(title: String, detail: String?, checked: Boolean, onChange: (Boolean) -> Unit) {
    Row(Modifier.fillMaxWidth().clickable { onChange(!checked) }.padding(vertical = 4.dp), verticalAlignment = Alignment.CenterVertically) {
        Column(Modifier.weight(1f)) {
            Text(title, style = MaterialTheme.typography.bodyLarge)
            detail?.let { Text(it, style = MaterialTheme.typography.bodySmall, color = Nocturne.muted) }
        }
        Switch(checked = checked, onCheckedChange = onChange)
    }
}

@Composable
private fun VoiceRow(
    name: String, selected: Boolean, previewing: Boolean, onPreview: (() -> Unit)?,
    detail: String = "", onDelete: (() -> Unit)? = null, onSelect: () -> Unit,
) {
    Row(
        Modifier.fillMaxWidth().clip(RoundedCornerShape(12.dp)).background(if (selected) Nocturne.accentDark else Nocturne.surface)
            .clickable(onClick = onSelect).padding(start = 4.dp, end = 4.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        RadioButton(selected = selected, onClick = onSelect)
        Column(Modifier.weight(1f).padding(vertical = 6.dp)) {
            Text(name, style = MaterialTheme.typography.bodyMedium, maxLines = 2, overflow = TextOverflow.Ellipsis)
            if (detail.isNotBlank()) Text(detail, style = MaterialTheme.typography.bodySmall, color = Nocturne.muted, maxLines = 2, overflow = TextOverflow.Ellipsis)
        }
        if (onDelete != null) IconButton(onClick = onDelete) { Icon(painterResource(R.drawable.ic_trash), "Stimme löschen", Modifier.size(18.dp), tint = Nocturne.muted) }
        if (onPreview != null) {
            IconButton(onClick = onPreview) {
                Icon(
                    painterResource(if (previewing) R.drawable.ic_pause else R.drawable.ic_play), if (previewing) "Hörprobe anhalten" else "Hörprobe",
                    Modifier.size(20.dp).clip(CircleShape), tint = Nocturne.accentLight,
                )
            }
        }
    }
}

@OptIn(ExperimentalLayoutApi::class)
@Composable
private fun PlacePicker(settings: StudioSettings, state: RadioState, actions: RadioActions) {
    var query by remember { mutableStateOf("") }
    settings.place?.let { place ->
        Row(verticalAlignment = Alignment.CenterVertically) {
            Text("📍 ${place.name}", style = MaterialTheme.typography.bodyLarge, modifier = Modifier.weight(1f))
            TextButton(onClick = { actions.editStudio(settings.copy(place = null)) }) { Text("Entfernen") }
        }
    }
    OutlinedTextField(
        value = query, onValueChange = { query = it.take(80) }, label = { Text("Ort suchen, z. B. Bern") }, singleLine = true,
        keyboardOptions = KeyboardOptions(imeAction = ImeAction.Search), keyboardActions = KeyboardActions(onSearch = { actions.searchPlaces(query) }),
        trailingIcon = { TextButton(onClick = { actions.searchPlaces(query) }, enabled = query.trim().length >= 2) { Text("Suchen") } },
        modifier = Modifier.fillMaxWidth(),
    )
    state.places?.let { places ->
        if (places.isEmpty()) Text("Kein Ort gefunden.", style = MaterialTheme.typography.bodySmall, color = Nocturne.muted)
        FlowRow(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            for (place in places) {
                AssistChip(onClick = {
                    actions.editStudio(settings.copy(place = place.copy(region = "", country = "")))
                    state.places = null
                    query = ""
                }, label = { Text(place.label) })
            }
        }
    }
}

@OptIn(ExperimentalLayoutApi::class)
@Composable
private fun Interests(settings: StudioSettings, actions: RadioActions) {
    var own by remember { mutableStateOf("") }
    FlowRow(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
        for (topic in StudioSettings.TOPICS) {
            FilterChip(selected = topic in settings.topics, onClick = { actions.editStudio(settings.toggleTopic(topic)) }, label = { Text(topic) })
        }
    }
    val add = {
        actions.editStudio(settings.addInterest(own))
        own = ""
    }
    OutlinedTextField(
        value = own, onValueChange = { own = it.take(48) }, label = { Text("Eigenes Interesse, z. B. Geologie") }, singleLine = true,
        keyboardOptions = KeyboardOptions(imeAction = ImeAction.Done), keyboardActions = KeyboardActions(onDone = { add() }),
        trailingIcon = { TextButton(onClick = add, enabled = own.isNotBlank()) { Text("+") } },
        modifier = Modifier.fillMaxWidth(),
    )
    if (settings.interests.isNotEmpty()) {
        FlowRow(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            for (interest in settings.interests) {
                InputChip(selected = false, onClick = { actions.editStudio(settings.removeInterest(interest)) }, label = { Text("$interest  ×") })
            }
        }
    }
    Text("Neues entdecken: ${settings.exploration} %", style = MaterialTheme.typography.bodyMedium)
    Text("Platz für Themen ausserhalb deiner Interessen.", style = MaterialTheme.typography.bodySmall, color = Nocturne.muted)
    Slider(value = settings.exploration.toFloat(), onValueChange = { actions.editStudio(settings.exploration(Math.round(it))) }, valueRange = 0f..50f, steps = 9)
}

/** The day plan, which lives in «Programm». */
@Composable
private fun More(state: RadioState, actions: RadioActions) {
    Text("MEHR", style = Kicker, color = Nocturne.muted, modifier = Modifier.padding(start = 20.dp, top = 22.dp, bottom = 6.dp))
    // Only on this phone: how the app looks.
    Column(Modifier.padding(horizontal = 16.dp, vertical = 4.dp)) {
        Text("Darstellung", style = MaterialTheme.typography.titleSmall, modifier = Modifier.padding(start = 4.dp, bottom = 6.dp))
        Segments(listOf("Automatisch", "Hell", "Dunkel"), state.appearance) { actions.setAppearance(it) }
        Text("«Automatisch» folgt dem dunklen Design von Android.", style = MaterialTheme.typography.bodySmall, color = Nocturne.muted, modifier = Modifier.padding(start = 4.dp, top = 4.dp))
    }
    LinkRow("🗓", "Tagesplan", "Zeitfenster und Überraschungen") {
        state.tab = Tab.PROGRAM
        actions.openDayPlan()
    }
}

@Composable
private fun LinkRow(icon: String, title: String, detail: String, onClick: () -> Unit) {
    Row(
        Modifier.padding(horizontal = 16.dp, vertical = 4.dp).fillMaxWidth().clip(RoundedCornerShape(18.dp)).background(Nocturne.surface)
            .border(1.dp, Nocturne.divider, RoundedCornerShape(18.dp))
            .clickable(onClick = onClick).padding(horizontal = 16.dp, vertical = 14.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Text(icon, style = MaterialTheme.typography.titleLarge)
        Spacer(Modifier.width(14.dp))
        Column(Modifier.weight(1f)) {
            Text(title, style = MaterialTheme.typography.titleSmall)
            Text(detail, style = MaterialTheme.typography.bodySmall, color = Nocturne.muted)
        }
        Text("›", style = MaterialTheme.typography.titleLarge, color = Nocturne.muted)
    }
}

@Composable
private fun Note(text: String, action: @Composable () -> Unit) {
    Column(Modifier.padding(20.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
        Text(text, style = MaterialTheme.typography.bodyMedium, color = Nocturne.muted)
        action()
    }
}

/** Searches Google's German voice library by a word, e.g. «warm» or «Erzähler». */
@Composable
private fun VoiceSearch(state: RadioState, actions: RadioActions) {
    var query by remember { mutableStateOf(state.voiceSearch) }
    OutlinedTextField(
        value = query, onValueChange = { query = it.take(60) }, label = { Text("Bibliothek durchsuchen, z. B. warm") }, singleLine = true,
        keyboardOptions = KeyboardOptions(imeAction = ImeAction.Search), keyboardActions = KeyboardActions(onSearch = { actions.searchVoices(query) }),
        trailingIcon = { TextButton(onClick = { actions.searchVoices(query) }) { Text("Suchen") } },
        modifier = Modifier.fillMaxWidth(),
    )
}

@OptIn(ExperimentalLayoutApi::class)
@Composable
private fun VoiceDialogs(state: RadioState, actions: RadioActions) {
    if (state.designOpen) DesignDialog(state, actions)
    if (state.cloneOpen) CloneDialog(state, actions)
    state.voiceDeleteAsk?.let { voice ->
        AlertDialog(
            onDismissRequest = { state.voiceDeleteAsk = null },
            title = { Text("Stimme löschen?") },
            text = { Text("«${voice.name}» wird bei Google gelöscht. Beiträge, die schon gesprochen sind, bleiben.") },
            confirmButton = { TextButton(onClick = { actions.deleteVoice(voice) }) { Text("Löschen") } },
            dismissButton = { TextButton(onClick = { state.voiceDeleteAsk = null }) { Text("Abbrechen") } },
        )
    }
}

/** A voice from a description: who speaks, how, with which accent. */
@OptIn(ExperimentalLayoutApi::class)
@Composable
private fun DesignDialog(state: RadioState, actions: RadioActions) {
    var name by remember { mutableStateOf("") }
    var description by remember { mutableStateOf("") }
    var gender by remember { mutableStateOf<String?>(null) }
    AlertDialog(
        onDismissRequest = { if (!state.voiceBusy) actions.closeVoiceDialogs() },
        title = { Text("Stimme entwerfen") },
        text = {
            Column(Modifier.verticalScroll(rememberScrollState()), verticalArrangement = Arrangement.spacedBy(10.dp)) {
                Text("Beschreib die Stimme so konkret wie möglich: Alter, Klang, Tempo, Akzent, Haltung.", style = MaterialTheme.typography.bodySmall, color = Nocturne.muted)
                OutlinedTextField(value = name, onValueChange = { name = it.take(60) }, label = { Text("Name, z. B. Mira") }, singleLine = true, modifier = Modifier.fillMaxWidth())
                OutlinedTextField(
                    value = description, onValueChange = { description = it.take(600) }, minLines = 3,
                    label = { Text("Beschreibung") }, placeholder = { Text("Warme Moderatorin Mitte 30, ruhiges Tempo, leichter Berner Einschlag, hörbares Lächeln") },
                    modifier = Modifier.fillMaxWidth(),
                )
                FlowRow(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    for ((value, label) in listOf(null to "Offen", "female" to "Weiblich", "male" to "Männlich")) {
                        FilterChip(selected = gender == value, onClick = { gender = value }, label = { Text(label) })
                    }
                }
                if (state.voiceBusy) Text("Google entwirft die Stimme …", style = MaterialTheme.typography.bodySmall, color = Nocturne.accentLight)
            }
        },
        confirmButton = {
            Button(onClick = { actions.designVoice(name, description, gender) }, enabled = !state.voiceBusy && name.isNotBlank() && description.trim().length >= 10) { Text("Entwerfen") }
        },
        dismissButton = { TextButton(onClick = actions::closeVoiceDialogs, enabled = !state.voiceBusy) { Text("Abbrechen") } },
    )
}

/**
 * Cloning your own voice in four steps: what happens, a speech sample (10–30 s), the consent sentence
 * Google requires, a name. Both recordings go to Google only on «Erstellen».
 */
@Composable
private fun CloneDialog(state: RadioState, actions: RadioActions) {
    var name by remember { mutableStateOf("") }
    val step = state.cloneStep
    AlertDialog(
        onDismissRequest = { if (!state.voiceBusy && !state.recording) actions.closeVoiceDialogs() },
        title = { Text(listOf("Deine Stimme klonen", "1 · Sprachprobe", "2 · Einverständnis", "3 · Name")[step]) },
        text = {
            Column(Modifier.verticalScroll(rememberScrollState()), verticalArrangement = Arrangement.spacedBy(10.dp)) {
                when (step) {
                    0 -> {
                        Text("Aus zwei kurzen Aufnahmen macht Google eine Stimme, die wie du klingt. Sie liegt in deinem Gemini-Projekt, gilt ein Jahr und lässt sich hier jederzeit löschen.", style = MaterialTheme.typography.bodyMedium)
                        Text("Klone nur deine eigene Stimme oder eine, für die du die Erlaubnis hast. Google verlangt dafür einen gesprochenen Einverständnis-Satz.", style = MaterialTheme.typography.bodySmall, color = Nocturne.muted)
                        Text("Tipp: ruhiger Raum, Handy etwa 20 cm vor dem Mund, natürlich sprechen.", style = MaterialTheme.typography.bodySmall, color = Nocturne.muted)
                    }
                    1 -> {
                        Text("Lies diesen Text in deinem Radio-Tonfall vor (10–30 Sekunden):", style = MaterialTheme.typography.bodyMedium)
                        Quote(VoiceGroups.SAMPLE)
                        RecordButton(state, done = state.sampleSeconds, needed = 10) { actions.toggleRecording(consent = false) }
                    }
                    2 -> {
                        Text("Sprich jetzt genau diesen Satz:", style = MaterialTheme.typography.bodyMedium)
                        Quote(VoiceGroups.CONSENT)
                        RecordButton(state, done = state.consentSeconds, needed = 3) { actions.toggleRecording(consent = true) }
                    }
                    else -> {
                        OutlinedTextField(value = name, onValueChange = { name = it.take(60) }, label = { Text("Name der Stimme") }, singleLine = true, modifier = Modifier.fillMaxWidth())
                        if (state.voiceBusy) Text("Google erstellt deine Stimme …", style = MaterialTheme.typography.bodySmall, color = Nocturne.accentLight)
                    }
                }
            }
        },
        confirmButton = {
            val ready = when (step) { 0 -> true; 1 -> state.sampleSeconds >= 10; 2 -> state.consentSeconds >= 3; else -> name.isNotBlank() }
            Button(
                onClick = { if (step < 3) state.cloneStep = step + 1 else actions.cloneVoice(name) },
                enabled = ready && !state.recording && !state.voiceBusy,
            ) { Text(when (step) { 0 -> "Los"; 3 -> "Erstellen"; else -> "Weiter" }) }
        },
        dismissButton = { TextButton(onClick = actions::closeVoiceDialogs, enabled = !state.voiceBusy) { Text("Abbrechen") } },
    )
}

@Composable
private fun Quote(text: String) {
    Text(text, style = MaterialTheme.typography.bodyLarge, modifier = Modifier.fillMaxWidth().clip(RoundedCornerShape(12.dp)).background(Nocturne.surfaceHigh).padding(12.dp))
}

@Composable
private fun RecordButton(state: RadioState, done: Int, needed: Int, onClick: () -> Unit) {
    Row(verticalAlignment = Alignment.CenterVertically) {
        Button(onClick = onClick) { Text(if (state.recording) "⏹ Stopp (${state.recordedSeconds} s)" else if (done > 0) "🎤 Nochmals aufnehmen" else "🎤 Aufnehmen") }
        Spacer(Modifier.width(12.dp))
        if (!state.recording && done > 0) {
            Text(if (done >= needed) "✓ $done s" else "$done s – zu kurz", style = MaterialTheme.typography.bodySmall, color = if (done >= needed) Nocturne.accentLight else Nocturne.danger)
        }
    }
}

/** Suggestions for the first start; anything else can be typed. */
private val INTEREST_IDEAS = listOf(
    "Wissenschaft", "Raumfahrt", "Natur", "Tiere", "Geschichte", "Technik", "Klima", "Gesundheit", "Kultur", "Film",
    "Literatur", "Kunst", "Musik", "Sport", "Politik", "Wirtschaft", "Reisen", "Essen", "Schweiz", "Philosophie",
)

/**
 * The first start, in three steps: what interests you, which voice speaks, what music you like. Everything
 * can be changed later in the studio; «Überspringen» takes the defaults.
 */
@OptIn(ExperimentalLayoutApi::class)
@Composable
private fun FirstStart(state: RadioState, actions: RadioActions) {
    var step by remember { mutableStateOf(0) }
    val interests = remember { mutableStateListOf<String>() }
    var custom by remember { mutableStateOf("") }
    var voiceId by remember { mutableStateOf<String?>(null) }
    var taste by remember { mutableStateOf("") }
    Column(Modifier.padding(20.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
        Text("WILLKOMMEN · ${step + 1} VON 3", style = Kicker, color = Nocturne.muted)
        when (step) {
            0 -> {
                Text("Was interessiert dich?", style = MaterialTheme.typography.headlineSmall)
                Text("Wähle ein paar Themen. Daraus recherchiert das Radio deine Beiträge.", style = MaterialTheme.typography.bodyMedium, color = Nocturne.muted)
                FlowRow(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    for (idea in (INTEREST_IDEAS + interests.filter { it !in INTEREST_IDEAS })) {
                        FilterChip(selected = idea in interests, onClick = { if (idea in interests) interests.remove(idea) else interests.add(idea) }, label = { Text(idea) })
                    }
                }
                OutlinedTextField(custom, { custom = it.take(40) }, label = { Text("Eigenes Thema, z. B. Vulkane") }, singleLine = true, modifier = Modifier.fillMaxWidth(),
                    trailingIcon = { TextButton(onClick = { custom.trim().takeIf { it.length >= 2 && it !in interests }?.let(interests::add); custom = "" }, enabled = custom.isNotBlank()) { Text("Dazu") } })
            }
            1 -> {
                Text("Wer moderiert?", style = MaterialTheme.typography.headlineSmall)
                Text("Tippe auf eine Stimme, um sie zu hören.", style = MaterialTheme.typography.bodyMedium, color = Nocturne.muted)
                val voices = state.voices.filter { !it.own }.take(12)
                if (voices.isEmpty()) Text("Die Stimmen werden geladen …", style = MaterialTheme.typography.bodySmall, color = Nocturne.muted)
                FlowRow(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    for (voice in voices) {
                        FilterChip(selected = voiceId == voice.id, onClick = { voiceId = voice.id; actions.previewVoice(voice.id) }, label = { Text(voice.name) })
                    }
                }
            }
            else -> {
                Text("Welche Musik magst du?", style = MaterialTheme.typography.headlineSmall)
                Text("Zwischen den Beiträgen laufen Songs über Spotify. Ein paar Stichworte genügen.", style = MaterialTheme.typography.bodyMedium, color = Nocturne.muted)
                OutlinedTextField(taste, { taste = it.take(300) }, label = { Text("z. B. Indie, Jazz, Schweizer Mundart") }, modifier = Modifier.fillMaxWidth())
            }
        }
        Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            if (step > 0) TextButton(onClick = { step-- }) { Text("Zurück") }
            Spacer(Modifier.weight(1f))
            if (step < 2) {
                TextButton(onClick = { step++ }) { Text(if (step == 0 && interests.isEmpty() || step == 1 && voiceId == null) "Überspringen" else "Weiter") }
            } else {
                FilledTonalButton(onClick = { actions.setUpStation(interests.toList(), voiceId, taste.trim()) }, enabled = !state.settingUp) {
                    Text(if (state.settingUp) "Wird eingerichtet …" else "Radio starten")
                }
            }
        }
    }
}
