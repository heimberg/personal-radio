/** Music: hours (artist, genre, theme), single songs and music blocks, voiced part by part. */
import { HOUR_FOCUS, MUSIC_SHOW_ID, SONG_MINUTES, activeSlot, hourSubject, localClock, stationSounds } from '../../src/domain/station.ts';
import type { HourFocus, ShowConfig, StationConfig } from '../../src/domain/station.ts';
import type { QualityScore, Script, Source } from '../../src/domain/program.ts';
import { juryRounds, parseQuality } from '../editing.ts';
import { TTS_PARALLEL } from '../providers.ts';
import { usesHeadlines, usesWeather } from '../tools.ts';
import { WILDCARD, WILDCARD_TASTES, blockOf, surpriseLevel } from '../../src/domain/blocks.ts';
import { agentOf, resolveAgents } from '../../src/domain/agents.ts';
import type { TimelineRow } from '../station-store.ts';
import { HOUR_KINDS } from '../music.ts';
import type { BlockMoment, HourScript, PlaylistTrack, SongPick, TrackPick } from '../music.ts';
import { produceWithTeam } from '../agentic/music-hour.ts';
import type { DurableStepRunner } from '../agentic/runtime.ts';
import { PARTS_PER_RUN } from './core.ts';
import type { StationDeps } from './core.ts';
import { scheduledShow } from './plan.ts';
import { notesFor, recentTopics } from './produce.ts';
import { FEEDBACK_REASONS } from '../../src/domain/listener-notes.ts';
import type { FeedbackReason } from '../../src/domain/listener-notes.ts';
import type { ProduceOutcome } from './produce.ts';

/** Stored in script_json: the hour's speech and tracks in playing order. */
export interface SpeechPart { kind: 'speech'; text: string; sourceIds: string[]; audioKey?: string; contentType?: string }
/** [title] and [artist] are what the AI picked (and may be named to it again); [shown] is Spotify's spelling, for the app only. */
export interface TrackPart { kind: 'track'; uri: string; title: string; artist: string; durationMs: number; imageUrl?: string; reason?: string; group?: string; picked?: 'ai' | 'playlist' | 'release'; shown?: { title: string; artist: string } }
/** `artist_hour` packages were written before genre and theme hours existed; they are artist hours. */
export interface HourPackage {
  kind: 'music_hour' | 'artist_hour' | 'song' | 'music_block'; focus?: HourFocus; subject?: string; artist?: string; title: string; text: string; sourceIds: string[]; parts: Array<SpeechPart | TrackPart>;
  /** Music blocks: the group the next block of this show starts with. */
  nextGroup?: number;
  /** The jury's marks on the moderation, after its notes were worked in. */
  quality?: QualityScore;
}

/**
 * The jury judges the moderation of a music hour or block and the writer works its notes in (see juryRounds).
 * Without the jury, or without an editor to judge with, the texts stay as written.
 */
async function judgedMusic<T>(deps: StationDeps, owner: string, row: TimelineRow, config: StationConfig, first: T, script: (text: T) => Script,
  sources: Source[], revise: (text: T, notes: string) => Promise<T | undefined>): Promise<{ text: T; quality?: QualityScore }> {
  const agents = resolveAgents(config.agents);
  if (!agentOf(agents, 'jury').enabled || !deps.editor) return { text: first };
  const judge = async (text: T) => { try { return parseQuality(await deps.editor!.judge(script(text), sources, { agents, stationName: config.name, persona: config.host })); } catch { return undefined; } };
  const { best, score, rounds } = await juryRounds(first, judge, async (text, notes) => { try { return await revise(text, notes); } catch { return undefined; } }, agentOf(agents, 'jury').threshold);
  if (score) await deps.store.logQuality(owner, { itemId: row.id, showId: row.show_id, overall: score.overall, at: deps.now() });
  return { text: best, ...(score ? { quality: { ...score, ...(rounds.length > 1 ? { rounds } : {}) } } : {}) };
}

/** One grounded search for facts about the named songs (AI picks and new releases only), for the block's moderation. */
async function researchSongs(deps: StationDeps, config: StationConfig, songs: Array<{ artist: string; title: string }>): Promise<Source[]> {
  if (!deps.researcher || !songs.length) return [];
  try {
    const { sources } = await deps.researcher.research({
      brief: `Finde zu jeder dieser Aufnahmen ein bis zwei konkrete, belegbare Fakten: Erscheinungsjahr, Album, Entstehung, Besetzung oder was sie besonders macht. Keine allgemeinen Biografien.\n${songs.map((song, index) => `${index + 1}. ${song.artist} – ${song.title}`).join('\n')}`,
      interests: [], avoidTopics: [], now: deps.now(), agent: agentOf(resolveAgents(config.agents), 'research'),
    });
    return sources.slice(0, 12);
  } catch { return []; }
}
export const packageFocus = (pkg: Partial<HourPackage>): HourFocus => pkg.focus ?? 'artist';
export const packageSubject = (pkg: Partial<HourPackage>): string => pkg.subject ?? pkg.artist ?? '';
export function requestedHourSubject(row: TimelineRow): string | undefined {
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
export async function recentSubjects(deps: StationDeps, owner: string, focus: HourFocus): Promise<string[]> {
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
export async function produceMusicHour(deps: StationDeps, owner: string, config: StationConfig, show: ShowConfig, row: TimelineRow,
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
    let resolved: Array<{ pick: TrackPick; uri: string; durationMs: number; imageUrl?: string; shown?: { title: string; artist: string } }>;
    let hour: HourScript;
    let team: { songs: number; specialists: number; corrections: number } | undefined;
    let quality: QualityScore | undefined;
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
      const found = resolved.map(item => item.pick), writer = deps.musicWriter;
      hour = await writer.writeHour({ focus, subject, picks: found, sources, talkSeconds: show.talkSeconds ?? 60, direction });
      const judged = await judgedMusic(deps, owner, row, config, hour, script => ({ title: script.title, text: [script.intro, ...script.tracks, script.outro].map(part => part.text).join('\n\n'), sourceIds: [] }),
        sources, (script, notes) => writer.writeHour({ focus, subject, picks: found, sources, talkSeconds: show.talkSeconds ?? 60, direction, revise: { script, notes } }));
      hour = judged.text; quality = judged.quality;
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
      parts.push({ kind: 'track', uri: item.uri, title: item.pick.title, artist: item.pick.artist, durationMs: item.durationMs, ...(item.imageUrl ? { imageUrl: item.imageUrl } : {}), ...(item.shown ? { shown: item.shown } : {}), reason: item.pick.reason });
    });
    parts.push(...speech(hour.outro));
    pkg = { kind: 'music_hour', focus, subject, title: hour.title, text, sourceIds, parts, ...(quality ? { quality } : {}) };
    await deps.store.markCovered(owner, sources.map(source => source.url), now);
    await deps.store.update(owner, row.id, { state: 'voicing', script_json: JSON.stringify(pkg), sources_json: JSON.stringify(sources),
      verification, research_json: queries.length || team ? JSON.stringify({ queries, ...(team ? { team } : {}) }) : null }, deps.now());
  } else {
    pkg = JSON.parse(row.script_json ?? 'null') as HourPackage;
  }
  return voiceParts(deps, owner, config, show.voiceId ?? config.host.voiceId, row, pkg);
}

/** Without durable storage (tests, local runs) the team's steps simply run in memory. */
export function memorySteps(): DurableStepRunner & { clear(): Promise<void> } {
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
export async function voiceParts(deps: StationDeps, owner: string, config: StationConfig, voiceId: string | undefined, row: TimelineRow, pkg: HourPackage): Promise<ProduceOutcome> {
  const missing = [...pkg.parts.entries()].filter(([, part]) => part.kind === 'speech' && !part.audioKey);
  // At most [PARTS_PER_RUN] parts per invocation, so a long hour stays within one invocation's request
  // limits; the rest follows in the next queue message. Progress is stored after each batch, so a retry
  // voices only what is missing.
  const open = missing.slice(0, PARTS_PER_RUN);
  for (let start = 0; start < open.length; start += TTS_PARALLEL) {
    const batch = open.slice(start, start + TTS_PARALLEL);
    const settled = await Promise.allSettled(batch.map(async ([index, part]) => {
      const speech = part as SpeechPart;
      const audio = await deps.pipeline.voice(owner, { title: pkg.title, text: speech.text, sourceIds: speech.sourceIds.length ? speech.sourceIds : pkg.sourceIds }, 'brief', voiceId, config.host.voiceStyle, { bed: stationSounds(config).musicBed, compress: deps.compressSpeech });
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
  if (missing.length > open.length) {
    await deps.store.update(owner, row.id, { lease_until: null }, deps.now());
    return 'continue';
  }
  await deps.store.update(owner, row.id, { state: 'ready', lease_until: null, error: null }, deps.now());
  return 'ready';
}

/** Songs of recent song items with the owner's reaction: liked, disliked, or just played. */
export async function songHistory(deps: StationDeps, owner: string): Promise<{ recent: string[]; liked: string[]; disliked: string[] }> {
  const rows = (await deps.store.recentItems(owner, 120)).filter(row => row.show_id === MUSIC_SHOW_ID && row.script_json);
  const reactions = new Map<string, string>();
  const reasons = await deps.store.reasonsByItem?.(owner).catch(() => new Map()) ?? new Map();
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
      // With the reason, if one was given: «… (zu wild)» tells the music desk what to avoid.
      const reason = reasons.get(row.id);
      if (reactions.get(row.id) === 'dislike') disliked.push(reason ? `${name} (${FEEDBACK_REASONS[reason as FeedbackReason].label.toLowerCase()})` : name);
    } catch { /* Skip corrupt rows. */ }
  }
  return { recent: [...new Set(recent)].reverse(), liked: liked.reverse(), disliked: disliked.reverse() };
}

/**
 * One song between spoken items: the AI proposes a few songs from the owner's taste (and reactions to
 * earlier songs), Spotify resolves the first it knows, the host announces it briefly.
 */
export async function produceSong(deps: StationDeps, owner: string, config: StationConfig, row: TimelineRow,
  fail: (error: string) => Promise<'failed'>): Promise<ProduceOutcome> {
  let pkg: HourPackage;
  if (row.state === 'planned') {
    if (!deps.musicWriter) return fail('GEMINI_NOT_CONFIGURED');
    if (!deps.catalog) return fail('SPOTIFY_NOT_CONFIGURED');
    const history = await songHistory(deps, owner);
    const recent = await recentArtists(deps, owner);
    const listens = rotateListens(deps.listening ? await deps.listening.topArtists(owner, deps.now()) : [], recent.all, deps.random ?? Math.random);
    const picks = await deps.musicWriter.pickSongs({
      taste: config.music.taste, interests: [...config.profile.topics, ...config.profile.interests], avoid: history.recent,
      liked: history.liked, disliked: history.disliked, announce: config.music.announce, listens, recentArtists: recent.named, count: 8, surprise: surpriseLevel(config),
      notes: await notesFor(deps, owner, deps.now(), 'music'),
      direction: { stationName: config.name, persona: config.host, agents: resolveAgents(config.agents) },
    });
    // An artist heard lately waits; only if every pick is one, the first that Spotify knows plays anyway. Among
    // the fresh picks chance decides, not the AI's order: its first choice is the most predictable one.
    const fresh = shuffled(picks.filter(pick => !recent.all.has(artistKey(pick.artist))), deps.random ?? Math.random);
    const ordered = [...fresh, ...picks.filter(pick => recent.all.has(artistKey(pick.artist)))];
    let chosen: { pick: SongPick; uri: string; durationMs: number; imageUrl?: string; shown?: { title: string; artist: string } } | null = null;
    for (const pick of ordered) {
      const track = await deps.catalog.find(pick);
      if (track) { chosen = { pick, ...track }; break; }
    }
    if (!chosen) return fail(`TOO_FEW_TRACKS: 0 von ${picks.length} Songs auf Spotify gefunden`);
    const title = `${chosen.pick.artist} – ${chosen.pick.title}`;
    const intro: SpeechPart[] = config.music.announce && chosen.pick.announcement ? [{ kind: 'speech', text: chosen.pick.announcement, sourceIds: [] }] : [];
    pkg = { kind: 'song', title, subject: title, text: chosen.pick.announcement, sourceIds: [],
      parts: [...intro, { kind: 'track', uri: chosen.uri, title: chosen.pick.title, artist: chosen.pick.artist, durationMs: chosen.durationMs, ...(chosen.imageUrl ? { imageUrl: chosen.imageUrl } : {}), ...(chosen.shown ? { shown: chosen.shown } : {}) }] };
    await deps.store.update(owner, row.id, { state: 'voicing', script_json: JSON.stringify(pkg), estimated_minutes: Math.max(1, Math.round(chosen.durationMs / 60_000)) }, deps.now());
  } else {
    pkg = JSON.parse(row.script_json ?? 'null') as HourPackage;
  }
  return voiceParts(deps, owner, config, config.host.voiceId, row, pkg);
}

/** A track's artist is not picked again within this many tracks (songs, blocks, hours). */
export const ARTIST_GAP = 40;
/** How many of the owner's top artists one pick sees: a rotating selection, so not always the same few lead. */
export const LISTENS_PER_PICK = 8;

const artistKey = (artist: string) => artist.toLowerCase().normalize('NFKD').replace(/[\u0300-\u036f]/g, '').replace(/^the\s+/, '').replace(/[^a-z0-9]+/g, ' ').trim();

/**
 * The artists of the last [ARTIST_GAP] tracks, newest first: [all] for the check in code, [named] only the
 * AI's own picks, which may go to the AI (playlist tracks never do).
 */
export async function recentArtists(deps: StationDeps, owner: string): Promise<{ all: Set<string>; named: string[] }> {
  const tracks: Array<{ artist: string; ai: boolean }> = [];
  for (const row of (await deps.store.recentItems(owner, 120)).reverse()) {
    if (!row.script_json || tracks.length >= ARTIST_GAP) continue;
    try {
      const pkg = JSON.parse(row.script_json) as Partial<HourPackage>;
      for (const part of [...(pkg.parts ?? [])].reverse()) if (part.kind === 'track' && tracks.length < ARTIST_GAP) tracks.push({ artist: part.artist, ai: part.picked !== 'playlist' });
    } catch { /* Skip corrupt rows. */ }
  }
  return { all: new Set(tracks.map(track => artistKey(track.artist))), named: [...new Set(tracks.filter(track => track.ai).map(track => track.artist))] };
}

function shuffled<T>(items: T[], random: () => number): T[] {
  const copy = [...items];
  for (let i = copy.length - 1; i > 0; i--) { const j = Math.floor(random() * (i + 1)); [copy[i], copy[j]] = [copy[j], copy[i]]; }
  return copy;
}

/** A different handful of top artists each time, leaving out those played lately. */
export function rotateListens(listens: string[], recent: Set<string>, random: () => number): string[] {
  const fresh = listens.filter(artist => !recent.has(artistKey(artist)));
  return shuffled(fresh.length >= 3 ? fresh : listens, random).slice(0, LISTENS_PER_PICK);
}

export const MAX_BLOCK_TRACKS = 30;
export const MAX_AI_BATCHES = 4;
/** Speech takes part of a block's length; the music fills the rest. */
export const BLOCK_MUSIC_SHARE = 0.85;

/** Items whose content belongs to their time: live tools, placeholders, or a music block's time-of-day moderation. */
export function timeBound(row: TimelineRow, config: StationConfig): boolean {
  const show = config.shows.find(item => item.id === row.show_id) ?? blockOf(row.show_id)?.show;
  if (!show) return false;
  return !!show.tools?.length || usesWeather(show as ShowConfig) || usesHeadlines(show as ShowConfig) || /\{(datum|wochentag|uhrzeit)\}/i.test(`${show.instructions} ${show.researchPrompt}`) || show.format === 'music_block';
}

/** The music wildcard draws its taste when it is produced. */
export function wildcardTaste(blockId: string, deps: StationDeps): string | undefined {
  return blockId === WILDCARD ? WILDCARD_TASTES[Math.floor((deps.random ?? Math.random)() * WILDCARD_TASTES.length)] : undefined;
}

/** When an item is expected on air: its planned time, or now when that has passed. */
export function airTime(row: TimelineRow, now: Date): Date {
  const planned = Date.parse(row.planned_at);
  return Number.isFinite(planned) && planned > now.getTime() ? new Date(planned) : now;
}

export function daytime(date: Date, timezone: string): string {
  const hour = Math.floor(localClock(date, timezone).minutes / 60);
  return hour < 5 ? 'Nacht' : hour < 11 ? 'Morgen' : hour < 14 ? 'Mittag' : hour < 18 ? 'Nachmittag' : hour < 22 ? 'Abend' : 'Nacht';
}

/** The show that follows in the schedule slot, for the host's hand-over at the end of a block. */
export function nextShowName(config: StationConfig, show: ShowConfig, at: Date): string | undefined {
  const rotation = (activeSlot(config, at)?.showIds ?? []).map(id => scheduledShow(config, id)).filter((item): item is ShowConfig => !!item);
  const index = rotation.findIndex(item => item.id === show.id);
  const next = index >= 0 && rotation.length > 1 ? rotation[(index + 1) % rotation.length] : undefined;
  return next?.name;
}

/** Recent Spotify URIs of songs and blocks, and where the last block of this show left the group rotation. */
export async function blockHistory(deps: StationDeps, owner: string, showId: string): Promise<{ uris: Set<string>; names: string[]; nextGroup: number }> {
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

export interface BlockTrack extends PlaylistTrack { group: number; picked: 'ai' | 'playlist' | 'release' }

/**
 * A music block: songs from rotating groups – the owner's playlists or AI picks from a taste – with
 * short moderations where the triggers fire. Playlist tracks are shuffled in code and never reach an AI
 * provider; the host names only the AI's own picks. The whole block is produced ahead of time.
 */
export async function produceMusicBlock(deps: StationDeps, owner: string, config: StationConfig, show: ShowConfig, row: TimelineRow,
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
  const recent = await recentArtists(deps, owner);
  const musicNotes = await notesFor(deps, owner, deps.now(), 'music');
  // Artists in this block so far: each AI pick brings a new one.
  const blockArtists = new Set<string>();
  const used = new Set(history.uris);
  const problems: string[] = [];

  // Each group's queue is filled when the group comes up: playlists are loaded and shuffled once,
  // AI groups ask for a batch of picks and keep those Spotify resolves.
  const queues = new Map<number, BlockTrack[]>(), exhausted = new Set<number>();
  let aiBatches = 0;
  const listens = rotateListens(deps.listening ? await deps.listening.topArtists(owner, deps.now()) : [], recent.all, random);
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
      listens, recentArtists: recent.named, notes: musicNotes, announce: false, count: Math.min(15, wanted + 4), surprise: surpriseLevel(config), direction: { stationName: config.name, persona: config.host, agents: resolveAgents(config.agents) },
    });
    let found = 0;
    const waiting: SongPick[] = [];
    for (const pick of shuffled(picks, random)) {
      const key = artistKey(pick.artist);
      if (blockArtists.has(key)) continue;
      // Heard lately: only if the batch brings nothing else (a narrow taste must not leave the block empty).
      if (recent.all.has(key)) { waiting.push(pick); continue; }
      const track = await deps.catalog!.find(pick);
      if (!track || used.has(track.uri) || queue.some(item => item.uri === track.uri)) continue;
      blockArtists.add(key);
      queue.push({ ...track, title: pick.title, artist: pick.artist, group: index, picked: 'ai' }); found++;
    }
    for (const pick of found ? [] : waiting) {
      const key = artistKey(pick.artist), track = await deps.catalog!.find(pick);
      if (!track || blockArtists.has(key) || used.has(track.uri) || queue.some(item => item.uri === track.uri)) continue;
      blockArtists.add(key);
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
  const ordered = positions.map(position => moments.get(position)!);
  // Facts for the moderation: one search about the songs named to the AI (its picks and new releases).
  const songs = [...new Map(ordered.flatMap(moment => [moment.next, moment.previous]).flatMap(song => song ? [[`${song.artist}|${song.title}`, song] as const] : [])).values()];
  const sources = await researchSongs(deps, config, songs);
  const writer = deps.musicWriter;
  const write = (revise?: { texts: string[]; notes: string }) => writer.writeBlock({
    blockName: show.name, groups: groupNames, nextShow: nextShowName(config, show, new Date(row.planned_at)),
    daytime: daytime(airTime(row, deps.now()), config.timezone), talkSeconds: show.talkSeconds ?? 20, moments: ordered, sources,
    direction: { instructions: show.instructions, stationName: config.name, persona: config.host, agents: resolveAgents(config.agents) }, ...(revise ? { revise } : {}),
  });
  const written = await write();
  if (!written.some(Boolean)) throw new Error('Gemini block moderation returned nothing');
  const { text: texts, quality } = await judgedMusic(deps, owner, row, config, written, list => ({ title: show.name, text: list.filter(Boolean).join('\n\n'), sourceIds: [] }), sources,
    async (list, notes) => { const next = await write({ texts: list, notes }); return next.some(Boolean) ? next : undefined; });
  const speechAt = new Map(positions.map((position, index) => [position, texts[index]]));
  const parts: Array<SpeechPart | TrackPart> = [];
  const speak = (position: number) => { const body = speechAt.get(position); if (body) parts.push(...splitSpeech(body).map(chunk => ({ kind: 'speech' as const, text: chunk, sourceIds: [] }))); };
  tracks.forEach((track, index) => {
    speak(index);
    parts.push({ kind: 'track', uri: track.uri, title: track.title, artist: track.artist, durationMs: track.durationMs, ...(track.imageUrl ? { imageUrl: track.imageUrl } : {}), ...(track.shown ? { shown: track.shown } : {}), group: groups[track.group].name, picked: track.picked });
  });
  speak(tracks.length);
  const text = parts.flatMap(part => part.kind === 'speech' ? [part.text] : []).join(' ');
  const pkg: HourPackage = { kind: 'music_block', title: show.name, subject: groupNames.join(' → '), text, sourceIds: [], parts,
    nextGroup: (tracks.at(-1)!.group + 1) % groups.length, ...(quality ? { quality } : {}) };
  const spokenMs = text.split(/\s+/).length / 130 * 60_000;
  await deps.store.update(owner, row.id, { state: 'voicing', script_json: JSON.stringify(pkg), verification: 'off',
    estimated_minutes: Math.max(1, Math.round((musicMs + spokenMs) / 60_000)) }, deps.now());
  return voiceParts(deps, owner, config, show.voiceId ?? config.host.voiceId, { ...row, state: 'voicing' }, pkg);
}
