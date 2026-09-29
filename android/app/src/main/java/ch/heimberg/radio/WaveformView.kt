package ch.heimberg.radio

import android.animation.ValueAnimator
import android.content.Context
import android.graphics.Canvas
import android.graphics.Paint
import android.os.SystemClock
import android.util.AttributeSet
import android.view.View
import androidx.core.content.ContextCompat
import kotlin.math.abs
import kotlin.math.cos
import kotlin.math.max
import kotlin.math.sin

/**
 * The segment's progress as a row of bars: the part already heard in the accent, the rest in a
 * neutral. The bars sway while audio plays. Display only; the lock screen and headphones seek.
 */
class WaveformView @JvmOverloads constructor(context: Context, attrs: AttributeSet? = null) : View(context, attrs) {
    var progress = 0f
        set(value) {
            val clamped = value.coerceIn(0f, 1f)
            if (field == clamped) return
            field = clamped
            invalidate()
        }
    var active = false
        set(value) {
            if (field == value) return
            field = value
            invalidate()
        }

    private val density = resources.displayMetrics.density
    private val heard = Paint(Paint.ANTI_ALIAS_FLAG).apply { color = ContextCompat.getColor(context, R.color.accent) }

    /** The colour of the heard part: the playing item's kind. */
    var tint: Int = ContextCompat.getColor(context, R.color.accent)
        set(value) {
            if (field == value) return
            field = value
            heard.color = value
            invalidate()
        }
    private val ahead = Paint(Paint.ANTI_ALIAS_FLAG).apply { color = ContextCompat.getColor(context, R.color.neutral_700) }

    override fun onDraw(canvas: Canvas) {
        val gap = 2 * density
        val barWidth = (width - gap * (BARS.size - 1)) / BARS.size
        // Bars reach 24 of the view's 28dp, leaving room for the sway.
        val maxHeight = height * 24f / 28f
        val now = SystemClock.uptimeMillis()
        val animate = active && ValueAnimator.areAnimatorsEnabled()
        val radius = 2 * density
        BARS.forEachIndexed { i, v ->
            val sway = if (animate) 0.45f + 0.55f * OrbView.breathe(now, 800L + (i % 5) * 170L, (i % 7) * 90L) else 1f
            val h = max(3 * density, v * maxHeight) * sway
            val left = i * (barWidth + gap)
            val top = (height - h) / 2f
            canvas.drawRoundRect(left, top, left + barWidth, top + h, radius, radius, if (i.toFloat() / BARS.size < progress) heard else ahead)
        }
        if (animate && isShown) postInvalidateOnAnimation()
    }

    private companion object {
        val BARS = FloatArray(48) { i -> 0.25f + 0.75f * abs(sin(i * 0.55f) * cos(i * 0.17f + 1f)) }
    }
}
