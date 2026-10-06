// Why the owner rated spoken items down. Repeated reasons become notes for the writer, the final editor
// and the jury, so the station learns from listening without anyone writing prompts.

export type FeedbackReason = 'too_long' | 'boring' | 'tone' | 'known' | 'wrong'
  | 'not_my_style' | 'heard_too_often' | 'too_wild' | 'too_calm' | 'wrong_moment';

/** Spoken reasons steer writer, editor and jury; music reasons steer the music desk. */
export const FEEDBACK_REASONS: Record<FeedbackReason, { label: string; note: string; music?: true }> = {
  too_long: { label: 'Zu lang', note: 'Beiträge waren dem Hörer zuletzt oft zu lang: straffen, keine Füllsätze, schneller zum Punkt.' },
  boring: { label: 'Langweilig', note: 'Beiträge waren dem Hörer zuletzt oft zu langweilig: stärkerer Aufhänger, überraschende konkrete Details, mehr Tempo.' },
  tone: { label: 'Falscher Ton', note: 'Der Ton passte dem Hörer zuletzt oft nicht: natürlicher und weniger aufgesetzt, näher an der Persona.' },
  known: { label: 'Kenn ich schon', note: 'Der Hörer kannte die Inhalte zuletzt oft schon: Allgemeinwissen weglassen, neue Aspekte und Hintergründe in den Vordergrund.' },
  wrong: { label: 'Fehlerhaft', note: 'Der Hörer fand zuletzt Fehler: nur klar Belegtes sagen, Unsicheres vorsichtig formulieren oder weglassen.' },
  not_my_style: { label: 'Nicht mein Stil', music: true, note: 'Mehrere Songs trafen zuletzt nicht seinen Stil: näher am angegebenen Geschmack und an «mag» bleiben, weniger Ausflüge.' },
  heard_too_often: { label: 'Zu oft gehört', music: true, note: 'Er hat zuletzt mehrfach Songs als zu oft gehört bemängelt: weniger Bekanntes und Hits, mehr Entdeckungen.' },
  too_wild: { label: 'Zu wild', music: true, note: 'Songs waren ihm zuletzt oft zu wild: ruhigere, zugänglichere Stücke wählen.' },
  too_calm: { label: 'Zu ruhig', music: true, note: 'Songs waren ihm zuletzt oft zu ruhig: mehr Energie und Tempo wählen.' },
  wrong_moment: { label: 'Passt gerade nicht', music: true, note: 'Songs passten zuletzt oft nicht zum Moment: stärker auf Tageszeit und Stimmung achten.' },
};
export const isMusicReason = (reason: FeedbackReason) => !!FEEDBACK_REASONS[reason].music;
export const REASON_IDS = Object.keys(FEEDBACK_REASONS) as FeedbackReason[];
export const isFeedbackReason = (value: unknown): value is FeedbackReason => typeof value === 'string' && value in FEEDBACK_REASONS;

/** A reason counts once it came up at least twice in the window: one bad day is not a pattern. */
export const NOTE_MIN_COUNT = 2;
export const NOTE_WINDOW_DAYS = 30;

export interface ReasonCount { reason: FeedbackReason; count: number }

/** The notes for the prompts, most frequent first: about spoken items, or with [kind] `music` about songs. */
export function listenerNotes(counts: ReasonCount[], kind: 'speech' | 'music' = 'speech'): string[] {
  return counts.filter(item => item.count >= NOTE_MIN_COUNT && isMusicReason(item.reason) === (kind === 'music'))
    .sort((a, b) => b.count - a.count).map(item => FEEDBACK_REASONS[item.reason].note);
}
