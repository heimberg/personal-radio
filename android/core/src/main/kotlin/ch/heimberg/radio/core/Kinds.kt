package ch.heimberg.radio.core

/**
 * What kind of content an item or block is, with its colour and icon, so the program reads at a
 * glance. The colours are shared with the web studio (src/domain/kinds.ts); they are always paired with an icon.
 */
enum class Kind(val label: String, val argb: Long) {
    NEWS("Aktuell", 0xFFD08A2A),
    DISCOVER("Wissen", 0xFF2BA57A),
    WEATHER("Wetter", 0xFF5B95F5),
    MUSIC("Musik", 0xFFD06BD8),
    SURPRISE("Überraschung", 0xFFF0704F),
}

data class Look(val kind: Kind, val icon: String)

object Looks {
    private val BLOCKS = mapOf(
        "morgen" to Look(Kind.NEWS, "☕"), "schlagzeilen" to Look(Kind.NEWS, "📰"), "wetter" to Look(Kind.WEATHER, "☀️"),
        "entdeckung" to Look(Kind.DISCOVER, "🔭"), "hintergrund" to Look(Kind.DISCOVER, "🎙️"), "vertiefung" to Look(Kind.DISCOVER, "🔍"),
        "kuenstler" to Look(Kind.MUSIC, "🎸"), "genre" to Look(Kind.MUSIC, "🎛️"), "themenstunde" to Look(Kind.MUSIC, "🌙"),
        "musik" to Look(Kind.MUSIC, "🎵"), "neu" to Look(Kind.MUSIC, "✨"), "song" to Look(Kind.MUSIC, "🎶"),
        "ueberraschung" to Look(Kind.SURPRISE, "🎲"), "zufallsfund" to Look(Kind.SURPRISE, "🧭"), "heute-vor" to Look(Kind.SURPRISE, "📜"),
        "um-die-ecke" to Look(Kind.SURPRISE, "📍"), "wort-des-tages" to Look(Kind.SURPRISE, "🔤"), "frage-des-tages" to Look(Kind.SURPRISE, "❓"),
        "musik-wildcard" to Look(Kind.SURPRISE, "🌍"), "ueberraschungsstunde" to Look(Kind.SURPRISE, "🎭"),
        "serie" to Look(Kind.DISCOVER, "📚"), "geschichte" to Look(Kind.DISCOVER, "📖"),
    )
    private val SPOKEN = Look(Kind.DISCOVER, "🗞️")
    private val MUSIC = Look(Kind.MUSIC, "🎵")

    /** A program item: songs and blocks by their ID, the owner's own shows by whether they bring music. */
    fun of(item: TimelineItem): Look = when {
        item.showId == "_musik" -> BLOCKS.getValue("song")
        item.showId.startsWith("_series:") -> BLOCKS.getValue(if (item.series?.kind == "geschichte") "geschichte" else "serie")
        item.surprise && !item.showId.startsWith("_block:") -> Look(Kind.SURPRISE, "🎲")
        item.showId.startsWith("_block:") -> BLOCKS[item.showId.removePrefix("_block:")] ?: if (item.hasMusic) MUSIC else SPOKEN
        item.hasMusic -> MUSIC
        else -> SPOKEN
    }

    /** A palette block: catalog IDs, «song», or the owner's shows («show:<id>», by their music flag). */
    fun ofBlock(block: BlockView): Look = BLOCKS[block.id] ?: if (block.music) MUSIC else SPOKEN
}
