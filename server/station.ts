// Server-only program runtime: plans the timeline and produces its segments without an open browser.
import { HOUR_FOCUS, MUSIC_SHOW_ID, SONG_MINUTES, activeSlot, bringsOwnMusic, hourSubject, isMusicHour, localClock } from '../src/domain/station.ts';
import type { HourFocus, ShowConfig, StationConfig, TextProvider, TimelineItemView, VerificationPolicy } from '../src/domain/station.ts';
import type { Profile, Script, Source, TextGenerator } from '../src/domain/program.ts';
import { learnedWeights, rankCandidates } from '../src/domain/recommendation.ts';
import type { FeedItem } from './feed.ts';
import { ProviderError } from './providers.ts';
import { clockValues, expandPlaceholders, usesHeadlines, usesWeather } from './tools.ts';
import { BLOCKS, BLOCK_PREFIX, blockOf, blockShow } from '../src/domain/blocks.ts';
import type { Weather } from './tools.ts';
import type { Researcher } from './providers.ts';
import { PipelineError } from './segment-pipeline.ts';
import type { SegmentPipeline } from './segment-pipeline.ts';
import { audioKeysOf } from './station-store.ts';
import type { StationStore, TimelineRow } from './station-store.ts';
import { HOUR_KINDS } from './music.ts';
import type { BlockMoment, HourScript, MusicCatalog, MusicWriter, PlaylistSource, PlaylistTrack, SongPick, TrackPick } from './music.ts';
import { produceWithTeam } from './agentic/music-hour.ts';
import type { JsonModel } from './agentic/music-hour.ts';
import type { DurableStepRunner } from './agentic/runtime.ts';

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
  /** Music blocks: the owner's Spotify playlists. */
  playlists?: PlaylistSource;
  /** Tool: the weather for `{wetter}` (Open-Meteo). */
  weather?: Weather;
  /** The owner's Spotify top artists, when the owner connected the listening profile. */
  listening?: { topArtists(owner: string, now: Date): Promise<string[]> };
  /** The editorial team's model and durable step storage (music hours with `production: agents`). */
  agentModel?: JsonModel;
  agentSteps?(owner: string, runId: string): DurableStepRunner & { clear(): Promise<void> };
  now(): Date;
  random?(): number;
  newId?(): string;
}

const LEASE_MINUTES = 10;
const MAX_ATTEMPTS = 3;
const MAX_NEW_ITEMS = 12;
const STALE_HOURS = 12;
const ACTIVE_LISTENER_HOURS = 3;
export const AUDIO_RETENTION_DAYS = 7;
const PURGE_AFTER_HOURS = 24;
const MAX_SOURCE_AGE_DAYS = 30;
const minutes = (date: Date, amount: number) => new Date(date.getTime() + amount * 60_000);
const nextUtcMidnight = (date: Date) => new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate() + 1));

export interface PlannedItem { id: string; seq: number; showId: string; plannedAt: string; estimatedMinutes: number }

/** A show of the day plan: an enabled show of the owner, or a building block. */
function scheduledShow(config: StationConfig, id: string): ShowConfig | undefined {
  const own = config.shows.find(show => show.id === id);
  if (own) return own.enabled ? own : undefined;
  const block = blockOf(id);
  return block ? blockShow(block, config) : undefined;
}

/** Spoken items need songs after them; music hours bring their own music. */
function needsSongsAfter(config: StationConfig, showId: string | undefined): boolean {
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
  now: Date, newId: () => string, tail: string[] = last ? [last.show_id] : []): PlannedItem[] {
  let ahead = open.reduce((sum, item) => sum + item.estimated_minutes, 0);
  let seq = (last?.seq ?? 0) + 1;
  let lastShow = [...tail].reverse().find(id => id !== MUSIC_SHOW_ID);
  // Songs still owed after the most recent spoken item.
  const trailingSongs = tail.length - 1 - tail.map(id => id !== MUSIC_SHOW_ID).lastIndexOf(true);
  let songsOwed = needsSongsAfter(config, lastShow) ? Math.max(0, config.music.between - trailingSongs) : 0;
  const planned: PlannedItem[] = [];
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
  const expired = await deps.store.expire(owner, minutes(now, -STALE_HOURS * 60), now);
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
    const recent = await deps.store.recentItems(owner, 4);
    planned = planTimeline(config, await deps.store.openItems(owner), recent.at(-1) ?? null, now, deps.newId ?? (() => crypto.randomUUID()), recent.map(row => row.show_id));
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

/**
 * The headlines of the day: the newest items of the owner's feeds (last 36 hours); without feeds, a
 * web search for today's most important news.
 */
async function headlines(deps: StationDeps, owner: string, config: StationConfig, now: Date, date: string): Promise<{ text: string; sources: Source[] }> {
  const collected: FeedItem[] = [];
  for (const feed of config.feeds) {
    try { await deps.reserveFeed(owner); } catch { break; }
    try { collected.push(...await deps.fetchFeed(feed.url)); } catch { /* One unreachable feed must not block the others. */ }
  }
  let sources: Source[] = [...new Map(collected.map(item => [item.url, item])).values()]
    .filter(item => now.getTime() - Date.parse(item.publishedAt) <= 36 * 3_600_000)
    .sort((a, b) => Date.parse(b.publishedAt) - Date.parse(a.publishedAt)).slice(0, 6)
    .map((item, index) => ({ id: `h${index + 1}`, url: item.url, title: item.title, excerpt: item.excerpt.slice(0, 1500), publishedAt: item.publishedAt, retrievedAt: now.toISOString() }));
  if (!sources.length && deps.researcher) {
    const found = await deps.researcher.research({ brief: `Die wichtigsten Nachrichten von heute${date ? `, ${date}` : ''}: sechs Schlagzeilen aus der Schweiz und der Welt, jeweils mit einem Satz Einordnung.`, interests: [], avoidTopics: [], now });
    sources = found.sources.slice(0, 6).map((source, index) => ({ ...source, id: `h${index + 1}` }));
  }
  return { text: sources.map(source => `– ${source.title}`).join('\n'), sources };
}

/** Topic memory: titles of the most recent produced segments. */
async function recentTopics(deps: StationDeps, owner: string): Promise<string[]> {
  const titles: string[] = [];
  for (const row of (await deps.store.recentItems(owner, 30)).reverse()) {
    if (!row.script_json || !['voicing', 'ready', 'played', 'skipped', 'archived'].includes(row.state)) continue;
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
  // A building block added from the app is produced with its template.
  const block = blockOf(row.show_id);
  const configured = config.shows.find(item => item.id === row.show_id) ?? (block ? blockShow(block, config, requestedHourSubject(row)) : undefined);
  if (!configured && row.show_id !== MUSIC_SHOW_ID) return fail('SHOW_REMOVED');
  try {
    // Tools (switched on per show, or as placeholders like {wetter}) are filled in once per production;
    // weather and headlines also become sources, so the writer can cite them.
    let show = configured, toolSources: Source[] = [];
    if (configured) {
      const values = clockValues(now, config.timezone, config.location);
      const tools = new Set(configured.tools ?? []);
      if (usesWeather(configured)) tools.add('weather');
      if (usesHeadlines(configured)) tools.add('headlines');
      const notes: string[] = [];
      if (tools.has('clock')) notes.push(`Heute ist ${values.wochentag}, ${values.datum}, es ist ${values.uhrzeit} Uhr.`);
      // Only a new draft needs fresh information; a retry of the voice keeps the approved script.
      if (row.state === 'planned') {
        if (tools.has('weather')) {
          if (!config.location) return fail('NO_LOCATION');
          if (!deps.weather) return fail('WEATHER_NOT_CONFIGURED');
          const report = await deps.weather.report(config.location, config.timezone, now);
          values.wetter = report.text;
          toolSources.push(report.source);
          notes.push('Das aktuelle Wetter steht in der Quelle «wetter».');
        }
        if (tools.has('headlines')) {
          const news = await headlines(deps, owner, config, now, values.datum ?? '');
          values.schlagzeilen = news.text;
          toolSources.push(...news.sources);
          if (news.sources.length) notes.push('Die aktuellen Schlagzeilen stehen in den Quellen «h1» bis «h' + news.sources.length + '».');
        }
      }
      const instructions = [expandPlaceholders(configured.instructions, values), ...notes].filter(Boolean).join(' ');
      show = { ...configured, instructions, researchPrompt: expandPlaceholders(configured.researchPrompt, values) };
    }
    if (!show) return await produceSong(deps, owner, config, row, fail);
    if (isMusicHour(show.format)) return await produceMusicHour(deps, owner, config, show, row, fail);
    if (show.format === 'music_block') return await produceMusicBlock(deps, owner, config, show, row, fail);
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
      // Mark sources before drafting: a rejected article is not retried endlessly at provider cost.
      await deps.store.markCovered(owner, sources.map(source => source.url), now);
      // Tool results are evidence too; a show can live on them alone (a weather report).
      sources = [...toolSources, ...sources];
      if (!sources.length) return fail('NO_SOURCES');
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
    const voiced = await deps.pipeline.voice(owner, script, format, format === 'brief' ? show.voiceId ?? config.host.voiceId : undefined, config.host.voiceStyle);
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
interface TrackPart { kind: 'track'; uri: string; title: string; artist: string; durationMs: number; reason?: string; group?: string; picked?: 'ai' | 'playlist' }
/** `artist_hour` packages were written before genre and theme hours existed; they are artist hours. */
interface HourPackage {
  kind: 'music_hour' | 'artist_hour' | 'song' | 'music_block'; focus?: HourFocus; subject?: string; artist?: string; title: string; text: string; sourceIds: string[]; parts: Array<SpeechPart | TrackPart>;
  /** Music blocks: the group the next block of this show starts with. */
  nextGroup?: number;
}
const packageFocus = (pkg: Partial<HourPackage>): HourFocus => pkg.focus ?? 'artist';
const packageSubject = (pkg: Partial<HourPackage>): string => pkg.subject ?? pkg.artist ?? '';
function requestedHourSubject(row: TimelineRow): string | undefined {
  try {
    const value = (JSON.parse(row.research_json ?? '{}') as { subjectOverride?: unknown }).subjectOverride;
    return typeof value === 'string' && value.trim() ? value.trim().slice(0, 200) : undefined;
  } catch { return undefined; }
}

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
    // Artist and genre hours also draw on what the owner listens to; theme hours stay with the interests.
    const listens = focus !== 'theme' && deps.listening ? (await deps.listening.topArtists(owner, now)).slice(0, 15).map(artist => `hört ${artist}`) : [];
    const interests = [...config.profile.topics, ...config.profile.interests, ...listens];
    const subject = requestedHourSubject(row) ?? hourSubject(show)
      ?? (await deps.musicWriter.pickSubject({ focus, interests, avoid: await recentSubjects(deps, owner, focus), instructions: show.instructions })).subject;
    // Search grounding does not trigger every time: one more, more explicit attempt. If both stay empty,
    // the hour is written from well-known facts, carefully worded and marked as unverified ("frei").
    // The editorial team does its own research; the standard path researches here.
    const brief = `${HOUR_KINDS[focus].research(subject)} ${show.researchPrompt}`.trim();
    let sources: Source[] = [], queries: string[] = [];
    if (show.production !== 'agents') {
      ({ sources, queries } = await deps.researcher.research({ brief, interests: [subject], avoidTopics: [], now }));
      if (!sources.length) ({ sources, queries } = await deps.researcher.research({ brief: `Suche mit Google nach: ${subject}. ${brief}`, interests: [subject], avoidTopics: [], now }));
    }
    const direction = { instructions: show.instructions, stationName: config.name, persona: config.host, avoidTopics: await recentTopics(deps, owner) };
    let resolved: Array<{ pick: TrackPick; uri: string; durationMs: number }>;
    let hour: HourScript;
    let team: { songs: number; specialists: number; corrections: number } | undefined;
    if (show.production === 'agents') {
      // The editorial team researches, plans, writes, checks and edits in durable steps.
      if (!deps.agentModel) return fail('GEMINI_NOT_CONFIGURED');
      const steps = deps.agentSteps?.(owner, row.id) ?? memorySteps();
      const result = await produceWithTeam({ runId: row.id, ownerId: owner, steps,
        tools: { model: deps.agentModel, researcher: deps.researcher, catalog: deps.catalog, now: deps.now },
        request: { focus, subject, count: show.tracks ?? 10, talkSeconds: show.talkSeconds ?? 60, instructions: show.instructions, researchPrompt: show.researchPrompt, direction } });
      if (!result.ok) { await steps.clear(); return fail(result.error); }
      sources = result.sources; queries = result.queries; hour = result.script;
      resolved = result.songs.map(song => ({ pick: { title: song.title, artist: song.artist, reason: song.role, ...(song.album ? { album: song.album } : {}), ...(song.year ? { year: song.year } : {}) }, uri: song.uri, durationMs: song.durationMs }));
      team = { songs: result.songs.length, specialists: result.specialists, corrections: result.corrections };
      await steps.clear();
    } else {
      const picks = await deps.musicWriter.pickTracks({ focus, subject, count: show.tracks ?? 10, sources, instructions: show.instructions });
      resolved = [];
      for (const pick of picks) {
        if (resolved.length >= (show.tracks ?? 10)) break;
        const track = await deps.catalog.find(pick);
        if (track && !resolved.some(item => item.uri === track.uri)) resolved.push({ pick, ...track });
      }
      if (resolved.length < 3) return fail(`TOO_FEW_TRACKS: ${resolved.length} von ${picks.length} Songs auf Spotify gefunden`);
      // A second research pass runs after Spotify has confirmed the exact tracks. This gives the writer
      // song-specific evidence, rather than asking it to improvise from a broad artist dossier.
      const songDossier = await deps.researcher.research({
        brief: `Recherchiere gezielt für jede dieser bestätigten Aufnahmen eine eigene, belegbare Geschichte. Suche konkrete Hintergründe zu Entstehung, Aufnahme, Album, Text oder Motiv, beteiligten Musikerinnen und Musikern und damaligem Kontext. Liefere unterschiedliche Details pro Song; keine allgemeine Künstlerbiografie.\n${resolved.map((item, index) => `${index + 1}. ${item.pick.artist} – ${item.pick.title}${item.pick.album ? `, Album ${item.pick.album}` : ''}${item.pick.year ? ` (${item.pick.year})` : ''}: ${item.pick.reason}`).join('\n')}`,
        interests: [subject], avoidTopics: [], now,
      });
      const knownUrls = new Set(sources.map(source => source.url));
      const songSources = songDossier.sources.flatMap((source, index) => {
        if (knownUrls.has(source.url)) return [];
        knownUrls.add(source.url);
        return [{ ...source, id: `song-${index + 1}-${source.id}` }];
      });
      sources = [...sources, ...songSources];
      queries = [...new Set([...queries, ...songDossier.queries])];
      hour = await deps.musicWriter.writeHour({ focus, subject, picks: resolved.map(item => item.pick), sources, talkSeconds: show.talkSeconds ?? 60, direction });
    }
    const verification = sources.length ? show.verification : 'off';
    const spoken = [hour.intro, ...hour.tracks, hour.outro];
    const sourceIds = [...new Set(spoken.flatMap(part => part.sourceIds))];
    const text = spoken.map(part => part.text).join(' ');
    await deps.pipeline.review({ title: hour.title, text, sourceIds }, sources, verification);
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
      verification, research_json: queries.length || team ? JSON.stringify({ queries, ...(team ? { team } : {}) }) : null }, deps.now());
  } else {
    pkg = JSON.parse(row.script_json ?? 'null') as HourPackage;
  }
  return voiceParts(deps, owner, config, show.voiceId ?? config.host.voiceId, row, pkg);
}

/** Without durable storage (tests, local runs) the team's steps simply run in memory. */
function memorySteps(): DurableStepRunner & { clear(): Promise<void> } {
  const done = new Map<string, unknown>();
  return {
    async do<T>(name: string, _config: unknown, callback: () => Promise<T>): Promise<T> {
      if (done.has(name)) return done.get(name) as T;
      const result = await callback(); done.set(name, result); return result;
    },
    async clear() { done.clear(); },
  };
}

/** Voices every spoken part that has no audio yet, storing progress after each, then marks the item ready. */
async function voiceParts(deps: StationDeps, owner: string, config: StationConfig, voiceId: string | undefined, row: TimelineRow, pkg: HourPackage): Promise<ProduceOutcome> {
  for (const [index, part] of pkg.parts.entries()) {
    if (part.kind !== 'speech' || part.audioKey) continue;
    const voiced = await deps.pipeline.voice(owner, { title: pkg.title, text: part.text, sourceIds: part.sourceIds.length ? part.sourceIds : pkg.sourceIds }, 'brief', voiceId, config.host.voiceStyle);
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

/** Songs of recent song items with the owner's reaction: liked, disliked, or just played. */
async function songHistory(deps: StationDeps, owner: string): Promise<{ recent: string[]; liked: string[]; disliked: string[] }> {
  const rows = (await deps.store.recentItems(owner, 120)).filter(row => row.show_id === MUSIC_SHOW_ID && row.script_json);
  const reactions = new Map<string, string>();
  for (const event of await deps.store.feedback(owner)) {
    if (event.action === 'like' || event.action === 'dislike') reactions.set(event.itemId, event.action);
    else if (event.action === 'skip' && event.listenedRatio < 0.3 && !reactions.has(event.itemId)) reactions.set(event.itemId, 'dislike');
  }
  const recent: string[] = [], liked: string[] = [], disliked: string[] = [];
  for (const row of rows) {
    try {
      const track = (JSON.parse(row.script_json!) as HourPackage).parts.find((part): part is TrackPart => part.kind === 'track');
      if (!track) continue;
      const name = `${track.artist} – ${track.title}`;
      recent.push(name);
      if (reactions.get(row.id) === 'like') liked.push(name);
      if (reactions.get(row.id) === 'dislike') disliked.push(name);
    } catch { /* Skip corrupt rows. */ }
  }
  return { recent: [...new Set(recent)].reverse(), liked: liked.reverse(), disliked: disliked.reverse() };
}

/**
 * One song between spoken items: the AI proposes a few songs from the owner's taste (and reactions to
 * earlier songs), Spotify resolves the first it knows, the host announces it briefly.
 */
async function produceSong(deps: StationDeps, owner: string, config: StationConfig, row: TimelineRow,
  fail: (error: string) => Promise<'failed'>): Promise<ProduceOutcome> {
  let pkg: HourPackage;
  if (row.state === 'planned') {
    if (!deps.musicWriter) return fail('GEMINI_NOT_CONFIGURED');
    if (!deps.catalog) return fail('SPOTIFY_NOT_CONFIGURED');
    const history = await songHistory(deps, owner);
    const listens = deps.listening ? await deps.listening.topArtists(owner, deps.now()) : [];
    const picks = await deps.musicWriter.pickSongs({
      taste: config.music.taste, interests: [...config.profile.topics, ...config.profile.interests], avoid: history.recent,
      liked: history.liked, disliked: history.disliked, announce: config.music.announce, listens,
      direction: { stationName: config.name, persona: config.host },
    });
    let chosen: { pick: SongPick; uri: string; durationMs: number } | null = null;
    for (const pick of picks) {
      const track = await deps.catalog.find(pick);
      if (track) { chosen = { pick, ...track }; break; }
    }
    if (!chosen) return fail(`TOO_FEW_TRACKS: 0 von ${picks.length} Songs auf Spotify gefunden`);
    const title = `${chosen.pick.artist} – ${chosen.pick.title}`;
    const intro: SpeechPart[] = config.music.announce && chosen.pick.announcement ? [{ kind: 'speech', text: chosen.pick.announcement, sourceIds: [] }] : [];
    pkg = { kind: 'song', title, subject: title, text: chosen.pick.announcement, sourceIds: [],
      parts: [...intro, { kind: 'track', uri: chosen.uri, title: chosen.pick.title, artist: chosen.pick.artist, durationMs: chosen.durationMs }] };
    await deps.store.update(owner, row.id, { state: 'voicing', script_json: JSON.stringify(pkg), estimated_minutes: Math.max(1, Math.round(chosen.durationMs / 60_000)) }, deps.now());
  } else {
    pkg = JSON.parse(row.script_json ?? 'null') as HourPackage;
  }
  return voiceParts(deps, owner, config, config.host.voiceId, row, pkg);
}

const MAX_BLOCK_TRACKS = 30;
const MAX_AI_BATCHES = 4;
/** Speech takes part of a block's length; the music fills the rest. */
const BLOCK_MUSIC_SHARE = 0.85;

function daytime(date: Date, timezone: string): string {
  const hour = Math.floor(localClock(date, timezone).minutes / 60);
  return hour < 5 ? 'Nacht' : hour < 11 ? 'Morgen' : hour < 14 ? 'Mittag' : hour < 18 ? 'Nachmittag' : hour < 22 ? 'Abend' : 'Nacht';
}

/** The show that follows in the schedule slot, for the host's hand-over at the end of a block. */
function nextShowName(config: StationConfig, show: ShowConfig, at: Date): string | undefined {
  const rotation = (activeSlot(config, at)?.showIds ?? []).map(id => scheduledShow(config, id)).filter((item): item is ShowConfig => !!item);
  const index = rotation.findIndex(item => item.id === show.id);
  const next = index >= 0 && rotation.length > 1 ? rotation[(index + 1) % rotation.length] : undefined;
  return next?.name;
}

/** Recent Spotify URIs of songs and blocks, and where the last block of this show left the group rotation. */
async function blockHistory(deps: StationDeps, owner: string, showId: string): Promise<{ uris: Set<string>; names: string[]; nextGroup: number }> {
  const uris = new Set<string>(), names: string[] = [];
  let nextGroup = 0;
  for (const row of await deps.store.recentItems(owner, 120)) {
    if (!row.script_json) continue;
    try {
      const pkg = JSON.parse(row.script_json) as Partial<HourPackage>;
      if (pkg.kind !== 'music_block' && pkg.kind !== 'song') continue;
      for (const part of pkg.parts ?? []) if (part.kind === 'track') {
        uris.add(part.uri);
        if (part.picked !== 'playlist') names.push(`${part.artist} – ${part.title}`);
      }
      if (pkg.kind === 'music_block' && row.show_id === showId && Number.isInteger(pkg.nextGroup)) nextGroup = pkg.nextGroup!;
    } catch { /* Skip corrupt rows. */ }
  }
  return { uris, names: [...new Set(names)].reverse(), nextGroup };
}

interface BlockTrack extends PlaylistTrack { group: number; picked: 'ai' | 'playlist' }

/**
 * A music block: songs from rotating groups – the owner's playlists or AI picks from a taste – with
 * short moderations where the triggers fire. Playlist tracks are shuffled in code and never reach an AI
 * provider; the host names only the AI's own picks. The whole block is produced ahead of time.
 */
async function produceMusicBlock(deps: StationDeps, owner: string, config: StationConfig, show: ShowConfig, row: TimelineRow,
  fail: (error: string) => Promise<'failed'>): Promise<ProduceOutcome> {
  if (row.state !== 'planned') return voiceParts(deps, owner, config, show.voiceId ?? config.host.voiceId, row, JSON.parse(row.script_json ?? 'null') as HourPackage);
  const groups = show.groups ?? [], triggers = show.triggers!;
  if (!deps.musicWriter) return fail('GEMINI_NOT_CONFIGURED');
  if (!deps.catalog) return fail('SPOTIFY_NOT_CONFIGURED');
  if (groups.some(group => group.playlists.length) && !deps.playlists) return fail('SPOTIFY_NOT_CONFIGURED');
  await deps.reserveGeneration(owner);
  const random = deps.random ?? Math.random;
  const history = await blockHistory(deps, owner, show.id);
  const reactions = await songHistory(deps, owner);
  const used = new Set(history.uris);
  const problems: string[] = [];

  // Each group's queue is filled when the group comes up: playlists are loaded and shuffled once,
  // AI groups ask for a batch of picks and keep those Spotify resolves.
  const queues = new Map<number, BlockTrack[]>(), exhausted = new Set<number>();
  let aiBatches = 0;
  const listens = deps.listening ? await deps.listening.topArtists(owner, deps.now()) : [];
  const refill = async (index: number, wanted: number) => {
    const group = groups[index], queue = queues.get(index) ?? [];
    queues.set(index, queue);
    if (group.playlists.length) {
      if (exhausted.has(index)) return;
      exhausted.add(index); // A playlist group is loaded once per block.
      const pool: PlaylistTrack[] = [];
      for (const id of group.playlists) {
        try { pool.push(...await deps.playlists!.tracks(owner, id)); }
        catch (error) { problems.push(`Playlist ${id}: ${error instanceof Error ? error.message : 'nicht lesbar'}`.slice(0, 120)); }
      }
      const fresh = [...new Map(pool.filter(track => track.durationMs > 0).map(track => [track.uri, track])).values()];
      // Unheard tracks first; when a playlist has been played through, it starts over.
      const unheard = fresh.filter(track => !used.has(track.uri));
      const candidates = unheard.length ? unheard : fresh;
      for (let i = candidates.length - 1; i > 0; i--) { const j = Math.floor(random() * (i + 1)); [candidates[i], candidates[j]] = [candidates[j], candidates[i]]; }
      queue.push(...candidates.map(track => ({ ...track, group: index, picked: 'playlist' as const })));
      return;
    }
    if (aiBatches >= MAX_AI_BATCHES) { exhausted.add(index); return; }
    aiBatches++;
    const picks = await deps.musicWriter!.pickSongs({
      taste: group.taste || config.music.taste, interests: [...config.profile.topics, ...config.profile.interests],
      avoid: [...history.names.slice(-60), ...[...queues.values()].flat().filter(track => track.picked === 'ai').map(track => `${track.artist} – ${track.title}`)], liked: reactions.liked, disliked: reactions.disliked,
      listens, announce: false, count: Math.min(15, wanted + 2), direction: { stationName: config.name, persona: config.host },
    });
    let found = 0;
    for (const pick of picks) {
      const track = await deps.catalog!.find(pick);
      if (!track || used.has(track.uri) || queue.some(item => item.uri === track.uri)) continue;
      queue.push({ ...track, title: pick.title, artist: pick.artist, group: index, picked: 'ai' }); found++;
    }
    if (!found) exhausted.add(index);
  };

  const musicTarget = show.targetMinutes * 60_000 * BLOCK_MUSIC_SHARE;
  const tracks: BlockTrack[] = [];
  const perGroup = show.switchAfterTracks || Math.ceil(show.targetMinutes / SONG_MINUTES);
  let current = history.nextGroup % groups.length, inGroup = 0, groupMs = 0, musicMs = 0;
  const switchGroup = () => { current = (current + 1) % groups.length; inGroup = 0; groupMs = 0; };
  while (musicMs < musicTarget && tracks.length < MAX_BLOCK_TRACKS) {
    if (groups.length > 1 && inGroup > 0 && ((show.switchAfterTracks && inGroup >= show.switchAfterTracks) || (show.switchAfterMinutes && groupMs >= show.switchAfterMinutes * 60_000))) switchGroup();
    let queue = queues.get(current);
    if (!queue?.length && !exhausted.has(current)) { await refill(current, Math.max(1, perGroup - inGroup)); queue = queues.get(current); }
    const track = queue?.shift();
    if (!track) {
      exhausted.add(current);
      if (groups.every((_, index) => exhausted.has(index) && !queues.get(index)?.length)) break;
      switchGroup();
      continue;
    }
    used.add(track.uri);
    const ms = track.durationMs || SONG_MINUTES * 60_000;
    tracks.push(track); inGroup++; groupMs += ms; musicMs += ms;
  }
  if (!tracks.length) return fail(`TOO_FEW_TRACKS: keine Songs für den Block${problems.length ? ` (${problems.join('; ')})` : ''}`);

  // Moments: index i means "before track i"; tracks.length is after the last track.
  const moments = new Map<number, BlockMoment>();
  const at = (index: number) => { let moment = moments.get(index); if (!moment) moments.set(index, moment = { triggers: [] }); return moment; };
  const named = (track: BlockTrack) => ({ artist: track.artist, title: track.title });
  if (triggers.blockStart) at(0).triggers.push('block_start');
  let aiCount = 0, sinceSpeech = 0;
  tracks.forEach((track, index) => {
    if (index > 0 && track.group !== tracks[index - 1].group && triggers.groupTransition) {
      Object.assign(at(index), { fromGroup: groups[tracks[index - 1].group].name, toGroup: groups[track.group].name }).triggers.push('group_transition');
    }
    if (triggers.everyMinutes && sinceSpeech >= triggers.everyMinutes * 60_000 && !moments.has(index)) at(index).triggers.push('interval');
    if (track.picked === 'ai') {
      if (triggers.beforeTrack && aiCount % triggers.beforeTrack === 0) Object.assign(at(index), { next: named(track) }).triggers.push('before_track');
      if (triggers.afterTrack && aiCount % triggers.afterTrack === triggers.afterTrack - 1) Object.assign(at(index + 1), { previous: named(track) }).triggers.push('after_track');
      aiCount++;
    }
    if (moments.has(index)) sinceSpeech = 0;
    sinceSpeech += track.durationMs;
  });
  if (triggers.blockEnd) at(tracks.length).triggers.push('block_end');
  // Every block has generated speech, even when no configured trigger fired (e.g. only playlist tracks).
  if (!moments.size) at(0).triggers.push('block_start');

  const positions = [...moments.keys()].sort((a, b) => a - b);
  const groupNames = [...new Set(tracks.map(track => groups[track.group].name))];
  const texts = await deps.musicWriter.writeBlock({
    blockName: show.name, groups: groupNames, nextShow: nextShowName(config, show, new Date(row.planned_at)),
    daytime: daytime(new Date(row.planned_at), config.timezone), talkSeconds: show.talkSeconds ?? 20,
    moments: positions.map(position => moments.get(position)!),
    direction: { instructions: show.instructions, stationName: config.name, persona: config.host },
  });
  if (!texts.some(Boolean)) throw new Error('Gemini block moderation returned nothing');
  const speechAt = new Map(positions.map((position, index) => [position, texts[index]]));
  const parts: Array<SpeechPart | TrackPart> = [];
  const speak = (position: number) => { const body = speechAt.get(position); if (body) parts.push(...splitSpeech(body).map(chunk => ({ kind: 'speech' as const, text: chunk, sourceIds: [] }))); };
  tracks.forEach((track, index) => {
    speak(index);
    parts.push({ kind: 'track', uri: track.uri, title: track.title, artist: track.artist, durationMs: track.durationMs, group: groups[track.group].name, picked: track.picked });
  });
  speak(tracks.length);
  const text = parts.flatMap(part => part.kind === 'speech' ? [part.text] : []).join(' ');
  const pkg: HourPackage = { kind: 'music_block', title: show.name, subject: groupNames.join(' → '), text, sourceIds: [], parts,
    nextGroup: (tracks.at(-1)!.group + 1) % groups.length };
  const spokenMs = text.split(/\s+/).length / 130 * 60_000;
  await deps.store.update(owner, row.id, { state: 'voicing', script_json: JSON.stringify(pkg), verification: 'off',
    estimated_minutes: Math.max(1, Math.round((musicMs + spokenMs) / 60_000)) }, deps.now());
  return voiceParts(deps, owner, config, show.voiceId ?? config.host.voiceId, { ...row, state: 'voicing' }, pkg);
}

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
  if (blockId === 'song') {
    const song = await scheduleShowNow(deps, owner, MUSIC_SHOW_ID);
    if (song) await placeAfter(deps, owner, song, after);
    return song;
  }
  // The owner's own shows are blocks too ("show:<id>"); music hours among them take a subject.
  const own = blockId.startsWith(SHOW_BLOCK) ? config.shows.find(show => show.id === blockId.slice(SHOW_BLOCK.length)) : undefined;
  const block = own ? undefined : BLOCKS.find(item => item.id === blockId);
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

/** Moves a new item right after [after] (the item that is playing), or to the start of the program. */
async function placeAfter(deps: StationDeps, owner: string, id: string, after?: string) {
  const others = (await deps.store.openItems(owner)).map(item => item.id).filter(item => item !== id);
  const at = after ? others.indexOf(after) + 1 : 0;
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

export function toView(row: TimelineRow, config: StationConfig | null): TimelineItemView {
  let script: Partial<Script> = {}, sources: Source[] = [];
  try { script = JSON.parse(row.script_json ?? '{}'); } catch { /* Keep the item visible without details. */ }
  try { sources = JSON.parse(row.sources_json ?? '[]'); } catch { /* Keep the item visible without sources. */ }
  let queries: string[] = [];
  let team: TimelineItemView['team'];
  try { ({ queries = [], team } = JSON.parse(row.research_json ?? '{}') as { queries?: string[]; team?: TimelineItemView['team'] }); } catch { /* Research details are optional. */ }
  return {
    id: row.id, seq: row.seq, showId: row.show_id,
    showName: row.show_id === MUSIC_SHOW_ID ? 'Musik' : config?.shows.find(show => show.id === row.show_id)?.name ?? blockOf(row.show_id)?.name ?? row.show_id,
    plannedAt: row.planned_at, state: row.state, estimatedMinutes: row.estimated_minutes, updatedAt: row.updated_at,
    ...(script.title ? { title: script.title } : {}),
    ...(sources.length ? { sources: sources.map(source => ({ title: source.title, url: source.url })) } : {}),
    ...(script.interestTags?.length ? { interestTags: script.interestTags } : {}),
    ...(row.verification ? { verification: row.verification as VerificationPolicy } : {}),
    ...(queries.length ? { searchQueries: queries } : {}),
    ...(team ? { team } : {}),
    ...(row.error ? { error: row.error } : {}),
    ...(hourView(row, script as Partial<HourPackage>) ?? (row.audio_key && row.state !== 'expired' ? { audioUrl: `api/timeline/${row.id}/audio` } : {})),
  };
}

/** What was said in an item, for reading along: spoken text (dialogs by speaker, hours with their songs) and sources. */
export interface TranscriptView {
  title: string;
  lines: Array<{ speaker?: string; text: string; song?: boolean }>;
  sources: Array<{ title: string; url: string }>;
}

export function transcriptView(row: TimelineRow, config: StationConfig | null): TranscriptView {
  let script: Partial<Script> & Partial<HourPackage> = {}, sources: Source[] = [];
  try { script = JSON.parse(row.script_json ?? '{}'); } catch { /* No text yet. */ }
  try { sources = JSON.parse(row.sources_json ?? '[]'); } catch { /* No sources. */ }
  const host = config?.host.name ?? 'Moderation', cohost = config?.host.cohostName ?? 'Co-Moderation';
  let lines: TranscriptView['lines'];
  if (Array.isArray(script.parts)) {
    lines = script.parts.map(part => part.kind === 'track'
      ? { text: `${part.title} – ${part.artist}`, song: true }
      : { text: part.text });
  } else if (Array.isArray(script.turns)) {
    lines = script.turns.map(turn => ({ speaker: turn.speaker === 'host-b' ? cohost : host, text: turn.text }));
  } else lines = script.text ? [{ text: script.text }] : [];
  return {
    title: script.title ?? config?.shows.find(show => show.id === row.show_id)?.name ?? blockOf(row.show_id)?.name ?? row.show_id,
    lines: lines.filter(line => line.text?.trim()),
    sources: sources.map(source => ({ title: source.title, url: source.url })),
  };
}

function hourView(row: TimelineRow, pkg: Partial<HourPackage>): Pick<TimelineItemView, 'parts' | 'focus' | 'subject' | 'artist'> | null {
  if ((pkg.kind !== 'music_hour' && pkg.kind !== 'artist_hour' && pkg.kind !== 'song' && pkg.kind !== 'music_block') || !Array.isArray(pkg.parts)) return null;
  // Released audio (after the retention period) leaves the parts without URLs.
  const playable = row.state !== 'expired' && !!row.audio_key, focus = packageFocus(pkg), subject = packageSubject(pkg);
  return {
    ...(pkg.kind === 'song' || pkg.kind === 'music_block' ? { subject } : { focus, subject, ...(focus === 'artist' ? { artist: subject } : {}) }),
    parts: pkg.parts.map((part, index) => part.kind === 'track'
      ? { kind: 'track' as const, spotifyUri: part.uri, title: part.title, artist: part.artist, durationMs: part.durationMs }
      : { kind: 'speech' as const, ...(playable && part.audioKey ? { audioUrl: `api/timeline/${row.id}/audio?part=${index}` } : {}) }),
  };
}
