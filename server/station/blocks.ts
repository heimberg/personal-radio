/** Building blocks and own shows added from the app, surprises, and place stories. */
import { MUSIC_SHOW_ID, SONG_MINUTES, isMusicHour } from '../../src/domain/station.ts';
import type { StationConfig } from '../../src/domain/station.ts';
import { KIDS_RULES } from '../listeners.ts';
import { SERIES_EPISODES, seriesBlock } from '../../src/domain/series.ts';
import { featureOn } from '../../src/domain/features.ts';
import { BLOCKS, BLOCK_PREFIX, SURPRISE_ID, drawSurprise } from '../../src/domain/blocks.ts';
import type { TimelineRow } from '../station-store.ts';
import { minutes } from './core.ts';
import type { StationDeps } from './core.ts';
import { startSeries, placeSoon } from './series.ts';
import { placeAfter } from './listener.ts';

/** Plans one item of a show (or a song) right away, outside the program clock ("Jetzt produzieren"). */
export async function scheduleShowNow(deps: StationDeps, owner: string, showId: string, subjectOverride?: string): Promise<string | null> {
  const config = await deps.store.getConfig(owner);
  const show = showId === MUSIC_SHOW_ID ? { id: MUSIC_SHOW_ID, targetMinutes: SONG_MINUTES } : config?.shows.find(item => item.id === showId);
  if (!config || !show || (subjectOverride && !('format' in show && isMusicHour(show.format)))) return null;
  const now = deps.now();
  const ahead = (await deps.store.openItems(owner)).reduce((sum, item) => sum + item.estimated_minutes, 0);
  const last = await deps.store.lastItem(owner);
  const id = (deps.newId ?? (() => crypto.randomUUID()))();
  await deps.store.insertItem(owner, { id, seq: (last?.seq ?? 0) + 1, showId: show.id, plannedAt: minutes(now, ahead).toISOString(), estimatedMinutes: show.targetMinutes }, now);
  if (subjectOverride?.trim()) await deps.store.update(owner, id, { research_json: JSON.stringify({ subjectOverride: subjectOverride.trim().slice(0, 200) }) }, now);
  return id;
}

export const SHOW_BLOCK = 'show:';

/**
 * Adds a building block to the program, right after [after] (the item that is playing) or at the start,
 * and returns its ID for production. [subject] is the one optional word the block asks for.
 */
export async function addBlock(deps: StationDeps, owner: string, blockId: string, subject?: string, after?: string): Promise<string | null> {
  const config = await deps.store.getConfig(owner);
  if (!config) return null;
  if (blockId === SURPRISE_ID) return addSurprise(deps, owner, config, after);
  const series = seriesBlock(blockId);
  if (series) return (await startSeries(deps, owner, config, series.kind, subject ?? '', SERIES_EPISODES, series.interactive)).itemId;
  if (blockId === 'song') {
    const song = await scheduleShowNow(deps, owner, MUSIC_SHOW_ID);
    if (song) await placeAfter(deps, owner, song, after);
    return song;
  }
  // The owner's own shows are blocks too ("show:<id>"); music hours among them take a subject.
  const own = blockId.startsWith(SHOW_BLOCK) ? config.shows.find(show => show.id === blockId.slice(SHOW_BLOCK.length)) : undefined;
  const block = own ? undefined : BLOCKS.find(item => item.id === blockId && !item.hidden);
  if (!own && !block) return null;
  const now = deps.now();
  const last = await deps.store.lastItem(owner);
  const id = (deps.newId ?? (() => crypto.randomUUID()))();
  await deps.store.insertItem(owner, { id, seq: (last?.seq ?? 0) + 1, showId: own ? own.id : `${BLOCK_PREFIX}${block!.id}`, plannedAt: now.toISOString(),
    estimatedMinutes: own ? own.targetMinutes : block!.show.targetMinutes }, now);
  const takesWord = own ? isMusicHour(own.format) : !!block!.input;
  const word = takesWord ? subject?.trim().slice(0, 200) : undefined;
  if (word) await deps.store.update(owner, id, { research_json: JSON.stringify({ subjectOverride: word }) }, now);
  await placeAfter(deps, owner, id, after);
  return id;
}

/** 🎲 Draws a surprise and puts it after [after] (or at the start); never the kind in [avoid]. */
export async function addSurprise(deps: StationDeps, owner: string, config: StationConfig, after?: string, avoid?: string): Promise<string> {
  const random = deps.random ?? Math.random;
  const block = drawSurprise(config, random, avoid);
  const now = deps.now(), last = await deps.store.lastItem(owner);
  const id = (deps.newId ?? (() => crypto.randomUUID()))();
  await deps.store.insertItem(owner, { id, seq: (last?.seq ?? 0) + 1, showId: `${BLOCK_PREFIX}${block.id}`, plannedAt: now.toISOString(), estimatedMinutes: block.show.targetMinutes }, now);
  await placeAfter(deps, owner, id, after);
  return id;
}

/** A child's station carries its rules in the host's instructions; series take them over. */
export const kidsRules = (config: StationConfig) => config.host.instructions.includes(KIDS_RULES) ? KIDS_RULES : '';

export const PLACE_SHOW = `${BLOCK_PREFIX}ortsgeschichte`;
/** At most this many place stories a day; the same place is told once a month. */
export const PLACES_PER_DAY = 6, PLACE_REPEAT_DAYS = 30;

/**
 * Ortsgeschichten: the listener passes [place] (named by the Worker from the app's location). Its story is
 * put into the program soon – unless it was told this month or the day's stories are used up.
 */
export async function addPlaceStory(deps: StationDeps, owner: string, place: string): Promise<{ itemId: string } | { skipped: 'known' | 'enough' | 'waiting' | 'off' }> {
  const config = await deps.store.getConfig(owner);
  if (!config || !featureOn(config, 'places')) return { skipped: 'off' };
  const now = deps.now();
  const month = await deps.store.ofShowSince(owner, PLACE_SHOW, new Date(now.getTime() - PLACE_REPEAT_DAYS * 86_400_000));
  const placeOf = (row: TimelineRow) => { try { return (JSON.parse(row.research_json ?? '{}') as { place?: string }).place; } catch { return undefined; } };
  if (month.some(row => placeOf(row) === place)) return { skipped: 'known' };
  if (month.filter(row => now.getTime() - Date.parse(row.created_at) < 86_400_000).length >= PLACES_PER_DAY) return { skipped: 'enough' };
  // One story waits at a time: on a drive the places would otherwise pile up back to back. The next one is
  // about wherever the listener is once this one has run.
  if (month.some(row => ['planned', 'voicing', 'ready'].includes(row.state))) return { skipped: 'waiting' };
  const last = await deps.store.lastItem(owner), id = (deps.newId ?? (() => crypto.randomUUID()))();
  await deps.store.insertItem(owner, { id, seq: (last?.seq ?? 0) + 1, showId: PLACE_SHOW, plannedAt: now.toISOString(), estimatedMinutes: 2 }, now);
  await deps.store.update(owner, id, { research_json: JSON.stringify({ subjectOverride: place, place }) }, now);
  await placeSoon(deps, owner, id);
  return { itemId: id };
}
