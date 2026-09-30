package ch.heimberg.radio

import android.annotation.SuppressLint
import android.content.Context
import android.content.Intent
import android.net.Uri
import android.view.ViewGroup
import android.webkit.CookieManager
import android.webkit.WebResourceRequest
import android.webkit.WebView
import android.webkit.WebViewClient
import androidx.compose.animation.animateContentSize
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
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
import androidx.compose.material3.AssistChip
import androidx.compose.material3.Button
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
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.toArgb
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.viewinterop.AndroidView
import ch.heimberg.radio.core.Connection
import ch.heimberg.radio.core.StudioSettings

/**
 * «Studio»: the station's everyday settings, native – station and host, the voice with a sample,
 * where you listen, interests, music and station sound. Changes stay local until «Speichern». Shows,
 * feeds, the editorial team and usage stay in the web studio, one tap away.
 */
@Composable
fun StudioScreen(state: RadioState, actions: RadioActions, web: () -> WebView, version: String, padding: PaddingValues) {
    if (state.webStudioOpen) return WebStudio(web(), actions, padding)
    LaunchedEffect(Unit) { actions.loadStudio() }
    val settings = state.studio
    Column(Modifier.fillMaxSize().padding(padding)) {
        Row(Modifier.fillMaxWidth().padding(start = 20.dp, end = 8.dp, top = 6.dp), verticalAlignment = Alignment.CenterVertically) {
            Text("Studio", style = MaterialTheme.typography.headlineSmall)
            Spacer(Modifier.weight(1f))
            Text(version, style = MaterialTheme.typography.bodySmall, color = Nocturne.faint)
            TextButton(onClick = actions::openConnection) { Text("Verbindung") }
        }
        if (state.studioDirty) SaveBar(state, actions)
        Column(Modifier.weight(1f).verticalScroll(rememberScrollState()).padding(bottom = 24.dp)) {
            when {
                settings != null -> {
                    StationHero(settings, state)
                    Cards(settings, state, actions)
                }
                state.studioMissing -> Note("Das Radio ist noch nicht eingerichtet. Die Einrichtung läuft im Web-Studio.") {
                    FilledTonalButton(onClick = actions::openWebStudio) { Text("Einrichten") }
                }
                else -> Text("Einstellungen werden geladen …", style = MaterialTheme.typography.bodyMedium, color = Nocturne.muted, modifier = Modifier.padding(20.dp))
            }
            More(state, actions)
        }
    }
}

@Composable
private fun SaveBar(state: RadioState, actions: RadioActions) {
    Row(
        Modifier.padding(horizontal = 16.dp, vertical = 6.dp).fillMaxWidth().clip(RoundedCornerShape(16.dp))
            .background(Nocturne.accentDark).padding(start = 16.dp, end = 8.dp, top = 4.dp, bottom = 4.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Text("Noch nicht gespeichert", style = MaterialTheme.typography.bodyMedium, color = Nocturne.accentLight, modifier = Modifier.weight(1f))
        TextButton(onClick = actions::discardStudio, enabled = !state.studioSaving) { Text("Verwerfen") }
        Button(onClick = actions::saveStudio, enabled = !state.studioSaving) { Text(if (state.studioSaving) "Speichert …" else "Speichern") }
    }
}

/** The station at a glance: its name, who speaks, and in which voice. */
@Composable
private fun StationHero(settings: StudioSettings, state: RadioState) {
    val voice = state.voices.firstOrNull { it.id == settings.voiceId }?.name ?: settings.voiceId ?: "Standardstimme"
    Column(
        Modifier.padding(horizontal = 16.dp, vertical = 8.dp).fillMaxWidth()
            .kindTile(null, RoundedCornerShape(24.dp), glow = 0.35f).padding(20.dp),
    ) {
        Text("📻", style = MaterialTheme.typography.headlineMedium)
        Spacer(Modifier.height(6.dp))
        Text(settings.name.ifBlank { "Dein Radio" }, style = MaterialTheme.typography.headlineSmall, maxLines = 1, overflow = TextOverflow.Ellipsis)
        Text(
            listOfNotNull(settings.hostName.ifBlank { null }?.let { "mit $it" }, voice.substringBefore(" ("), settings.place?.name).joinToString(" · "),
            style = MaterialTheme.typography.bodyMedium, color = Nocturne.muted, maxLines = 2, overflow = TextOverflow.Ellipsis,
        )
    }
}

@Composable
private fun Cards(settings: StudioSettings, state: RadioState, actions: RadioActions) {
    val edit = actions::editStudio
    Card("sender", "🎙️", "Sender und Moderation", "${settings.name} · ${settings.hostName} · ${settings.tone}", state) {
        Field("Name des Senders", settings.name) { edit(settings.copy(name = it.take(60))) }
        Field("Moderation", settings.hostName) { edit(settings.copy(hostName = it.take(40))) }
        Field("Tonfall", settings.tone, hint = "z. B. ruhig, neugierig, präzise") { edit(settings.copy(tone = it.take(160))) }
        Field("Stil", settings.style, hint = "z. B. persönliches Hintergrundradio") { edit(settings.copy(style = it.take(160))) }
        Field("Co-Moderation in Dialogen", settings.cohostName) { edit(settings.copy(cohostName = it.take(40))) }
        Field("Anweisungen an die Moderation", settings.instructions, hint = "Gilt für alle Sendungen.", lines = 3) { edit(settings.copy(instructions = it.take(2000))) }
    }
    val voiceName = state.voices.firstOrNull { it.id == settings.voiceId }?.name ?: settings.voiceId ?: "Standard"
    Card("stimme", "🗣️", "Stimme", voiceName, state) {
        Text("Antippen wählt die Stimme, ▶ spielt eine Hörprobe mit deinem Sendernamen.", style = MaterialTheme.typography.bodySmall, color = Nocturne.muted)
        Field("Sprechstil", settings.voiceStyle, hint = "Gemini-Stimmen folgen ihm, z. B. «warm, lebendig, mit hörbarem Lächeln».", lines = 2) { edit(settings.copy(voiceStyle = it.take(300))) }
        VoiceRow("Standard", selected = settings.voiceId == null, previewing = false, onPreview = null) { edit(settings.copy(voiceId = null)) }
        if (state.voices.isEmpty()) Text("Stimmen werden geladen …", style = MaterialTheme.typography.bodySmall, color = Nocturne.muted)
        for (voice in state.voices) {
            VoiceRow(voice.name, selected = voice.id == settings.voiceId, previewing = state.previewing == voice.id, onPreview = { actions.previewVoice(voice.id) }) {
                edit(settings.copy(voiceId = voice.id))
            }
        }
    }
    Card("ort", "📍", "Wo du hörst", settings.place?.name ?: "Noch kein Ort – ohne Ort kein Wetter", state) { PlacePicker(settings, state, actions) }
    val interests = settings.topics + settings.interests
    Card("interessen", "✨", "Interessen", if (interests.isEmpty()) "Noch keine" else interests.take(4).joinToString(", ") + if (interests.size > 4) " und ${interests.size - 4} weitere" else "", state) {
        Interests(settings, actions)
    }
    val songs = when (settings.between) { 0 -> "Keine Songs zwischen Beiträgen"; 1 -> "1 Song zwischen Beiträgen"; else -> "${settings.between} Songs zwischen Beiträgen" }
    Card("musik", "🎵", "Musik", songs + if (settings.taste.isNotBlank()) " · ${settings.taste.take(40)}" else "", state) {
        Text(if (settings.between == 0) "Songs zwischen Beiträgen: aus" else songs, style = MaterialTheme.typography.bodyMedium)
        Slider(value = settings.between.toFloat(), onValueChange = { edit(settings.between(Math.round(it))) }, valueRange = 0f..3f, steps = 2)
        Field("Musikgeschmack", settings.taste, hint = "Genres, Künstler, Stimmungen – so konkret wie möglich.", lines = 2) { edit(settings.copy(taste = it.take(500))) }
        Toggle("Kurze Ansage vor jedem Song", null, settings.announce) { edit(settings.copy(announce = it)) }
        Text("Dein Spotify-Hörprofil verbindest du im Web-Studio unter «Musik».", style = MaterialTheme.typography.bodySmall, color = Nocturne.muted)
    }
    val sounds = listOf(settings.ident, settings.hourChange, settings.linker, settings.bed).count { it }
    Card("sound", "🔊", "Stationssound", "$sounds von 4 an", state) {
        Toggle("Jingles", "Zwischen Musik und Wort, der Opener vor den Nachrichten", settings.ident) { edit(settings.copy(ident = it)) }
        Toggle("Zeitzeichen zur vollen Stunde", "Mit der gesprochenen Zeitansage", settings.hourChange) { edit(settings.copy(hourChange = it)) }
        Toggle("Live-Übergänge", "Die Moderation verbindet die Beiträge kurz vor der Sendung", settings.linker) { edit(settings.copy(linker = it)) }
        Toggle("Klangteppich", "Leise Musik unter kurzen Moderationen", settings.bed) { edit(settings.copy(bed = it)) }
    }
}

/** A card that opens in place; one is open at a time. */
@Composable
private fun Card(id: String, icon: String, title: String, summary: String, state: RadioState, content: @Composable () -> Unit) {
    val open = state.studioCard == id
    Column(
        Modifier.padding(horizontal = 16.dp, vertical = 5.dp).fillMaxWidth().clip(RoundedCornerShape(18.dp))
            .background(if (open) Nocturne.surfaceHigh else Nocturne.surface).animateContentSize(),
    ) {
        Row(
            Modifier.fillMaxWidth().clickable { state.studioCard = if (open) null else id }.padding(horizontal = 16.dp, vertical = 14.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Text(icon, style = MaterialTheme.typography.titleLarge)
            Spacer(Modifier.width(14.dp))
            Column(Modifier.weight(1f)) {
                Text(title, style = MaterialTheme.typography.titleSmall)
                if (!open) Text(summary, style = MaterialTheme.typography.bodySmall, color = Nocturne.muted, maxLines = 1, overflow = TextOverflow.Ellipsis)
            }
            Text(if (open) "−" else "+", style = MaterialTheme.typography.titleMedium, color = Nocturne.muted)
        }
        if (open) Column(Modifier.padding(start = 16.dp, end = 16.dp, bottom = 16.dp), verticalArrangement = Arrangement.spacedBy(10.dp)) { content() }
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
private fun VoiceRow(name: String, selected: Boolean, previewing: Boolean, onPreview: (() -> Unit)?, onSelect: () -> Unit) {
    Row(
        Modifier.fillMaxWidth().clip(RoundedCornerShape(12.dp)).background(if (selected) Nocturne.accentDark else Nocturne.surface)
            .clickable(onClick = onSelect).padding(start = 4.dp, end = 4.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        RadioButton(selected = selected, onClick = onSelect)
        Text(name, style = MaterialTheme.typography.bodyMedium, modifier = Modifier.weight(1f), maxLines = 2, overflow = TextOverflow.Ellipsis)
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

/** Everything else: the day plan in the app, the rest in the web studio. */
@Composable
private fun More(state: RadioState, actions: RadioActions) {
    Text("MEHR", style = MaterialTheme.typography.labelSmall, color = Nocturne.accentLight, modifier = Modifier.padding(start = 20.dp, top = 18.dp, bottom = 6.dp))
    LinkRow("🗓", "Tagesplan", "Zeitfenster und Überraschungen") {
        state.tab = Tab.PROGRAM
        actions.openDayPlan()
    }
    LinkRow("🧰", "Sendungen, Feeds, Redaktion", "Formate, Quellen, KI-Team, Verbrauch und Hörprofil – im Web-Studio", actions::openWebStudio)
}

@Composable
private fun LinkRow(icon: String, title: String, detail: String, onClick: () -> Unit) {
    Row(
        Modifier.padding(horizontal = 16.dp, vertical = 4.dp).fillMaxWidth().clip(RoundedCornerShape(18.dp)).background(Nocturne.surface)
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

/** The web studio for what the app does not edit itself; back returns to the native studio. */
@Composable
private fun WebStudio(web: WebView, actions: RadioActions, padding: PaddingValues) {
    Column(Modifier.fillMaxSize().padding(padding)) {
        Row(Modifier.fillMaxWidth().padding(start = 4.dp, end = 16.dp, top = 6.dp), verticalAlignment = Alignment.CenterVertically) {
            IconButton(onClick = actions::closeWebStudio) { Icon(painterResource(R.drawable.ic_arrow_left), "Zurück zum Studio") }
            Text("Web-Studio", style = MaterialTheme.typography.titleLarge)
        }
        AndroidView(
            factory = { (web.parent as? ViewGroup)?.removeView(web); web },
            modifier = Modifier.fillMaxSize(),
        )
    }
}

/** The studio's web view; created once, so the page keeps its place while other tabs are open. */
@SuppressLint("SetJavaScriptEnabled")
fun studioWebView(context: Context, connection: Connection): WebView = WebView(context).apply {
    // The ground colour shows while the page loads instead of a white flash.
    setBackgroundColor(Nocturne.bg.toArgb())
    CookieManager.getInstance().setAcceptCookie(true)
    settings.javaScriptEnabled = true
    settings.domStorageEnabled = true
    settings.userAgentString = "${settings.userAgentString} PersonalRadioAndroid/1"
    webViewClient = object : WebViewClient() {
        override fun shouldOverrideUrlLoading(view: WebView, request: WebResourceRequest): Boolean {
            val host = request.url.host ?: return true
            if (host == connection.host || host.endsWith(".cloudflareaccess.com")) return false
            // Source links open in the browser, never with the token.
            context.startActivity(Intent(Intent.ACTION_VIEW, Uri.parse(request.url.toString())))
            return true
        }
    }
    loadUrl(connection.baseUrl, connection.headers())
}
