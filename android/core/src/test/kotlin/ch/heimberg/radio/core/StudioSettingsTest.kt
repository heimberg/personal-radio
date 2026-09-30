package ch.heimberg.radio.core

import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertNull
import kotlin.test.assertSame
import kotlin.test.assertTrue

class StudioSettingsTest {
    private val body = """
        {"config":{"name":"Radio Melchnau","host":{"name":"Lea","tone":"ruhig","style":"persönlich","instructions":"Kurz.","voiceId":"gemini_Kore","voiceStyle":"warm"},
         "profile":{"topics":["Kultur"],"interests":["Geologie"],"interestWeights":{"Geologie":2},"speechMinutes":2,"exploration":15},
         "music":{"between":2,"announce":false,"taste":"Indie"},"sounds":{"ident":true,"hourChange":false},
         "location":{"name":"Bern","latitude":46.95,"longitude":7.45},"shows":[{"id":"kurz"}],"schedule":[],"agents":{"x":1}}}
    """.trimIndent()

    @Test fun readsTheStationAndDefaultsWhatIsMissing() {
        val settings = StudioSettings.parse(body)!!
        assertEquals("Radio Melchnau", settings.name)
        assertEquals("gemini_Kore", settings.voiceId)
        assertEquals(Place("Bern", 46.95, 7.45), settings.place)
        assertEquals(listOf("Kultur"), settings.topics)
        assertEquals(2, settings.between)
        assertFalse(settings.announce)
        assertFalse(settings.hourChange)
        assertTrue(settings.linker && !settings.bed)
        assertNull(StudioSettings.parse("""{"config":null}"""))
        assertEquals(StudioSettings(), StudioSettings.parse("""{"config":{}}"""))
    }

    @Test fun editsStayWithinTheServersLimits() {
        val settings = StudioSettings.parse(body)!!
        assertEquals(listOf("Kultur", "Technologie"), settings.toggleTopic("Technologie").topics)
        assertEquals(emptyList(), settings.toggleTopic("Kultur").topics)
        assertSame(settings, settings.addInterest("  geologie "))
        assertSame(settings, settings.addInterest("   "))
        assertEquals(listOf("Geologie", "Vulkane"), settings.addInterest(" Vulkane ").interests)
        assertEquals(emptyList(), settings.removeInterest("Geologie").interests)
        assertEquals(50, settings.exploration(80).exploration)
        assertEquals(25, settings.exploration(23).exploration)
        assertEquals(3, settings.between(9).between)
    }

    @Test fun savingReplacesOnlyTheStudioFields() {
        val config = StudioSettings.parseConfig(body)
        val edited = StudioSettings.parse(body)!!.copy(name = " Radio Neu ", voiceId = null, place = null, bed = true, cohostName = "Jonas", cohostVoiceId = "gemini_Charon")
            .addInterest("Vulkane")
        val merged = edited.mergeInto(config)
        assertEquals("Radio Neu", merged["name"]!!.jsonPrimitive.content)
        val host = merged["host"]!!.jsonObject
        assertNull(host["voiceId"])
        assertEquals("Jonas", host["cohostName"]!!.jsonPrimitive.content)
        assertEquals("gemini_Charon", host["cohostVoiceId"]!!.jsonPrimitive.content)
        assertNull(merged["location"])
        // Untouched parts of the settings come back unchanged, down to the learned weights.
        assertEquals(config["shows"], merged["shows"])
        assertEquals(config["agents"], merged["agents"])
        assertEquals(config["profile"]!!.jsonObject["interestWeights"], merged["profile"]!!.jsonObject["interestWeights"])
        assertEquals("2", merged["profile"]!!.jsonObject["speechMinutes"]!!.jsonPrimitive.content)
        assertEquals("true", (merged["sounds"] as JsonObject)["musicBed"]!!.jsonPrimitive.content)
        // Read back, the merged settings are the edited ones.
        assertEquals(edited.copy(name = "Radio Neu"), StudioSettings.of(merged))
    }

    @Test fun aRefusedSettingSaysWhichField() {
        assertEquals("Nicht gespeichert – host.name: Text erwartet", AccessDiagnosis.message(400, null, """{"error":"invalid_config","detail":"host.name: Text erwartet"}"""))
    }

    @Test fun readsPlacesAndVoices() {
        val places = StudioSettings.parsePlaces("""{"places":[{"name":"Bern","region":"Bern","country":"Schweiz","latitude":46.948123,"longitude":7.447441},{"name":"kaputt"}]}""")
        assertEquals(listOf(Place("Bern", 46.9481, 7.4474, "Bern", "Schweiz")), places)
        assertEquals("Bern, Bern, Schweiz", places.single().label)
        val voices = StudioSettings.parseVoices("""{"voices":[{"id":"gemini_voice_a1","name":"Meine","group":"own"},{"id":"gemini_Kore","name":"Kore · bestimmt","group":"standard"},{"id":"gemini_Bernerin","name":"Bernerin","group":"library","description":"warm"},{"name":"ohne id"}]}""")
        assertEquals(listOf(VoiceOption("gemini_voice_a1", "Meine", "own"), VoiceOption("gemini_Kore", "Kore · bestimmt"), VoiceOption("gemini_Bernerin", "Bernerin", "library", "warm")), voices)
        assertTrue(voices.first().own)
        assertEquals(VoiceOption("gemini_voice_n", "Mira", "own"), StudioSettings.parseCreatedVoice("""{"voice":{"id":"gemini_voice_n","name":"Mira","group":"own"}}"""))
        assertNull(StudioSettings.parseCreatedVoice("""{"error":"voice_failed"}"""))
    }
}
