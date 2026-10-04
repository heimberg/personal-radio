package ch.heimberg.radio

import androidx.compose.material3.Surface
import com.github.takahirom.roborazzi.RoborazziOptions
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.unit.Density
import androidx.compose.ui.unit.dp
import ch.heimberg.radio.core.TimelineItem
import com.github.takahirom.roborazzi.captureRoboImage
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config
import org.robolectric.annotation.GraphicsMode
import java.time.Instant

/**
 * Screenshots of program rows: light, dark and with large system fonts. A change in how they look shows
 * as a failing `verifyRoborazziDebug`; `recordRoborazziDebug` takes the new pictures after a deliberate change.
 */
@RunWith(RobolectricTestRunner::class)
@GraphicsMode(GraphicsMode.Mode.NATIVE)
@Config(sdk = [34], qualifiers = "w400dp-h800dp-xxhdpi")
class ScreenshotTest {
    private val start = Instant.parse("2026-10-04T21:36:00Z")
    private val items = listOf(
        TimelineItem("a", 1, "_block:ortsgeschichte", "Ortsgeschichte", start.toString(), "ready", 2.0, title = "Rust: Tiefes Wasser und alte Grenzen"),
        TimelineItem("b", 2, "_block:mitmach", "Mitmach-Geschichte", start.toString(), "voicing", 6.0, title = "Fini im Zauberwald – Kapitel 2"),
        TimelineItem("c", 3, "s", "Wissen", start.toString(), "failed", 3.0, title = "Ein Beitrag", error = "INVALID_INPUT: Text zu lang"),
    )

    /** Tiny differences in anti-aliasing between machines are not a change. */
    private val options = RoborazziOptions(compareOptions = RoborazziOptions.CompareOptions(changeThreshold = 0.01f))

    @Composable
    private fun Rows() {
        // As in the app: the screen's ground and text colour come from the scaffold.
        Surface(color = Nocturne.bg, contentColor = Nocturne.text) {
            Column(Modifier.width(400.dp).padding(8.dp)) {
                ItemRow(items[0], start, onTap = {}, onLongPress = {}, live = true, progress = 0.4f, liveLabel = "pausiert")
                for (item in items.drop(1)) ItemRow(item, start, onTap = {}, onLongPress = {}, handle = Modifier)
            }
        }
    }

    @Test fun programRowsLight() = captureRoboImage("src/test/screenshots/program-rows-light.png", roborazziOptions = options) { RadioTheme { Rows() } }

    @Config(qualifiers = "+night")
    @Test fun programRowsDark() = captureRoboImage("src/test/screenshots/program-rows-dark.png", roborazziOptions = options) { RadioTheme { Rows() } }

    @Test fun programRowsLargeFont() = captureRoboImage("src/test/screenshots/program-rows-large-font.png", roborazziOptions = options) {
        val density = LocalDensity.current
        CompositionLocalProvider(LocalDensity provides Density(density.density, fontScale = 1.6f)) { RadioTheme { Rows() } }
    }
}
