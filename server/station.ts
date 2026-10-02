// Server-only program runtime: plans the timeline and produces its segments without an open browser.
import { HOUR_FOCUS, MUSIC_SHOW_ID, SONG_MINUTES, activeSlot, bringsOwnMusic, hourSubject, isMusicHour, localClock, stationSounds } from '../src/domain/station.ts';
import type { HourFocus, ShowConfig, StationConfig, TextProvider, TimelineItemView, VerificationPolicy } from '../src/domain/station.ts';
import type { Profile, QualityScore, Script, Source, TextGenerator } from '../src/domain/program.ts';
import { learnedWeights, rankCandidates } from '../src/domain/recommendation.ts';
import type { FeedItem } from './feed.ts';
import { ProviderError, TTS_PARALLEL, withoutVoiceTags } from './providers.ts';
import { KIDS_RULES } from './listeners.ts';
import { MAX_EPISODES, MIN_EPISODES, OUTLINE_SOURCE_ID, SERIES_EPISODES, SERIES_PREFIX, episodeRefOf, episodeShow, outlinePrompt, parseOutline, recapOf, seriesBlock } from '../src/domain/series.ts';
import type { EpisodeRef, Series, SeriesKind } from '../src/domain/series.ts';
import { CHOICE_PROMPT, CHOICE_WAIT_HOURS, QUIZ_PROMPT, parseChoice, parseQuiz, quizSpeech } from '../src/domain/play.ts';
import type { Quiz, StoryChoice } from '../src/domain/play.ts';
import { MIN_REVIEW_ITEMS, REVIEW_DAYS, REVIEW_SHOW, reviewSources, reviewable } from './review.ts';
import type { WeekExtras } from './review.ts';
import { ANSWER_PROMPT, NOVELTY_PROMPT, parseAnswer, parseNovelty } from './follow.ts';
import type { FollowStore } from './follow.ts';
import { featureOn } from '../src/domain/features.ts';
import { clockValues, expandPlaceholders, usesHeadlines, usesWeather } from './tools.ts';
import { finishScript, repairScript } from './editing.ts';
import type { ScriptEditor, StationContext } from './editing.ts';
import { BLOCKS, BLOCK_PREFIX, SURPRISE_ID, WILDCARD, WILDCARD_TASTES, blockOf, blockShow, drawSurprise, isSurprise, surpriseChance, surpriseLevel } from '../src/domain/blocks.ts';
import { agentOf, resolveAgents } from '../src/domain/agents.ts';
import { applyMood } from '../src/domain/mood.ts';
import type { AgentConfig } from '../src/domain/agents.ts';
import { NOTE_WINDOW_DAYS, listenerNotes } from '../src/domain/listener-notes.ts';
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
  /** Final edit and quality jury for spoken items. */
  editor?: ScriptEditor;
  /** Tool: the weather for `{wetter}` (Open-Meteo). */
  weather?: Weather;
  /** The owner's Spotify top artists, when the owner connected the listening profile. */
  listening?: { topArtists(owner: string, now: Date): Promise<string[]> };
  /** The editorial team's model and durable step storage (music hours with `production: agents`). */
  agentModel?: JsonModel;
  agentSteps?(owner: string, runId: string): DurableStepRunner & { clear(): Promise<void> };
  /** Wochenrückblick: questions to the radio and stickers since a date. */
  week?(owner: string, since: Date): Promise<WeekExtras>;
  /** Dranbleiben: the topics the listener follows. */
  follows?: Pick<FollowStore, 'due' | 'get' | 'checked' | 'reported'>;
  now(): Date;
  random?(): number;
  newId?(): string;
}

const LEASE_MINUTES = 10;
const MAX_ATTEMPTS = 3;
const MAX_NEW_ITEMS = 12;
const STALE_HOURS = 12;
/** Time-bound items leave the program when their planned air time is this far in the past. */
const TIMELY_HOURS = 2;
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
  const expired = await deps.store.expire(owner, minutes(now, -STALE_HOURS * 60), now);
  // Time-bound items (weather, headlines, date, a music block's time of day) that missed their air time
  // by hours no longer fit: finished ones move to the archive, and the planner makes fresh ones.
  for (const row of await deps.store.openItems(owner)) {
    if ((row.state !== 'ready' && row.state !== 'voicing') || Date.parse(row.planned_at) > now.getTime() - TIMELY_HOURS * 3_600_000 || !timeBound(row, config)) continue;
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

/** What comes before an item: for the bridge into it and the station ident after music. */
async function stationContext(deps: StationDeps, owner: string, config: StationConfig, row: TimelineRow, now: Date): Promise<StationContext> {
  const air = airTime(row, now), clock = clockValues(air, config.timezone);
  const previous = await deps.store.previousItem(owner, row.seq);
  const before = previous ? toView(previous, config) : undefined;
  const musical = !!previous && (previous.show_id === MUSIC_SHOW_ID || bringsOwnMusic((config.shows.find(show => show.id === previous.show_id) ?? blockOf(previous.show_id)?.show)?.format ?? 'brief'));
  return { stationName: config.name, when: `${clock.wochentag}, am ${daytime(air, config.timezone)}`, afterMusic: musical,
    ...(stationSounds(config).linker ? { live: true } : {}),
    ...(before && previous!.show_id !== MUSIC_SHOW_ID ? { previous: before.title ?? before.showName } : {}) };
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
    const found = await deps.researcher.research({ brief: `Die wichtigsten Nachrichten von heute${date ? `, ${date}` : ''}: sechs Schlagzeilen aus der Schweiz und der Welt, jeweils mit einem Satz Einordnung.`, interests: [], avoidTopics: [], now, agent: agentOf(resolveAgents(config.agents), 'research') });
    sources = found.sources.slice(0, 6).map((source, index) => ({ ...source, id: `h${index + 1}` }));
  }
  return { text: sources.map(source => `– ${source.title}`).join('\n'), sources };
}

/** The owner's repeated reasons for 👎 in the last weeks, as notes for the prompts. */
async function notesFor(deps: StationDeps, owner: string, now: Date): Promise<string[]> {
  return listenerNotes(await deps.store.reasonCounts(owner, new Date(now.getTime() - NOTE_WINDOW_DAYS * 86_400_000)));
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
  const agents = resolveAgents(config.agents);
  const row = await deps.store.lease(owner, itemId, now, minutes(now, LEASE_MINUTES));
  if (!row) return 'skipped';
  const fail = async (error: string) => { await deps.store.update(owner, row.id, { state: 'failed', lease_until: null, error }, deps.now()); return 'failed' as const; };
  // A building block added from the app is produced with its template.
  const block = blockOf(row.show_id);
  let configured = config.shows.find(item => item.id === row.show_id) ?? (block ? blockShow(block, config, requestedHourSubject(row) ?? wildcardTaste(block.id, deps)) : undefined);
  // An episode of a series is produced from the series: its step (knowledge) or its chapter (story).
  const episode = row.show_id.startsWith(SERIES_PREFIX) ? episodeRefOf(row.research_json) : null;
  let seriesSources: Source[] = [];
  let storyChoice: StoryChoice | null = null;
  const followId = followOf(row);
  let followed: { id: number; topic: string; known: string; createdAt: string; reportedAt: string | null } | null = null, followNote = '';
  if (row.show_id.startsWith(SERIES_PREFIX)) {
    const series = episode ? await deps.store.getSeries(owner, episode.series) : null;
    if (!series || !episode || !series.episodes[episode.episode]) return fail('SERIES_REMOVED');
    // A Mitmach-Geschichte ends each episode but the last with a choice, planned before the episode is written.
    if (series.interactive && row.state === 'planned' && episode.episode < series.episodes.length - 1) {
      storyChoice = series.choices?.[episode.episode] ?? await planChoice(deps, series, episode.episode, config);
      if (storyChoice && !series.choices?.[episode.episode]) {
        const choices = [...(series.choices ?? [])];
        while (choices.length <= episode.episode) choices.push(null);
        choices[episode.episode] = storyChoice;
        await deps.store.updateSeries(owner, series.id, { choices }, now);
      }
    }
    const built = episodeShow(series, episode.episode, now, kidsRules(config), storyChoice);
    // Without the dialog voices a knowledge episode is told by the host alone.
    configured = built.show.format === 'podcast' && !deps.podcastAvailable ? { ...built.show, format: 'brief' } : built.show;
    seriesSources = built.sources;
  }
  if (!configured && row.show_id !== MUSIC_SHOW_ID) return fail('SHOW_REMOVED');
  try {
    // Tools (switched on per show, or as placeholders like {wetter}) are filled in once per production;
    // weather and headlines also become sources, so the writer can cite them.
    let show = configured, toolSources: Source[] = [...seriesSources];
    if (configured) {
      // Items are produced ahead: date and time of day are those of the expected air time, and the
      // speech never names a clock time (the live time signal in the app does that).
      const air = airTime(row, now), values = clockValues(air, config.timezone, config.location);
      values.uhrzeit = daytime(air, config.timezone);
      const tools = new Set(configured.tools ?? []);
      if (usesWeather(configured)) tools.add('weather');
      if (usesHeadlines(configured)) tools.add('headlines');
      const notes: string[] = [];
      if (tools.has('clock')) notes.push(`Heute ist ${values.wochentag}, ${values.datum}; der Beitrag läuft voraussichtlich am ${values.uhrzeit}.`);
      // Only a new draft needs fresh information; a retry of the voice keeps the approved script.
      if (row.state === 'planned') {
        // The Wochenrückblick is written from the week's heard items, questions and stickers.
        if (row.show_id === REVIEW_SHOW) {
          const since = new Date(now.getTime() - REVIEW_DAYS * 86_400_000);
          toolSources.push(...reviewSources(await deps.store.heardSince(owner, since), await deps.week?.(owner, since) ?? { questions: [], stickers: [] }, now));
        }
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
      let researchPrompt = expandPlaceholders(configured.researchPrompt, values);
      // «Mehr dazu»: the item it deepens gives its sources and what was already said.
      const parentId = followUpOf(row);
      if (parentId && row.state === 'planned') {
        const parent = await deps.store.getItem(owner, parentId);
        let said: Script | undefined, before: Source[] = [];
        try { said = JSON.parse(parent?.script_json ?? 'null') ?? undefined; before = JSON.parse(parent?.sources_json ?? '[]'); } catch { /* Handled below. */ }
        if (!said?.title || typeof said.text !== 'string') return fail('FOLLOW_UP_WITHOUT_ITEM');
        const parentSources = before.slice(0, 6).map((source, index) => ({ ...source, id: `p${index + 1}`, excerpt: source.excerpt.slice(0, 2500) }));
        toolSources.push(...parentSources);
        notes.push(`Der vorherige Beitrag hiess «${said.title}» und sagte bereits: «${said.text.replace(/\s+/g, ' ').slice(0, 1500)}». Wiederhole das nicht, sondern gehe tiefer.${parentSources.length ? ` Seine Quellen stehen in «p1» bis «p${parentSources.length}».` : ''}`);
        researchPrompt = `Recherchiere Hintergründe, Ursachen, Folgen und neue Aspekte zu «${said.title}», die über einen kurzen Nachrichtenbeitrag hinausgehen.`;
      }
      // Dranbleiben: research what is new about the topic since the last report.
      if (followId !== undefined && row.state === 'planned') {
        followed = await deps.follows?.get(owner, followId) ?? null;
        if (!followed) return fail('FOLLOW_REMOVED');
        const since = followSince(followed);
        researchPrompt = `Neue Entwicklungen zu «${followed.topic}» seit dem ${since.toISOString().slice(0, 10)}: was ist passiert, was wurde entschieden, was ist neu bekannt geworden? Nur Meldungen aus dieser Zeit.`;
      }
      // Konzerte: where the listener's Spotify top artists play soon (only artist names go to the AI).
      if (row.show_id === CONCERT_SHOW && row.state === 'planned') {
        const artists = (await deps.listening?.topArtists(owner, now).catch(() => []) ?? []).slice(0, 15);
        if (!artists.length) return fail('NO_ARTISTS');
        researchPrompt = `Angekündigte Konzerte in den nächsten vier Monaten in der Schweiz, möglichst nahe bei ${config.location?.name ?? 'Bern'} (etwa Bern, Zürich, Basel, Luzern), ` +
          `von diesen Künstlern: ${artists.join(', ')}. Nur bestätigte Termine mit Datum, Stadt und Halle.`;
      }
      const instructions = [expandPlaceholders(configured.instructions, values), ...notes].filter(Boolean).join(' ');
      show = { ...configured, instructions, researchPrompt };
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
      // A look back talks about the recent topics on purpose.
      const avoidTopics = row.show_id === REVIEW_SHOW ? [] : await recentTopics(deps, owner);
      let sources: Source[], queries: string[] = [];
      if (show.sourceMode === 'web') {
        ({ sources, queries } = await deps.researcher!.research({ brief: show.researchPrompt, interests: [...profile.topics, ...profile.interests], avoidTopics, now, agent: agentOf(agents, 'research') }));
      } else sources = await collectSources(deps, owner, config, show, profile);
      // Mark sources before drafting: a rejected article is not retried endlessly at provider cost.
      await deps.store.markCovered(owner, sources.map(source => source.url), now);
      // Tool results are evidence too; a show can live on them alone (a weather report).
      sources = [...toolSources, ...sources];
      if (!sources.length) return fail('NO_SOURCES');
      // Dranbleiben says nothing when there is nothing new: the check leaves the program quietly.
      if (followed) {
        const novelty = deps.agentModel ? parseNovelty(await deps.agentModel.askJson(NOVELTY_PROMPT, {
          thema: followed.topic, seit: followSince(followed).toISOString().slice(0, 10), bisher: followed.known || 'noch nichts',
          quellen: sources.slice(0, 8).map(source => ({ id: source.id, titel: source.title, datum: source.publishedAt, text: source.excerpt.slice(0, 1500) })),
        }, 'Gemini follow check', 0.2)) : { neu: true, was: '' };
        if (!novelty.neu) {
          await deps.store.update(owner, row.id, { state: 'expired', lease_until: null, error: 'NOTHING_NEW' }, deps.now());
          return 'skipped';
        }
        followNote = `Das Thema ist «${followed.topic}». Bisher bekannt: ${followed.known || 'noch nichts'}. Neu ist: ${novelty.was}`;
        followed.known = novelty.was;
      }
      const direction = { instructions: [show.instructions, followNote].filter(Boolean).join(' '), targetMinutes: show.targetMinutes, stationName: config.name, persona: config.host, avoidTopics, agents,
        listenerNotes: await notesFor(deps, owner, now), ...(episode?.kind === 'geschichte' ? { story: true } : {}) };
      let script = await deps.pipeline.draft(profile, sources, show.format === 'podcast' ? 'podcast' : 'brief', direction, generator);
      // Final desk: rewrite for the ear, connect to the program, score; facts are checked on the final text.
      const context = await stationContext(deps, owner, config, row, now);
      if (deps.editor) script = await finishScript(deps.editor, script, sources, direction, context);
      try { await deps.pipeline.review(script, sources, show.verification, agentOf(agents, 'verifier').instructions); }
      catch (error) {
        // A rejected script gets one repair: the editor drops or narrows the unsupported claims, then the check runs again.
        if (!(error instanceof PipelineError) || error.code !== 'REJECTED' || !deps.editor) throw error;
        const repaired = await repairScript(deps.editor, script, sources, direction, context, error.detail ?? '');
        if (repaired === script) throw error;
        script = repaired;
        await deps.pipeline.review(script, sources, show.verification, agentOf(agents, 'verifier').instructions);
      }
      if (script.quality) await deps.store.logQuality(owner, { itemId: row.id, showId: row.show_id, overall: script.quality.overall, at: now });
      // On a child's station a knowledge item ends with a quiz question, spoken and answered in the app.
      const quiz = kidsRules(config) && featureOn(config, 'quiz') && episode?.kind !== 'geschichte' && show.verification !== 'off' && show.targetMinutes >= 3 ? await writeQuiz(deps, script) : null;
      if (quiz) script = withQuiz(script, quiz);
      // The research record keeps what the item already carries (a requested subject, its series).
      const kept = (() => { try { return JSON.parse(row.research_json ?? 'null') ?? {}; } catch { return {}; } })() as Record<string, unknown>;
      const research = { ...kept, ...(queries.length ? { queries } : {}), ...(storyChoice ? { choice: storyChoice } : {}), ...(quiz ? { quiz } : {}) };
      const patch = { state: 'voicing' as const, script_json: JSON.stringify(script), sources_json: JSON.stringify(sources), verification: show.verification,
        research_json: Object.keys(research).length ? JSON.stringify(research) : null };
      await deps.store.update(owner, row.id, patch, deps.now());
      if (episode) await rememberEpisode(deps, owner, episode, script);
      if (followed) await deps.follows?.reported(owner, followed.id, followed.known, deps.now());
      current = { ...current, ...patch };
    }
    const script = JSON.parse(current.script_json ?? 'null') as Script;
    const format = script.turns ? 'podcast' : 'brief';
    // The show's own voice wins; otherwise the host persona speaks.
    // Dialogs speak with the host's and the co-host's voice; a brief with the show's own voice, else the host's.
    const voiced = await deps.pipeline.voice(owner, script, format, format === 'brief' ? show.voiceId ?? config.host.voiceId : undefined, config.host.voiceStyle,
      { bed: stationSounds(config).musicBed, ...(format === 'podcast' ? { voices: [config.host.voiceId, config.host.cohostVoiceId] } : {}) });
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
interface TrackPart { kind: 'track'; uri: string; title: string; artist: string; durationMs: number; imageUrl?: string; reason?: string; group?: string; picked?: 'ai' | 'playlist' | 'release' }
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
  const now = deps.now(), agents = resolveAgents(config.agents);
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
      ({ sources, queries } = await deps.researcher.research({ brief, interests: [subject], avoidTopics: [], now, agent: agentOf(agents, 'research') }));
      if (!sources.length) ({ sources, queries } = await deps.researcher.research({ brief: `Suche mit Google nach: ${subject}. ${brief}`, interests: [subject], avoidTopics: [], now, agent: agentOf(agents, 'research') }));
    }
    const direction = { instructions: show.instructions, stationName: config.name, persona: config.host, avoidTopics: await recentTopics(deps, owner), agents, listenerNotes: await notesFor(deps, owner, now) };
    let resolved: Array<{ pick: TrackPick; uri: string; durationMs: number; imageUrl?: string }>;
    let hour: HourScript;
    let team: { songs: number; specialists: number; corrections: number } | undefined;
    if (show.production === 'agents') {
      // The editorial team researches, plans, writes, checks and edits in durable steps.
      if (!deps.agentModel) return fail('GEMINI_NOT_CONFIGURED');
      const steps = deps.agentSteps?.(owner, row.id) ?? memorySteps();
      const result = await produceWithTeam({ runId: row.id, ownerId: owner, steps,
        tools: { model: deps.agentModel, researcher: deps.researcher, catalog: deps.catalog, now: deps.now, agents },
        request: { focus, subject, count: show.tracks ?? 10, talkSeconds: show.talkSeconds ?? 60, instructions: show.instructions, researchPrompt: show.researchPrompt, direction } });
      if (!result.ok) { await steps.clear(); return fail(result.error); }
      sources = result.sources; queries = result.queries; hour = result.script;
      resolved = result.songs.map(song => ({ pick: { title: song.title, artist: song.artist, reason: song.role, ...(song.album ? { album: song.album } : {}), ...(song.year ? { year: song.year } : {}) }, uri: song.uri, durationMs: song.durationMs, ...(song.imageUrl ? { imageUrl: song.imageUrl } : {}) }));
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
        interests: [subject], avoidTopics: [], now, agent: agentOf(agents, 'research'),
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
    await deps.pipeline.review({ title: hour.title, text, sourceIds }, sources, verification, agentOf(agents, 'verifier').instructions);
    const speech = (part: { text: string; sourceIds: string[] }): SpeechPart[] => splitSpeech(part.text).map(chunk => ({ kind: 'speech', text: chunk, sourceIds: part.sourceIds }));
    const parts: Array<SpeechPart | TrackPart> = [...speech(hour.intro)];
    resolved.forEach((item, index) => {
      const moderation = hour.tracks.find(track => track.index === index);
      if (moderation) parts.push(...speech(moderation));
      parts.push({ kind: 'track', uri: item.uri, title: item.pick.title, artist: item.pick.artist, durationMs: item.durationMs, ...(item.imageUrl ? { imageUrl: item.imageUrl } : {}), reason: item.pick.reason });
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
  const open = [...pkg.parts.entries()].filter(([, part]) => part.kind === 'speech' && !part.audioKey);
  // A few parts at a time; progress is stored after each batch, so a retry voices only what is missing.
  for (let start = 0; start < open.length; start += TTS_PARALLEL) {
    const batch = open.slice(start, start + TTS_PARALLEL);
    const settled = await Promise.allSettled(batch.map(async ([index, part]) => {
      const speech = part as SpeechPart;
      const audio = await deps.pipeline.voice(owner, { title: pkg.title, text: speech.text, sourceIds: speech.sourceIds.length ? speech.sourceIds : pkg.sourceIds }, 'brief', voiceId, config.host.voiceStyle, { bed: stationSounds(config).musicBed });
      const key = `segments/${row.id}-${index}.${audio.contentType === 'audio/wav' ? 'wav' : 'mp3'}`;
      await deps.audio.put(key, audio.audio, { httpMetadata: { contentType: audio.contentType } });
      return { part: speech, key, contentType: audio.contentType };
    }));
    // What was voiced is kept even when another part of the batch failed; the failure then ends this round.
    const voiced = settled.flatMap(result => result.status === 'fulfilled' ? [result.value] : []);
    for (const { part, key, contentType } of voiced) { part.audioKey = key; part.contentType = contentType; }
    if (voiced.length) {
      // The first key marks the row as holding audio, so retention and cleanup find it.
      const first = voiced[0].key;
      await deps.store.update(owner, row.id, { script_json: JSON.stringify(pkg), audio_key: row.audio_key ?? first }, deps.now());
      row = { ...row, audio_key: row.audio_key ?? first };
    }
    const failed = settled.find(result => result.status === 'rejected');
    if (failed) throw (failed as PromiseRejectedResult).reason;
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
      liked: history.liked, disliked: history.disliked, announce: config.music.announce, listens, surprise: surpriseLevel(config),
      direction: { stationName: config.name, persona: config.host, agents: resolveAgents(config.agents) },
    });
    let chosen: { pick: SongPick; uri: string; durationMs: number; imageUrl?: string } | null = null;
    for (const pick of picks) {
      const track = await deps.catalog.find(pick);
      if (track) { chosen = { pick, ...track }; break; }
    }
    if (!chosen) return fail(`TOO_FEW_TRACKS: 0 von ${picks.length} Songs auf Spotify gefunden`);
    const title = `${chosen.pick.artist} – ${chosen.pick.title}`;
    const intro: SpeechPart[] = config.music.announce && chosen.pick.announcement ? [{ kind: 'speech', text: chosen.pick.announcement, sourceIds: [] }] : [];
    pkg = { kind: 'song', title, subject: title, text: chosen.pick.announcement, sourceIds: [],
      parts: [...intro, { kind: 'track', uri: chosen.uri, title: chosen.pick.title, artist: chosen.pick.artist, durationMs: chosen.durationMs, ...(chosen.imageUrl ? { imageUrl: chosen.imageUrl } : {}) }] };
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

/** Items whose content belongs to their time: live tools, placeholders, or a music block's time-of-day moderation. */
function timeBound(row: TimelineRow, config: StationConfig): boolean {
  const show = config.shows.find(item => item.id === row.show_id) ?? blockOf(row.show_id)?.show;
  if (!show) return false;
  return !!show.tools?.length || usesWeather(show as ShowConfig) || usesHeadlines(show as ShowConfig) || /\{(datum|wochentag|uhrzeit)\}/i.test(`${show.instructions} ${show.researchPrompt}`) || show.format === 'music_block';
}

/** The music wildcard draws its taste when it is produced. */
function wildcardTaste(blockId: string, deps: StationDeps): string | undefined {
  return blockId === WILDCARD ? WILDCARD_TASTES[Math.floor((deps.random ?? Math.random)() * WILDCARD_TASTES.length)] : undefined;
}

/** When an item is expected on air: its planned time, or now when that has passed. */
function airTime(row: TimelineRow, now: Date): Date {
  const planned = Date.parse(row.planned_at);
  return Number.isFinite(planned) && planned > now.getTime() ? new Date(planned) : now;
}

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
        if (part.picked === 'ai' || !part.picked) names.push(`${part.artist} – ${part.title}`);
      }
      if (pkg.kind === 'music_block' && row.show_id === showId && Number.isInteger(pkg.nextGroup)) nextGroup = pkg.nextGroup!;
    } catch { /* Skip corrupt rows. */ }
  }
  return { uris, names: [...new Set(names)].reverse(), nextGroup };
}

interface BlockTrack extends PlaylistTrack { group: number; picked: 'ai' | 'playlist' | 'release' }

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
  if (groups.some(group => group.playlists.length || group.releases) && !deps.playlists) return fail('SPOTIFY_NOT_CONFIGURED');
  if (groups.some(group => group.releases) && !deps.playlists?.releases) return fail('SPOTIFY_NOT_CONFIGURED');
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
    if (group.playlists.length || group.releases) {
      if (exhausted.has(index)) return;
      exhausted.add(index); // A playlist group is loaded once per block.
      const pool: PlaylistTrack[] = [], releases = new Set<string>();
      if (group.releases) {
        try { for (const track of await deps.playlists!.releases!(owner)) { pool.push(track); releases.add(track.uri); } }
        catch (error) { problems.push(`Neuerscheinungen: ${error instanceof Error ? error.message : 'nicht lesbar'}`.slice(0, 160)); }
      }
      for (const id of group.playlists) {
        try { pool.push(...await deps.playlists!.tracks(owner, id)); }
        catch (error) { problems.push(`Playlist ${id}: ${error instanceof Error ? error.message : 'nicht lesbar'}`.slice(0, 120)); }
      }
      const fresh = [...new Map(pool.filter(track => track.durationMs > 0).map(track => [track.uri, track])).values()];
      // Unheard tracks first; when a playlist has been played through, it starts over.
      const unheard = fresh.filter(track => !used.has(track.uri));
      const candidates = unheard.length ? unheard : fresh;
      // Releases stay newest first; playlists are shuffled.
      if (!group.releases) for (let i = candidates.length - 1; i > 0; i--) { const j = Math.floor(random() * (i + 1)); [candidates[i], candidates[j]] = [candidates[j], candidates[i]]; }
      // New releases are named in the moderation (the owner's decision, 29.09.2026); playlist tracks never are.
      queue.push(...candidates.map(track => ({ ...track, group: index, picked: releases.has(track.uri) ? 'release' as const : 'playlist' as const })));
      return;
    }
    if (aiBatches >= MAX_AI_BATCHES) { exhausted.add(index); return; }
    aiBatches++;
    const picks = await deps.musicWriter!.pickSongs({
      taste: group.taste || config.music.taste, interests: [...config.profile.topics, ...config.profile.interests],
      avoid: [...history.names.slice(-60), ...[...queues.values()].flat().filter(track => track.picked === 'ai').map(track => `${track.artist} – ${track.title}`)], liked: reactions.liked, disliked: reactions.disliked,
      listens, announce: false, count: Math.min(15, wanted + 2), surprise: surpriseLevel(config), direction: { stationName: config.name, persona: config.host, agents: resolveAgents(config.agents) },
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
  const named = (track: BlockTrack) => ({ artist: track.artist, title: track.title, ...(track.picked === 'release' ? { release: true } : {}) });
  if (triggers.blockStart) at(0).triggers.push('block_start');
  let aiCount = 0, sinceSpeech = 0;
  tracks.forEach((track, index) => {
    if (index > 0 && track.group !== tracks[index - 1].group && triggers.groupTransition) {
      Object.assign(at(index), { fromGroup: groups[tracks[index - 1].group].name, toGroup: groups[track.group].name }).triggers.push('group_transition');
    }
    if (triggers.everyMinutes && sinceSpeech >= triggers.everyMinutes * 60_000 && !moments.has(index)) at(index).triggers.push('interval');
    if (track.picked !== 'playlist') {
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
    daytime: daytime(airTime(row, deps.now()), config.timezone), talkSeconds: show.talkSeconds ?? 20,
    moments: positions.map(position => moments.get(position)!),
    direction: { instructions: show.instructions, stationName: config.name, persona: config.host, agents: resolveAgents(config.agents) },
  });
  if (!texts.some(Boolean)) throw new Error('Gemini block moderation returned nothing');
  const speechAt = new Map(positions.map((position, index) => [position, texts[index]]));
  const parts: Array<SpeechPart | TrackPart> = [];
  const speak = (position: number) => { const body = speechAt.get(position); if (body) parts.push(...splitSpeech(body).map(chunk => ({ kind: 'speech' as const, text: chunk, sourceIds: [] }))); };
  tracks.forEach((track, index) => {
    speak(index);
    parts.push({ kind: 'track', uri: track.uri, title: track.title, artist: track.artist, durationMs: track.durationMs, ...(track.imageUrl ? { imageUrl: track.imageUrl } : {}), group: groups[track.group].name, picked: track.picked });
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
async function addSurprise(deps: StationDeps, owner: string, config: StationConfig, after?: string, avoid?: string): Promise<string> {
  const random = deps.random ?? Math.random;
  const block = drawSurprise(config, random, avoid);
  const now = deps.now(), last = await deps.store.lastItem(owner);
  const id = (deps.newId ?? (() => crypto.randomUUID()))();
  await deps.store.insertItem(owner, { id, seq: (last?.seq ?? 0) + 1, showId: `${BLOCK_PREFIX}${block.id}`, plannedAt: now.toISOString(), estimatedMinutes: block.show.targetMinutes }, now);
  await placeAfter(deps, owner, id, after);
  return id;
}

/** A child's station carries its rules in the host's instructions; series take them over. */
const kidsRules = (config: StationConfig) => config.host.instructions.includes(KIDS_RULES) ? KIDS_RULES : '';

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
async function scheduleEpisode(deps: StationDeps, owner: string, series: Series, index: number, after?: string): Promise<string> {
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
async function rememberEpisode(deps: StationDeps, owner: string, episode: EpisodeRef, script: Script) {
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
async function advanceSeries(deps: StationDeps, owner: string) {
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

/**
 * On Sunday from eight in the morning (station time), the Wochenrückblick joins the program once: when
 * none was made in the last six days and at least three spoken items were heard this week.
 */
async function planWeekReview(deps: StationDeps, owner: string, config: StationConfig) {
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

const FOLLOW_SHOW = `${BLOCK_PREFIX}dranbleiben`, CONCERT_SHOW = `${BLOCK_PREFIX}konzerte`, ANSWER_SHOW = `${BLOCK_PREFIX}nachfrage`;

function followOf(row: TimelineRow): number | undefined {
  if (row.show_id !== FOLLOW_SHOW) return undefined;
  try { const value = (JSON.parse(row.research_json ?? '{}') as { follow?: unknown }).follow; return Number.isInteger(value) ? value as number : undefined; }
  catch { return undefined; }
}

/** What is new since: the last report, else a week before the topic was followed. */
const followSince = (topic: { createdAt: string; reportedAt: string | null }) =>
  new Date(topic.reportedAt ? Date.parse(topic.reportedAt) : Date.parse(topic.createdAt) - 7 * 86_400_000);

/** Dranbleiben: during the day, topics not checked for a day get a check (it stays quiet when nothing is new). */
async function planFollowChecks(deps: StationDeps, owner: string, config: StationConfig) {
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
async function planConcerts(deps: StationDeps, owner: string, config: StationConfig) {
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

const PLACE_SHOW = `${BLOCK_PREFIX}ortsgeschichte`;
/** At most this many place stories a day; the same place is told once a month. */
export const PLACES_PER_DAY = 6, PLACE_REPEAT_DAYS = 30;

/**
 * Ortsgeschichten: the listener passes [place] (named by the Worker from the app's location). Its story is
 * put into the program soon – unless it was told this month or the day's stories are used up.
 */
export async function addPlaceStory(deps: StationDeps, owner: string, place: string): Promise<{ itemId: string } | { skipped: 'known' | 'enough' | 'off' }> {
  const config = await deps.store.getConfig(owner);
  if (!config || !featureOn(config, 'places')) return { skipped: 'off' };
  const now = deps.now();
  const month = await deps.store.ofShowSince(owner, PLACE_SHOW, new Date(now.getTime() - PLACE_REPEAT_DAYS * 86_400_000));
  const placeOf = (row: TimelineRow) => { try { return (JSON.parse(row.research_json ?? '{}') as { place?: string }).place; } catch { return undefined; } };
  if (month.some(row => placeOf(row) === place)) return { skipped: 'known' };
  if (month.filter(row => now.getTime() - Date.parse(row.created_at) < 86_400_000).length >= PLACES_PER_DAY) return { skipped: 'enough' };
  const last = await deps.store.lastItem(owner), id = (deps.newId ?? (() => crypto.randomUUID()))();
  await deps.store.insertItem(owner, { id, seq: (last?.seq ?? 0) + 1, showId: PLACE_SHOW, plannedAt: now.toISOString(), estimatedMinutes: 2 }, now);
  await deps.store.update(owner, id, { research_json: JSON.stringify({ subjectOverride: place, place }) }, now);
  await placeSoon(deps, owner, id);
  return { itemId: id };
}

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
  const voiced = await deps.pipeline.voice(owner, reply, 'brief', config.host.voiceId, config.host.voiceStyle, { bed: stationSounds(config).musicBed });
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
async function planChoice(deps: StationDeps, series: Series, index: number, config: StationConfig): Promise<StoryChoice | null> {
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
async function recordChoice(deps: StationDeps, owner: string, series: Series, index: number, picked: 0 | 1, by: StoryChoice['by'], item: TimelineRow) {
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
async function writeQuiz(deps: StationDeps, script: Script): Promise<Quiz | null> {
  if (!deps.agentModel) return null;
  try { return parseQuiz(await deps.agentModel.askJson(`${QUIZ_PROMPT} ${KIDS_RULES}`, { titel: script.title, text: withoutVoiceTags(script.text).slice(0, 6000) }, 'Gemini quiz', 0.5)); }
  catch (error) {
    if (error instanceof ProviderError && error.status === 429) throw error;
    return null;
  }
}

/** The script with the quiz question spoken at its end: by the host, in a dialog by the first voice. */
function withQuiz(script: Script, quiz: Quiz): Script {
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

function followUpOf(row: TimelineRow): string | undefined {
  try {
    const value = (JSON.parse(row.research_json ?? '{}') as { followUp?: unknown }).followUp;
    return typeof value === 'string' ? value : undefined;
  } catch { return undefined; }
}

/** Moves a new item right after [after] (the item that is playing), or to the start of the program. */
/** Where a new block goes: after [after], at the start without it, or with [AT_END] behind everything open. */
export const AT_END = 'end';
async function placeAfter(deps: StationDeps, owner: string, id: string, after?: string) {
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

export const showNameOf = (showId: string, config: StationConfig | null) =>
  showId === MUSIC_SHOW_ID ? 'Musik' : config?.shows.find(show => show.id === showId)?.name ?? blockOf(showId)?.name ?? showId;

export function toView(row: TimelineRow, config: StationConfig | null): TimelineItemView {
  let script: Partial<Script> = {}, sources: Source[] = [];
  try { script = JSON.parse(row.script_json ?? '{}'); } catch { /* Keep the item visible without details. */ }
  try { sources = JSON.parse(row.sources_json ?? '[]'); } catch { /* Keep the item visible without sources. */ }
  let queries: string[] = [];
  let team: TimelineItemView['team'];
  let sharedBy: string | undefined, sharedShow: string | undefined, followTopic: string | undefined;
  try { ({ queries = [], team, sharedBy, sharedShow, followTopic } = JSON.parse(row.research_json ?? '{}') as { queries?: string[]; team?: TimelineItemView['team']; sharedBy?: string; sharedShow?: string; followTopic?: string }); } catch { /* Research details are optional. */ }
  const episode = row.show_id.startsWith(SERIES_PREFIX) ? episodeRefOf(row.research_json) : null;
  const { choice, quiz } = (() => {
    try { const research = JSON.parse(row.research_json ?? '{}') as { choice?: unknown; quiz?: unknown }; return { choice: parseChoice(research.choice), quiz: parseQuiz(research.quiz) }; }
    catch { return { choice: null, quiz: null }; }
  })();
  // The plan of a story is how it is written, not a source to list.
  sources = sources.filter(source => source.id !== OUTLINE_SOURCE_ID);
  return {
    id: row.id, seq: row.seq, showId: row.show_id,
    showName: episode ? `${episode.seriesTitle} · Folge ${episode.episode + 1}/${episode.total}` : sharedShow ?? (followTopic ? `Dranbleiben: ${followTopic}` : showNameOf(row.show_id, config)),
    ...(typeof sharedBy === 'string' ? { sharedBy } : {}),
    ...(episode ? { series: { id: episode.series, episode: episode.episode + 1, total: episode.total, kind: episode.kind } } : {}),
    ...(isSurprise(row.show_id) ? { surprise: true } : {}),
    ...(choice ? { choice: { question: choice.question, options: choice.options, ...(choice.picked !== undefined ? { picked: choice.picked } : {}) } } : {}),
    // The right answer stays on the server until the listener answered.
    ...(quiz ? { quiz: { question: quiz.question, options: quiz.options, ...(quiz.answered !== undefined ? { answered: quiz.answered, correct: quiz.correct } : {}) } } : {}),
    plannedAt: row.planned_at, state: row.state, estimatedMinutes: row.estimated_minutes, updatedAt: row.updated_at,
    ...(script.title ? { title: script.title } : {}),
    ...(sources.length ? { sources: sources.map(source => ({ title: source.title, url: source.url })) } : {}),
    ...(script.interestTags?.length ? { interestTags: script.interestTags } : {}),
    ...(row.verification ? { verification: row.verification as VerificationPolicy } : {}),
    ...(script.quality ? { quality: script.quality.overall } : {}),
    ...(queries.length ? { searchQueries: queries } : {}),
    ...(team ? { team } : {}),
    ...(row.error ? { error: row.error } : {}),
    ...(hourView(row, script as Partial<HourPackage>) ?? (row.audio_key && row.state !== 'expired' ? { audioUrl: `api/timeline/${row.id}/audio` } : {})),
  };
}

/** What was said in an item, for reading along: spoken text (dialogs by speaker, hours with their songs) and sources. */
export interface TranscriptView {
  title: string;
  /** The jury's marks after the final edit, when there was one. */
  quality?: QualityScore;
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
      : { text: withoutVoiceTags(part.text) });
  } else if (Array.isArray(script.turns)) {
    lines = script.turns.map(turn => ({ speaker: turn.speaker === 'host-b' ? cohost : host, text: withoutVoiceTags(turn.text) }));
  } else lines = script.text ? [{ text: withoutVoiceTags(script.text) }] : [];
  return {
    ...(script.quality ? { quality: script.quality } : {}),
    title: script.title ?? config?.shows.find(show => show.id === row.show_id)?.name ?? blockOf(row.show_id)?.name ?? row.show_id,
    lines: lines.filter(line => line.text?.trim()),
    sources: sources.filter(source => source.id !== OUTLINE_SOURCE_ID).map(source => ({ title: source.title, url: source.url })),
  };
}

function hourView(row: TimelineRow, pkg: Partial<HourPackage>): Pick<TimelineItemView, 'parts' | 'focus' | 'subject' | 'artist'> | null {
  if ((pkg.kind !== 'music_hour' && pkg.kind !== 'artist_hour' && pkg.kind !== 'song' && pkg.kind !== 'music_block') || !Array.isArray(pkg.parts)) return null;
  // Released audio (after the retention period) leaves the parts without URLs.
  const playable = row.state !== 'expired' && !!row.audio_key, focus = packageFocus(pkg), subject = packageSubject(pkg);
  return {
    ...(pkg.kind === 'song' || pkg.kind === 'music_block' ? { subject } : { focus, subject, ...(focus === 'artist' ? { artist: subject } : {}) }),
    parts: pkg.parts.map((part, index) => part.kind === 'track'
      ? { kind: 'track' as const, spotifyUri: part.uri, title: part.title, artist: part.artist, durationMs: part.durationMs, ...(part.imageUrl ? { imageUrl: part.imageUrl } : {}) }
      : { kind: 'speech' as const, ...(playable && part.audioKey ? { audioUrl: `api/timeline/${row.id}/audio?part=${index}` } : {}) }),
  };
}

/** The music desk proposes the next songs with the unsaved settings; nothing is searched or planned. */
async function trialSongs(deps: StationDeps, owner: string, config: StationConfig, agents: ReturnType<typeof resolveAgents>): Promise<TrialOutcome> {
  const history = await songHistory(deps, owner);
  const listens = deps.listening ? await deps.listening.topArtists(owner, deps.now()) : [];
  await deps.reserveGeneration(owner);
  const picks = await deps.musicWriter!.pickSongs({
    taste: config.music.taste, interests: [...config.profile.topics, ...config.profile.interests], avoid: history.recent,
    liked: history.liked, disliked: history.disliked, announce: true, listens, count: 5,
    direction: { stationName: config.name, persona: config.host, agents },
  });
  const recent = history.recent.slice(-5);
  return { ok: true, itemTitle: 'die nächsten Songs',
    before: { text: recent.length ? recent.map(song => `– ${song}`).join('\n') : 'Noch keine Songs gespielt.' },
    after: { text: picks.map(pick => `– ${pick.artist} – ${pick.title}${pick.announcement ? `\n  «${pick.announcement}»` : ''}`).join('\n') } };
}

/** The last music hour, moderated anew with the unsaved settings, from the same songs and sources. */
async function trialHour(deps: StationDeps, owner: string, config: StationConfig, agents: ReturnType<typeof resolveAgents>): Promise<TrialOutcome> {
  let found: { pkg: HourPackage; sources: Source[]; show: ShowConfig } | undefined;
  for (const row of (await deps.store.recentItems(owner, 60)).reverse()) {
    if (!row.script_json || !['voicing', 'ready', 'played', 'skipped', 'archived'].includes(row.state)) continue;
    try {
      const pkg = JSON.parse(row.script_json) as HourPackage;
      if (pkg.kind !== 'music_hour' && pkg.kind !== 'artist_hour') continue;
      const show = config.shows.find(item => item.id === row.show_id) ?? (blockOf(row.show_id) ? blockShow(blockOf(row.show_id)!, config) : undefined);
      found = { pkg, sources: JSON.parse(row.sources_json ?? '[]') as Source[], show: show ?? { talkSeconds: 60, instructions: '' } as ShowConfig };
      break;
    } catch { /* Skip corrupt rows. */ }
  }
  if (!found) return { ok: false, error: 'NO_ITEM' };
  const { pkg, sources, show } = found;
  const tracks = pkg.parts.filter((part): part is TrackPart => part.kind === 'track');
  if (!tracks.length) return { ok: false, error: 'NO_ITEM' };
  await deps.reserveGeneration(owner);
  const hour = await deps.musicWriter!.writeHour({ focus: packageFocus(pkg), subject: packageSubject(pkg), sources, talkSeconds: show.talkSeconds ?? 60,
    picks: tracks.map(track => ({ title: track.title, artist: track.artist, reason: track.reason ?? '' })),
    direction: { instructions: show.instructions, stationName: config.name, persona: config.host, agents, listenerNotes: await notesFor(deps, owner, deps.now()) } });
  const before: string[] = [];
  for (const part of pkg.parts) {
    if (part.kind === 'track') before.push(`♪ ${part.artist} – ${part.title}`);
    else if (before.length && !before[before.length - 1].startsWith('♪')) before[before.length - 1] += ` ${part.text}`;
    else before.push(part.text);
  }
  const after = [hour.intro.text, ...tracks.flatMap((track, index) => [hour.tracks.find(item => item.index === index)?.text ?? '', `♪ ${track.artist} – ${track.title}`]), hour.outro.text].filter(Boolean);
  return { ok: true, itemTitle: pkg.title, before: { text: before.join('\n\n') }, after: { text: after.join('\n\n') } };
}

export type TrialOutcome =
  | { ok: true; itemTitle: string; before: { text: string; quality?: QualityScore }; after: { text: string; quality?: QualityScore } }
  | { ok: false; error: 'NO_ITEM' | 'NOT_CONFIGURED' | 'FAILED'; detail?: string };

const scriptText = (script: Script) => script.turns ? script.turns.map(turn => `${turn.speaker === 'host-b' ? 'B' : 'A'}: ${turn.text}`).join('\n') : script.text;

/**
 * Tries an agent with unsaved settings on the last produced spoken item and returns before and after;
 * nothing is stored. The writer drafts anew from the same sources, the editor rewrites (and the jury
 * scores) the final text, the jury only scores it.
 */
export type TrialAgent = 'writer' | 'editor' | 'jury' | 'music' | 'hour';

export async function trialAgent(deps: StationDeps, owner: string, agent: TrialAgent, draft: AgentConfig | undefined): Promise<TrialOutcome> {
  const config = await deps.store.getConfig(owner);
  if (!config) return { ok: false, error: 'NO_ITEM' };
  const agents = resolveAgents(draft);
  if (agent === 'music' || agent === 'hour') {
    if (!deps.musicWriter) return { ok: false, error: 'NOT_CONFIGURED' };
    try { return agent === 'music' ? await trialSongs(deps, owner, config, agents) : await trialHour(deps, owner, config, agents); }
    catch (error) { return { ok: false, error: 'FAILED', detail: (error instanceof Error ? error.message : 'unbekannt').slice(0, 200) }; }
  }
  let found: { row: TimelineRow; script: Script; sources: Source[]; show: ShowConfig } | undefined;
  for (const row of (await deps.store.recentItems(owner, 40)).reverse()) {
    if (!row.script_json || !row.sources_json || !['voicing', 'ready', 'played', 'skipped', 'archived'].includes(row.state)) continue;
    const show = config.shows.find(item => item.id === row.show_id) ?? (blockOf(row.show_id) ? blockShow(blockOf(row.show_id)!, config) : undefined);
    if (!show || (show.format !== 'brief' && show.format !== 'podcast')) continue;
    try {
      const script = JSON.parse(row.script_json) as Script, sources = JSON.parse(row.sources_json) as Source[];
      if (typeof script.text === 'string' && script.text.trim() && Array.isArray(script.sourceIds) && sources.length) { found = { row, script, sources, show }; break; }
    } catch { /* Skip corrupt rows. */ }
  }
  if (!found) return { ok: false, error: 'NO_ITEM' };
  const { row, script, sources, show } = found;
  const direction = { instructions: show.instructions, targetMinutes: show.targetMinutes, stationName: config.name, persona: config.host, agents, listenerNotes: await notesFor(deps, owner, deps.now()) };
  const before = { text: scriptText(script), ...(script.quality ? { quality: script.quality } : {}) };
  try {
    if (agent === 'writer') {
      const generator = deps.generator ? deps.generator(show.textProvider, show.format) : undefined;
      if (deps.generator && !generator) return { ok: false, error: 'NOT_CONFIGURED' };
      await deps.reserveGeneration(owner);
      const fresh = await deps.pipeline.draft(config.profile, sources, show.format === 'podcast' ? 'podcast' : 'brief', direction, generator);
      return { ok: true, itemTitle: script.title, before, after: { text: scriptText(fresh) } };
    }
    if (!deps.editor) return { ok: false, error: 'NOT_CONFIGURED' };
    await deps.reserveGeneration(owner);
    if (agent === 'jury') {
      const { interestTags: _tags, quality: _quality, ...plain } = script;
      const scored = await finishScript(deps.editor, plain, sources, { ...direction, agents: { ...agents, editor: { ...agents.editor, enabled: false }, jury: { ...agents.jury, enabled: true } } }, await stationContext(deps, owner, config, row, deps.now()));
      return { ok: true, itemTitle: script.title, before, after: { text: before.text, ...(scored.quality ? { quality: scored.quality } : {}) } };
    }
    const { quality: _quality, ...plain } = script;
    const edited = await finishScript(deps.editor, plain, sources, { ...direction, agents: { ...agents, editor: { ...agents.editor, enabled: true } } }, await stationContext(deps, owner, config, row, deps.now()));
    return { ok: true, itemTitle: script.title, before, after: { text: scriptText(edited), ...(edited.quality ? { quality: edited.quality } : {}) } };
  } catch (error) {
    return { ok: false, error: 'FAILED', detail: (error instanceof Error ? error.message : 'unbekannt').slice(0, 200) };
  }
}
