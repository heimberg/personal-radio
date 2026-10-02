// Wochenrückblick: a personal look back on the week in the radio, written from what was heard (our own
// spoken scripts, never songs or playlist data), the questions to the radio and the stickers earned.
import type { Source } from '../src/domain/program.ts';
import { MUSIC_SHOW_ID } from '../src/domain/station.ts';
import { BLOCK_PREFIX } from '../src/domain/blocks.ts';
import { parseChoice, parseQuiz } from '../src/domain/play.ts';
import type { TimelineRow } from './station-store.ts';
import { withoutVoiceTags } from './providers.ts';

export const REVIEW_BLOCK = 'rueckblick';
export const REVIEW_SHOW = `${BLOCK_PREFIX}${REVIEW_BLOCK}`;
/** How far the review looks back, and how many items it uses at most (the newest). */
export const REVIEW_DAYS = 7;
const MAX_ITEMS = 15;
/** Below this, there is not enough for a review on Sunday. */
export const MIN_REVIEW_ITEMS = 3;

/** What else happened this week: questions to the radio (with the answer on air) and new stickers. */
export interface WeekExtras { questions: Array<{ text: string; answer: string | null }>; stickers: string[] }

interface Spoken { title?: unknown; text?: unknown; kind?: unknown; parts?: unknown }

/** A heard item the review may use: spoken, with a script; music, songs, hours and earlier reviews stay out. */
export function reviewable(row: TimelineRow): boolean {
  if (row.show_id === MUSIC_SHOW_ID || row.show_id === REVIEW_SHOW || !row.script_json) return false;
  try {
    const script = JSON.parse(row.script_json) as Spoken;
    return typeof script.title === 'string' && typeof script.text === 'string' && script.kind === undefined && !Array.isArray(script.parts);
  } catch { return false; }
}

/** The review's sources: one per heard item (`w1` …), and `woche` for questions and stickers. */
export function reviewSources(rows: TimelineRow[], extras: WeekExtras, now: Date): Source[] {
  const at = now.toISOString();
  const items = rows.filter(reviewable).slice(-MAX_ITEMS);
  const sources: Source[] = items.map((row, index) => {
    const script = JSON.parse(row.script_json!) as { title: string; text: string };
    const research = (() => { try { return JSON.parse(row.research_json ?? 'null') ?? {}; } catch { return {}; } })() as { choice?: unknown; quiz?: unknown; sharedBy?: unknown };
    const choice = parseChoice(research.choice), quiz = parseQuiz(research.quiz);
    const notes = [
      typeof research.sharedBy === 'string' ? `Geteilt von ${research.sharedBy}.` : '',
      choice?.picked !== undefined ? `Mitmach-Entscheidung: «${choice.options[choice.picked].label}»${choice.by === 'narrator' ? ' (die Erzählerin hat gewählt)' : ''}.` : '',
      quiz ? `Quizfrage: ${quiz.question} ${quiz.answered === undefined ? '(nicht beantwortet)' : quiz.answered === quiz.correct ? '(richtig beantwortet)' : '(falsch beantwortet)'}` : '',
    ].filter(Boolean).join(' ');
    const text = withoutVoiceTags(script.text).replace(/\s+/g, ' ').trim();
    return { id: `w${index + 1}`, url: '', title: script.title.slice(0, 160), publishedAt: row.updated_at, retrievedAt: at,
      excerpt: `${text.length > 900 ? `${text.slice(0, 900).replace(/\s+\S*$/, '')} …` : text}${notes ? `\n${notes}` : ''}` };
  });
  const lines = [
    ...extras.questions.map(question => `Frage ans Radio: «${question.text}»${question.answer ? ` – Antwort im Radio: ${question.answer.slice(0, 400)}` : ' (noch nicht beantwortet)'}`),
    ...(extras.stickers.length ? [`Neue Sticker im Album: ${extras.stickers.join(', ')}`] : []),
  ];
  if (lines.length) sources.push({ id: 'woche', url: '', title: 'Diese Woche', publishedAt: at, retrievedAt: at, excerpt: lines.join('\n').slice(0, 4000) });
  return sources;
}
