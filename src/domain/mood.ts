// «Heute»: a mood for the rest of the day, one tap in the app. It does not touch the saved day plan; the
// planner reads the plan through the mood, so the program leans that way until midnight and then returns.
import { BLOCK_PREFIX } from './blocks.ts';
import { localClock } from './station.ts';
import type { MoodId, StationConfig } from './station.ts';

export interface Mood { id: MoodId; label: string; icon: string; description: string }

export const MOODS: Mood[] = [
  { id: 'ruhig', label: 'Eher ruhig', icon: '😌', description: 'Mehr Musik, keine Schlagzeilen, keine Überraschungen' },
  { id: 'wissen', label: 'Mehr Wissen', icon: '🧠', description: 'Öfter Entdeckungen und Hintergründe' },
  { id: 'musik', label: 'Mehr Musik', icon: '🎵', description: 'Mehr Songs zwischen den Beiträgen und Musikblöcke' },
  { id: 'aktuell', label: 'Was läuft?', icon: '📰', description: 'Öfter die Schlagzeilen' },
  { id: 'ueberraschung', label: 'Überrasch mich', icon: '🎲', description: 'Viel öfter etwas Unerwartetes' },
];

const block = (id: string) => `${BLOCK_PREFIX}${id}`;
/** What «Eher ruhig» leaves out of the rotation. */
const LOUD = [block('schlagzeilen'), block('morgen')];
/** What the other moods add to every time window. */
const EXTRA: Partial<Record<MoodId, string[]>> = {
  wissen: [block('entdeckung'), block('hintergrund')],
  musik: [block('musik')],
  aktuell: [block('schlagzeilen')],
};

/** The mood that applies at [now], if any. */
export function activeMood(config: StationConfig, now: Date): MoodId | undefined {
  return config.mood && Date.parse(config.mood.until) > now.getTime() ? config.mood.id : undefined;
}

/** The end of the station's day: the next local midnight. */
export function endOfDay(now: Date, timezone: string): Date {
  const { minutes } = localClock(now, timezone);
  const midnight = new Date(now.getTime() + (24 * 60 - minutes) * 60_000);
  midnight.setUTCSeconds(0, 0);
  return midnight;
}

/** The configuration as the planner sees it under today's mood; the stored plan stays as it is. */
export function applyMood(config: StationConfig, now: Date): StationConfig {
  const mood = activeMood(config, now);
  if (!mood) return config;
  const between = config.music.between;
  if (mood === 'ruhig') {
    return {
      ...config, surprise: 0,
      music: { ...config.music, between: between > 0 ? Math.min(3, between + 1) : 0 },
      schedule: config.schedule.map(slot => {
        const quiet = slot.showIds.filter(id => !LOUD.includes(id));
        return quiet.length ? { ...slot, showIds: quiet } : slot;
      }),
    };
  }
  if (mood === 'ueberraschung') return { ...config, surprise: Math.max(config.surprise ?? 25, 80) };
  const extra = EXTRA[mood] ?? [];
  return {
    ...config,
    ...(mood === 'musik' ? { music: { ...config.music, between: Math.min(3, Math.max(2, between + 1)) } } : {}),
    schedule: config.schedule.map(slot => ({ ...slot, showIds: [...slot.showIds, ...extra.filter(id => !slot.showIds.includes(id))] })),
  };
}
