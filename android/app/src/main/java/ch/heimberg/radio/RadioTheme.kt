package ch.heimberg.radio

import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Typography
import androidx.compose.material3.darkColorScheme
import androidx.compose.runtime.Composable
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.lerp
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.Font
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.sp
import ch.heimberg.radio.core.Kind

/**
 * Nocturne in Compose: a desaturated blue-grey ground, one blurple accent, and a colour per kind of
 * content. The same tokens as res/values/colors.xml, which the remaining view screens use.
 */
object Nocturne {
    val bg = Color(0xFF161826)
    val bgGlow = Color(0xFF1E2034)
    val surface = Color(0xFF232532)
    val surfaceHigh = Color(0xFF2B2E3D)
    val text = Color(0xFFE9E9ED)
    val muted = Color(0xFF9397AB)
    val faint = Color(0xFF595D6C)
    val divider = Color(0x29E9E9ED)
    val accent = Color(0xFF9184D9)
    val accentLight = Color(0xFFD2CEFD)
    val accentDeep = Color(0xFF423A6A)
    val accentDark = Color(0xFF2B2741)
    val danger = Color(0xFFF08A7E)

    fun kind(kind: Kind?): Color = kind?.let { Color(it.argb) } ?: accent

    /** The label colour of a kind: its hue, lifted towards the text colour for legibility. */
    fun kindLabel(kind: Kind?): Color = lerp(kind(kind), text, 0.25f)
}

private val Inter = FontFamily(Font(R.font.inter_regular, FontWeight.Normal), Font(R.font.inter_medium, FontWeight.Medium))

private val RadioType = Typography(
    headlineMedium = TextStyle(fontFamily = Inter, fontWeight = FontWeight.Medium, fontSize = 26.sp, lineHeight = 31.sp, letterSpacing = (-0.4).sp),
    headlineSmall = TextStyle(fontFamily = Inter, fontWeight = FontWeight.Medium, fontSize = 22.sp, lineHeight = 28.sp, letterSpacing = (-0.3).sp),
    titleLarge = TextStyle(fontFamily = Inter, fontWeight = FontWeight.Medium, fontSize = 19.sp, lineHeight = 24.sp, letterSpacing = (-0.2).sp),
    titleMedium = TextStyle(fontFamily = Inter, fontWeight = FontWeight.Medium, fontSize = 16.sp, lineHeight = 21.sp),
    titleSmall = TextStyle(fontFamily = Inter, fontWeight = FontWeight.Medium, fontSize = 14.sp, lineHeight = 19.sp),
    bodyLarge = TextStyle(fontFamily = Inter, fontSize = 15.sp, lineHeight = 21.sp),
    bodyMedium = TextStyle(fontFamily = Inter, fontSize = 13.sp, lineHeight = 18.sp),
    bodySmall = TextStyle(fontFamily = Inter, fontSize = 12.sp, lineHeight = 16.sp),
    labelLarge = TextStyle(fontFamily = Inter, fontWeight = FontWeight.Medium, fontSize = 14.sp, lineHeight = 18.sp),
    labelMedium = TextStyle(fontFamily = Inter, fontWeight = FontWeight.Medium, fontSize = 12.sp, lineHeight = 16.sp),
    labelSmall = TextStyle(fontFamily = Inter, fontWeight = FontWeight.Medium, fontSize = 10.sp, lineHeight = 14.sp, letterSpacing = 0.8.sp),
)

private val RadioColors = darkColorScheme(
    primary = Nocturne.accent,
    onPrimary = Nocturne.bg,
    primaryContainer = Nocturne.accentDeep,
    onPrimaryContainer = Color(0xFFF5F4FF),
    secondary = Nocturne.accent,
    onSecondary = Nocturne.bg,
    secondaryContainer = Nocturne.accentDark,
    onSecondaryContainer = Color(0xFFE7E5FE),
    background = Nocturne.bg,
    onBackground = Nocturne.text,
    surface = Nocturne.bg,
    onSurface = Nocturne.text,
    surfaceVariant = Nocturne.surface,
    onSurfaceVariant = Nocturne.muted,
    surfaceContainerLowest = Nocturne.bg,
    surfaceContainerLow = Nocturne.surface,
    surfaceContainer = Nocturne.surface,
    surfaceContainerHigh = Nocturne.surfaceHigh,
    surfaceContainerHighest = Nocturne.surfaceHigh,
    outline = Nocturne.divider,
    outlineVariant = Color(0xFF3F424D),
    error = Nocturne.danger,
    onError = Nocturne.bg,
)

@Composable
fun RadioTheme(content: @Composable () -> Unit) {
    MaterialTheme(colorScheme = RadioColors, typography = RadioType, content = content)
}
