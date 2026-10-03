package ch.heimberg.radio

import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Switch
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp

/**
 * «Funktionen» in the studio: everything the station does on its own, each with what it costs, and the
 * building blocks the palette shows – switched right away, without «Speichern».
 */
@Composable
fun FeaturesContent(state: RadioState, actions: RadioActions) {
    LaunchedEffect(Unit) { actions.loadFeatures() }
    val catalog = state.features ?: return Text("Wird geladen …", style = MaterialTheme.typography.bodySmall, color = Nocturne.muted)
    Text("VON SELBST", style = Kicker, color = Nocturne.muted)
    for (feature in catalog.features) {
        SwitchRow(feature.name, feature.description, "Kosten: ${feature.cost}", feature.enabled, !state.featuresBusy) { actions.setFeature(feature.id, it) }
    }
    if (catalog.on("places")) {
        Text("Ortsgeschichten: Der Standort wird nur geprüft, solange die App offen ist. Die Position geht an OpenStreetMap (für den Ortsnamen), an die KI nur der Ortsname.",
            style = MaterialTheme.typography.bodySmall, color = Nocturne.faint)
    }
    Text("BAUSTEINE IM PROGRAMM", style = Kicker, color = Nocturne.muted, modifier = Modifier.padding(top = 8.dp))
    Text("Ausgeblendete Bausteine verschwinden nur aus der Auswahl; was der Tagesplan vorsieht, läuft weiter.", style = MaterialTheme.typography.bodySmall, color = Nocturne.muted)
    for (block in catalog.blocks) {
        SwitchRow(block.name, block.description, null, block.visible, !state.featuresBusy) { actions.setBlockVisible(block.id, it) }
    }
}

@Composable
private fun SwitchRow(title: String, detail: String, note: String?, checked: Boolean, enabled: Boolean, onChange: (Boolean) -> Unit) {
    Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
        Column(Modifier.weight(1f)) {
            Text(title, style = MaterialTheme.typography.bodyLarge)
            if (detail.isNotBlank()) Text(detail, style = MaterialTheme.typography.bodySmall, color = Nocturne.muted)
            if (note != null) Text(note, style = MaterialTheme.typography.labelSmall, color = Nocturne.faint)
        }
        Spacer(Modifier.width(12.dp))
        Switch(checked = checked, onCheckedChange = onChange, enabled = enabled)
    }
}
