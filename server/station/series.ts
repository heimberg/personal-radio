/** Series and Mitmach-Geschichten: episodes, choices, quizzes and stopping a series. */
import type { StationConfig } from '../../src/domain/station.ts';
import type { Script } from '../../src/domain/program.ts';
import { ProviderError, withoutVoiceTags } from '../providers.ts';
import { KIDS_RULES } from '../listeners.ts';
import { MAX_EPISODES, MIN_EPISODES, SERIES_EPISODES, SERIES_PREFIX, episodeRefOf, outlinePrompt, parseOutline, recapOf } from '../../src/domain/series.ts';
import type { EpisodeRef, Series, SeriesKind } from '../../src/domain/series.ts';
import { CHOICE_PROMPT, CHOICE_WAIT_HOURS, QUIZ_PROMPT, parseChoice, parseQuiz, quizSpeech } from '../../src/domain/play.ts';
import type { Quiz, StoryChoice } from '../../src/domain/play.ts';
import type { TimelineRow } from '../station-store.ts';
import type { StationDeps } from './core.ts';
import { kidsRules } from './blocks.ts';
import { AT_END, placeAfter, removeItem } from './listener.ts';

/** Thrown when a series cannot be planned (no model configured, or no usable outline). */
export class SeriesError extends Error {
  readonly code: 'NOT_CONFIGURED' | 'NO_OUTLINE';
  constructor(code: SeriesError['code']) { super(code); this.code = code; }
}

/**
 * Starts a series: plans its episodes (one model call, counted like a production) and puts the first
 * episode into the program. Without a subject the planner picks one from the listener's interests.
 */
export async function startSeries(deps: StationDeps, owner: string, config: StationConfig, kind: SeriesKind, subject: string,
  episodes = SERIES_EPISODES, interactive = false): Promise<{ seriesId: string; itemId: string }> {
  if (!deps.agentModel) throw new SeriesError('NOT_CONFIGURED');
  const count = Math.min(MAX_EPISODES, Math.max(MIN_EPISODES, Math.round(episodes)));
  await deps.reserveGeneration(owner);
  const topic = subject.trim().slice(0, 200);
  let outline: { title: string; episodes: Series['episodes'] };
  try {
    outline = parseOutline(await deps.agentModel.askJson(outlinePrompt(kind, count, kidsRules(config), interactive && kind === 'geschichte'),
      { thema: topic || 'Wähle selbst ein Thema, das zu den Interessen passt.', interessen: [...config.profile.topics, ...config.profile.interests].slice(0, 30) },
      'Gemini series outline', kind === 'geschichte' ? 0.9 : 0.6), count);
  } catch (error) {
    if (error instanceof ProviderError) throw error;
    throw new SeriesError('NO_OUTLINE');
  }
  const now = deps.now();
  const series: Series = { id: (deps.newId ?? (() => crypto.randomUUID()))(), title: outline.title, subject: topic || outline.title, kind,
    episodes: outline.episodes, recaps: [], scheduled: 0, state: 'active', createdAt: now.toISOString(),
    ...(interactive && kind === 'geschichte' ? { interactive: true, choices: [] } : {}) };
  await deps.store.insertSeries(owner, series, now);
  const itemId = await scheduleEpisode(deps, owner, series, 0, AT_END);
  return { seriesId: series.id, itemId };
}

/** Puts episode [index] into the program: after [after], or soon (behind the next item) without it. */
export async function scheduleEpisode(deps: StationDeps, owner: string, series: Series, index: number, after?: string): Promise<string> {
  const now = deps.now(), last = await deps.store.lastItem(owner);
  const id = (deps.newId ?? (() => crypto.randomUUID()))();
  await deps.store.insertItem(owner, { id, seq: (last?.seq ?? 0) + 1, showId: `${SERIES_PREFIX}${series.id}`, plannedAt: now.toISOString(), estimatedMinutes: 6 }, now);
  const ref: EpisodeRef = { series: series.id, episode: index, total: series.episodes.length, seriesTitle: series.title, kind: series.kind };
  await deps.store.update(owner, id, { research_json: JSON.stringify(ref) }, now);
  await deps.store.updateSeries(owner, series.id, { scheduled: Math.max(series.scheduled, index + 1) }, now);
  if (after) await placeAfter(deps, owner, id, after); else await placeSoon(deps, owner, id);
  return id;
}

/** Soon, but with time to produce: behind the item that plays next (or first, when nothing is open). */
export async function placeSoon(deps: Pick<StationDeps, 'store' | 'now'>, owner: string, id: string) {
  const open = (await deps.store.openItems(owner)).filter(item => item.id !== id);
  await placeAfter(deps as StationDeps, owner, id, open[Math.min(1, open.length - 1)]?.id);
}

/** What an episode said, kept for the «previously on» of the next ones. */
export async function rememberEpisode(deps: StationDeps, owner: string, episode: EpisodeRef, script: Script) {
  const series = await deps.store.getSeries(owner, episode.series);
  if (!series) return;
  const recaps = [...series.recaps];
  while (recaps.length < episode.episode) recaps.push('');
  recaps[episode.episode] = recapOf(script.title, script.text);
  await deps.store.updateSeries(owner, series.id, { recaps }, deps.now());
}

/**
 * The next episode joins the program once the one before has left it heard (played, skipped or archived).
 * An episode that left unheard (removed, expired) comes again; a failed one waits for its retry.
 */
export async function advanceSeries(deps: StationDeps, owner: string) {
  for (const series of (await deps.store.listSeries(owner)).filter(item => item.state === 'active')) {
    const latest = await deps.store.latestOfShow(owner, `${SERIES_PREFIX}${series.id}`);
    if (latest && ['planned', 'voicing', 'ready', 'failed'].includes(latest.state)) continue;
    const ref = latest ? episodeRefOf(latest.research_json) : null;
    // A Mitmach-Geschichte waits for the listener's choice; after a while the narrator decides.
    const choice = latest && ref && latest.state !== 'expired' ? series.choices?.[ref.episode] : null;
    if (choice && choice.picked === undefined) {
      if (deps.now().getTime() - Date.parse(latest!.updated_at) < CHOICE_WAIT_HOURS * 3_600_000) continue;
      await recordChoice(deps, owner, series, ref!.episode, (deps.random ?? Math.random)() < 0.5 ? 0 : 1, 'narrator', latest!);
    }
    const index = !latest || !ref ? series.scheduled : latest.state === 'expired' ? ref.episode : ref.episode + 1;
    if (index >= series.episodes.length) { await deps.store.updateSeries(owner, series.id, { state: 'done' }, deps.now()); continue; }
    await scheduleEpisode(deps, owner, series, index);
  }
}

/** Ends a series: no further episodes, and the open one leaves the program. */
export async function stopSeries(deps: StationDeps, owner: string, id: string): Promise<boolean> {
  const series = await deps.store.getSeries(owner, id);
  if (!series) return false;
  await deps.store.updateSeries(owner, id, { state: 'stopped' }, deps.now());
  for (const item of await deps.store.openItems(owner)) if (item.show_id === `${SERIES_PREFIX}${id}`) await removeItem(deps, owner, item.id);
  return true;
}

/** The series for the app: running ones first, with their episode titles and how far they are. */
export interface SeriesView { id: string; title: string; subject: string; kind: SeriesKind; state: Series['state']; episodes: string[]; scheduled: number; interactive?: boolean }
export const seriesView = (series: Series): SeriesView => ({ id: series.id, title: series.title, subject: series.subject, kind: series.kind,
  state: series.state, episodes: series.episodes.map(episode => episode.title), scheduled: series.scheduled, ...(series.interactive ? { interactive: true } : {}) });

/** Plans the choice at the end of episode [index]: from the outline and what was told so far (our own story, no listener data). */
export async function planChoice(deps: StationDeps, series: Series, index: number, config: StationConfig): Promise<StoryChoice | null> {
  if (!deps.agentModel) return null;
  try {
    return parseChoice(await deps.agentModel.askJson([CHOICE_PROMPT, kidsRules(config)].filter(Boolean).join(' '), {
      geschichte: series.title, worum: series.subject,
      plan: series.episodes.map((episode, at) => `Folge ${at + 1}: ${episode.title} – ${episode.idea}`),
      bisher: series.recaps.slice(0, index).filter(Boolean),
      dieseFolge: series.episodes[index], naechsteFolge: series.episodes[index + 1],
    }, 'Gemini story choice', 0.9));
  } catch (error) {
    // A spent quota waits like any production; anything else just tells the episode without a choice.
    if (error instanceof ProviderError && error.status === 429) throw error;
    return null;
  }
}

/** Stores what was chosen at the end of episode [index], on the series (for the next episode) and on the item (for the app). */
export async function recordChoice(deps: StationDeps, owner: string, series: Series, index: number, picked: 0 | 1, by: StoryChoice['by'], item: TimelineRow) {
  const choices = [...(series.choices ?? [])];
  const choice = choices[index];
  if (!choice) return null;
  choices[index] = { ...choice, picked, by };
  series.choices = choices;
  await deps.store.updateSeries(owner, series.id, { choices }, deps.now());
  const research = (() => { try { return JSON.parse(item.research_json ?? 'null') ?? {}; } catch { return {}; } })() as Record<string, unknown>;
  await deps.store.update(owner, item.id, { research_json: JSON.stringify({ ...research, choice: choices[index] }) }, deps.now());
  return choices[index];
}

/**
 * The listener chose how a Mitmach-Geschichte goes on, after (or while) hearing the episode [itemId].
 * Returns the stored choice and whether it is new (a sticker), or null when the item offers no choice.
 */
export async function chooseStory(deps: StationDeps, owner: string, itemId: string, option: number): Promise<{ choice: StoryChoice; fresh: boolean } | null> {
  const row = await deps.store.getItem(owner, itemId);
  const ref = row ? episodeRefOf(row.research_json) : null;
  const series = ref ? await deps.store.getSeries(owner, ref.series) : null;
  const choice = series?.choices?.[ref!.episode];
  if (!row || !series || !choice || (option !== 0 && option !== 1)) return null;
  if (choice.picked !== undefined) return { choice, fresh: false };
  const stored = await recordChoice(deps, owner, series, ref!.episode, option, 'listener', row);
  return stored ? { choice: stored, fresh: true } : null;
}

/** A quiz question about a finished script (our own text). Nothing when the model is missing or answers badly. */
export async function writeQuiz(deps: StationDeps, script: Script): Promise<Quiz | null> {
  if (!deps.agentModel) return null;
  try { return parseQuiz(await deps.agentModel.askJson(`${QUIZ_PROMPT} ${KIDS_RULES}`, { titel: script.title, text: withoutVoiceTags(script.text).slice(0, 6000) }, 'Gemini quiz', 0.5)); }
  catch (error) {
    if (error instanceof ProviderError && error.status === 429) throw error;
    return null;
  }
}

/** The script with the quiz question spoken at its end: by the host, in a dialog by the first voice. */
export function withQuiz(script: Script, quiz: Quiz): Script {
  const speech = quizSpeech(quiz);
  return { ...script, text: `${script.text.trim()} ${speech}`, ...(script.turns ? { turns: [...script.turns, { speaker: 'host-a' as const, text: speech }] } : {}) };
}

/** The listener answered an item's quiz: once only. Returns the quiz and whether the answer was right and new (a sticker). */
export async function answerQuiz(deps: StationDeps, owner: string, itemId: string, answer: number): Promise<{ quiz: Quiz; right: boolean; fresh: boolean } | null> {
  const row = await deps.store.getItem(owner, itemId);
  const research = (() => { try { return JSON.parse(row?.research_json ?? 'null') ?? {}; } catch { return {}; } })() as Record<string, unknown>;
  const quiz = parseQuiz(research.quiz);
  if (!row || !quiz || ![0, 1, 2].includes(answer)) return null;
  if (quiz.answered !== undefined) return { quiz, right: quiz.answered === quiz.correct, fresh: false };
  const answered = { ...quiz, answered: answer };
  await deps.store.update(owner, row.id, { research_json: JSON.stringify({ ...research, quiz: answered }) }, deps.now());
  return { quiz: answered, right: answer === quiz.correct, fresh: true };
}
