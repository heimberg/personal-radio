/** Planning: the timeline from the day plan, series episodes, the weekly review, follow-up checks and concerts. */
import { MUSIC_SHOW_ID, SONG_MINUTES, activeSlot, bringsOwnMusic, localClock } from '../../src/domain/station.ts';
import type { ShowConfig, StationConfig } from '../../src/domain/station.ts';
import { MIN_REVIEW_ITEMS, REVIEW_DAYS, REVIEW_SHOW, reviewable } from '../review.ts';
import { featureOn } from '../../src/domain/features.ts';
import { BLOCK_PREFIX, blockOf, blockShow, drawSurprise, isSurprise, surpriseChance } from '../../src/domain/blocks.ts';
import { applyMood } from '../../src/domain/mood.ts';
import { audioKeysOf } from '../station-store.ts';
import type { TimelineRow } from '../station-store.ts';
import { MAX_NEW_ITEMS, STALE_HOURS, TIMELY_HOURS, ACTIVE_LISTENER_HOURS, AUDIO_RETENTION_DAYS, PURGE_AFTER_HOURS, minutes } from './core.ts';
import type { StationDeps, PlannedItem } from './core.ts';
import { timeBound } from './music.ts';
import { placeSoon, advanceSeries } from './series.ts';

/** A show of the day plan: an enabled show of the owner, or a building block. */
export function scheduledShow(config: StationConfig, id: string): ShowConfig | undefined {
  const own = config.shows.find(show => show.id === id);
  if (own) return own.enabled ? own : undefined;
  const block = blockOf(id);
  return block ? blockShow(block, config) : undefined;
}

/** Spoken items need songs after them; music hours bring their own music. */
export function needsSongsAfter(config: StationConfig, showId: string | undefined): boolean {
  const show = config.shows.find(item => item.id === showId) ?? (showId ? blockOf(showId)?.show : undefined);
  return !!show && !bringsOwnMusic(show.format);
}

/**
 * Fills the program up to the configured horizon. Plans only while a schedule slot is active, so
 * nothing is produced hours ahead for a slot that starts later; the next cron tick picks it up.
 * With music on, every spoken item is followed by `music.between` songs. [tail] lists the show IDs of
 * the most recent items, newest last, so the rule also holds across planning runs.
 */
export function planTimeline(config: StationConfig, open: Array<Pick<TimelineRow, 'estimated_minutes'>>, last: Pick<TimelineRow, 'seq' | 'show_id'> | null,
  now: Date, newId: () => string, tail: string[] = last ? [last.show_id] : [], random: () => number = () => 1): PlannedItem[] {
  // Today's mood leans the plan (more music, more knowledge, …) without changing the saved day plan.
  config = applyMood(config, now);
  let ahead = open.reduce((sum, item) => sum + item.estimated_minutes, 0);
  let seq = (last?.seq ?? 0) + 1;
  let lastShow = [...tail].reverse().find(id => id !== MUSIC_SHOW_ID && !isSurprise(id));
  // Songs still owed after the most recent spoken item.
  const trailingSongs = tail.length - 1 - tail.map(id => id !== MUSIC_SHOW_ID).lastIndexOf(true);
  let songsOwed = needsSongsAfter(config, [...tail].reverse().find(id => id !== MUSIC_SHOW_ID)) ? Math.max(0, config.music.between - trailingSongs) : 0;
  const planned: PlannedItem[] = [];
  let lastSurprise = [...tail].reverse().find(isSurprise);
  while (ahead < config.horizonMinutes && planned.length < MAX_NEW_ITEMS) {
    const at = minutes(now, ahead);
    const slot = activeSlot(config, at);
    if (!slot) break;
    if (songsOwed > 0) {
      planned.push({ id: newId(), seq: seq++, showId: MUSIC_SHOW_ID, plannedAt: at.toISOString(), estimatedMinutes: SONG_MINUTES });
      ahead += SONG_MINUTES; songsOwed--;
      continue;
    }
    const rotation = slot.showIds.map(id => scheduledShow(config, id)).filter((show): show is ShowConfig => !!show);
    if (!rotation.length) break;
    // 🎲 By the surprise level, a spoken turn becomes a surprise; the rotation continues after it.
    if (random() < surpriseChance(config)) {
      const surprise = drawSurprise(config, random, lastSurprise);
      const id = `${BLOCK_PREFIX}${surprise.id}`;
      planned.push({ id: newId(), seq: seq++, showId: id, plannedAt: at.toISOString(), estimatedMinutes: surprise.show.targetMinutes });
      ahead += surprise.show.targetMinutes; lastSurprise = id;
      if (needsSongsAfter(config, id)) songsOwed = config.music.between;
      continue;
    }
    const show = rotation[(rotation.findIndex(item => item.id === lastShow) + 1) % rotation.length];
    planned.push({ id: newId(), seq: seq++, showId: show.id, plannedAt: at.toISOString(), estimatedMinutes: show.targetMinutes });
    ahead += show.targetMinutes; lastShow = show.id;
    if (needsSongsAfter(config, show.id)) songsOwed = config.music.between;
  }
  return planned;
}

/**
 * One tick: expire stale content, release old audio, refill the program and report what needs producing.
 * The cron passes `requireListener`, so new content is only paid for while the owner actually listens.
 */
export async function tick(deps: StationDeps, owner: string, options: { requireListener?: boolean } = {}): Promise<{ planned: number; due: string[]; expired: number }> {
  const now = deps.now();
  const config = await deps.store.getConfig(owner);
  if (!config) return { planned: 0, due: [], expired: 0 };
  // What plays right now is never taken out from under the listener.
  const playing = await deps.store.playingNow(owner, now);
  const expired = await deps.store.expire(owner, minutes(now, -STALE_HOURS * 60), now, playing);
  // Time-bound items (weather, headlines, date, a music block's time of day) that missed their air time
  // by hours no longer fit: finished ones move to the archive, and the planner makes fresh ones.
  for (const row of await deps.store.openItems(owner)) {
    if (row.id === playing || (row.state !== 'ready' && row.state !== 'voicing') || Date.parse(row.planned_at) > now.getTime() - TIMELY_HOURS * 3_600_000 || !timeBound(row, config)) continue;
    await deps.store.update(owner, row.id, { state: row.state === 'ready' ? 'archived' : 'expired', lease_until: null }, now);
    expired.push({ ...row, state: row.state === 'ready' ? 'archived' : 'expired' });
  }
  // Archived items keep their audio for the retention period, so they can still be heard.
  const stale = expired.filter(row => row.state === 'expired');
  for (const row of [...stale, ...await deps.store.audioToRelease(owner, minutes(now, -AUDIO_RETENTION_DAYS * 24 * 60))]) {
    const keys = audioKeysOf(row);
    if (!keys.length) continue;
    for (const key of keys) await deps.audio.delete(key);
    await deps.store.update(owner, row.id, { audio_key: null }, now);
  }
  // Failed and expired items are only kept for a day, so the timeline does not fill up.
  for (const key of (await deps.store.purge(owner, minutes(now, -PURGE_AFTER_HOURS * 60))).audioKeys) await deps.audio.delete(key);
  let planned: PlannedItem[] = [];
  // Circuit breaker: repeated failures (bad feeds, provider outage) must not turn into a paid loop.
  const lastSeen = options.requireListener ? await deps.store.lastSeen(owner) : now;
  const listening = !!lastSeen && now.getTime() - lastSeen.getTime() <= ACTIVE_LISTENER_HOURS * 3_600_000;
  if (listening && await deps.store.recentFailures(owner, minutes(now, -60)) < 3) {
    await advanceSeries(deps, owner);
    await planWeekReview(deps, owner, config);
    await planFollowChecks(deps, owner, config);
    await planConcerts(deps, owner, config);
    const recent = await deps.store.recentItems(owner, 4);
    planned = planTimeline(config, await deps.store.openItems(owner), recent.at(-1) ?? null, now, deps.newId ?? (() => crypto.randomUUID()), recent.map(row => row.show_id), deps.random);
    await deps.store.insertItems(owner, planned, now);
  }
  const due = (await deps.store.dueItems(owner, now)).map(row => row.id);
  return { planned: planned.length, due, expired: expired.length };
}

/**
 * On Sunday from eight in the morning (station time), the Wochenrückblick joins the program once: when
 * none was made in the last six days and at least three spoken items were heard this week.
 */
export async function planWeekReview(deps: StationDeps, owner: string, config: StationConfig) {
  const now = deps.now(), { day, minutes } = localClock(now, config.timezone);
  if (!featureOn(config, 'review') || day !== 0 || minutes < 8 * 60) return;
  const latest = await deps.store.latestOfShow(owner, REVIEW_SHOW);
  if (latest && now.getTime() - Date.parse(latest.created_at) < 6 * 86_400_000) return;
  const heard = (await deps.store.heardSince(owner, new Date(now.getTime() - REVIEW_DAYS * 86_400_000))).filter(reviewable);
  if (heard.length < MIN_REVIEW_ITEMS) return;
  const last = await deps.store.lastItem(owner), id = (deps.newId ?? (() => crypto.randomUUID()))();
  await deps.store.insertItem(owner, { id, seq: (last?.seq ?? 0) + 1, showId: REVIEW_SHOW, plannedAt: now.toISOString(), estimatedMinutes: 4 }, now);
  await placeSoon(deps, owner, id);
}

export const FOLLOW_SHOW = `${BLOCK_PREFIX}dranbleiben`, CONCERT_SHOW = `${BLOCK_PREFIX}konzerte`, ANSWER_SHOW = `${BLOCK_PREFIX}nachfrage`;

export function followOf(row: TimelineRow): number | undefined {
  if (row.show_id !== FOLLOW_SHOW) return undefined;
  try { const value = (JSON.parse(row.research_json ?? '{}') as { follow?: unknown }).follow; return Number.isInteger(value) ? value as number : undefined; }
  catch { return undefined; }
}

/** What is new since: the last report, else a week before the topic was followed. */
export const followSince = (topic: { createdAt: string; reportedAt: string | null }) =>
  new Date(topic.reportedAt ? Date.parse(topic.reportedAt) : Date.parse(topic.createdAt) - 7 * 86_400_000);

/** Dranbleiben: during the day, topics not checked for a day get a check (it stays quiet when nothing is new). */
export async function planFollowChecks(deps: StationDeps, owner: string, config: StationConfig) {
  if (!deps.follows || !featureOn(config, 'follow')) return;
  const now = deps.now(), { minutes } = localClock(now, config.timezone);
  if (minutes < 7 * 60 || minutes >= 21 * 60) return;
  for (const topic of await deps.follows.due(owner, now)) {
    const last = await deps.store.lastItem(owner), id = (deps.newId ?? (() => crypto.randomUUID()))();
    await deps.store.insertItem(owner, { id, seq: (last?.seq ?? 0) + 1, showId: FOLLOW_SHOW, plannedAt: now.toISOString(), estimatedMinutes: 2 }, now);
    await deps.store.update(owner, id, { research_json: JSON.stringify({ follow: topic.id, followTopic: topic.topic }) }, now);
    await deps.follows.checked(owner, topic.id, now);
    await placeSoon(deps, owner, id);
  }
}

/** Konzerte: on Friday from four in the afternoon, once a week, when the listener's Spotify profile has top artists. */
export async function planConcerts(deps: StationDeps, owner: string, config: StationConfig) {
  if (!deps.listening || !featureOn(config, 'concerts')) return;
  const now = deps.now(), { day, minutes } = localClock(now, config.timezone);
  if (day !== 5 || minutes < 16 * 60) return;
  const latest = await deps.store.latestOfShow(owner, CONCERT_SHOW);
  if (latest && now.getTime() - Date.parse(latest.created_at) < 6 * 86_400_000) return;
  if (!(await deps.listening.topArtists(owner, now).catch(() => [])).length) return;
  const last = await deps.store.lastItem(owner), id = (deps.newId ?? (() => crypto.randomUUID()))();
  await deps.store.insertItem(owner, { id, seq: (last?.seq ?? 0) + 1, showId: CONCERT_SHOW, plannedAt: now.toISOString(), estimatedMinutes: 2 }, now);
  await placeSoon(deps, owner, id);
}
