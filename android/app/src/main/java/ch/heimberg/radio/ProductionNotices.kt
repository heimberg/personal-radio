package ch.heimberg.radio

import android.Manifest
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.os.Build
import androidx.core.app.NotificationCompat
import androidx.core.app.NotificationManagerCompat
import androidx.core.content.ContextCompat
import ch.heimberg.radio.core.FailureSummary
import ch.heimberg.radio.core.Labels
import ch.heimberg.radio.core.NoticeTracker
import ch.heimberg.radio.core.Timeline
import ch.heimberg.radio.core.TimelineItem
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch

/**
 * Notifications about the program while the player runs: a music hour or block is ready, or a
 * production failed – with "Erneut versuchen" right in the notification.
 */
class ProductionNotices(private val context: Context) {
    private val tracker = NoticeTracker()

    init {
        val channel = NotificationChannel(CHANNEL, context.getString(R.string.notices_channel), NotificationManager.IMPORTANCE_DEFAULT)
        context.getSystemService(NotificationManager::class.java).createNotificationChannel(channel)
    }

    fun update(timeline: Timeline) {
        val notices = tracker.update(timeline)
        notices.ready.forEach(::ready)
        notices.failure?.let(::failed)
    }

    private fun ready(item: TimelineItem) {
        notify(item.id.hashCode(), builder(context.getString(R.string.notice_ready, item.displayTitle), item.showName).build())
    }

    private fun failed(failure: FailureSummary) {
        val retry = PendingIntent.getBroadcast(
            context, 0, Intent(context, RetryReceiver::class.java), PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT,
        )
        val reason = failure.latestError?.let(Labels::error) ?: ""
        notify(FAILURE_ID, builder(context.getString(R.string.notice_failed), reason)
            .setStyle(NotificationCompat.BigTextStyle().bigText(reason))
            .addAction(0, context.getString(R.string.notice_retry), retry)
            .build())
    }

    private fun builder(title: String, text: String) = NotificationCompat.Builder(context, CHANNEL)
        .setSmallIcon(R.drawable.ic_waveform)
        .setContentTitle(title)
        .setContentText(text)
        .setAutoCancel(true)
        .setContentIntent(PendingIntent.getActivity(context, 0, Intent(context, MainActivity::class.java), PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT))

    private fun notify(id: Int, notification: android.app.Notification) {
        if (Build.VERSION.SDK_INT >= 33 && ContextCompat.checkSelfPermission(context, Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED) return
        NotificationManagerCompat.from(context).notify(id, notification)
    }

    companion object {
        private const val CHANNEL = "productions"
        const val FAILURE_ID = 4201
    }
}

/** "Erneut versuchen" in the failure notification: retires failed items and restarts waiting ones. */
class RetryReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        val connection = RadioSettings(context).connection() ?: return
        val pending = goAsync()
        CoroutineScope(Dispatchers.IO).launch {
            val ok = runCatching { ApiClient(connection).retry() }.isSuccess
            NotificationManagerCompat.from(context).cancel(ProductionNotices.FAILURE_ID)
            if (!ok) {
                android.os.Handler(android.os.Looper.getMainLooper()).post {
                    android.widget.Toast.makeText(context, R.string.connection_failed, android.widget.Toast.LENGTH_SHORT).show()
                }
            }
            pending.finish()
        }
    }
}
