/** What a listener changes: questions about an item, «Anders», «Mehr dazu», arranging, removing, shuffling. */
import { MUSIC_SHOW_ID, SONG_MINUTES, stationSounds } from '../../src/domain/station.ts';
import type { Script, Source } from '../../src/domain/program.ts';
import { withoutVoiceTags } from '../providers.ts';
import { OUTLINE_SOURCE_ID } from '../../src/domain/series.ts';
import { reviewable } from '../review.ts';
import { ANSWER_PROMPT, parseAnswer } from '../follow.ts';
import { BLOCK_PREFIX, isSurprise } from '../../src/domain/blocks.ts';
import { agentOf, resolveAgents } from '../../src/domain/agents.ts';
import { audioKeysOf } from '../station-store.ts';
import type { TimelineRow } from '../station-store.ts';
import type { StationDeps } from './core.ts';
import { ANSWER_SHOW } from './plan.ts';
import { addSurprise, kidsRules } from './blocks.ts';

/** Thrown when a question about an item cannot be answered (not a spoken item, no model). */
export class AnswerError extends Error {
  readonly code: 'NOT_SPOKEN' | 'NOT_CONFIGURED';
  constructor(code: AnswerError['code']) { super(code); this.code = code; }
}

/**
 * «Nachfragen»: the listener's question about an item, answered from that item's script and sources
 * (with fresh research when they do not suffice), voiced and put right after it. Songs and hours are
 * not asked about, so no playlist data reaches the AI.
 */
export async function answerAbout(deps: StationDeps, owner: string, itemId: string, question: string): Promise<{ itemId: string; text: string } | null> {
  const row = await deps.store.getItem(owner, itemId), config = await deps.store.getConfig(owner);
  if (!row || !config) return null;
  if (!reviewable(row)) throw new AnswerError('NOT_SPOKEN');
  if (!deps.agentModel) throw new AnswerError('NOT_CONFIGURED');
  await deps.reserveGeneration(owner);
  const now = deps.now(), script = JSON.parse(row.script_json!) as Script;
  let sources: Source[] = (() => { try { return (JSON.parse(row.sources_json ?? '[]') as Source[]).filter(source => source.id !== OUTLINE_SOURCE_ID); } catch { return []; } })();
  const system = [ANSWER_PROMPT, kidsRules(config)].filter(Boolean).join(' ');
  const ask = async () => parseAnswer(await deps.agentModel!.askJson(system, {
    frage: question, beitrag: { titel: script.title, text: withoutVoiceTags(script.text).slice(0, 6000) },
    quellen: sources.slice(0, 8).map(source => ({ id: source.id, titel: source.title, text: source.excerpt.slice(0, 2500) })),
  }, 'Gemini answer', 0.3));
  let answer = await ask();
  // Not in the item: one grounded search for the question, then answer again.
  if (!answer.answerable && deps.researcher) {
    const found = await deps.researcher.research({ brief: `${question} (im Zusammenhang mit «${script.title}»)`, interests: [], avoidTopics: [], now, agent: agentOf(resolveAgents(config.agents), 'research') });
    if (found.sources.length) { sources = found.sources; answer = await ask(); }
  }
  const text = answer.answerable ? answer.text : `Zu deiner Frage «${question}» habe ich leider nichts Verlässliches gefunden – weder im Beitrag noch bei einer kurzen Suche.`;
  const reply: Script = { title: `Nachgefragt: ${question.slice(0, 80)}`, text, sourceIds: answer.sourceIds.filter(id => sources.some(source => source.id === id)) };
  const voiced = await deps.pipeline.voice(owner, reply, 'brief', config.host.voiceId, config.host.voiceStyle, { bed: stationSounds(config).musicBed, compress: deps.compressSpeech });
  const last = await deps.store.lastItem(owner), id = (deps.newId ?? (() => crypto.randomUUID()))();
  const key = `segments/${id}.${voiced.contentType === 'audio/wav' ? 'wav' : 'mp3'}`;
  await deps.audio.put(key, voiced.audio, { httpMetadata: { contentType: voiced.contentType } });
  await deps.store.insertItem(owner, { id, seq: (last?.seq ?? 0) + 1, showId: ANSWER_SHOW, plannedAt: now.toISOString(), estimatedMinutes: 1 }, now);
  await deps.store.update(owner, id, { state: 'ready', script_json: JSON.stringify(reply), sources_json: JSON.stringify(sources.filter(source => reply.sourceIds.includes(source.id))),
    verification: 'light', audio_key: key, content_type: voiced.contentType, research_json: JSON.stringify({ question, about: row.id }) }, now);
  const open = (await deps.store.openItems(owner)).map(item => item.id);
  await placeAfter(deps, owner, id, open.includes(row.id) ? row.id : undefined);
  return { itemId: id, text };
}

/**
 * «Anders»: an open item gives way to something different at the same place – a surprise for another
 * surprise of a different kind, any other item for a surprise.
 */
export async function swapItem(deps: StationDeps, owner: string, itemId: string): Promise<string | null> {
  const config = await deps.store.getConfig(owner);
  const open = await deps.store.openItems(owner);
  const index = open.findIndex(item => item.id === itemId);
  if (!config || index < 0) return null;
  if (!await removeItem(deps, owner, itemId)) return null;
  return addSurprise(deps, owner, config, index > 0 ? open[index - 1].id : undefined, isSurprise(open[index].show_id) ? open[index].show_id : undefined);
}

/**
 * «Mehr dazu»: a deeper follow-up to a produced spoken item, right after it. It starts from the item's
 * sources, researches more on the web and is checked like every item; it knows what was already said.
 */
export async function addFollowUp(deps: StationDeps, owner: string, parentId: string): Promise<string | null> {
  const parent = await deps.store.getItem(owner, parentId);
  if (!parent?.script_json || !['voicing', 'ready', 'played', 'skipped', 'archived'].includes(parent.state)) return null;
  let script: Partial<Script> & { parts?: unknown };
  try { script = JSON.parse(parent.script_json); } catch { return null; }
  if (script.parts || typeof script.text !== 'string' || !script.title) return null;
  const now = deps.now(), last = await deps.store.lastItem(owner);
  const id = (deps.newId ?? (() => crypto.randomUUID()))();
  await deps.store.insertItem(owner, { id, seq: (last?.seq ?? 0) + 1, showId: `${BLOCK_PREFIX}vertiefung`, plannedAt: now.toISOString(), estimatedMinutes: 3 }, now);
  await deps.store.update(owner, id, { research_json: JSON.stringify({ followUp: parent.id }) }, now);
  const open = (await deps.store.openItems(owner)).map(item => item.id);
  await placeAfter(deps, owner, id, open.includes(parent.id) ? parent.id : undefined);
  return id;
}

export function followUpOf(row: TimelineRow): string | undefined {
  try {
    const value = (JSON.parse(row.research_json ?? '{}') as { followUp?: unknown }).followUp;
    return typeof value === 'string' ? value : undefined;
  } catch { return undefined; }
}

/** Moves a new item right after [after] (the item that is playing), or to the start of the program. */
/** Where a new block goes: after [after], at the start without it, or with [AT_END] behind everything open. */
export const AT_END = 'end';
export async function placeAfter(deps: StationDeps, owner: string, id: string, after?: string) {
  const others = (await deps.store.openItems(owner)).map(item => item.id).filter(item => item !== id);
  const at = after === AT_END ? others.length : after ? others.indexOf(after) + 1 : 0;
  await arrangeTimeline(deps, owner, [...others.slice(0, at), id, ...others.slice(at)]);
}

/** Puts the open items into the owner's order; unknown or missing IDs leave the program as it is. */
export async function arrangeTimeline(deps: StationDeps, owner: string, order: string[]): Promise<boolean> {
  const open = await deps.store.openItems(owner);
  if (order.length !== open.length || new Set(order).size !== order.length || !order.every(id => open.some(item => item.id === id))) return false;
  const start = open.reduce((earliest, item) => Math.min(earliest, Date.parse(item.planned_at)), Date.parse(open[0]?.planned_at ?? deps.now().toISOString()));
  await deps.store.arrange(owner, order.map(id => open.find(item => item.id === id)!), new Date(start), deps.now());
  return true;
}

/** Takes an item out of the program and releases its audio. */
export async function removeItem(deps: StationDeps, owner: string, id: string): Promise<boolean> {
  const row = await deps.store.getItem(owner, id);
  if (!row || !['planned', 'voicing', 'ready'].includes(row.state)) return false;
  await deps.store.update(owner, id, { state: 'expired', lease_until: null, error: null }, deps.now());
  for (const key of audioKeysOf(row)) await deps.audio.delete(key);
  await deps.store.update(owner, id, { audio_key: null }, deps.now());
  return true;
}

/** Deletes a production from the archive; one still in the program leaves it instead. */
export async function deleteItem(deps: StationDeps, owner: string, id: string): Promise<boolean> {
  if (await removeItem(deps, owner, id)) return true;
  const keys = await deps.store.deleteHeard(owner, id);
  if (!keys) return false;
  for (const key of keys) await deps.audio.delete(key);
  return true;
}

/**
 * Shuffles the open items and spreads the songs so that at least `max(1, music.between)` songs sit
 * between two spoken items; missing songs are added. Returns the IDs of new items to produce.
 */
export async function shuffleTimeline(deps: StationDeps, owner: string): Promise<string[] | null> {
  const config = await deps.store.getConfig(owner);
  if (!config) return null;
  const random = deps.random ?? Math.random;
  const shuffle = <T>(list: T[]) => { for (let i = list.length - 1; i > 0; i--) { const j = Math.floor(random() * (i + 1)); [list[i], list[j]] = [list[j], list[i]]; } return list; };
  const open = await deps.store.openItems(owner);
  const spoken = shuffle(open.filter(item => item.show_id !== MUSIC_SHOW_ID));
  const songs = shuffle(open.filter(item => item.show_id === MUSIC_SHOW_ID));
  const perGap = Math.max(1, config.music.between);
  const added: string[] = [];
  const now = deps.now(), newId = deps.newId ?? (() => crypto.randomUUID());
  const last = await deps.store.lastItem(owner);
  let seq = (last?.seq ?? 0) + 1;
  while (songs.length < Math.max(0, spoken.length - 1) * perGap) {
    const id = newId();
    await deps.store.insertItem(owner, { id, seq: seq++, showId: MUSIC_SHOW_ID, plannedAt: now.toISOString(), estimatedMinutes: SONG_MINUTES }, now);
    songs.push({ id, estimated_minutes: SONG_MINUTES } as TimelineRow); added.push(id);
  }
  // Every gap between two spoken items gets its share; the rest lands in random gaps, start and end included.
  const gaps: Array<typeof songs> = Array.from({ length: spoken.length + 1 }, (_, index) => index > 0 && index < spoken.length ? songs.splice(0, perGap) : []);
  for (const song of songs) gaps[Math.floor(random() * gaps.length)].push(song);
  const ordered = gaps.flatMap((gap, index) => index < spoken.length ? [...gap, spoken[index]] : gap);
  const start = open.reduce((earliest, item) => Math.min(earliest, Date.parse(item.planned_at)), now.getTime());
  await deps.store.arrange(owner, ordered, new Date(start), now);
  return added;
}
