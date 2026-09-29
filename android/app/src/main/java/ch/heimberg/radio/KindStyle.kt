package ch.heimberg.radio

import android.content.Context
import android.graphics.drawable.GradientDrawable
import androidx.core.content.ContextCompat
import androidx.core.graphics.ColorUtils
import ch.heimberg.radio.core.Kind

/** Surfaces tinted with the colour of a kind of content: tiles, badges and the player card. */
object KindStyle {
    fun color(kind: Kind?, context: Context): Int = kind?.argb?.toInt() ?: ContextCompat.getColor(context, R.color.accent)

    /** A card whose top corner glows in the kind's colour, with a thin edge in it. */
    fun tile(context: Context, kind: Kind?, radiusDp: Float = 16f): GradientDrawable {
        val color = color(kind, context)
        val surface = ContextCompat.getColor(context, R.color.surface)
        return GradientDrawable(GradientDrawable.Orientation.TR_BL, intArrayOf(ColorUtils.blendARGB(surface, color, 0.28f), surface, surface)).apply {
            cornerRadius = radiusDp * context.resources.displayMetrics.density
            setStroke((context.resources.displayMetrics.density).toInt().coerceAtLeast(1), ColorUtils.setAlphaComponent(color, 110))
        }
    }

    /** A round badge behind an icon. */
    fun badge(context: Context, kind: Kind?, cornerDp: Float = 12f): GradientDrawable {
        val color = color(kind, context)
        val surface = ContextCompat.getColor(context, R.color.surface)
        return GradientDrawable().apply {
            setColor(ColorUtils.blendARGB(surface, color, 0.32f))
            cornerRadius = cornerDp * context.resources.displayMetrics.density
            setStroke((context.resources.displayMetrics.density).toInt().coerceAtLeast(1), ColorUtils.setAlphaComponent(color, 150))
        }
    }

    /** The label colour of a kind: its hue, lifted towards the text colour for legibility. */
    fun label(context: Context, kind: Kind?): Int = ColorUtils.blendARGB(color(kind, context), ContextCompat.getColor(context, R.color.text), 0.25f)
}
