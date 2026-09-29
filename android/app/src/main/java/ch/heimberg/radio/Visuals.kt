package ch.heimberg.radio

import androidx.compose.animation.animateColorAsState
import androidx.compose.animation.core.LinearEasing
import androidx.compose.animation.core.RepeatMode
import androidx.compose.animation.core.animateFloat
import androidx.compose.animation.core.infiniteRepeatable
import androidx.compose.animation.core.rememberInfiniteTransition
import androidx.compose.animation.core.tween
import androidx.compose.foundation.Canvas
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.geometry.CornerRadius
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.Shape
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.graphics.lerp
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import ch.heimberg.radio.core.Kind
import kotlin.math.PI
import kotlin.math.abs
import kotlin.math.cos
import kotlin.math.max
import kotlin.math.min
import kotlin.math.sin

/** 0 → 1 → 0 over one turn of [phase], eased like CSS ease-in-out keyframes. */
private fun breathe(phase: Float): Float = (0.5 - 0.5 * cos(2 * PI * phase)).toFloat()

/**
 * The glowing orb that stands for the station: three thin rings around a lit core in the colour of
 * what plays. While audio plays the rings and the core breathe; paused, the orb dims and rests.
 */
@Composable
fun Orb(active: Boolean, tint: Color, modifier: Modifier = Modifier) {
    val color by animateColorAsState(tint, tween(600), label = "orb colour")
    val time by rememberInfiniteTransition(label = "orb").animateFloat(
        0f, 1f, infiniteRepeatable(tween(7_200, easing = LinearEasing), RepeatMode.Restart), label = "orb time",
    )
    Canvas(modifier) {
        val size = min(this.size.width, this.size.height)
        val center = Offset(this.size.width / 2f, this.size.height / 2f)
        val stroke = 1.dp.toPx()
        listOf(1f, 0.72f, 0.46f).forEachIndexed { index, ring ->
            // Periods of 2.4, 3.0 and 3.6 seconds fit the 7.2-second loop a whole number of times.
            val breath = if (active) breathe((time * 7_200f / (2_400f + index * 600f) + index * 0.12f) % 1f) else 0.5f
            val scale = if (active) 0.9f + 0.15f * breath else 1f
            drawCircle(
                color = lerp(Nocturne.accentDeep, color, if (index == 0) 0.25f else 0.45f).copy(alpha = if (active) 0.7f + 0.3f * breath else 0.6f),
                radius = (ring * size / 2f / 1.05f - stroke / 2f) * scale, center = center, style = Stroke(stroke),
            )
        }
        val coreBreath = if (active) breathe((time * 4f) % 1f) else 0.5f
        val core = size * 0.14f * (if (active) 0.9f + 0.15f * coreBreath else 1f)
        val glow = core + size * 0.25f
        val glowColor = if (active) lerp(color, Color.Black, 0.3f) else Nocturne.accentDeep
        drawCircle(
            Brush.radialGradient(0f to glowColor, core / glow to glowColor.copy(alpha = 0.8f), 1f to Color.Transparent, center = center, radius = glow),
            radius = glow, center = center,
        )
        drawCircle(
            Brush.radialGradient(
                0f to Nocturne.accentLight, 0.55f to (if (active) color else lerp(Nocturne.accentDeep, color, 0.4f)), 1f to Nocturne.accentDeep,
                center = Offset(center.x - core * 0.2f, center.y - core * 0.3f), radius = core * 1.4f,
            ),
            radius = core, center = center,
        )
    }
}

private val BARS = FloatArray(48) { i -> 0.25f + 0.75f * abs(sin(i * 0.55f) * cos(i * 0.17f + 1f)) }

/** The item's progress as a row of bars: heard in the kind's colour, ahead in a neutral; they sway while playing. */
@Composable
fun Waveform(progress: Float, active: Boolean, tint: Color, modifier: Modifier = Modifier) {
    val time by rememberInfiniteTransition(label = "wave").animateFloat(
        0f, 1f, infiniteRepeatable(tween(4_000, easing = LinearEasing), RepeatMode.Restart), label = "wave time",
    )
    Canvas(modifier) {
        val gap = 2.dp.toPx()
        val barWidth = (size.width - gap * (BARS.size - 1)) / BARS.size
        val maxHeight = size.height * 24f / 28f
        BARS.forEachIndexed { i, value ->
            val sway = if (active) 0.45f + 0.55f * breathe((time * (5 + i % 5) + (i % 7) * 0.11f) % 1f) else 1f
            val height = max(3.dp.toPx(), value * maxHeight) * sway
            val left = i * (barWidth + gap)
            drawRoundRect(
                color = if (i.toFloat() / BARS.size < progress) tint else Nocturne.faint,
                topLeft = Offset(left, (size.height - height) / 2f), size = Size(barWidth, height), cornerRadius = CornerRadius(2.dp.toPx()),
            )
        }
    }
}

/** A surface whose top corner glows in the kind's colour, edged in it. */
fun Modifier.kindTile(kind: Kind?, shape: Shape = RoundedCornerShape(20.dp), glow: Float = 0.3f): Modifier {
    val color = Nocturne.kind(kind)
    return this
        .background(Brush.linearGradient(listOf(lerp(Nocturne.surface, color, glow), Nocturne.surface, Nocturne.surface), start = Offset(Float.POSITIVE_INFINITY, 0f), end = Offset(0f, Float.POSITIVE_INFINITY)), shape)
        .border(1.dp, color.copy(alpha = 0.45f), shape)
}

/** An emoji icon on a round badge in the kind's colour. */
@Composable
fun KindBadge(icon: String, kind: Kind?, size: Dp = 36.dp, modifier: Modifier = Modifier) {
    val color = Nocturne.kind(kind)
    Box(
        modifier
            .size(size)
            .background(lerp(Nocturne.surface, color, 0.32f), RoundedCornerShape(size * 0.36f))
            .border(1.dp, color.copy(alpha = 0.6f), RoundedCornerShape(size * 0.36f)),
        contentAlignment = Alignment.Center,
    ) { Text(icon, fontSize = (size.value * 0.46f).sp) }
}

/** The kind's name as a small pill, e.g. «☕ Aktuell». */
@Composable
fun KindChip(text: String, kind: Kind?, modifier: Modifier = Modifier) {
    val color = Nocturne.kind(kind)
    Text(
        text, style = MaterialTheme.typography.labelMedium, color = Nocturne.text,
        modifier = modifier
            .background(color.copy(alpha = 0.28f), RoundedCornerShape(999.dp))
            .border(1.dp, color.copy(alpha = 0.6f), RoundedCornerShape(999.dp))
            .padding(horizontal = 10.dp, vertical = 4.dp),
    )
}
