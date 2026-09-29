// Why the owner rated spoken items down. Repeated reasons become notes for the writer, the final editor
// and the jury, so the station learns from listening without anyone writing prompts.

export type FeedbackReason = 'too_long' | 'boring' | 'tone' | 'known' | 'wrong';

export const FEEDBACK_REASONS: Record<FeedbackReason, { label: string; note: string }> = {
  too_long: { label: 'Zu lang', note: 'Beiträge waren dem Hörer zuletzt oft zu lang: straffen, keine Füllsätze, schneller zum Punkt.' },
  boring: { label: 'Langweilig', note: 'Beiträge waren dem Hörer zuletzt oft zu langweilig: stärkerer Aufhänger, überraschende konkrete Details, mehr Tempo.' },
  tone: { label: 'Falscher Ton', note: 'Der Ton passte dem Hörer zuletzt oft nicht: natürlicher und weniger aufgesetzt, näher an der Persona.' },
  known: { label: 'Kenn ich schon', note: 'Der Hörer kannte die Inhalte zuletzt oft schon: Allgemeinwissen weglassen, neue Aspekte und Hintergründe in den Vordergrund.' },
  wrong: { label: 'Fehlerhaft', note: 'Der Hörer fand zuletzt Fehler: nur klar Belegtes sagen, Unsicheres vorsichtig formulieren oder weglassen.' },
};
export const REASON_IDS = Object.keys(FEEDBACK_REASONS) as FeedbackReason[];
export const isFeedbackReason = (value: unknown): value is FeedbackReason => typeof value === 'string' && value in FEEDBACK_REASONS;

/** A reason counts once it came up at least twice in the window: one bad day is not a pattern. */
export const NOTE_MIN_COUNT = 2;
export const NOTE_WINDOW_DAYS = 30;

export interface ReasonCount { reason: FeedbackReason; count: number }

/** The notes for the prompts, most frequent first. */
export function listenerNotes(counts: ReasonCount[]): string[] {
  return counts.filter(item => item.count >= NOTE_MIN_COUNT).sort((a, b) => b.count - a.count).map(item => FEEDBACK_REASONS[item.reason].note);
}
