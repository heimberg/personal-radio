package ch.heimberg.radio

import android.animation.ValueAnimator
import android.content.Context
import android.graphics.Canvas
import android.graphics.Color
import android.graphics.Paint
import android.graphics.RadialGradient
import android.graphics.Shader
import android.os.SystemClock
import android.util.AttributeSet
import android.view.View
import androidx.core.content.ContextCompat
import kotlin.math.PI
import kotlin.math.cos
import kotlin.math.min

/**
 * The glowing orb that stands for the station: three thin rings around a lit core. While audio plays
 * the rings and the core breathe at different rates; paused, the orb dims and rests.
 */
class OrbView @JvmOverloads constructor(context: Context, attrs: AttributeSet? = null) : View(context, attrs) {
    var active = false
        set(value) {
            if (field == value) return
            field = value
            invalidate()
        }

    private val outerRing = color(R.color.accent_800)
    private val innerRing = color(R.color.accent_700)
    private val highlight = color(R.color.accent_300)
    private var lit = color(R.color.accent)
    private var litGlow = color(R.color.accent_600)

    /** The colour of the playing item's kind; null for the station's own accent. */
    var tint: Int? = null
        set(value) {
            if (field == value) return
            field = value
            lit = value ?: color(R.color.accent)
            litGlow = value?.let { androidx.core.graphics.ColorUtils.blendARGB(it, Color.BLACK, 0.3f) } ?: color(R.color.accent_600)
            invalidate()
        }
    private val deep = color(R.color.accent_800)
    private val ringPaint = Paint(Paint.ANTI_ALIAS_FLAG).apply {
        style = Paint.Style.STROKE
        strokeWidth = resources.displayMetrics.density
    }
    private val corePaint = Paint(Paint.ANTI_ALIAS_FLAG)
    private val glowPaint = Paint(Paint.ANTI_ALIAS_FLAG)

    override fun onDraw(canvas: Canvas) {
        val size = min(width, height).toFloat()
        if (size <= 0f) return
        val cx = width / 2f
        val cy = height / 2f
        val now = SystemClock.uptimeMillis()
        val animate = active && ValueAnimator.areAnimatorsEnabled()

        RINGS.forEachIndexed { i, k ->
            val breath = if (animate) breathe(now, 2400L + i * 600L, i * 300L) else 0.5f
            ringPaint.color = if (i == 0) outerRing else innerRing
            ringPaint.alpha = ((if (animate) 0.7f + 0.3f * breath else if (active) 1f else 0.6f) * 255).toInt()
            val scale = if (animate) 0.9f + 0.15f * breath else 1f
            // Sized so the outer ring still fits at the top of its breath (scale 1.05).
            canvas.drawCircle(cx, cy, (k * size / 2f / 1.05f - ringPaint.strokeWidth / 2f) * scale, ringPaint)
        }

        val coreBreath = if (animate) breathe(now, 1800L, 0L) else 0.5f
        val core = size * 0.14f * (if (animate) 0.9f + 0.15f * coreBreath else 1f)
        val glowColor = if (active) litGlow else deep
        val glow = core + size * 0.25f
        glowPaint.shader = RadialGradient(cx, cy, glow, intArrayOf(glowColor, glowColor, Color.TRANSPARENT), floatArrayOf(0f, core / glow, 1f), Shader.TileMode.CLAMP)
        canvas.drawCircle(cx, cy, glow, glowPaint)

        // Lit from the upper left: the highlight sits at 40 % / 35 % of the core.
        val mid = if (active) lit else innerRing
        corePaint.shader = RadialGradient(
            cx - core * 0.2f, cy - core * 0.3f, core * 1.4f,
            intArrayOf(highlight, mid, deep), floatArrayOf(0f, 0.55f, 1f), Shader.TileMode.CLAMP,
        )
        canvas.drawCircle(cx, cy, core, corePaint)

        if (animate && isShown) postInvalidateOnAnimation()
    }

    private fun color(id: Int) = ContextCompat.getColor(context, id)

    companion object {
        private val RINGS = floatArrayOf(1f, 0.72f, 0.46f)

        /** 0 → 1 → 0 over [period], eased like CSS ease-in-out keyframes. */
        fun breathe(now: Long, period: Long, delay: Long): Float {
            val phase = ((now - delay).mod(period)).toFloat() / period
            return (0.5 - 0.5 * cos(2 * PI * phase)).toFloat()
        }
    }
}
