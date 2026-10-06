package ch.heimberg.radio

import androidx.compose.animation.core.RepeatMode
import androidx.compose.animation.core.animateFloat
import androidx.compose.animation.core.infiniteRepeatable
import androidx.compose.animation.core.rememberInfiniteTransition
import androidx.compose.animation.core.tween
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.alpha
import androidx.compose.ui.draw.clip
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp

/*
 * Placeholders while something loads: grey shapes where the content will be, gently pulsing, so the screen
 * does not jump when it arrives. Screen readers hear «[label] wird geladen».
 */

@Composable
private fun pulse(): Float {
    val transition = rememberInfiniteTransition(label = "skeleton")
    val alpha by transition.animateFloat(0.45f, 0.9f, infiniteRepeatable(tween(900), RepeatMode.Reverse), label = "alpha")
    return alpha
}

@Composable
private fun Bar(width: Float, height: Dp = 12.dp, alpha: Float) {
    Box(Modifier.fillMaxWidth(width).height(height).alpha(alpha).clip(RoundedCornerShape(6.dp)).background(Nocturne.surfaceHigh))
}

/** Lines of text: the last one shorter, as a paragraph ends. */
@Composable
fun SkeletonLines(count: Int = 3, label: String = "Inhalt") {
    val alpha = pulse()
    Column(Modifier.fillMaxWidth().semantics { contentDescription = "$label wird geladen" }, verticalArrangement = Arrangement.spacedBy(8.dp)) {
        repeat(count) { index -> Bar(if (index == count - 1) 0.6f else 1f, alpha = alpha) }
    }
}

/** List rows: a round badge, a title and a shorter line under it. */
@Composable
fun SkeletonRows(count: Int = 4, label: String = "Liste", modifier: Modifier = Modifier) {
    val alpha = pulse()
    Column(modifier.fillMaxWidth().semantics { contentDescription = "$label wird geladen" }, verticalArrangement = Arrangement.spacedBy(16.dp)) {
        repeat(count) { index ->
            Row(verticalAlignment = Alignment.CenterVertically) {
                Box(Modifier.size(40.dp).alpha(alpha).clip(RoundedCornerShape(12.dp)).background(Nocturne.surfaceHigh))
                Spacer(Modifier.width(12.dp))
                Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(6.dp)) {
                    Bar(if (index % 2 == 0) 0.7f else 0.55f, 14.dp, alpha)
                    Bar(if (index % 2 == 0) 0.45f else 0.6f, 10.dp, alpha)
                }
            }
        }
    }
}

/** The studio's setting cards, as outlines. */
@Composable
fun SkeletonCards(count: Int = 6, label: String = "Einstellungen") {
    val alpha = pulse()
    val shape = RoundedCornerShape(18.dp)
    Column(Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 8.dp).semantics { contentDescription = "$label werden geladen" }, verticalArrangement = Arrangement.spacedBy(8.dp)) {
        repeat(count) {
            Row(
                Modifier.fillMaxWidth().clip(shape).background(Nocturne.surface).border(1.dp, Nocturne.divider, shape).padding(12.dp),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                Box(Modifier.size(40.dp).alpha(alpha).clip(RoundedCornerShape(12.dp)).background(Nocturne.surfaceHigh))
                Spacer(Modifier.width(12.dp))
                Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(6.dp)) {
                    Bar(0.5f, 14.dp, alpha)
                    Bar(0.75f, 10.dp, alpha)
                }
            }
        }
    }
}
