package ch.heimberg.radio

import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.compose.runtime.getValue
import androidx.compose.material3.darkColorScheme
import androidx.compose.foundation.isSystemInDarkTheme
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Typography
import androidx.compose.material3.lightColorScheme
import androidx.compose.runtime.Composable
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.Font
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.sp
import ch.heimberg.radio.core.Kind

/**
 * «Magazin»: a light paper ground, ink for text and the main buttons, and one strong colour per rubric
 * that fills whole cards. The object keeps its old name so every screen picks up the tokens; the view
 * screens (setup, transcript) still use the dark tokens in res/values/colors.xml.
 */
object Nocturne {
    /** Follows the system: dark at night, light by day. Read in composition, so a switch redraws everything. */
    var dark by mutableStateOf(false)

    private fun pick(light: Long, night: Long) = Color(if (dark) night else light)

    val bg get() = pick(0xFFF3F4F0, 0xFF111214)
    val bgGlow get() = pick(0xFFECEDE8, 0xFF17181B)
    val surface get() = pick(0xFFFFFFFF, 0xFF1C1D21)
    val surfaceHigh get() = pick(0xFFE6E8E2, 0xFF2A2C31)
    val text get() = pick(0xFF16171B, 0xFFF1F1EE)
    val muted get() = pick(0xFF5C5F68, 0xFFA9ACB4)
    val faint get() = pick(0xFF74777F, 0xFF8A8D95)
    val divider get() = pick(0xFFDCDED8, 0xFF2E3035)
    /** Ink: the play button, the active tab, the «Einfügen» pill (paper-white at night). */
    val accent get() = pick(0xFF16171B, 0xFFF1F1EE)
    /** Links, highlighted labels and active toggles. */
    val accentLight get() = pick(0xFF1F5FD0, 0xFF8FB2F5)
    val accentDeep get() = pick(0xFFDCE6FA, 0xFF22324F)
    val accentDark get() = pick(0xFFE8EEFB, 0xFF1B2638)
    val danger get() = pick(0xFFC8361F, 0xFFFF7A63)
    /** The red dot of «LIVE» and the time of what plays now. */
    val live get() = pick(0xFFD93A24, 0xFFFF6B52)

    fun kind(kind: Kind?): Color = kind?.let { Color(it.argb) } ?: accentLight

    /** Text on a card filled with the rubric's colour. */
    fun onKind(kind: Kind?): Color = kind?.let { Color(it.onArgb) } ?: Color.White

    /** The rubric's name on the ground: darkened by day where it would be too pale, the full colour at night. */
    fun kindLabel(kind: Kind?): Color = kind?.let { Color(if (dark) it.argb else it.labelArgb) } ?: accentLight
}

/** Figtree: everything that is read rather than looked at. */
val Figtree = FontFamily(
    Font(R.font.figtree_regular, FontWeight.Normal), Font(R.font.figtree_medium, FontWeight.Medium),
    Font(R.font.figtree_semibold, FontWeight.SemiBold), Font(R.font.figtree_bold, FontWeight.Bold),
)

/** Archivo, condensed and black: the big uppercase titles of the magazine. */
val Display = FontFamily(Font(R.font.archivo_condensed_black, FontWeight.Black))

/** A display title of [size] sp; set in capitals by the caller. */
fun display(size: Int): TextStyle = TextStyle(fontFamily = Display, fontWeight = FontWeight.Black, fontSize = size.sp, lineHeight = (size * 0.92f).sp)

/** Small capitals above a section or a card: «FÜR DICH», «SENDEPLAN». */
val Kicker = TextStyle(fontFamily = Figtree, fontWeight = FontWeight.Bold, fontSize = 12.sp, lineHeight = 16.sp, letterSpacing = 1.5.sp)

private val RadioType = Typography(
    headlineMedium = TextStyle(fontFamily = Display, fontWeight = FontWeight.Black, fontSize = 34.sp, lineHeight = 34.sp),
    headlineSmall = TextStyle(fontFamily = Display, fontWeight = FontWeight.Black, fontSize = 28.sp, lineHeight = 29.sp),
    titleLarge = TextStyle(fontFamily = Figtree, fontWeight = FontWeight.Bold, fontSize = 19.sp, lineHeight = 24.sp, letterSpacing = (-0.2).sp),
    titleMedium = TextStyle(fontFamily = Figtree, fontWeight = FontWeight.Bold, fontSize = 16.sp, lineHeight = 21.sp),
    titleSmall = TextStyle(fontFamily = Figtree, fontWeight = FontWeight.Bold, fontSize = 15.sp, lineHeight = 19.sp),
    bodyLarge = TextStyle(fontFamily = Figtree, fontWeight = FontWeight.Medium, fontSize = 15.sp, lineHeight = 21.sp),
    bodyMedium = TextStyle(fontFamily = Figtree, fontSize = 13.sp, lineHeight = 18.sp),
    bodySmall = TextStyle(fontFamily = Figtree, fontSize = 12.sp, lineHeight = 16.sp),
    labelLarge = TextStyle(fontFamily = Figtree, fontWeight = FontWeight.SemiBold, fontSize = 14.sp, lineHeight = 18.sp),
    labelMedium = TextStyle(fontFamily = Figtree, fontWeight = FontWeight.SemiBold, fontSize = 12.sp, lineHeight = 16.sp),
    labelSmall = TextStyle(fontFamily = Figtree, fontWeight = FontWeight.Bold, fontSize = 10.sp, lineHeight = 14.sp, letterSpacing = 0.8.sp),
)

/** Material's colours from the tokens; built per theme, so it follows day and night. */
private fun radioColors() = (if (Nocturne.dark) darkColorScheme() else lightColorScheme()).copy(
    primary = Nocturne.accent,
    onPrimary = Nocturne.bg,
    primaryContainer = Nocturne.accentDeep,
    onPrimaryContainer = Nocturne.text,
    secondary = Nocturne.accentLight,
    onSecondary = Nocturne.bg,
    secondaryContainer = Nocturne.surfaceHigh,
    onSecondaryContainer = Nocturne.text,
    tertiary = Nocturne.accentLight,
    background = Nocturne.bg,
    onBackground = Nocturne.text,
    surface = Nocturne.bg,
    onSurface = Nocturne.text,
    surfaceVariant = Nocturne.surfaceHigh,
    onSurfaceVariant = Nocturne.muted,
    surfaceContainerLowest = Nocturne.surface,
    surfaceContainerLow = Nocturne.surface,
    surfaceContainer = Nocturne.surface,
    surfaceContainerHigh = Nocturne.surface,
    surfaceContainerHighest = Nocturne.surfaceHigh,
    outline = Nocturne.text.copy(alpha = 0.35f),
    outlineVariant = Nocturne.divider,
    error = Nocturne.danger,
    onError = Nocturne.bg,
    inverseSurface = Nocturne.text,
    inverseOnSurface = Nocturne.bg,
)

@Composable
fun RadioTheme(content: @Composable () -> Unit) {
    Nocturne.dark = isSystemInDarkTheme()
    MaterialTheme(colorScheme = radioColors(), typography = RadioType, content = content)
}
