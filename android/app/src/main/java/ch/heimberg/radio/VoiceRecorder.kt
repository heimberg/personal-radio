package ch.heimberg.radio

import android.annotation.SuppressLint
import android.media.AudioFormat
import android.media.AudioRecord
import android.media.MediaRecorder
import java.io.ByteArrayOutputStream
import java.nio.ByteBuffer
import java.nio.ByteOrder
import kotlin.concurrent.thread

/**
 * Records speech for cloning a voice: 24 kHz, mono, 16-bit PCM, as Google recommends, and hands it
 * back as WAV. At most [MAX_SECONDS]; the caller checks the microphone permission first.
 */
class VoiceRecorder {
    private var record: AudioRecord? = null
    private var worker: Thread? = null
    private val pcm = ByteArrayOutputStream()
    @Volatile private var running = false

    val recording: Boolean get() = running
    val seconds: Int get() = synchronized(pcm) { pcm.size() / (RATE * 2) }

    @SuppressLint("MissingPermission")
    fun start() {
        if (running) return
        val size = maxOf(AudioRecord.getMinBufferSize(RATE, AudioFormat.CHANNEL_IN_MONO, AudioFormat.ENCODING_PCM_16BIT), RATE / 5 * 2)
        val recorder = AudioRecord(MediaRecorder.AudioSource.VOICE_RECOGNITION, RATE, AudioFormat.CHANNEL_IN_MONO, AudioFormat.ENCODING_PCM_16BIT, size)
        if (recorder.state != AudioRecord.STATE_INITIALIZED) {
            recorder.release()
            throw IllegalStateException("Mikrofon nicht verfügbar")
        }
        synchronized(pcm) { pcm.reset() }
        record = recorder
        running = true
        recorder.startRecording()
        worker = thread(name = "voice-recorder") {
            val buffer = ByteArray(size)
            while (running) {
                val read = recorder.read(buffer, 0, buffer.size)
                if (read > 0) synchronized(pcm) { if (pcm.size() < MAX_SECONDS * RATE * 2) pcm.write(buffer, 0, read) else running = false }
            }
        }
    }

    /** Stops and returns the recording as WAV. */
    fun stop(): ByteArray {
        running = false
        worker?.join(1_000)
        worker = null
        record?.let { runCatching { it.stop() }; it.release() }
        record = null
        return wav(synchronized(pcm) { pcm.toByteArray() })
    }

    fun release() {
        if (running) stop()
    }

    companion object {
        const val RATE = 24_000
        const val MAX_SECONDS = 30

        fun wav(data: ByteArray): ByteArray {
            val header = ByteBuffer.allocate(44).order(ByteOrder.LITTLE_ENDIAN)
            header.put("RIFF".toByteArray()).putInt(36 + data.size).put("WAVE".toByteArray()).put("fmt ".toByteArray())
            header.putInt(16).putShort(1).putShort(1).putInt(RATE).putInt(RATE * 2).putShort(2).putShort(16)
            header.put("data".toByteArray()).putInt(data.size)
            return header.array() + data
        }
    }
}
