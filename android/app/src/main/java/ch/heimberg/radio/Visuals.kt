package ch.heimberg.radio

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
import androidx.compose.ui.draw.clip
import androidx.compose.ui.geometry.CornerRadius
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.Shape
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.graphics.lerp
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import ch.heimberg.radio.core.Kind
import ch.heimberg.radio.core.Look
import coil.compose.AsyncImage
import kotlin.math.PI
import kotlin.math.abs
import kotlin.math.cos
import kotlin.math.max
import kotlin.math.sin

/** 0 → 1 → 0 over one turn of [phase], eased like CSS ease-in-out keyframes. */
private fun breathe(phase: Float): Float = (0.5 - 0.5 * cos(2 * PI * phase)).toFloat()

private val BARS = FloatArray(48) { i -> 0.25f + 0.75f * abs(sin(i * 0.55f) * cos(i * 0.17f + 1f)) }

/** The item's progress as a row of bars: heard in [tint], ahead in [rest]; they sway while playing. */
@Composable
fun Waveform(progress: Float, active: Boolean, tint: Color, modifier: Modifier = Modifier, rest: Color = Nocturne.faint) {
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
                color = if (i.toFloat() / BARS.size < progress) tint else rest,
                topLeft = Offset(left, (size.height - height) / 2f), size = Size(barWidth, height), cornerRadius = CornerRadius(2.dp.toPx()),
            )
        }
    }
}

/** A white card, edged in the rubric's colour; selected or on air, it is filled with a tint of it. */
fun Modifier.kindTile(kind: Kind?, shape: Shape = RoundedCornerShape(20.dp), glow: Float = 0f): Modifier {
    val color = Nocturne.kind(kind)
    return this
        .background(lerp(Nocturne.surface, color, glow * 0.4f), shape)
        .border(if (glow > 0.2f) 2.dp else 1.dp, if (glow > 0.2f) color else Nocturne.divider, shape)
}

/**
 * The cover of an item: its album image when it has songs, otherwise a tile filled with the rubric's
 * colour, rings in one corner and the icon, so every item has a face. The tile shows while an image loads or if it fails.
 */
@Composable
fun Cover(look: Look?, imageUrl: String?, extent: Dp, modifier: Modifier = Modifier) {
    val shape = RoundedCornerShape(extent * 0.22f)
    val color = Nocturne.kind(look?.kind)
    val on = Nocturne.onKind(look?.kind)
    Box(modifier.size(extent).clip(shape).background(color), contentAlignment = Alignment.Center) {
        Canvas(Modifier.matchParentSize()) {
            val corner = Offset(size.width * 0.9f, size.height * 0.1f)
            for (ring in 1..3) drawCircle(on.copy(alpha = 0.22f), radius = size.width * 0.26f * ring, center = corner, style = Stroke(1.dp.toPx()))
        }
        Text(look?.icon ?: "📻", fontSize = (extent.value * 0.4f).sp)
        if (imageUrl != null) {
            AsyncImage(model = imageUrl, contentDescription = null, contentScale = ContentScale.Crop, modifier = Modifier.matchParentSize())
        }
    }
}

/** An emoji icon on a rounded square filled with the rubric's colour. */
@Composable
fun KindBadge(icon: String, kind: Kind?, size: Dp = 36.dp, modifier: Modifier = Modifier) {
    Box(
        modifier.size(size).background(Nocturne.kind(kind), RoundedCornerShape(size * 0.28f)),
        contentAlignment = Alignment.Center,
    ) { Text(icon, fontSize = (size.value * 0.46f).sp) }
}

/** A small pill filled with the rubric's colour, e.g. «☕ Aktuell». */
@Composable
fun KindChip(text: String, kind: Kind?, modifier: Modifier = Modifier) {
    Text(
        text, style = MaterialTheme.typography.labelMedium, color = Nocturne.onKind(kind),
        modifier = modifier
            .background(Nocturne.kind(kind), RoundedCornerShape(999.dp))
            .padding(horizontal = 10.dp, vertical = 4.dp),
    )
}

/** The big uppercase title at the top of a tab: «PROGRAMM», «ARCHIV». */
@Composable
fun ScreenTitle(text: String, modifier: Modifier = Modifier) {
    Text(text.uppercase(), style = display(44), color = Nocturne.text, maxLines = 1, modifier = modifier)
}

/** The rubric's name in small capitals, in its label colour. */
@Composable
fun RubricLabel(kind: Kind?, extra: String? = null, color: Color = Nocturne.kindLabel(kind)) {
    Text(
        listOfNotNull(kind?.label, extra).joinToString(" · ").uppercase(),
        style = Kicker.copy(fontSize = 11.sp, letterSpacing = 1.sp), color = color, maxLines = 1, overflow = TextOverflow.Ellipsis,
    )
}
