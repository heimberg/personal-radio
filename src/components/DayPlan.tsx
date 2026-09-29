import { useState } from 'react';
import { BLOCKS, BLOCK_PREFIX } from '../domain/blocks.ts';
import type { ScheduleSlot, ShowConfig } from '../domain/station.ts';

interface Props {
  schedule: ScheduleSlot[];
  shows: ShowConfig[];
  onChange(schedule: ScheduleSlot[]): void;
}

const DAYS: Array<[number, string]> = [[1, 'Mo'], [2, 'Di'], [3, 'Mi'], [4, 'Do'], [5, 'Fr'], [6, 'Sa'], [0, 'So']];
const DAY_SETS: Array<[string, number[]]> = [['Täglich', [0, 1, 2, 3, 4, 5, 6]], ['Werktags', [1, 2, 3, 4, 5]], ['Wochenende', [0, 6]]];
/** Ready-made windows: a time of day and blocks that suit it. */
const PRESETS: Array<{ name: string; from: string; to: string; blocks: string[] }> = [
  { name: 'Morgen', from: '06:00', to: '09:00', blocks: ['morgen', 'entdeckung'] },
  { name: 'Mittag', from: '12:00', to: '13:30', blocks: ['schlagzeilen', 'entdeckung'] },
  { name: 'Nachmittag', from: '14:00', to: '18:00', blocks: ['entdeckung', 'hintergrund'] },
  { name: 'Abend', from: '18:00', to: '22:00', blocks: ['kuenstler', 'musik'] },
];
const sameDays = (a: number[], b: number[]) => a.length === b.length && a.every(day => b.includes(day));

function slotId(taken: string[], base: string): string {
  const slug = base.toLowerCase().replace(/[^a-z0-9]+/g, '-');
  let id = slug, n = 2;
  while (taken.includes(id)) id = `${slug}-${n++}`;
  return id;
}

/**
 * The day plan: time windows, each a row of building blocks that take turns (with songs in between when
 * music is on). Windows come ready-made; blocks are added from the catalog or the owner's own shows.
 */
export function DayPlan({ schedule, shows, onChange }: Props) {
  const [picking, setPicking] = useState<string | null>(null);
  const name = (id: string) => id.startsWith(BLOCK_PREFIX) ? BLOCKS.find(block => `${BLOCK_PREFIX}${block.id}` === id)?.name ?? id : shows.find(show => show.id === id)?.name ?? id;
  const update = (index: number, change: (slot: ScheduleSlot) => ScheduleSlot) => onChange(schedule.map((slot, i) => i === index ? change(slot) : slot));
  const choices = [
    ...BLOCKS.filter(block => !block.hidden).map(block => ({ id: `${BLOCK_PREFIX}${block.id}`, name: block.name, hint: block.description, own: false })),
    ...shows.filter(show => show.enabled).map(show => ({ id: show.id, name: show.name, hint: 'Deine Sendung', own: true })),
  ];

  return <div className="day-plan">
    {schedule.map((slot, index) => <div key={slot.id} className="slot" aria-label={`Zeitfenster ${index + 1}`}>
      <div className="slot-head">
        <label className="time">Von <input aria-label="Von" value={slot.from} inputMode="numeric" pattern="\d\d:\d\d" maxLength={5} onChange={event => update(index, current => ({ ...current, from: event.target.value }))} /></label>
        <label className="time">bis <input aria-label="Bis" value={slot.to} inputMode="numeric" pattern="\d\d:\d\d" maxLength={5} onChange={event => update(index, current => ({ ...current, to: event.target.value }))} /></label>
        <button type="button" className="button ghost small danger" aria-label={`Zeitfenster ${index + 1} entfernen`} onClick={() => onChange(schedule.filter((_, i) => i !== index))}>×</button>
      </div>
      <div className="days" role="group" aria-label="Tage">
        {DAY_SETS.map(([label, days]) => <button type="button" key={label} aria-pressed={sameDays(slot.days, days)} onClick={() => update(index, current => ({ ...current, days: [...days].sort() }))}>{label}</button>)}
      </div>
      <div className="days" role="group" aria-label="Wochentage">{DAYS.map(([day, label]) => <button type="button" key={day} aria-pressed={slot.days.includes(day)}
        onClick={() => update(index, current => ({ ...current, days: current.days.includes(day) ? current.days.filter(value => value !== day) : [...current.days, day].sort() }))}>{label}</button>)}</div>
      <div className="chips slot-blocks" role="group" aria-label="Bausteine im Zeitfenster">
        {slot.showIds.map((id, position) => <span key={`${id}-${position}`} className="chip">
          {name(id)}
          <button type="button" aria-label={`${name(id)} entfernen`} disabled={slot.showIds.length === 1}
            onClick={() => update(index, current => ({ ...current, showIds: current.showIds.filter((_, i) => i !== position) }))}>×</button>
        </span>)}
        <button type="button" className="add-block" aria-expanded={picking === slot.id} onClick={() => setPicking(picking === slot.id ? null : slot.id)}>+ Baustein</button>
      </div>
      {picking === slot.id && <div className="block-list picker">{choices.map(choice => <button type="button" key={choice.id} className={`block ${choice.own ? 'own' : ''}`}
        aria-label={`${choice.name}${choice.own ? ' (deine Sendung)' : ''} hinzufügen`}
        onClick={() => { update(index, current => ({ ...current, showIds: [...current.showIds, choice.id].slice(0, 20) })); setPicking(null); }}>
        <strong>{choice.name}</strong><small>{choice.hint}</small>
      </button>)}</div>}
    </div>)}
    <div className="chips presets" role="group" aria-label="Zeitfenster hinzufügen">
      {PRESETS.map(preset => <button type="button" key={preset.name} disabled={schedule.length >= 50}
        onClick={() => onChange([...schedule, { id: slotId(schedule.map(slot => slot.id), preset.name), days: [1, 2, 3, 4, 5], from: preset.from, to: preset.to,
          showIds: preset.blocks.map(block => `${BLOCK_PREFIX}${block}`) }])}>+ {preset.name} <small>{preset.from}–{preset.to}</small></button>)}
    </div>
  </div>;
}
