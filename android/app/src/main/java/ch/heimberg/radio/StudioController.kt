package ch.heimberg.radio

import android.content.Intent
import android.net.Uri
import ch.heimberg.radio.core.AgentInfo
import ch.heimberg.radio.core.ListeningProfile
import ch.heimberg.radio.core.StationDraft
import ch.heimberg.radio.core.StudioSettings
import kotlinx.coroutines.launch

/** «Studio»: the settings with their draft, the first setup, insights, the agents and the listening profile. */
interface StudioActions {
    /** Loads the settings (once, or again with [force]), edits them locally, saves them. */
    fun loadStudio(force: Boolean = false)
    fun editStudio(settings: StudioSettings)
    /** Shows, feeds and agents: a changed draft, saved with the rest. */
    fun editStation(draft: StationDraft)
    fun saveStudio()
    fun discardStudio()
    /** First start: sets up the station with the default shows. */
    fun setUpStation(interests: List<String> = emptyList(), voiceId: String? = null, taste: String = "")
    /** Usage and quality, the agents, the listening profile: loaded when their card opens. */
    fun loadInsights()
    fun loadDiagnostics()
    /** Developer view: the newest provider calls, or the next page with [more]. */
    fun loadLlmCalls(more: Boolean = false)
    /** Sicherungen: list, copy now, bring one back. */
    fun loadBackups()
    fun backupNow()
    fun restoreBackup(name: String)
    /** Einladen: list, hand out (opens the share sheet), withdraw, take a listener's access away. */
    fun loadInvites()
    fun createInvite(name: String, kind: ch.heimberg.radio.core.ListenerKind)
    fun deleteInvite(id: String)
    fun removeListener(key: String, eraseData: Boolean = false)
    fun setListenerLimit(key: String, dailyGenerations: Int?)
    /** A monthly budget in francs for `server`, `own` or a listener; null removes it. */
    fun setBudget(station: String, monthlyChf: Double?)
    fun loadAgents()
    fun loadListening()
    fun connectListening()
    fun disconnectListening()
    fun clearReasons()
    /** A trial run of the agent with the draft's settings; nothing is saved. */
    fun trialAgent(agent: AgentInfo)
    fun searchPlaces(name: String)
}

class StudioController(private val ref: HostRef) : StudioActions {
    private val host get() = ref.host
    private val state get() = host.state
    private val api get() = host.api

    override fun loadStudio(force: Boolean) {
        // Unsaved changes stay until they are saved or discarded.
        if (!force && (state.studio != null || state.studioMissing)) return
        host.scope.launch {
            // The formats first, so the show editor shows the server's lengths from the start.
            runCatching { api.formats() }
            runCatching { api.station() }
                .onSuccess { config ->
                    state.studio = config?.let { StudioSettings.of(it) }
                    state.station = config?.let(::StationDraft)
                    state.studioMissing = config == null
                    state.studioDirty = false
                }
                .onFailure { state.say(host.failure(it)) }
        }
        if (state.voices.isEmpty()) host.scope.launch { runCatching { api.voices() }.onSuccess { state.voices = it } }
    }

    override fun editStudio(settings: StudioSettings) {
        if (settings == state.studio) return
        state.studio = settings
        state.studioDirty = true
    }

    override fun editStation(draft: StationDraft) {
        if (draft == state.station) return
        state.station = draft
        state.studioDirty = true
    }

    override fun saveStudio() {
        val settings = state.studio ?: return
        state.studioSaving = true
        host.scope.launch {
            val result = runCatching { api.saveStudio(settings, state.station) }
            state.studioSaving = false
            if (result.isSuccess) state.studioDirty = false
            state.say(result.fold({ "Gespeichert. Gilt ab den nächsten Beiträgen." }, { host.failure(it) }))
            if (result.isSuccess) host.changed()
        }
    }

    override fun discardStudio() {
        state.studioDirty = false
        loadStudio(force = true)
    }

    override fun setUpStation(interests: List<String>, voiceId: String?, taste: String) {
        if (state.settingUp) return
        state.settingUp = true
        host.scope.launch {
            val result = runCatching { api.setUp(java.util.TimeZone.getDefault().id, interests, voiceId, taste) }
            state.settingUp = false
            state.say(result.fold({ "Dein Radio ist eingerichtet. Das erste Programm wird produziert." }, { host.failure(it) }))
            if (result.isSuccess) {
                loadStudio(force = true)
                host.changed()
                // The first program is on its way: «Hören» shows it as it arrives.
                state.tab = Tab.LISTEN
            }
        }
    }

    override fun loadInsights() {
        host.scope.launch { runCatching { api.insights() }.onSuccess { state.insights = it } }
    }

    override fun loadBackups() {
        host.scope.launch { runCatching { api.backups() }.onSuccess { state.backups = it }.onFailure { state.say(host.failure(it)) } }
    }

    override fun backupNow() {
        host.scope.launch {
            runCatching { api.backupNow() }.onSuccess { state.backups = it; state.say("Einstellungen gesichert.") }.onFailure { state.say(host.failure(it)) }
        }
    }

    override fun restoreBackup(name: String) {
        state.restoreAsk = null
        host.scope.launch {
            runCatching { api.restoreBackup(name) }
                .onSuccess { state.say("Sicherung vom ${Backups.label(name)} wiederhergestellt."); loadStudio(true); loadBackups(); host.changed() }
                .onFailure { state.say(host.failure(it)) }
        }
    }

    override fun loadInvites() {
        host.scope.launch { runCatching { api.invites() }.onSuccess { state.invites = it }.onFailure { state.say(host.failure(it)) } }
    }

    override fun createInvite(name: String, kind: ch.heimberg.radio.core.ListenerKind) {
        host.scope.launch {
            runCatching { api.createInvite(name, kind) }
                .onSuccess { invite ->
                    loadInvites()
                    // The code is shown only now: the share sheet sends it on (messenger, mail, SMS).
                    val send = Intent(Intent.ACTION_SEND).setType("text/plain").putExtra(Intent.EXTRA_TEXT, invite.message(name, state.stationName.ifBlank { null }))
                    host.activity.startActivity(Intent.createChooser(send, "Einladung an $name senden"))
                }
                .onFailure { state.say(host.failure(it)) }
        }
    }

    override fun deleteInvite(id: String) {
        host.scope.launch { runCatching { api.deleteInvite(id) }.onSuccess { state.say("Einladung zurückgezogen."); loadInvites() }.onFailure { state.say(host.failure(it)) } }
    }

    override fun removeListener(key: String, eraseData: Boolean) {
        state.removeListenerAsk = null
        host.scope.launch {
            runCatching { api.removeListener(key, eraseData) }
                .onSuccess { state.say(if (eraseData) "Zugang und alle Daten entfernt." else "Zugang entfernt."); loadInvites() }
                .onFailure { state.say(host.failure(it)) }
        }
    }

    override fun setListenerLimit(key: String, dailyGenerations: Int?) {
        host.scope.launch { runCatching { api.setListenerLimit(key, dailyGenerations) }.onSuccess { loadInvites() }.onFailure { state.say(host.failure(it)) } }
    }

    override fun setBudget(station: String, monthlyChf: Double?) {
        host.scope.launch {
            runCatching { api.setBudget(station, monthlyChf) }
                .onSuccess { state.say(if (monthlyChf == null) "Budget entfernt." else "Budget gespeichert."); loadInvites(); loadInsights() }
                .onFailure { state.say(host.failure(it)) }
        }
    }

    override fun loadLlmCalls(more: Boolean) {
        val before = if (more) state.llmCalls?.lastOrNull()?.id else null
        host.scope.launch {
            runCatching { api.llmCalls(before, state.llmFailedOnly) }
                .onSuccess { page -> state.llmCalls = if (more) state.llmCalls.orEmpty() + page else page }
                .onFailure { state.say(host.failure(it)) }
        }
    }

    override fun loadDiagnostics() {
        host.scope.launch { runCatching { api.diagnostics() }.onSuccess { state.diagnostics = it }.onFailure { state.say(host.failure(it)) } }
    }

    override fun loadAgents() {
        if (state.agentInfo.isNotEmpty()) return
        host.scope.launch {
            runCatching { api.agents() }.onSuccess { (agents, presets) -> state.agentInfo = agents; state.agentPresets = presets }
        }
    }

    override fun loadListening() {
        host.scope.launch { runCatching { api.listening() }.onSuccess { state.listening = it } }
    }

    /** Spotify's login opens in the browser; back in the app, the card loads the new state. */
    override fun connectListening() {
        runCatching { host.activity.startActivity(Intent(Intent.ACTION_VIEW, Uri.parse(api.listeningConnectUrl()))) }
            .onFailure { state.say("Kein Browser gefunden.") }
    }

    override fun disconnectListening() {
        host.scope.launch {
            runCatching { api.disconnectListening() }
                .onSuccess { state.listening = ListeningProfile(false, emptyList()) }
                .onFailure { state.say(host.failure(it)) }
        }
    }

    override fun clearReasons() {
        host.scope.launch {
            runCatching { api.clearReasons() }
                .onSuccess { state.say("Zurückgesetzt."); loadInsights() }
                .onFailure { state.say(host.failure(it)) }
        }
    }

    override fun trialAgent(agent: AgentInfo) {
        if (state.trials.containsKey(agent.id) && state.trials[agent.id] == null) return
        state.trials = state.trials + (agent.id to null)
        host.scope.launch {
            val result = runCatching { api.trial(agent.id, state.station?.config?.get("agents")) }
                .getOrElse { TrialResult(false, "", null, null, "FAILED", it.message) }
            state.trials = state.trials + (agent.id to result)
        }
    }

    override fun searchPlaces(name: String) {
        if (name.trim().length < 2) return
        host.scope.launch {
            runCatching { api.places(name.trim()) }
                .onSuccess { state.places = it }
                .onFailure { state.say("Die Ortssuche ist gerade nicht erreichbar.") }
        }
    }
}
