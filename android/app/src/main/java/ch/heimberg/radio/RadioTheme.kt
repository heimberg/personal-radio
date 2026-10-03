package ch.heimberg.radio

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
    val bg = Color(0xFFF3F4F0)
    val bgGlow = Color(0xFFECEDE8)
    val surface = Color(0xFFFFFFFF)
    val surfaceHigh = Color(0xFFE6E8E2)
    val text = Color(0xFF16171B)
    val muted = Color(0xFF5C5F68)
    val faint = Color(0xFF74777F)
    val divider = Color(0xFFDCDED8)
    /** Ink: the play button, the active tab, the «Einfügen» pill. */
    val accent = Color(0xFF16171B)
    /** Links, highlighted labels and active toggles. */
    val accentLight = Color(0xFF1F5FD0)
    val accentDeep = Color(0xFFDCE6FA)
    val accentDark = Color(0xFFE8EEFB)
    val danger = Color(0xFFC8361F)
    /** The red dot of «LIVE» and the time of what plays now. */
    val live = Color(0xFFD93A24)

    fun kind(kind: Kind?): Color = kind?.let { Color(it.argb) } ?: accentLight

    /** Text on a card filled with the rubric's colour. */
    fun onKind(kind: Kind?): Color = kind?.let { Color(it.onArgb) } ?: Color.White

    /** The rubric's name on the light ground: its colour, darkened where it would be too pale to read. */
    fun kindLabel(kind: Kind?): Color = kind?.let { Color(it.labelArgb) } ?: accentLight
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

private val RadioColors = lightColorScheme(
    primary = Nocturne.accent,
    onPrimary = Nocturne.bg,
    primaryContainer = Nocturne.accentDeep,
    onPrimaryContainer = Nocturne.text,
    secondary = Nocturne.accentLight,
    onSecondary = Color.White,
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
    onError = Color.White,
)

@Composable
fun RadioTheme(content: @Composable () -> Unit) {
    MaterialTheme(colorScheme = RadioColors, typography = RadioType, content = content)
}
