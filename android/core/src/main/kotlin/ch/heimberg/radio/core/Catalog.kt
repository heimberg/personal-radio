package ch.heimberg.radio.core

import java.text.Normalizer

/**
 * The catalog of building blocks behind «＋ Einfügen»: grouped into the five rubrics, searchable, with
 * favourites first. The server already leaves out the blocks switched off under «Funktionen».
 */
object Catalog {
    /** Blocks that are not inserted from the catalog: a single song has its own button. */
    private val NOT_LISTED = setOf("song")

    fun listed(blocks: List<BlockView>): List<BlockView> = blocks.filter { it.id !in NOT_LISTED }

    /** Each rubric with its blocks, favourites first, then in the server's order; empty rubrics stay as tabs. */
    fun rubrics(blocks: List<BlockView>, favorites: Set<String>): List<Pair<Kind, List<BlockView>>> {
        val listed = listed(blocks)
        return Kind.entries.map { kind ->
            kind to listed.filter { Looks.ofBlock(it).kind == kind }.sortedBy { if (it.id in favorites) 0 else 1 }
        }
    }

    /** Blocks whose name, description or rubric contains every word of [query]; umlauts and case do not matter. */
    fun search(blocks: List<BlockView>, query: String, favorites: Set<String> = emptySet()): List<BlockView> {
        val words = fold(query).split(' ').filter { it.isNotBlank() }
        if (words.isEmpty()) return emptyList()
        return listed(blocks)
            .filter { block ->
                val text = fold("${block.name} ${block.description} ${Looks.ofBlock(block).kind.label}")
                words.all { it in text }
            }
            .sortedBy { if (it.id in favorites) 0 else 1 }
    }

    /** Lower case and without accents, «ß» as «ss»: «Überraschung» and «uberraschung» meet. */
    fun fold(text: String): String =
        Normalizer.normalize(text.lowercase().replace("ß", "ss"), Normalizer.Form.NFD)
            .replace(Regex("\\p{M}+"), "")
            .replace(Regex("[^a-z0-9 ]+"), " ")
}

/** One suggestion under «Für dich»: the block and why it is there, in one short word. */
data class Pick(val block: BlockView, val why: String)

/**
 * «Für dich»: up to four blocks that fit now. One for the time of day, then the owner's favourites and
 * what they insert most often, then something they have not tried yet, which changes from day to day.
 * Everything is counted on the device; nothing of it leaves the phone.
 */
object ForYou {
    const val LIMIT = 4

    /** What suits a part of the day, best first; only blocks the station offers are suggested. */
    private fun suited(hour: Int, weekday: Int): List<Pair<String, String>> = buildList {
        if (weekday == 7 && hour >= 9) add("rueckblick" to "SONNTAGS")
        when (hour) {
            in 5..9 -> { add("morgen" to "MORGENS"); add("wetter" to "MORGENS") }
            in 10..13 -> { add("schlagzeilen" to "MITTAGS"); add("hintergrund" to "MITTAGS") }
            in 14..17 -> { add("entdeckung" to "NACHMITTAGS"); add("weltpresse" to "NACHMITTAGS") }
            in 18..21 -> { add("musik" to "ABENDS"); add("geschichte" to "ABENDS"); add("mitmach" to "ABENDS") }
            else -> { add("themenstunde" to "SPÄT"); add("musik" to "SPÄT") }
        }
    }

    /**
     * [hour] 0–23 and [weekday] 1 (Monday) – 7 (Sunday) on the phone's clock; [usage] how often each block was
     * inserted here; [day] any number that changes daily (the day of the year), for the new block.
     */
    fun picks(blocks: List<BlockView>, hour: Int, weekday: Int, day: Int, usage: Map<String, Int>, favorites: Set<String>): List<Pick> {
        val offered = Catalog.listed(blocks).associateBy { it.id }
        val picks = LinkedHashMap<String, Pick>()
        fun add(id: String, why: String) {
            if (picks.size < LIMIT && id !in picks) offered[id]?.let { picks[id] = Pick(it, why) }
        }
        suited(hour, weekday).firstOrNull { it.first in offered }?.let { (id, why) -> add(id, why) }
        favorites.sortedByDescending { usage[it] ?: 0 }.take(2).forEach { add(it, "FAVORIT") }
        usage.filter { it.value >= 2 }.entries.sortedByDescending { it.value }.forEach { add(it.key, "OFT") }
        val untried = offered.keys.filter { (usage[it] ?: 0) == 0 && it !in favorites }
        if (untried.isNotEmpty()) add(untried[Math.floorMod(day, untried.size)], "NEU")
        // Still room (a new station): the rest of the time of day, then the catalog's order.
        suited(hour, weekday).forEach { (id, why) -> add(id, why) }
        offered.keys.forEach { add(it, "TIPP") }
        return picks.values.toList()
    }

    /** «Samstagmorgen», «Montagabend»: the moment the suggestions are for. */
    fun moment(hour: Int, weekday: Int): String {
        val day = listOf("Montag", "Dienstag", "Mittwoch", "Donnerstag", "Freitag", "Samstag", "Sonntag")[(weekday - 1).coerceIn(0, 6)]
        val part = when (hour) {
            in 5..9 -> "morgen"
            in 10..11 -> "vormittag"
            in 12..13 -> "mittag"
            in 14..17 -> "nachmittag"
            in 18..21 -> "abend"
            else -> "nacht"
        }
        return day + part
    }
}

/** A title for the big player: a short head, and the rest as a line below it. */
object Headline {
    private val BREAKS = listOf(": ", " – ", " - ", " · ")

    fun split(title: String): Pair<String, String?> {
        for (mark in BREAKS) {
            val at = title.indexOf(mark)
            if (at in 1..40) return title.substring(0, at).trim() to title.substring(at + mark.length).trim().ifBlank { null }
        }
        return title.trim() to null
    }
}
