package ch.heimberg.radio.core

/**
 * The five rubrics of the program, each with its colour, the colour of text on it ([onArgb]) and a
 * darker shade for labels on the light ground ([labelArgb]). Every block and item belongs to one, so the
 * program and the catalog read at a glance; the colour always comes with a name or an icon.
 */
enum class Kind(val label: String, val hint: String, val argb: Long, val onArgb: Long, val labelArgb: Long) {
    NEWS("Aktuell", "Was heute passiert", 0xFFD93A24, 0xFFFFFFFF, 0xFFB32E1B),
    DISCOVER("Wissen", "Verstehen und entdecken", 0xFF1F5FD0, 0xFFFFFFFF, 0xFF1F5FD0),
    MUSIC("Musik", "Über Spotify", 0xFF7A3FD1, 0xFFFFFFFF, 0xFF7A3FD1),
    STORY("Geschichten", "Erzählt in Folgen", 0xFFF2A900, 0xFF16171B, 0xFF8A6100),
    SPECIAL("Spezial", "Überraschend und persönlich", 0xFF0B7F5E, 0xFFFFFFFF, 0xFF0B7F5E),
}

data class Look(val kind: Kind, val icon: String)

object Looks {
    private val BLOCKS = mapOf(
        // Aktuell
        "morgen" to Look(Kind.NEWS, "☕"), "schlagzeilen" to Look(Kind.NEWS, "📰"), "wetter" to Look(Kind.NEWS, "☀️"),
        "weltpresse" to Look(Kind.NEWS, "🌐"), "streitgespraech" to Look(Kind.NEWS, "⚖️"), "dranbleiben" to Look(Kind.NEWS, "📌"),
        // Wissen
        "entdeckung" to Look(Kind.DISCOVER, "🔭"), "hintergrund" to Look(Kind.DISCOVER, "🎙️"), "vertiefung" to Look(Kind.DISCOVER, "🔍"),
        "serie" to Look(Kind.DISCOVER, "📚"), "nachfrage" to Look(Kind.DISCOVER, "❓"),
        "ortsgeschichte" to Look(Kind.DISCOVER, "🏰"),
        // Musik
        "kuenstler" to Look(Kind.MUSIC, "🎸"), "genre" to Look(Kind.MUSIC, "🎛️"), "themenstunde" to Look(Kind.MUSIC, "🌙"),
        "musik" to Look(Kind.MUSIC, "🎵"), "neu" to Look(Kind.MUSIC, "✨"), "song" to Look(Kind.MUSIC, "🎶"),
        "konzerte" to Look(Kind.MUSIC, "🎟️"),
        // Geschichten
        "geschichte" to Look(Kind.STORY, "📖"), "mitmach" to Look(Kind.STORY, "🧩"),
        // Spezial
        "ueberraschung" to Look(Kind.SPECIAL, "🎲"), "rueckblick" to Look(Kind.SPECIAL, "🗓️"), "zufallsfund" to Look(Kind.SPECIAL, "🧭"),
        "heute-vor" to Look(Kind.SPECIAL, "📜"), "um-die-ecke" to Look(Kind.SPECIAL, "📍"), "wort-des-tages" to Look(Kind.SPECIAL, "🔤"),
        "frage-des-tages" to Look(Kind.SPECIAL, "💡"), "musik-wildcard" to Look(Kind.SPECIAL, "🌍"), "ueberraschungsstunde" to Look(Kind.SPECIAL, "🎭"),
    )
    private val SPOKEN = Look(Kind.DISCOVER, "🗞️")
    private val MUSIC = Look(Kind.MUSIC, "🎵")

    /** A program item: songs and blocks by their ID, the owner's own shows by whether they bring music. */
    fun of(item: TimelineItem): Look = when {
        item.showId == "_musik" -> BLOCKS.getValue("song")
        item.showId.startsWith("_series:") -> BLOCKS.getValue(
            when {
                item.series?.kind != "geschichte" -> "serie"
                item.choice != null -> "mitmach"
                else -> "geschichte"
            },
        )
        item.surprise && !item.showId.startsWith("_block:") -> BLOCKS.getValue("ueberraschung")
        item.showId.startsWith("_block:") -> BLOCKS[item.showId.removePrefix("_block:")] ?: if (item.hasMusic) MUSIC else SPOKEN
        item.hasMusic -> MUSIC
        else -> SPOKEN
    }

    /** A palette block: catalog IDs, «song», or the owner's shows («show:<id>», by their music flag). */
    fun ofBlock(block: BlockView): Look = BLOCKS[block.id] ?: if (block.music) MUSIC else SPOKEN
}
