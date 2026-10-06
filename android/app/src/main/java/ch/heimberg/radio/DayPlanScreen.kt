package ch.heimberg.radio

import androidx.compose.foundation.layout.size
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ExperimentalLayoutApi
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.AssistChip
import androidx.compose.material3.Button
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.FilterChip
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.ModalBottomSheet
import androidx.compose.material3.Slider
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import ch.heimberg.radio.core.BlockView
import ch.heimberg.radio.core.DayPlan
import ch.heimberg.radio.core.Looks
import ch.heimberg.radio.core.ScheduleSlot
import java.time.ZonedDateTime

/**
 * «Tagesplan» in the app: time windows whose blocks take turns, the ready-made windows and the
 * surprise level. Changes stay local until «Speichern»; only the plan and the level are sent.
 */
@OptIn(ExperimentalLayoutApi::class)
@Composable
fun DayPlanScreen(state: RadioState, actions: RadioActions, padding: PaddingValues) {
    val plan = state.dayPlan
    Column(Modifier.padding(padding).verticalScroll(rememberScrollState()).padding(bottom = 24.dp)) {
        Row(Modifier.fillMaxWidth().padding(start = 4.dp, end = 16.dp, top = 8.dp), verticalAlignment = Alignment.CenterVertically) {
            IconButton(onClick = actions::closeDayPlan) { Icon(painterResource(R.drawable.ic_arrow_left), "Zurück zum Programm") }
            ScreenTitle("Tagesplan")
            Spacer(Modifier.weight(1f))
            Button(onClick = actions::saveDayPlan, enabled = plan != null && state.dayPlanDirty && !state.dayPlanSaving) { Text("Speichern") }
        }
        Text(
            if (state.dayPlanDirty) "Noch nicht gespeichert." else "Zeitfenster mit Bausteinen, die sich abwechseln – dazwischen Songs, wenn Musik an ist.",
            style = MaterialTheme.typography.bodySmall, color = if (state.dayPlanDirty) Nocturne.accentLight else Nocturne.muted,
            modifier = Modifier.padding(horizontal = 20.dp, vertical = 4.dp),
        )
        if (plan == null) {
            SkeletonRows(5, "Tagesplan", Modifier.padding(20.dp))
            return@Column
        }
        val now = ZonedDateTime.now()
        val active = plan.active(now.dayOfWeek.value % 7, now.hour * 60 + now.minute)
        for (slot in plan.slots) SlotCard(slot, slot.id == active?.id, plan, state, actions)
        if (plan.slots.isEmpty()) {
            Text("Noch keine Zeitfenster. Ohne Zeitfenster plant das Radio nichts.", style = MaterialTheme.typography.bodyMedium, color = Nocturne.muted, modifier = Modifier.padding(20.dp))
        }

        Text("Zeitfenster hinzufügen", style = MaterialTheme.typography.titleMedium, modifier = Modifier.padding(start = 20.dp, top = 18.dp, bottom = 4.dp))
        FlowRow(Modifier.padding(horizontal = 16.dp), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            for (preset in DayPlan.PRESETS) {
                AssistChip(onClick = { actions.editDayPlan(plan.add(preset)) }, label = { Text("+ ${preset.name}  ${preset.from}–${preset.to}") })
            }
        }

        Text("Überraschungen", style = MaterialTheme.typography.titleMedium, modifier = Modifier.padding(start = 20.dp, top = 18.dp))
        Text(surpriseLabel(plan.surprise), style = MaterialTheme.typography.bodySmall, color = Nocturne.muted, modifier = Modifier.padding(horizontal = 20.dp))
        Slider(
            value = plan.surprise.toFloat(), onValueChange = { actions.editDayPlan(plan.surprise(Math.round(it / 5f) * 5)) },
            valueRange = 0f..100f, modifier = Modifier.padding(horizontal = 20.dp),
        )
    }
}

private fun surpriseLabel(level: Int): String = when {
    level == 0 -> "Nie – nur was im Plan steht."
    level < 20 -> "Selten ($level)."
    level < 40 -> "Etwa einmal pro Stunde ($level)."
    level < 70 -> "Öfter ($level)."
    else -> "Sehr oft ($level)."
}

@OptIn(ExperimentalLayoutApi::class)
@Composable
private fun SlotCard(slot: ScheduleSlot, onAir: Boolean, plan: DayPlan, state: RadioState, actions: RadioActions) {
    Column(
        Modifier
            .padding(horizontal = 16.dp, vertical = 6.dp)
            .fillMaxWidth()
            .kindTile(null, RoundedCornerShape(18.dp), glow = if (onAir) 0.3f else 0.08f)
            .padding(12.dp),
    ) {
        Row(verticalAlignment = Alignment.CenterVertically) {
            TextButton(onClick = { state.timeAsk = slot.id to true }) { Text(slot.from, style = MaterialTheme.typography.titleMedium) }
            Text("–", color = Nocturne.muted)
            TextButton(onClick = { state.timeAsk = slot.id to false }) { Text(slot.to, style = MaterialTheme.typography.titleMedium) }
            if (onAir) KindChip("läuft jetzt", null, Modifier.padding(start = 4.dp))
            Spacer(Modifier.weight(1f))
            IconButton(onClick = { actions.editDayPlan(plan.remove(slot.id)) }) { Icon(painterResource(R.drawable.ic_x), "Zeitfenster entfernen", Modifier.size(16.dp), tint = Nocturne.muted) }
        }
        FlowRow(horizontalArrangement = Arrangement.spacedBy(6.dp)) {
            for ((label, days) in DayPlan.DAY_SETS) {
                FilterChip(selected = slot.days.sorted() == days.sorted(), onClick = { actions.editDayPlan(plan.days(slot.id, days)) }, label = { Text(label) })
            }
        }
        FlowRow(horizontalArrangement = Arrangement.spacedBy(4.dp)) {
            for ((day, label) in DayPlan.WEEKDAYS) {
                FilterChip(selected = day in slot.days, onClick = { actions.editDayPlan(plan.toggleDay(slot.id, day)) }, label = { Text(label) })
            }
        }
        Spacer(Modifier.height(6.dp))
        FlowRow(horizontalArrangement = Arrangement.spacedBy(6.dp)) {
            slot.showIds.forEachIndexed { position, id ->
                val block = blockFor(id, state.blocks)
                AssistChip(
                    onClick = { actions.editDayPlan(plan.removeBlock(slot.id, position)) },
                    label = { Text("${block?.let { Looks.ofBlock(it).icon } ?: "🗞️"}  ${block?.name ?: id.removePrefix(DayPlan.BLOCK_PREFIX)}  ✕") },
                    enabled = slot.showIds.size > 1,
                )
            }
            AssistChip(onClick = { state.blockPickFor = slot.id }, label = { Text("+ Baustein") })
        }
    }
}

private fun blockFor(scheduleId: String, blocks: List<BlockView>): BlockView? = blocks.firstOrNull { DayPlan.scheduleId(it) == scheduleId }

/** The pickers the day plan opens: a start or end time, and a block for a window. */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun DayPlanDialogs(state: RadioState, actions: RadioActions) {
    val plan = state.dayPlan ?: return
    state.timeAsk?.let { (slotId, from) ->
        val slot = plan.slots.firstOrNull { it.id == slotId }
        AlertDialog(
            onDismissRequest = { state.timeAsk = null },
            title = { Text(if (from) "Beginn" else "Ende") },
            text = {
                LazyColumn(Modifier.heightIn(max = 360.dp)) {
                    items(DayPlan.TIMES.filter { if (from) it != "24:00" else it != "00:00" }) { time ->
                        val chosen = time == (if (from) slot?.from else slot?.to)
                        Text(
                            time, style = MaterialTheme.typography.bodyLarge, color = if (chosen) Nocturne.accentLight else Nocturne.text,
                            modifier = Modifier.fillMaxWidth().clickable {
                                state.timeAsk = null
                                if (slot != null) {
                                    val start = if (from) time else slot.from
                                    val end = if (from) slot.to else time
                                    if (DayPlan.minutesOf(start) >= DayPlan.minutesOf(end)) state.say("Das Ende muss nach dem Beginn liegen.")
                                    else actions.editDayPlan(plan.times(slotId, start, end))
                                }
                            }.padding(vertical = 10.dp),
                        )
                    }
                }
            },
            confirmButton = { TextButton(onClick = { state.timeAsk = null }) { Text("Abbrechen") } },
            containerColor = Nocturne.surface,
        )
    }
    state.blockPickFor?.let { slotId ->
        ModalBottomSheet(onDismissRequest = { state.blockPickFor = null }, containerColor = Nocturne.surface) {
            Text("Baustein hinzufügen", style = MaterialTheme.typography.titleMedium, modifier = Modifier.padding(start = 20.dp, bottom = 8.dp))
            LazyColumn(Modifier.heightIn(max = 480.dp)) {
                items(state.blocks.filter { DayPlan.scheduleId(it) != null }, key = { it.id }) { block ->
                    val look = Looks.ofBlock(block)
                    Row(
                        Modifier.fillMaxWidth().clickable {
                            state.blockPickFor = null
                            actions.editDayPlan(plan.addBlock(slotId, DayPlan.scheduleId(block)!!))
                        }.padding(horizontal = 20.dp, vertical = 10.dp),
                        verticalAlignment = Alignment.CenterVertically,
                    ) {
                        KindBadge(look.icon, look.kind, 36.dp)
                        Spacer(Modifier.width(12.dp))
                        Column(Modifier.weight(1f)) {
                            Text(block.name, style = MaterialTheme.typography.titleSmall)
                            Text(block.description, style = MaterialTheme.typography.bodySmall, color = Nocturne.muted, maxLines = 1, overflow = TextOverflow.Ellipsis)
                        }
                    }
                }
            }
            Spacer(Modifier.height(24.dp))
        }
    }
}
