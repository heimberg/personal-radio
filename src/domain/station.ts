import { parseFeatures, parseHiddenBlocks } from './features.ts';
import type { FeatureSettings } from './features.ts';
import { defaultProfile, parseProfile } from './program.ts';
import type { HostPersona, Profile } from './program.ts';
import { parseAgentConfig } from './agents.ts';
import type { AgentConfig } from './agents.ts';

// Server-side station configuration. Everything that shapes the program is data the owner can edit.
export type ShowFormat = 'brief' | 'podcast' | 'artist_hour' | 'genre_hour' | 'theme_hour' | 'music_block';
/** Music hours: spoken parts with Spotify tracks in between, about one artist, one genre or one theme. */
export type HourFocus = 'artist' | 'genre' | 'theme';
export type HourProduction = 'standard' | 'agents';
export const HOUR_FOCUS: Partial<Record<ShowFormat, HourFocus>> = { artist_hour: 'artist', genre_hour: 'genre', theme_hour: 'theme' };
export const isMusicHour = (format: ShowFormat): boolean => HOUR_FOCUS[format] !== undefined;
/** Music hours and music blocks bring their own music, so no songs are planned after them. */
export const bringsOwnMusic = (format: ShowFormat): boolean => isMusicHour(format) || format === 'music_block';
/** The fixed artist, genre or theme of a music hour; undefined lets the AI choose. */
export function hourSubject(show: ShowConfig): string | undefined {
  return HOUR_FOCUS[show.format] === 'artist' ? show.artist : HOUR_FOCUS[show.format] === 'genre' ? show.genre : show.theme;
}
export type VerificationPolicy = 'strict' | 'light' | 'off';
export type TextProvider = 'gemini' | 'ask';
export type SourceMode = 'feeds' | 'web';
export interface FeedConfig { id: string; name: string; url: string }
export type ShowTool = 'clock' | 'weather' | 'headlines';
export const SHOW_TOOLS: readonly ShowTool[] = ['clock', 'weather', 'headlines'];

export interface ShowConfig {
  id: string;
  name: string;
  enabled: boolean;
  format: ShowFormat;
  /** Owner-written editorial instructions, appended to the provider prompt. */
  instructions: string;
  feedIds: string[];
  targetMinutes: number;
  verification: VerificationPolicy;
  voiceId?: string;
  /** Model that writes the script. Dialogs need Gemini. */
  textProvider: TextProvider;
  /** `feeds`: the show's RSS/Atom feeds; `web`: research grounded in Google Search. */
  sourceMode: SourceMode;
  /** Research brief for `web` shows, written by the owner. */
  researchPrompt: string;
  /** Live information the show works in: date and time, the weather, the headlines. */
  tools?: ShowTool[];
  /** Music hours: fixed artist, genre or theme; without it the AI picks one from the listener's interests. */
  artist?: string;
  genre?: string;
  theme?: string;
  /** Music hours: `agents` lets the editorial team produce the hour (beta); `standard` is the single-writer path. */
  production?: HourProduction;
  /** Music hours: number of tracks and spoken seconds before each track. */
  tracks?: number;
  talkSeconds?: number;
  /** Music blocks: rotating groups of songs, when to switch groups and when the host speaks. */
  groups?: PlaylistGroup[];
  switchAfterTracks?: number;
  switchAfterMinutes?: number;
  triggers?: BlockTriggers;
}
/**
 * One group of a music block: the owner's Spotify playlists, or – without playlists – songs the AI picks
 * from `taste`. Playlist tracks are never sent to an AI provider, so their moderation stays generic.
 */
export interface PlaylistGroup {
  name: string; playlists: string[]; taste: string;
  /** New albums and singles of the owner's top artists (needs the connected listening profile). */
  releases?: boolean;
}
/** When the host speaks inside a music block; 0 turns a counting trigger off. */
export interface BlockTriggers {
  blockStart: boolean;
  blockEnd: boolean;
  /** Before every Nth AI-picked song, naming it. */
  beforeTrack: number;
  /** After every Nth AI-picked song, naming it. */
  afterTrack: number;
  /** After at least X minutes of music without speech. */
  everyMinutes: number;
  groupTransition: boolean;
}
export const DEFAULT_TRIGGERS: BlockTriggers = { blockStart: true, blockEnd: true, beforeTrack: 1, afterTrack: 0, everyMinutes: 0, groupTransition: true };
/** Accepts a playlist link, a `spotify:playlist:` URI or the bare ID; returns the ID or undefined. */
export function playlistId(value: string): string | undefined {
  const match = value.trim().match(/^(?:https:\/\/open\.spotify\.com\/(?:intl-[a-z]{2}(?:-[a-z]{2})?\/)?playlist\/|spotify:playlist:)?([A-Za-z0-9]{22})(?:[?#].*)?$/);
  return match?.[1];
}
/** Songs between spoken items, picked by the AI from the owner's taste and played through Spotify. */
export interface MusicConfig {
  /** Songs after every spoken item; 0 turns music between items off. */
  between: number;
  /** A short spoken intro naming the song before it plays. */
  announce: boolean;
  /** The owner's own words: genres, artists, moods. */
  taste: string;
}
/** Reserved show ID of song items; show IDs from the configuration cannot start with an underscore. */
export const MUSIC_SHOW_ID = '_musik';
export const SONG_MINUTES = 4;
export interface ScheduleSlot { id: string; days: number[]; from: string; to: string; showIds: string[] }
/** Where the listener is: the weather placeholder `{wetter}` and `{ort}` use it. */
export interface StationLocation { name: string; latitude: number; longitude: number }

export interface StationConfig {
  version: 1;
  /** Station name the host uses on air. */
  name: string;
  host: HostPersona;
  timezone: string;
  location?: StationLocation;
  horizonMinutes: number;
  music: MusicConfig;
  profile: Profile;
  feeds: FeedConfig[];
  shows: ShowConfig[];
  schedule: ScheduleSlot[];
  /** The owner's changes to the editorial agents (prompts, temperature, on/off); defaults otherwise. */
  agents?: AgentConfig;
  /** Station sound in the app: an ident jingle between music and speech, the time signal at the full hour. Missing: both on. */
  sounds?: StationSounds;
  /** How often the planner mixes in surprises (0–100); missing means 25, about one an hour. */
  surprise?: number;
  /** «Heute»: a mood for the rest of the day, set in the app; it shapes what the planner adds. */
  mood?: StationMood;
  /** What the station does on its own (Wochenrückblick, Konzerte, …); missing keys use the defaults in features.ts. */
  features?: FeatureSettings;
  /** Building blocks the palette does not show (they can still be planned). */
  hiddenBlocks?: string[];
}

/** Moods for the rest of the day; see src/domain/mood.ts for what each one changes. */
export const MOOD_IDS = ['ruhig', 'wissen', 'musik', 'aktuell', 'ueberraschung'] as const;
export type MoodId = typeof MOOD_IDS[number];
export interface StationMood { id: MoodId; until: string }

/**
 * The station's sound. [linker]: short live transitions spoken just before an item airs (default on);
 * [musicBed]: a soft music bed under short moderations (default off; the earlier key `bed` is ignored).
 */
export interface StationSounds { ident: boolean; hourChange: boolean; linker?: boolean; musicBed?: boolean }
export const stationSounds = (config: StationConfig): Required<StationSounds> => ({ ident: true, hourChange: true, linker: true, musicBed: false, ...config.sounds });

/** `archived`: produced but not heard before it left the program; it can still be played from the archive. */
export type TimelineState = 'planned' | 'voicing' | 'ready' | 'played' | 'skipped' | 'archived' | 'failed' | 'expired';
export const OPEN_STATES: readonly TimelineState[] = ['planned', 'voicing', 'ready'];
export type TimelinePartView =
  | { kind: 'speech'; audioUrl?: string }
  | { kind: 'track'; spotifyUri: string; title: string; artist: string; durationMs: number; imageUrl?: string };
export interface FailureSummary { count: number; latestError?: string; latestAt?: string }
export interface TimelineItemView {
  /** The production step while it runs: research, writing, editing, checking, voicing or music. */
  stage?: string;
  /** 🎲 a surprise the planner mixed in; it can be swapped for another one. */
  surprise?: boolean;
  /** Overall mark (1–5) of the quality jury, for spoken items that went through the final edit. */
  quality?: number;
  id: string;
  seq: number;
  showId: string;
  showName: string;
  plannedAt: string;
  state: TimelineState;
  estimatedMinutes: number;
  /** Last change on the server, e.g. when an error happened. */
  updatedAt?: string;
  title?: string;
  sources?: Array<{ title: string; url: string }>;
  interestTags?: string[];
  verification?: VerificationPolicy;
  searchQueries?: string[];
  /** Produced by the editorial team: songs researched one by one, specialist research, fact-check corrections. */
  team?: { songs: number; specialists: number; corrections: number };
  error?: string;
  audioUrl?: string;
  /** Music hour or song: speech and Spotify tracks in playing order, and what the hour is about. */
  parts?: TimelinePartView[];
  focus?: HourFocus;
  subject?: string;
  artist?: string;
  /** An episode of a series: which one, of how many, and whether the series is a story. */
  series?: { id: string; episode: number; total: number; kind: 'wissen' | 'geschichte' };
  /** Shared by another member of the family: their name. */
  sharedBy?: string;
  /** A Mitmach-Geschichte: how it may go on after this episode, and what was chosen. */
  choice?: { question: string; options: Array<{ label: string; emoji: string }>; picked?: number };
  /** A quiz question about this item; the right answer only once it was answered. */
  quiz?: { question: string; options: string[]; answered?: number; correct?: number };
}

/** Mistral speech is capped at about 280 words, which is roughly two spoken minutes. */
export const MINUTES_LIMITS: Record<ShowFormat, [number, number]> = { brief: [1, 2], podcast: [2, 10], artist_hour: [20, 90], genre_hour: [20, 90], theme_hour: [20, 90], music_block: [10, 120] };
export const FORMATS = Object.keys(MINUTES_LIMITS) as ShowFormat[];
export const FORMAT_NAMES: Record<ShowFormat, string> = {
  brief: 'Kurzbeitrag', podcast: 'Dialog', artist_hour: 'Künstler-Stunde', genre_hour: 'Genre-Stunde', theme_hour: 'Themen-Stunde', music_block: 'Musikblock',
};
/** The length a new show of a format starts with. */
export const DEFAULT_MINUTES: Record<ShowFormat, number> = { brief: 2, podcast: 5, artist_hour: 60, genre_hour: 60, theme_hour: 60, music_block: 30 };

/** The formats as the app's show editor offers them: name and the lengths the server accepts. */
export const formatList = () => FORMATS.map(id => ({
  id, label: FORMAT_NAMES[id], minMinutes: MINUTES_LIMITS[id][0], maxMinutes: MINUTES_LIMITS[id][1], defaultMinutes: DEFAULT_MINUTES[id],
}));

export class ConfigError extends Error {}
/** A building block in the day plan; the catalog lives in `blocks.ts`. */
export const BLOCK_ID = /^_block:[a-z0-9-]{1,40}$/;

export const DEFAULT_HOST: HostPersona = {
  name: 'Mira', tone: 'ruhig, neugierig, präzise', style: 'persönliches Hintergrundradio',
  instructions: 'Sprich den Hörer direkt an, ohne Floskeln. Erkläre Fachbegriffe kurz.', cohostName: 'Jonas',
  voiceId: 'gemini_Laomedeia',
  voiceStyle: 'wie eine begeisterte Radiomoderatorin: warm, lebendig, mit Tempowechseln, Betonung und hörbarem Lächeln',
};

const ID = /^[a-z0-9][a-z0-9-]{0,39}$/;
const TIME = /^(?:[01]\d|2[0-3]):[0-5]\d$|^24:00$/;

function fail(path: string, problem: string): never { throw new ConfigError(`${path}: ${problem}`); }
function record(value: unknown, path: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail(path, 'Objekt erwartet');
  return value as Record<string, unknown>;
}
function list(value: unknown, path: string, max: number): unknown[] {
  if (!Array.isArray(value)) fail(path, 'Liste erwartet');
  if (value.length > max) fail(path, `höchstens ${max} Einträge`);
  return value;
}
function text(value: unknown, path: string, max: number, required = true): string {
  if (typeof value !== 'string') fail(path, 'Text erwartet');
  const trimmed = value.trim();
  if (required && !trimmed) fail(path, 'darf nicht leer sein');
  if (trimmed.length > max) fail(path, `höchstens ${max} Zeichen`);
  return trimmed;
}
function id(value: unknown, path: string, seen: Set<string>): string {
  if (typeof value !== 'string' || !ID.test(value)) fail(path, 'ID aus Kleinbuchstaben, Ziffern und Bindestrich erwartet');
  if (seen.has(value)) fail(path, `ID «${value}» doppelt`);
  seen.add(value);
  return value;
}
function voiceIdOf(value: unknown, path: string): string {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]{1,170}$/.test(value)) fail(path, 'ungültige Stimmen-ID');
  return value;
}
function minutesOf(time: string) { const [h, m] = time.split(':').map(Number); return h * 60 + m; }
export function isValidTimezone(timezone: string) {
  try { new Intl.DateTimeFormat('en-US', { timeZone: timezone }); return true; } catch { return false; }
}

function musicBlock(s: Record<string, unknown>, path: string, whole: (value: unknown, name: string, min: number, max: number, fallback: number) => number)
  : Pick<ShowConfig, 'groups' | 'switchAfterTracks' | 'switchAfterMinutes' | 'triggers' | 'talkSeconds'> {
  const groups = list(s.groups ?? [{ name: 'Mein Geschmack', playlists: [], taste: '' }], `${path}.groups`, 6).map((value, index): PlaylistGroup => {
    const g = record(value, `${path}.groups[${index}]`);
    const playlists = list(g.playlists ?? [], `${path}.groups[${index}].playlists`, 5).map((item, i) => {
      const found = typeof item === 'string' ? playlistId(item) : undefined;
      if (!found) fail(`${path}.groups[${index}].playlists[${i}]`, 'Spotify-Playlist-Link oder -ID erwartet');
      return found;
    });
    if (g.releases !== undefined && typeof g.releases !== 'boolean') fail(`${path}.groups[${index}].releases`, 'true oder false');
    return { name: text(g.name, `${path}.groups[${index}].name`, 60), playlists: [...new Set(playlists)], taste: text(g.taste ?? '', `${path}.groups[${index}].taste`, 500, false),
      ...(g.releases === true ? { releases: true } : {}) };
  });
  if (!groups.length) fail(`${path}.groups`, 'mindestens eine Gruppe');
  const t = s.triggers === undefined ? DEFAULT_TRIGGERS : record(s.triggers, `${path}.triggers`);
  const flag = (name: keyof BlockTriggers) => {
    if (t[name] === undefined) return DEFAULT_TRIGGERS[name] as boolean;
    if (typeof t[name] !== 'boolean') fail(`${path}.triggers.${name}`, 'true oder false');
    return t[name] as boolean;
  };
  const count = (name: keyof BlockTriggers, max: number) => whole(t[name], `triggers.${name}`, 0, max, DEFAULT_TRIGGERS[name] as number);
  const triggers: BlockTriggers = {
    blockStart: flag('blockStart'), blockEnd: flag('blockEnd'), beforeTrack: count('beforeTrack', 10), afterTrack: count('afterTrack', 10),
    everyMinutes: count('everyMinutes', 60), groupTransition: flag('groupTransition'),
  };
  // Every block has generated speech: the host must get a word in somewhere.
  if (!Object.values(triggers).some(Boolean)) fail(`${path}.triggers`, 'mindestens ein Moderations-Anlass');
  return {
    groups, triggers, talkSeconds: whole(s.talkSeconds, 'talkSeconds', 10, 120, 20),
    switchAfterTracks: whole(s.switchAfterTracks, 'switchAfterTracks', 0, 20, 3), switchAfterMinutes: whole(s.switchAfterMinutes, 'switchAfterMinutes', 0, 120, 0),
  };
}

function production(value: unknown, path: string): HourProduction {
  if (value === undefined || value === 'standard') return 'standard';
  if (value !== 'agents') fail(path, '«standard» oder «agents»');
  return 'agents';
}

export function parseStationConfig(raw: unknown): StationConfig {
  const c = record(raw, 'config');
  if (c.version !== 1) fail('version', '1 erwartet');
  const timezone = text(c.timezone, 'timezone', 64);
  if (!isValidTimezone(timezone)) fail('timezone', 'unbekannte Zeitzone');
  const horizonMinutes = Number(c.horizonMinutes);
  if (!Number.isInteger(horizonMinutes) || horizonMinutes < 10 || horizonMinutes > 120) fail('horizonMinutes', 'ganze Zahl von 10 bis 120');

  // Name and host were added after the first release; stored documents without them get the defaults.
  const name = c.name === undefined ? 'Personal Radio' : text(c.name, 'name', 60);
  const h = c.host === undefined ? DEFAULT_HOST : record(c.host, 'host');
  const host: HostPersona = {
    name: text(h.name, 'host.name', 40), tone: text(h.tone, 'host.tone', 160), style: text(h.style, 'host.style', 160),
    instructions: text(h.instructions ?? '', 'host.instructions', 2000, false),
    ...(h.cohostName !== undefined && String(h.cohostName).trim() ? { cohostName: text(h.cohostName, 'host.cohostName', 40) } : {}),
    ...(h.voiceId !== undefined ? { voiceId: voiceIdOf(h.voiceId, 'host.voiceId') } : {}),
    ...(h.cohostVoiceId !== undefined && h.cohostVoiceId !== '' ? { cohostVoiceId: voiceIdOf(h.cohostVoiceId, 'host.cohostVoiceId') } : {}),
    ...(h.voiceStyle !== undefined && String(h.voiceStyle).trim() ? { voiceStyle: text(h.voiceStyle, 'host.voiceStyle', 300) } : {}),
  };

  const feedIds = new Set<string>();
  const feeds = list(c.feeds, 'feeds', 30).map((value, index): FeedConfig => {
    const f = record(value, `feeds[${index}]`);
    const url = text(f.url, `feeds[${index}].url`, 2048);
    try { if (new URL(url).protocol !== 'https:') throw new Error(); } catch { fail(`feeds[${index}].url`, 'HTTPS-URL erwartet'); }
    return { id: id(f.id, `feeds[${index}].id`, feedIds), name: text(f.name, `feeds[${index}].name`, 80), url };
  });

  const showIds = new Set<string>();
  const shows = list(c.shows, 'shows', 20).map((value, index): ShowConfig => {
    const path = `shows[${index}]`, s = record(value, path);
    if (!FORMATS.includes(s.format as ShowFormat)) fail(`${path}.format`, FORMATS.map(format => `«${format}»`).join(', '));
    const format = s.format as ShowFormat, focus = HOUR_FOCUS[format];
    if (s.verification !== 'strict' && s.verification !== 'light' && s.verification !== 'off') fail(`${path}.verification`, '«strict», «light» oder «off»');
    const [min, max] = MINUTES_LIMITS[format];
    const targetMinutes = Number(s.targetMinutes);
    if (!Number.isFinite(targetMinutes) || targetMinutes < min || targetMinutes > max) fail(`${path}.targetMinutes`, `${min} bis ${max} Minuten für «${s.format}»`);
    const showFeeds = list(s.feedIds, `${path}.feedIds`, 30).map((feed, i) => {
      if (typeof feed !== 'string' || !feedIds.has(feed)) fail(`${path}.feedIds[${i}]`, 'unbekannter Feed');
      return feed;
    });
    if (s.voiceId !== undefined && (typeof s.voiceId !== 'string' || !/^[A-Za-z0-9_-]{1,100}$/.test(s.voiceId))) fail(`${path}.voiceId`, 'ungültige Stimmen-ID');
    const textProvider = s.textProvider ?? 'gemini';
    if (textProvider !== 'gemini' && textProvider !== 'ask') fail(`${path}.textProvider`, '«gemini» oder «ask»');
    if (s.format === 'podcast' && textProvider !== 'gemini') fail(`${path}.textProvider`, 'Dialoge schreibt nur «gemini»');
    if (focus && textProvider !== 'gemini') fail(`${path}.textProvider`, 'Musikstunden schreibt nur «gemini» (Websuche)');
    if (format === 'music_block' && textProvider !== 'gemini') fail(`${path}.textProvider`, 'Musikblöcke moderiert nur «gemini»');
    const whole = (value: unknown, name: string, min: number, max: number, fallback: number) => {
      if (value === undefined) return fallback;
      if (!Number.isInteger(value) || (value as number) < min || (value as number) > max) fail(`${path}.${name}`, `ganze Zahl von ${min} bis ${max}`);
      return value as number;
    };
    const sourceMode = s.sourceMode ?? 'feeds';
    if (sourceMode !== 'feeds' && sourceMode !== 'web') fail(`${path}.sourceMode`, '«feeds» oder «web»');
    return {
      id: id(s.id, `${path}.id`, showIds), name: text(s.name, `${path}.name`, 80), enabled: s.enabled === true,
      format, instructions: text(s.instructions ?? '', `${path}.instructions`, 2000, false),
      feedIds: [...new Set(showFeeds)], targetMinutes, verification: s.verification,
      textProvider, sourceMode, researchPrompt: text(s.researchPrompt ?? '', `${path}.researchPrompt`, 1000, false),
      ...(focus ? {
        ...(s[focus] !== undefined && s[focus] !== null && String(s[focus]).trim() ? { [focus]: text(s[focus], `${path}.${focus}`, 200) } : {}),
        tracks: whole(s.tracks, 'tracks', 3, 15, focus === 'theme' ? 8 : 10),
        // Theme hours talk more: the topic is the content, the music accompanies it.
        talkSeconds: whole(s.talkSeconds, 'talkSeconds', 20, 180, focus === 'theme' ? 120 : 60),
        production: production(s.production, `${path}.production`),
      } : {}),
      ...(format === 'music_block' ? musicBlock(s, path, whole) : {}),
      ...(typeof s.voiceId === 'string' ? { voiceId: s.voiceId } : {}),
      ...(s.tools !== undefined ? { tools: [...new Set(list(s.tools, `${path}.tools`, 3).map((tool, i) => {
        if (!SHOW_TOOLS.includes(tool as ShowTool)) fail(`${path}.tools[${i}]`, SHOW_TOOLS.map(name => `«${name}»`).join(', '));
        return tool as ShowTool;
      }))] } : {}),
    };
  });

  const slotIds = new Set<string>();
  const schedule = list(c.schedule, 'schedule', 50).map((value, index): ScheduleSlot => {
    const path = `schedule[${index}]`, s = record(value, path);
    const days = list(s.days, `${path}.days`, 7).map(day => {
      if (!Number.isInteger(day) || (day as number) < 0 || (day as number) > 6) fail(`${path}.days`, 'Wochentage 0 (So) bis 6 (Sa)');
      return day as number;
    });
    if (!days.length) fail(`${path}.days`, 'mindestens ein Wochentag');
    if (typeof s.from !== 'string' || !TIME.test(s.from) || s.from === '24:00') fail(`${path}.from`, 'Zeit HH:MM erwartet');
    if (typeof s.to !== 'string' || !TIME.test(s.to)) fail(`${path}.to`, 'Zeit HH:MM erwartet');
    if (minutesOf(s.from) >= minutesOf(s.to)) fail(path, '«from» muss vor «to» liegen');
    const slotShows = list(s.showIds, `${path}.showIds`, 20).map((show, i) => {
      // Building blocks of the day plan (`_block:<id>`) stand next to the owner's shows.
      if (typeof show !== 'string' || (!showIds.has(show) && !BLOCK_ID.test(show))) fail(`${path}.showIds[${i}]`, 'unbekannte Sendung');
      return show;
    });
    if (!slotShows.length) fail(`${path}.showIds`, 'mindestens eine Sendung');
    return { id: id(s.id, `${path}.id`, slotIds), days: [...new Set(days)].sort(), from: s.from, to: s.to, showIds: slotShows };
  });

  // AI-generated speech is the core of the station: a program of music alone is not a valid configuration.
  // Every block brings its own moderation, so a day plan of blocks counts too.
  if (!shows.some(show => show.enabled) && !schedule.some(slot => slot.showIds.some(show => BLOCK_ID.test(show)))) {
    fail('shows', 'mindestens eine aktive Sendung oder ein Baustein im Tagesplan – KI-Sprechbeiträge sind Pflicht');
  }

  // Stations saved before music existed keep playing without songs until the owner turns them on.
  const m = c.music === undefined ? { between: 0, announce: true, taste: '' } : record(c.music, 'music');
  const between = Number(m.between ?? 1);
  if (!Number.isInteger(between) || between < 0 || between > 3) fail('music.between', 'ganze Zahl von 0 bis 3');
  if (m.announce !== undefined && typeof m.announce !== 'boolean') fail('music.announce', 'true oder false');
  const music: MusicConfig = { between, announce: m.announce !== false, taste: text(m.taste ?? '', 'music.taste', 500, false) };

  let location: StationLocation | undefined;
  if (c.location !== undefined && c.location !== null) {
    const l = record(c.location, 'location');
    const latitude = Number(l.latitude), longitude = Number(l.longitude);
    if (typeof l.latitude !== 'number' || !(latitude >= -90 && latitude <= 90)) fail('location.latitude', 'Breitengrad von -90 bis 90');
    if (typeof l.longitude !== 'number' || !(longitude >= -180 && longitude <= 180)) fail('location.longitude', 'Längengrad von -180 bis 180');
    location = { name: text(l.name, 'location.name', 80), latitude, longitude };
  }

  const agents = parseAgentConfig(c.agents, fail);
  let surprise: number | undefined;
  if (c.surprise !== undefined && c.surprise !== null) {
    surprise = Number(c.surprise);
    if (typeof c.surprise !== 'number' || !Number.isInteger(surprise) || surprise < 0 || surprise > 100) fail('surprise', 'ganze Zahl von 0 bis 100');
  }
  let mood: StationMood | undefined;
  if (c.mood !== undefined && c.mood !== null) {
    const m = record(c.mood, 'mood');
    if (!MOOD_IDS.includes(m.id as MoodId)) fail('mood.id', MOOD_IDS.join(', '));
    if (typeof m.until !== 'string' || Number.isNaN(Date.parse(m.until))) fail('mood.until', 'Zeitpunkt (ISO 8601)');
    mood = { id: m.id as MoodId, until: new Date(m.until as string).toISOString() };
  }
  let sounds: StationSounds | undefined;
  if (c.sounds !== undefined && c.sounds !== null) {
    const s = record(c.sounds, 'sounds');
    if (typeof s.ident !== 'boolean') fail('sounds.ident', 'true oder false');
    if (typeof s.hourChange !== 'boolean') fail('sounds.hourChange', 'true oder false');
    for (const key of ['linker', 'musicBed'] as const) if (s[key] !== undefined && typeof s[key] !== 'boolean') fail(`sounds.${key}`, 'true oder false');
    sounds = { ident: s.ident as boolean, hourChange: s.hourChange as boolean,
      ...(typeof s.linker === 'boolean' ? { linker: s.linker } : {}), ...(typeof s.musicBed === 'boolean' ? { musicBed: s.musicBed } : {}) };
  }
  const features = parseFeatures(c.features), hiddenBlocks = parseHiddenBlocks(c.hiddenBlocks);
  return { version: 1, name, host, timezone, ...(location ? { location } : {}), horizonMinutes, music, profile: parseProfile(c.profile), feeds, shows, schedule, ...(agents ? { agents } : {}), ...(sounds ? { sounds } : {}), ...(surprise !== undefined ? { surprise } : {}), ...(mood ? { mood } : {}),
    ...(features ? { features } : {}), ...(hiddenBlocks ? { hiddenBlocks } : {}) };
}

/** Starting point built from what the device already stores; the owner edits it afterwards. */
export function defaultStationConfig(input: { profile?: Profile; feeds?: Array<{ name: string; url: string }>; voiceId?: string; timezone?: string } = {}): StationConfig {
  const feeds = (input.feeds ?? []).slice(0, 30).map((feed, index) => ({ id: `feed-${index + 1}`, name: feed.name.slice(0, 80), url: feed.url }));
  const profile = input.profile ?? { ...defaultProfile, topics: [...defaultProfile.topics], interests: [], interestWeights: {} };
  const feedIds = feeds.map(feed => feed.id);
  return parseStationConfig({
    version: 1, name: 'Personal Radio', music: { between: 1, announce: true, taste: '' }, host: { ...DEFAULT_HOST, ...(input.voiceId ? { voiceId: input.voiceId } : {}) }, timezone: input.timezone && isValidTimezone(input.timezone) ? input.timezone : 'Europe/Zurich', horizonMinutes: 20,
    profile: { ...profile, interestWeights: {} }, feeds,
    shows: [
      { id: 'kurz', name: 'Kurzbeitrag', enabled: feedIds.length > 0, format: 'brief', feedIds, verification: 'strict', sourceMode: 'feeds',
        targetMinutes: Math.min(2, Math.max(1, profile.speechMinutes)), instructions: '' },
      { id: 'dialog', name: 'Hintergrund im Dialog', enabled: false, format: 'podcast', feedIds, verification: 'light',
        targetMinutes: 5, instructions: 'Ordne ein, erkläre Begriffe und zeige Zusammenhänge.' },
      { id: 'entdecken', name: 'Entdeckungen', enabled: true, format: 'brief', feedIds: [], verification: 'strict', sourceMode: 'web',
        targetMinutes: 2, instructions: 'Erzähle eine konkrete Entdeckung, nicht eine Übersicht.',
        researchPrompt: 'Finde eine aktuelle, wenig bekannte Entwicklung zu einem meiner Interessen, die ich wahrscheinlich noch nicht kenne.' },
      { id: 'kuenstler', name: 'Künstler-Stunde', enabled: false, format: 'artist_hour', feedIds: [], verification: 'light', sourceMode: 'web',
        targetMinutes: 60, tracks: 10, talkSeconds: 60, instructions: 'Frühwerk und Einflüsse betonen, keine Chart-Statistiken.',
        researchPrompt: 'Wenig bekannte Hintergründe zur Entstehung der Songs.' },
      { id: 'genre', name: 'Genre-Stunde', enabled: false, format: 'genre_hour', feedIds: [], verification: 'light', sourceMode: 'web',
        targetMinutes: 60, tracks: 10, talkSeconds: 60, instructions: 'Vom Ursprung bis heute, Wegbereiter und Seitenwege.', researchPrompt: '' },
      { id: 'thema', name: 'Themen-Stunde', enabled: false, format: 'theme_hour', feedIds: [], verification: 'light', sourceMode: 'web',
        targetMinutes: 60, tracks: 8, talkSeconds: 120, instructions: 'Erzähle das Thema in Kapiteln; jeder Song passt inhaltlich zum Kapitel davor.', researchPrompt: '' },
    ],
    schedule: [{ id: 'immer', days: [0, 1, 2, 3, 4, 5, 6], from: '00:00', to: '24:00', showIds: ['kurz', 'entdecken', 'dialog'] }],
  });
}

/** Weekday (0 = Sunday) and minutes since midnight in the station's time zone. */
export function localClock(date: Date, timezone: string): { day: number; minutes: number } {
  const parts = new Intl.DateTimeFormat('en-US', { timeZone: timezone, weekday: 'short', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(date);
  const get = (type: string) => parts.find(part => part.type === type)?.value ?? '';
  const day = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(get('weekday'));
  return { day, minutes: Number(get('hour')) * 60 + Number(get('minute')) };
}

export function activeSlot(config: StationConfig, date: Date): ScheduleSlot | undefined {
  const { day, minutes } = localClock(date, config.timezone);
  return config.schedule.find(slot => slot.days.includes(day) && minutesOf(slot.from) <= minutes && minutes < minutesOf(slot.to));
}
