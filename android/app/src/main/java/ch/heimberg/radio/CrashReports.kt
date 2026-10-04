package ch.heimberg.radio

import android.content.Context
import android.os.Build
import java.io.File

/**
 * App crashes for the studio's «Diagnose»: a crash is written to a small file (version, device, the first
 * lines of the trace), and the next start sends it to the Worker. Nothing goes anywhere else.
 */
object CrashReports {
    private const val FILE = "last-crash.txt"
    private const val TRACE_LINES = 25
    @Volatile private var installed = false

    /** Keeps the crash, then lets Android handle it as before. */
    fun install(context: Context) {
        if (installed) return
        installed = true
        val app = context.applicationContext
        val previous = Thread.getDefaultUncaughtExceptionHandler()
        Thread.setDefaultUncaughtExceptionHandler { thread, error ->
            runCatching {
                val trace = error.stackTraceToString().lineSequence().take(TRACE_LINES).joinToString("\n")
                File(app.filesDir, FILE).writeText("${version(app)}\n${Build.MANUFACTURER} ${Build.MODEL} · Android ${Build.VERSION.RELEASE}\n$trace")
            }
            previous?.uncaughtException(thread, error)
        }
    }

    /** Sends a crash from an earlier run, if there is one; the file goes once the Worker has it. */
    suspend fun send(context: Context, api: ApiClient) {
        val file = File(context.filesDir, FILE)
        if (!file.exists()) return
        val lines = runCatching { file.readLines() }.getOrDefault(emptyList())
        if (lines.size < 3) { file.delete(); return }
        runCatching { api.reportCrash(lines[0], lines[1], lines.drop(2).joinToString("\n")) }.onSuccess { file.delete() }
    }

    private fun version(context: Context): String =
        runCatching { context.packageManager.getPackageInfo(context.packageName, 0).versionName }.getOrNull() ?: "?"
}
