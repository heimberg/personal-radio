package ch.heimberg.radio

import android.content.Context
import android.content.Intent
import android.net.Uri
import android.provider.Settings
import androidx.core.content.FileProvider
import androidx.core.content.pm.PackageInfoCompat
import ch.heimberg.radio.core.AppBuild
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import java.io.File
import java.security.MessageDigest

/**
 * In-app updates from the private Worker: CI publishes each signed build there. The APK is downloaded
 * with the service token, checked against its SHA-256 and handed to Android's package installer.
 */
class AppUpdater(private val context: Context, private val api: ApiClient) {
    val installedVersion: Long
        get() = PackageInfoCompat.getLongVersionCode(context.packageManager.getPackageInfo(context.packageName, 0))

    /** The newer build, or null when this one is current or nothing is published. */
    suspend fun available(): AppBuild? = runCatching { api.latestApp() }.getOrNull()?.takeIf { it.newerThan(installedVersion) }

    /** Android asks once per app whether it may install updates; this opens that setting. */
    fun mayInstall(): Boolean = context.packageManager.canRequestPackageInstalls()

    fun askForPermission() {
        context.startActivity(Intent(Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES, Uri.parse("package:${context.packageName}")))
    }

    /** Downloads and verifies the build, then opens the installer. */
    suspend fun install(build: AppBuild) {
        val file = withContext(Dispatchers.IO) {
            val dir = File(context.cacheDir, "updates").apply { mkdirs() }
            dir.listFiles()?.forEach { it.delete() }
            val file = File(dir, "personal-radio-${build.versionCode}.apk")
            api.download("api/app/apk", file)
            val digest = MessageDigest.getInstance("SHA-256").digest(file.readBytes()).joinToString("") { "%02x".format(it) }
            if (digest != build.sha256) {
                file.delete()
                throw IllegalStateException(context.getString(R.string.update_corrupt))
            }
            file
        }
        val uri = FileProvider.getUriForFile(context, "${context.packageName}.updates", file)
        context.startActivity(
            Intent(Intent.ACTION_VIEW).setDataAndType(uri, "application/vnd.android.package-archive")
                .addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION or Intent.FLAG_ACTIVITY_NEW_TASK),
        )
    }
}
