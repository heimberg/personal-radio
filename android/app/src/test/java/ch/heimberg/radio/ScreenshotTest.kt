package ch.heimberg.radio

import androidx.compose.material3.Surface
import com.github.takahirom.roborazzi.RoborazziOptions
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.unit.Density
import androidx.compose.ui.unit.dp
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.fillMaxSize
import ch.heimberg.radio.core.InviteOverview
import ch.heimberg.radio.core.StationDraft
import ch.heimberg.radio.core.StudioSettings
import kotlinx.serialization.json.JsonObject
import ch.heimberg.radio.core.Kind
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

    /** The screens' actions do nothing here: a proxy answers every call. */
    private val actions = java.lang.reflect.Proxy.newProxyInstance(RadioActions::class.java.classLoader, arrayOf(RadioActions::class.java)) { _, _, _ -> null } as RadioActions

    private fun studioState() = RadioState().apply {
        isHost = true
        studio = StudioSettings(name = "Radio Heimberg", hostName = "Mia", tone = "ruhig, neugierig", topics = listOf("Wissenschaft", "Velo", "Bern"))
        station = StationDraft(JsonObject(emptyMap()))
        invites = InviteOverview.parse(INVITES)
    }

    @Composable
    private fun Screen(content: @Composable () -> Unit) {
        Surface(Modifier.fillMaxSize(), color = Nocturne.bg, contentColor = Nocturne.text) { content() }
    }

    /** The studio overview in its three groups: Mein Radio, Programm and Betrieb. */
    @Config(qualifiers = "w400dp-h1750dp-xxhdpi")
    @Test fun studioOverviewLight() = captureRoboImage("src/test/screenshots/studio-overview-light.png", roborazziOptions = options) {
        RadioTheme { Screen { StudioScreen(studioState(), actions, "1.0", PaddingValues(0.dp)) } }
    }

    @Config(qualifiers = "w400dp-h1750dp-night-xxhdpi")
    @Test fun studioOverviewDark() = captureRoboImage("src/test/screenshots/studio-overview-dark.png", roborazziOptions = options) {
        RadioTheme { Screen { StudioScreen(studioState(), actions, "1.0", PaddingValues(0.dp)) } }
    }

    @Config(qualifiers = "w400dp-h2700dp-xxhdpi")
    @Test fun studioOverviewLargeFont() = captureRoboImage("src/test/screenshots/studio-overview-large-font.png", roborazziOptions = options) {
        val density = LocalDensity.current
        CompositionLocalProvider(LocalDensity provides Density(density.density, fontScale = 1.6f)) {
            RadioTheme { Screen { StudioScreen(studioState(), actions, "1.0", PaddingValues(0.dp)) } }
        }
    }

    /** «Hören» before the first item is ready: its production step as a bar and in words. */
    @Test fun listenFirstItemInProduction() = captureRoboImage("src/test/screenshots/listen-first-item.png", roborazziOptions = options) {
        val state = RadioState().apply {
            stationName = "Radio Heimberg"
            open = listOf(TimelineItem("a", 1, "s", "Wissen", start.toString(), "planned", 4.0, title = "Warum der Aaregletscher schwindet", stage = "writing"))
        }
        RadioTheme { Screen { ListenScreen(state, actions, PaddingValues(0.dp)) } }
    }

    /** «Text» while the item plays: the line being read is marked, the others step back. */
    @Test fun transcriptFollowing() = captureRoboImage("src/test/screenshots/transcript-following.png", roborazziOptions = options) {
        val transcript = ch.heimberg.radio.core.Transcript(
            "Warum der Aaregletscher schwindet",
            listOf(
                ch.heimberg.radio.core.TranscriptLine("Guten Morgen. Heute geht es um einen Gletscher, den viele vom Wandern kennen.", speaker = "Mia"),
                ch.heimberg.radio.core.TranscriptLine("Der Unteraargletscher hat in den letzten zwanzig Jahren fast einen Kilometer an Länge verloren.", speaker = "Mia"),
                ch.heimberg.radio.core.TranscriptLine("Und das Schmelzwasser fehlt im Spätsommer der Aare – mit Folgen bis nach Bern.", speaker = "Luca"),
                ch.heimberg.radio.core.TranscriptLine("Was man dagegen tun kann, und was nicht, hören Sie gleich.", speaker = "Mia"),
            ),
            listOf(ch.heimberg.radio.core.SourceRef("Gletscherbericht 2026", "https://glamos.ch/bericht")),
        )
        val state = RadioState().apply { currentItemId = "a"; partDurationMs = 100_000; partPositionMs = 40_000 }
        RadioTheme { Screen { Column(Modifier.padding(top = 16.dp)) { TranscriptBody(transcript, "a", state) } } }
    }

    /** «Einladen»: one compact line per station with today's use and costs, and a thin bar for a budget. */
    @Test fun invitesLight() = captureRoboImage("src/test/screenshots/invites-light.png", roborazziOptions = options) {
        RadioTheme { Screen { Column(Modifier.padding(16.dp)) { InvitesContent(studioState(), actions) } } }
    }

    @Config(qualifiers = "+night")
    @Test fun invitesDark() = captureRoboImage("src/test/screenshots/invites-dark.png", roborazziOptions = options) {
        RadioTheme { Screen { Column(Modifier.padding(16.dp)) { InvitesContent(studioState(), actions) } } }
    }

    /** «Für dich» tiles at phone width: long names shrink or break where German allows, never mid-syllable. */
    @Test fun pickTiles() = captureRoboImage("src/test/screenshots/pick-tiles.png", roborazziOptions = options) {
        RadioTheme {
            Surface(color = Nocturne.bg) {
                Row(Modifier.width(400.dp).padding(20.dp), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    PickTile("Wochenrückblick", "SONNTAGS", Kind.SPECIAL, Modifier.weight(1f)) {}
                    PickTile("Musikblock", "OFT", Kind.MUSIC, Modifier.weight(1f)) {}
                    PickTile("Schlagzeilen", "OFT", Kind.NEWS, Modifier.weight(1f)) {}
                    PickTile("Streitgespräch", "NEU", Kind.NEWS, Modifier.weight(1f)) {}
                }
            }
        }
    }
}

private const val INVITES = """{"ready":true,"budgetFloor":4,
  "own":{"limit":24,"usage":{"today":{"generations":9},"week":{"generations":61},"costs":{"today":0.84,"month":14.2}}},
  "serverBudget":{"limit":30,"spent":19.6},
  "invites":[{"id":"i1","name":"Grosi","kind":"family","expiresAt":"2026-10-12T10:00:00Z"}],
  "listeners":[
    {"key":"lea","name":"Lea","kind":"kids","since":"2026-10-01T10:00:00Z","removable":true,"limit":12,
     "usage":{"today":{"generations":4},"week":{"generations":30},"costs":{"today":0.31,"month":4.1},"budget":{"limit":5,"spent":4.4}}},
    {"key":"tom","name":"Tom","kind":"guest","since":"2026-10-03T10:00:00Z","removable":true,"limit":12,
     "usage":{"today":{"generations":1},"week":{"generations":3},"costs":{"today":0.05,"month":0.4}}}
  ]}"""
