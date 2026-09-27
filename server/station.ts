// Server-only program runtime: plans the timeline and produces its segments without an open browser.
import { HOUR_FOCUS, activeSlot, hourSubject, isMusicHour } from '../src/domain/station.ts';
import type { HourFocus, ShowConfig, StationConfig, TextProvider, TimelineItemView, VerificationPolicy } from '../src/domain/station.ts';
import type { Profile, Script, Source, TextGenerator } from '../src/domain/program.ts';
import { learnedWeights, rankCandidates } from '../src/domain/recommendation.ts';
import type { FeedItem } from './feed.ts';
import { ProviderError } from './providers.ts';
import type { Researcher } from './providers.ts';
import { PipelineError } from './segment-pipeline.ts';
import type { SegmentPipeline } from './segment-pipeline.ts';
import { audioKeysOf } from './station-store.ts';
import type { StationStore, TimelineRow } from './station-store.ts';
import { HOUR_KINDS } from './music.ts';
import type { MusicCatalog, MusicWriter, TrackPick } from './music.ts';

export interface AudioBucket {
  put(key: string, value: Uint8Array, options: { httpMetadata: { contentType: string } }): Promise<unknown>;
  delete(key: string): Promise<void>;
}
export interface StationDeps {
  store: StationStore;
  pipeline: Pick<SegmentPipeline, 'draft' | 'review' | 'voice'>;
  audio: AudioBucket;
  fetchFeed(url: string): Promise<FeedItem[]>;
  reserveFeed(owner: string): Promise<void>;
  reserveGeneration(owner: string): Promise<void>;
  podcastAvailable: boolean;
  /** Script writer for a show's provider and format; undefined when that provider is not configured. */
  generator?(provider: TextProvider, format: ShowConfig['format']): TextGenerator | undefined;
  /** Google-Search-grounded research for `web` shows; undefined without Gemini. */
  researcher?: Researcher;
  /** Artist hours: Gemini picks and writes, Spotify resolves picks to tracks. */
  musicWriter?: MusicWriter;
  catalog?: MusicCatalog;
  now(): Date;
  random?(): number;
  newId?(): string;
}

const LEASE_MINUTES = 10;
const MAX_ATTEMPTS = 3;
const MAX_NEW_ITEMS = 12;
const STALE_HOURS = 12;
const ACTIVE_LISTENER_HOURS = 3;
const AUDIO_RETENTION_DAYS = 7;
const PURGE_AFTER_HOURS = 24;
const MAX_SOURCE_AGE_DAYS = 30;
const minutes = (date: Date, amount: number) => new Date(date.getTime() + amount * 60_000);
const nextUtcMidnight = (date: Date) => new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate() + 1));

export interface PlannedItem { id: string; seq: number; showId: string; plannedAt: string; estimatedMinutes: number }

/**
 * Fills the program up to the configured horizon. Plans only while a schedule slot is active, so
 * nothing is produced hours ahead for a slot that starts later; the next cron tick picks it up.
 */
export function planTimeline(config: StationConfig, open: Array<Pick<TimelineRow, 'estimated_minutes'>>, last: Pick<TimelineRow, 'seq' | 'show_id'> | null,
  now: Date, newId: () => string): PlannedItem[] {
  let ahead = open.reduce((sum, item) => sum + item.estimated_minutes, 0);
  let seq = (last?.seq ?? 0) + 1, lastShow = last?.show_id;
  const planned: PlannedItem[] = [];
  while (ahead < config.horizonMinutes && planned.length < MAX_NEW_ITEMS) {
    const at = minutes(now, ahead);
    const slot = activeSlot(config, at);
    if (!slot) break;
    const rotation = slot.showIds.map(id => config.shows.find(show => show.id === id)).filter((show): show is ShowConfig => !!show?.enabled);
    if (!rotation.length) break;
    const show = rotation[(rotation.findIndex(item => item.id === lastShow) + 1) % rotation.length];
    planned.push({ id: newId(), seq: seq++, showId: show.id, plannedAt: at.toISOString(), estimatedMinutes: show.targetMinutes });
    ahead += show.targetMinutes; lastShow = show.id;
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
  const expired = await deps.store.expire(owner, minutes(now, -STALE_HOURS * 60), now);
  for (const row of [...expired, ...await deps.store.audioToRelease(owner, minutes(now, -AUDIO_RETENTION_DAYS * 24 * 60))]) {
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
    planned = planTimeline(config, await deps.store.openItems(owner), await deps.store.lastItem(owner), now, deps.newId ?? (() => crypto.randomUUID()));
    for (const item of planned) await deps.store.insertItem(owner, item, now);
  }
  const due = (await deps.store.dueItems(owner, now)).map(row => row.id);
  return { planned: planned.length, due, expired: expired.length };
}

function interestsOf(profile: Profile, text: string) {
  const lower = text.toLocaleLowerCase();
  return [...profile.topics, ...profile.interests].filter(interest => lower.includes(interest.toLocaleLowerCase()));
}

async function collectSources(deps: StationDeps, owner: string, config: StationConfig, show: ShowConfig, profile: Profile): Promise<Source[]> {
  const now = deps.now();
  const collected: FeedItem[] = [];
  for (const feed of config.feeds.filter(feed => show.feedIds.includes(feed.id))) {
    try { await deps.reserveFeed(owner); } catch { break; }
    try { collected.push(...await deps.fetchFeed(feed.url)); } catch { /* One unreachable feed must not block the others. */ }
  }
  const unique = [...new Map(collected.map(item => [item.url, item])).values()]
    .filter(item => now.getTime() - Date.parse(item.publishedAt) <= MAX_SOURCE_AGE_DAYS * 86_400_000);
  const covered = await deps.store.coveredUrls(owner, unique.map(item => item.url));
  const candidates = unique.filter(item => !covered.has(item.url)).map(item => ({ ...item, interests: interestsOf(profile, `${item.title} ${item.excerpt}`) }));
  const ranked = rankCandidates(candidates, [...profile.topics, ...profile.interests], profile.interestWeights, profile.exploration, (deps.random ?? Math.random)(), profile.interests);
  return ranked.slice(0, show.format === 'podcast' ? 3 : 1).map((item, index) => ({
    id: `s${index + 1}`, url: item.url, title: item.title, excerpt: item.excerpt.slice(0, 8000),
    publishedAt: item.publishedAt, retrievedAt: now.toISOString(),
  }));
}

/** Topic memory: titles of the most recent produced segments. */
async function recentTopics(deps: StationDeps, owner: string): Promise<string[]> {
  const titles: string[] = [];
  for (const row of (await deps.store.recentItems(owner, 30)).reverse()) {
    if (!row.script_json || !['voicing', 'ready', 'played', 'skipped'].includes(row.state)) continue;
    try { const title = (JSON.parse(row.script_json) as Script).title; if (title) titles.push(title); } catch { /* Skip corrupt rows. */ }
    if (titles.length >= 15) break;
  }
  return titles;
}

export type ProduceOutcome = 'ready' | 'voicing' | 'failed' | 'deferred' | 'retry' | 'skipped';

/**
 * Advances one timeline item through planned → voicing → ready. The approved script is stored before
 * speech synthesis, so a TTS retry never pays for a second draft. Permanent problems fail the item;
 * transient provider errors back off and are retried by a later tick.
 */
export async function produceItem(deps: StationDeps, owner: string, itemId: string): Promise<ProduceOutcome> {
  const now = deps.now();
  const config = await deps.store.getConfig(owner);
  if (!config) return 'skipped';
  const row = await deps.store.lease(owner, itemId, now, minutes(now, LEASE_MINUTES));
  if (!row) return 'skipped';
  const fail = async (error: string) => { await deps.store.update(owner, row.id, { state: 'failed', lease_until: null, error }, deps.now()); return 'failed' as const; };
  const show = config.shows.find(item => item.id === row.show_id);
  if (!show) return fail('SHOW_REMOVED');
  try {
    if (isMusicHour(show.format)) return await produceMusicHour(deps, owner, config, show, row, fail);
    let current = row;
    if (current.state === 'planned') {
      if (show.format === 'podcast' && !deps.podcastAvailable) return fail('PODCAST_PROVIDER_NOT_CONFIGURED');
      const generator = deps.generator ? deps.generator(show.textProvider, show.format) : undefined;
      if (deps.generator && !generator) return fail(show.textProvider === 'ask' ? 'ASK_NOT_CONFIGURED' : 'GEMINI_NOT_CONFIGURED');
      if (show.sourceMode === 'web' && !deps.researcher) return fail('GEMINI_NOT_CONFIGURED');
      await deps.reserveGeneration(owner);
      const profile: Profile = { ...config.profile, interestWeights: learnedWeights(await deps.store.feedback(owner), now.getTime()) };
      const avoidTopics = await recentTopics(deps, owner);
      let sources: Source[], queries: string[] = [];
      if (show.sourceMode === 'web') {
        ({ sources, queries } = await deps.researcher!.research({ brief: show.researchPrompt, interests: [...profile.topics, ...profile.interests], avoidTopics, now }));
      } else sources = await collectSources(deps, owner, config, show, profile);
      if (!sources.length) return fail('NO_SOURCES');
      // Mark sources before drafting: a rejected article is not retried endlessly at provider cost.
      await deps.store.markCovered(owner, sources.map(source => source.url), now);
      const direction = { instructions: show.instructions, targetMinutes: show.targetMinutes, stationName: config.name, persona: config.host, avoidTopics };
      const script = await deps.pipeline.draft(profile, sources, show.format === 'podcast' ? 'podcast' : 'brief', direction, generator);
      await deps.pipeline.review(script, sources, show.verification);
      const patch = { state: 'voicing' as const, script_json: JSON.stringify(script), sources_json: JSON.stringify(sources), verification: show.verification,
        research_json: queries.length ? JSON.stringify({ queries }) : null };
      await deps.store.update(owner, row.id, patch, deps.now());
      current = { ...current, ...patch };
    }
    const script = JSON.parse(current.script_json ?? 'null') as Script;
    const format = script.turns ? 'podcast' : 'brief';
    // The show's own voice wins; otherwise the host persona speaks.
    const voiced = await deps.pipeline.voice(owner, script, format, format === 'brief' ? show.voiceId ?? config.host.voiceId : undefined);
    const key = `segments/${row.id}.${voiced.contentType === 'audio/wav' ? 'wav' : 'mp3'}`;
    await deps.audio.put(key, voiced.audio, { httpMetadata: { contentType: voiced.contentType } });
    await deps.store.update(owner, row.id, { state: 'ready', lease_until: null, audio_key: key, content_type: voiced.contentType, error: null }, deps.now());
    return 'ready';
  } catch (error) {
    if (error instanceof PipelineError && error.code === 'BUDGET_EXCEEDED') {
      await deps.store.update(owner, row.id, { lease_until: nextUtcMidnight(now).toISOString(), error: 'DAILY_LIMIT' }, deps.now());
      return 'deferred';
    }
    if (error instanceof ProviderError && error.status === 429) {
      // Rate limit or exhausted quota: wait as long as the provider asks (at least 2 minutes, at most 1 hour).
      // It is not the item's fault, so it neither uses up an attempt nor counts towards the failure pause.
      const waitMs = Math.min(Math.max(error.retryAfterMs ?? 0, 2 * 60_000), 60 * 60_000);
      await deps.store.update(owner, row.id, { lease_until: new Date(now.getTime() + waitMs).toISOString(), error: error.message.slice(0, 300) }, deps.now());
      return 'deferred';
    }
    if (error instanceof PipelineError && (error.code === 'REJECTED' || error.code === 'INVALID_INPUT')) return fail(error.message.slice(0, 300));
    const attempts = row.attempts + 1;
    const detail = (error instanceof Error ? error.message : 'UNKNOWN').slice(0, 160);
    if (attempts >= MAX_ATTEMPTS) {
      await deps.store.update(owner, row.id, { state: 'failed', attempts, lease_until: null, error: detail }, deps.now());
      return 'failed';
    }
    await deps.store.update(owner, row.id, { attempts, lease_until: minutes(now, 5 * 2 ** attempts).toISOString(), error: detail }, deps.now());
    return 'retry';
  }
}

/** Stored in script_json: the hour's speech and tracks in playing order. */
interface SpeechPart { kind: 'speech'; text: string; sourceIds: string[]; audioKey?: string; contentType?: string }
interface TrackPart { kind: 'track'; uri: string; title: string; artist: string; durationMs: number; reason?: string }
/** `artist_hour` packages were written before genre and theme hours existed; they are artist hours. */
interface HourPackage { kind: 'music_hour' | 'artist_hour'; focus?: HourFocus; subject?: string; artist?: string; title: string; text: string; sourceIds: string[]; parts: Array<SpeechPart | TrackPart> }
const packageFocus = (pkg: Partial<HourPackage>): HourFocus => pkg.focus ?? 'artist';
const packageSubject = (pkg: Partial<HourPackage>): string => pkg.subject ?? pkg.artist ?? '';

/** Mistral speaks at most about 280 words per request; longer moderations become consecutive parts. */
export function splitSpeech(text: string, maxWords = 250): string[] {
  const chunks: string[] = [];
  let current: string[] = [];
  for (const sentence of text.split(/(?<=[.!?…])\s+/)) {
    const words = sentence.split(/\s+/).filter(Boolean);
    if (current.length && current.length + words.length > maxWords) { chunks.push(current.join(' ')); current = []; }
    current.push(...words);
    while (current.length > maxWords) { chunks.push(current.slice(0, maxWords).join(' ')); current = current.slice(maxWords); }
  }
  if (current.length) chunks.push(current.join(' '));
  return chunks;
}

/** Subjects of recent hours of the same kind, so the AI does not pick them again. */
async function recentSubjects(deps: StationDeps, owner: string, focus: HourFocus): Promise<string[]> {
  const subjects: string[] = [];
  for (const row of await deps.store.recentItems(owner, 60)) {
    try {
      const pkg = JSON.parse(row.script_json ?? '{}') as Partial<HourPackage>;
      if ((pkg.kind === 'music_hour' || pkg.kind === 'artist_hour') && packageFocus(pkg) === focus && packageSubject(pkg)) subjects.push(packageSubject(pkg));
    } catch { /* Skip. */ }
  }
  return [...new Set(subjects)];
}

/**
 * One hour about an artist, a genre or a theme: grounded dossier → AI track picks → Spotify search (code
 * only) → moderations for resolved tracks → verification → voicing part by part. Progress is stored after
 * every spoken part, so a retry never pays twice.
 */
async function produceMusicHour(deps: StationDeps, owner: string, config: StationConfig, show: ShowConfig, row: TimelineRow,
  fail: (error: string) => Promise<'failed'>): Promise<ProduceOutcome> {
  const now = deps.now();
  let pkg: HourPackage;
  if (row.state === 'planned') {
    if (!deps.researcher || !deps.musicWriter) return fail('GEMINI_NOT_CONFIGURED');
    if (!deps.catalog) return fail('SPOTIFY_NOT_CONFIGURED');
    await deps.reserveGeneration(owner);
    const focus = HOUR_FOCUS[show.format]!;
    const interests = [...config.profile.topics, ...config.profile.interests];
    const subject = hourSubject(show)
      ?? (await deps.musicWriter.pickSubject({ focus, interests, avoid: await recentSubjects(deps, owner, focus), instructions: show.instructions })).subject;
    const { sources, queries } = await deps.researcher.research({
      brief: `${HOUR_KINDS[focus].research(subject)} ${show.researchPrompt}`.trim(), interests: [subject], avoidTopics: [], now,
    });
    if (!sources.length) return fail('NO_SOURCES');
    const picks = await deps.musicWriter.pickTracks({ focus, subject, count: show.tracks ?? 10, sources, instructions: show.instructions });
    const resolved: Array<{ pick: TrackPick; uri: string; durationMs: number }> = [];
    for (const pick of picks) {
      if (resolved.length >= (show.tracks ?? 10)) break;
      const track = await deps.catalog.find(pick);
      if (track && !resolved.some(item => item.uri === track.uri)) resolved.push({ pick, ...track });
    }
    if (resolved.length < 3) return fail(`TOO_FEW_TRACKS: ${resolved.length} von ${picks.length} Songs auf Spotify gefunden`);
    const direction = { instructions: show.instructions, stationName: config.name, persona: config.host, avoidTopics: await recentTopics(deps, owner) };
    const hour = await deps.musicWriter.writeHour({ focus, subject, picks: resolved.map(item => item.pick), sources, talkSeconds: show.talkSeconds ?? 60, direction });
    const spoken = [hour.intro, ...hour.tracks, hour.outro];
    const sourceIds = [...new Set(spoken.flatMap(part => part.sourceIds))];
    const text = spoken.map(part => part.text).join(' ');
    await deps.pipeline.review({ title: hour.title, text, sourceIds }, sources, show.verification);
    const speech = (part: { text: string; sourceIds: string[] }): SpeechPart[] => splitSpeech(part.text).map(chunk => ({ kind: 'speech', text: chunk, sourceIds: part.sourceIds }));
    const parts: Array<SpeechPart | TrackPart> = [...speech(hour.intro)];
    resolved.forEach((item, index) => {
      const moderation = hour.tracks.find(track => track.index === index);
      if (moderation) parts.push(...speech(moderation));
      parts.push({ kind: 'track', uri: item.uri, title: item.pick.title, artist: item.pick.artist, durationMs: item.durationMs, reason: item.pick.reason });
    });
    parts.push(...speech(hour.outro));
    pkg = { kind: 'music_hour', focus, subject, title: hour.title, text, sourceIds, parts };
    await deps.store.markCovered(owner, sources.map(source => source.url), now);
    await deps.store.update(owner, row.id, { state: 'voicing', script_json: JSON.stringify(pkg), sources_json: JSON.stringify(sources),
      verification: show.verification, research_json: queries.length ? JSON.stringify({ queries }) : null }, deps.now());
  } else {
    pkg = JSON.parse(row.script_json ?? 'null') as HourPackage;
  }
  const voiceId = show.voiceId ?? config.host.voiceId;
  for (const [index, part] of pkg.parts.entries()) {
    if (part.kind !== 'speech' || part.audioKey) continue;
    const voiced = await deps.pipeline.voice(owner, { title: pkg.title, text: part.text, sourceIds: part.sourceIds.length ? part.sourceIds : pkg.sourceIds }, 'brief', voiceId);
    const key = `segments/${row.id}-${index}.${voiced.contentType === 'audio/wav' ? 'wav' : 'mp3'}`;
    await deps.audio.put(key, voiced.audio, { httpMetadata: { contentType: voiced.contentType } });
    part.audioKey = key; part.contentType = voiced.contentType;
    // The first key marks the row as holding audio, so retention and cleanup find it.
    await deps.store.update(owner, row.id, { script_json: JSON.stringify(pkg), audio_key: row.audio_key ?? key }, deps.now());
    row = { ...row, audio_key: row.audio_key ?? key };
  }
  await deps.store.update(owner, row.id, { state: 'ready', lease_until: null, error: null }, deps.now());
  return 'ready';
}

/** Plans one item of a show right away, outside the program clock ("Jetzt produzieren"). */
export async function scheduleShowNow(deps: StationDeps, owner: string, showId: string): Promise<string | null> {
  const config = await deps.store.getConfig(owner);
  const show = config?.shows.find(item => item.id === showId);
  if (!show) return null;
  const now = deps.now();
  const ahead = (await deps.store.openItems(owner)).reduce((sum, item) => sum + item.estimated_minutes, 0);
  const last = await deps.store.lastItem(owner);
  const id = (deps.newId ?? (() => crypto.randomUUID()))();
  await deps.store.insertItem(owner, { id, seq: (last?.seq ?? 0) + 1, showId: show.id, plannedAt: minutes(now, ahead).toISOString(), estimatedMinutes: show.targetMinutes }, now);
  return id;
}

export function toView(row: TimelineRow, config: StationConfig | null): TimelineItemView {
  let script: Partial<Script> = {}, sources: Source[] = [];
  try { script = JSON.parse(row.script_json ?? '{}'); } catch { /* Keep the item visible without details. */ }
  try { sources = JSON.parse(row.sources_json ?? '[]'); } catch { /* Keep the item visible without sources. */ }
  let queries: string[] = [];
  try { queries = (JSON.parse(row.research_json ?? '{}') as { queries?: string[] }).queries ?? []; } catch { /* Research details are optional. */ }
  return {
    id: row.id, seq: row.seq, showId: row.show_id, showName: config?.shows.find(show => show.id === row.show_id)?.name ?? row.show_id,
    plannedAt: row.planned_at, state: row.state, estimatedMinutes: row.estimated_minutes, updatedAt: row.updated_at,
    ...(script.title ? { title: script.title } : {}),
    ...(sources.length ? { sources: sources.map(source => ({ title: source.title, url: source.url })) } : {}),
    ...(script.interestTags?.length ? { interestTags: script.interestTags } : {}),
    ...(row.verification ? { verification: row.verification as VerificationPolicy } : {}),
    ...(queries.length ? { searchQueries: queries } : {}),
    ...(row.error ? { error: row.error } : {}),
    ...(hourView(row, script as Partial<HourPackage>) ?? (row.audio_key && row.state !== 'expired' ? { audioUrl: `api/timeline/${row.id}/audio` } : {})),
  };
}

function hourView(row: TimelineRow, pkg: Partial<HourPackage>): Pick<TimelineItemView, 'parts' | 'focus' | 'subject' | 'artist'> | null {
  if ((pkg.kind !== 'music_hour' && pkg.kind !== 'artist_hour') || !Array.isArray(pkg.parts)) return null;
  const playable = row.state !== 'expired', focus = packageFocus(pkg), subject = packageSubject(pkg);
  return {
    focus, subject, ...(focus === 'artist' ? { artist: subject } : {}),
    parts: pkg.parts.map((part, index) => part.kind === 'track'
      ? { kind: 'track' as const, spotifyUri: part.uri, title: part.title, artist: part.artist, durationMs: part.durationMs }
      : { kind: 'speech' as const, ...(playable && part.audioKey ? { audioUrl: `api/timeline/${row.id}/audio?part=${index}` } : {}) }),
  };
}
