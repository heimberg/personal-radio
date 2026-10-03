package ch.heimberg.radio

import android.Manifest
import android.content.pm.PackageManager
import androidx.core.content.ContextCompat
import ch.heimberg.radio.core.VoiceOption
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext

/** Voices in «Studio»: samples, the library search, designing, cloning (two recordings) and deleting. */
interface VoiceActions {
    /** Plays the voice sample, or stops it when it is playing. */
    fun previewVoice(voiceId: String)
    fun searchVoices(query: String)
    fun designVoice(name: String, description: String, gender: String?)
    /** Starts or stops a recording: the speech sample, or with [consent] the spoken consent. */
    fun toggleRecording(consent: Boolean)
    fun cloneVoice(name: String)
    fun deleteVoice(voice: VoiceOption)
    fun closeVoiceDialogs()
}

class VoiceController(private val ref: HostRef) : VoiceActions {
    private val host get() = ref.host
    private val state get() = host.state
    private val api get() = host.api

    /** The voice sample playing, and whether the radio was playing before it. */
    private var sample: android.media.MediaPlayer? = null
    private var resumeAfterSample = false
    /** Cloning a voice: the recorder and the two recordings (they never leave the app except to Google, on «Erstellen»). */
    private val recorder = VoiceRecorder()
    private var sampleWav: ByteArray? = null
    private var consentWav: ByteArray? = null
    private var recordingConsent = false
    private var recordTicker: Job? = null

    override fun previewVoice(voiceId: String) {
        val playing = state.previewing
        stopSample()
        if (playing == voiceId) return
        val style = state.studio?.voiceStyle.orEmpty()
        state.previewing = voiceId
        // The radio pauses for the sample and goes on afterwards.
        resumeAfterSample = host.player?.isPlaying == true
        host.player?.pause()
        // The sample is fetched first (a new voice can take a while), so a refusal shows its reason.
        host.scope.launch {
            val file = java.io.File(host.activity.cacheDir, "voice-sample")
            val loaded = withContext(Dispatchers.IO) { runCatching { api.download(api.previewPath(voiceId, style), file) } }
            if (state.previewing != voiceId) return@launch
            loaded.exceptionOrNull()?.let { error ->
                state.say(error.message ?: "Die Hörprobe ist gerade nicht verfügbar.")
                stopSample()
                return@launch
            }
            sample = android.media.MediaPlayer().apply {
                setAudioAttributes(android.media.AudioAttributes.Builder().setUsage(android.media.AudioAttributes.USAGE_MEDIA).setContentType(android.media.AudioAttributes.CONTENT_TYPE_SPEECH).build())
                setOnPreparedListener { it.start() }
                setOnCompletionListener { stopSample() }
                setOnErrorListener { _, _, _ -> state.say("Die Hörprobe lässt sich nicht abspielen."); stopSample(); true }
                runCatching {
                    setDataSource(file.path)
                    prepareAsync()
                }.onFailure { state.say("Die Hörprobe lässt sich nicht abspielen."); stopSample() }
            }
        }
    }

    private fun stopSample() {
        sample?.let { runCatching { it.stop() }; it.release() }
        sample = null
        state.previewing = null
        if (resumeAfterSample) host.player?.play()
        resumeAfterSample = false
    }

    override fun searchVoices(query: String) {
        state.voiceSearch = query
        host.scope.launch { runCatching { api.voices(query) }.onSuccess { state.voices = it } }
    }

    override fun designVoice(name: String, description: String, gender: String?) {
        if (state.voiceBusy) return
        state.voiceBusy = true
        host.scope.launch {
            val result = runCatching { api.designVoice(name.trim(), description.trim(), gender) }
            state.voiceBusy = false
            result.onSuccess { voice -> if (voice != null) adoptVoice(voice, "Stimme «${voice.name}» entworfen – hör sie dir an.") else state.say("Google hat keine Stimme zurückgegeben.") }
                .onFailure { state.say(host.failure(it)) }
        }
    }

    override fun toggleRecording(consent: Boolean) {
        if (state.recording) {
            val wav = recorder.stop()
            recordTicker?.cancel()
            state.recording = false
            val seconds = (wav.size - 44) / (VoiceRecorder.RATE * 2)
            if (recordingConsent) { consentWav = wav; state.consentSeconds = seconds } else { sampleWav = wav; state.sampleSeconds = seconds }
            return
        }
        recordingConsent = consent
        if (ContextCompat.checkSelfPermission(host.activity, Manifest.permission.RECORD_AUDIO) != PackageManager.PERMISSION_GRANTED) {
            host.requestMicrophone()
            return
        }
        // The radio pauses while you speak.
        host.player?.pause()
        runCatching { recorder.start() }.onFailure { return state.say(it.message ?: "Mikrofon nicht verfügbar.") }
        state.recording = true
        state.recordedSeconds = 0
        recordTicker = host.scope.launch {
            while (recorder.recording) {
                state.recordedSeconds = recorder.seconds
                delay(250)
            }
            // The recorder stops itself at its limit.
            if (state.recording) toggleRecording(recordingConsent)
        }
    }

    /** The answer to the microphone permission: the recording starts, or the reason is said. */
    fun microphoneAnswered(granted: Boolean) {
        if (granted) toggleRecording(recordingConsent) else state.say("Ohne Mikrofon lässt sich keine Stimme klonen.")
    }

    override fun cloneVoice(name: String) {
        val sample = sampleWav ?: return state.say("Zuerst die Sprachprobe aufnehmen.")
        val consent = consentWav ?: return state.say("Zuerst den Einverständnis-Satz aufnehmen.")
        if (state.voiceBusy) return
        state.voiceBusy = true
        host.scope.launch {
            val result = runCatching { api.cloneVoice(name.trim(), sample, consent) }
            state.voiceBusy = false
            result.onSuccess { voice -> if (voice != null) adoptVoice(voice, "Deine Stimme «${voice.name}» ist bereit – hör sie dir an.") else state.say("Google hat keine Stimme zurückgegeben.") }
                .onFailure { state.say(host.failure(it)) }
        }
    }

    /** A new own voice: listed first, chosen for the host (still to be saved) and played as a sample. */
    private fun adoptVoice(voice: VoiceOption, message: String) {
        closeVoiceDialogs()
        state.voices = listOf(voice) + state.voices.filter { it.id != voice.id }
        state.studio?.let { host.actions.editStudio(it.copy(voiceId = voice.id)) }
        state.say(message)
        previewVoice(voice.id)
    }

    override fun deleteVoice(voice: VoiceOption) {
        state.voiceDeleteAsk = null
        host.scope.launch {
            val result = runCatching { api.deleteVoice(voice.id) }
            if (result.isSuccess) {
                state.voices = state.voices.filter { it.id != voice.id }
                state.studio?.takeIf { it.voiceId == voice.id }?.let { host.actions.editStudio(it.copy(voiceId = null)) }
            }
            state.say(result.fold({ "Stimme «${voice.name}» gelöscht." }, { host.failure(it) }))
        }
    }

    override fun closeVoiceDialogs() {
        if (state.recording) toggleRecording(recordingConsent)
        state.designOpen = false
        state.cloneOpen = false
        state.cloneStep = 0
        state.sampleSeconds = 0
        state.consentSeconds = 0
        sampleWav = null
        consentWav = null
    }

    /** The activity ends: stop the sample and free the microphone. */
    fun release() {
        recorder.release()
        stopSample()
    }
}
