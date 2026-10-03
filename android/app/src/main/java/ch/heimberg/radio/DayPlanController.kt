package ch.heimberg.radio

import ch.heimberg.radio.core.DayPlan
import ch.heimberg.radio.core.Moods
import kotlinx.coroutines.launch

/** «Heute» (a mood until midnight) and the day plan. */
interface DayPlanActions {
    /** A mood until midnight, or none. */
    fun setMood(id: String?)
    fun openDayPlan()
    fun editDayPlan(plan: DayPlan)
    fun saveDayPlan()
    fun closeDayPlan()
}

class DayPlanController(private val ref: HostRef) : DayPlanActions {
    private val host get() = ref.host
    private val state get() = host.state
    private val api get() = host.api

    /** Set while a mood is on its way, so a refresh in between does not flip the chip back. */
    var moodSending = false
        private set

    override fun setMood(id: String?) {
        val before = state.mood
        state.mood = id
        moodSending = true
        host.confirm()
        host.scope.launch {
            val result = runCatching { api.setMood(id) }
            moodSending = false
            if (result.isFailure) state.mood = before
            state.say(result.fold(
                { Moods.of(id)?.let { "${it.icon} ${it.label} – gilt ab den nächsten Beiträgen bis Mitternacht." } ?: "Wieder der normale Tagesplan." },
                { host.failure(it) },
            ))
            if (result.isSuccess) host.changed()
        }
    }

    override fun openDayPlan() {
        state.dayPlanOpen = true
        // Unsaved changes stay until they are saved; otherwise the plan is read fresh.
        if (state.dayPlanDirty && state.dayPlan != null) return
        state.dayPlan = null
        host.scope.launch {
            runCatching { api.dayPlan() }
                .onSuccess { plan -> if (plan == null) state.say("Das Radio ist noch nicht eingerichtet – das geht im Studio.") else state.dayPlan = plan }
                .onFailure { state.say(host.failure(it)) }
        }
    }

    override fun editDayPlan(plan: DayPlan) {
        if (plan == state.dayPlan) return
        state.dayPlan = plan
        state.dayPlanDirty = true
    }

    override fun saveDayPlan() {
        val plan = state.dayPlan ?: return
        state.dayPlanSaving = true
        host.scope.launch {
            val result = runCatching { api.saveDayPlan(plan) }
            state.dayPlanSaving = false
            if (result.isSuccess) state.dayPlanDirty = false
            state.say(result.fold({ "Tagesplan gespeichert. Er gilt ab den nächsten geplanten Beiträgen." }, { host.failure(it) }))
            if (result.isSuccess) host.changed()
        }
    }

    override fun closeDayPlan() {
        state.dayPlanOpen = false
    }
}
