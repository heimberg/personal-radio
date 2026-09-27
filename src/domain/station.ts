import { defaultProfile, parseProfile } from './program.ts';
import type { HostPersona, Profile } from './program.ts';

// Server-side station configuration. Everything that shapes the program is data the owner can edit.
export type ShowFormat = 'brief' | 'podcast';
export type VerificationPolicy = 'strict' | 'light' | 'off';
export type TextProvider = 'gemini' | 'ask';
export type SourceMode = 'feeds' | 'web';
export interface FeedConfig { id: string; name: string; url: string }
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
}
export interface ScheduleSlot { id: string; days: number[]; from: string; to: string; showIds: string[] }
export interface StationConfig {
  version: 1;
  /** Station name the host uses on air. */
  name: string;
  host: HostPersona;
  timezone: string;
  horizonMinutes: number;
  profile: Profile;
  feeds: FeedConfig[];
  shows: ShowConfig[];
  schedule: ScheduleSlot[];
}

export type TimelineState = 'planned' | 'voicing' | 'ready' | 'played' | 'skipped' | 'failed' | 'expired';
export const OPEN_STATES: readonly TimelineState[] = ['planned', 'voicing', 'ready'];
export interface TimelineItemView {
  id: string;
  seq: number;
  showId: string;
  showName: string;
  plannedAt: string;
  state: TimelineState;
  estimatedMinutes: number;
  title?: string;
  sources?: Array<{ title: string; url: string }>;
  interestTags?: string[];
  verification?: VerificationPolicy;
  searchQueries?: string[];
  error?: string;
  audioUrl?: string;
}

/** Mistral speech is capped at about 280 words, which is roughly two spoken minutes. */
export const MINUTES_LIMITS: Record<ShowFormat, [number, number]> = { brief: [1, 2], podcast: [2, 10] };

export class ConfigError extends Error {}

export const DEFAULT_HOST: HostPersona = {
  name: 'Mira', tone: 'ruhig, neugierig, präzise', style: 'persönliches Hintergrundradio',
  instructions: 'Sprich den Hörer direkt an, ohne Floskeln. Erkläre Fachbegriffe kurz.', cohostName: 'Jonas',
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
function minutesOf(time: string) { const [h, m] = time.split(':').map(Number); return h * 60 + m; }
export function isValidTimezone(timezone: string) {
  try { new Intl.DateTimeFormat('en-US', { timeZone: timezone }); return true; } catch { return false; }
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
    if (s.format !== 'brief' && s.format !== 'podcast') fail(`${path}.format`, '«brief» oder «podcast»');
    if (s.verification !== 'strict' && s.verification !== 'light' && s.verification !== 'off') fail(`${path}.verification`, '«strict», «light» oder «off»');
    const [min, max] = MINUTES_LIMITS[s.format];
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
    const sourceMode = s.sourceMode ?? 'feeds';
    if (sourceMode !== 'feeds' && sourceMode !== 'web') fail(`${path}.sourceMode`, '«feeds» oder «web»');
    return {
      id: id(s.id, `${path}.id`, showIds), name: text(s.name, `${path}.name`, 80), enabled: s.enabled === true,
      format: s.format, instructions: text(s.instructions ?? '', `${path}.instructions`, 2000, false),
      feedIds: [...new Set(showFeeds)], targetMinutes, verification: s.verification,
      textProvider, sourceMode, researchPrompt: text(s.researchPrompt ?? '', `${path}.researchPrompt`, 1000, false),
      ...(typeof s.voiceId === 'string' ? { voiceId: s.voiceId } : {}),
    };
  });

  // AI-generated speech is the core of the station: a program of music alone is not a valid configuration.
  if (!shows.some(show => show.enabled)) fail('shows', 'mindestens eine aktive Sendung – KI-Sprechbeiträge sind Pflicht');

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
      if (typeof show !== 'string' || !showIds.has(show)) fail(`${path}.showIds[${i}]`, 'unbekannte Sendung');
      return show;
    });
    if (!slotShows.length) fail(`${path}.showIds`, 'mindestens eine Sendung');
    return { id: id(s.id, `${path}.id`, slotIds), days: [...new Set(days)].sort(), from: s.from, to: s.to, showIds: slotShows };
  });

  return { version: 1, name, host, timezone, horizonMinutes, profile: parseProfile(c.profile), feeds, shows, schedule };
}

/** Starting point built from what the device already stores; the owner edits it afterwards. */
export function defaultStationConfig(input: { profile?: Profile; feeds?: Array<{ name: string; url: string }>; voiceId?: string; timezone?: string } = {}): StationConfig {
  const feeds = (input.feeds ?? []).slice(0, 30).map((feed, index) => ({ id: `feed-${index + 1}`, name: feed.name.slice(0, 80), url: feed.url }));
  const profile = input.profile ?? { ...defaultProfile, topics: [...defaultProfile.topics], interests: [], interestWeights: {} };
  const feedIds = feeds.map(feed => feed.id);
  return parseStationConfig({
    version: 1, name: 'Personal Radio', host: DEFAULT_HOST, timezone: input.timezone && isValidTimezone(input.timezone) ? input.timezone : 'Europe/Zurich', horizonMinutes: 20,
    profile: { ...profile, interestWeights: {} }, feeds,
    shows: [
      { id: 'kurz', name: 'Kurzbeitrag', enabled: feedIds.length > 0, format: 'brief', feedIds, verification: 'strict', sourceMode: 'feeds',
        targetMinutes: Math.min(2, Math.max(1, profile.speechMinutes)), instructions: '',
        ...(input.voiceId ? { voiceId: input.voiceId } : {}) },
      { id: 'dialog', name: 'Hintergrund im Dialog', enabled: false, format: 'podcast', feedIds, verification: 'light',
        targetMinutes: 5, instructions: 'Ordne ein, erkläre Begriffe und zeige Zusammenhänge.' },
      { id: 'entdecken', name: 'Entdeckungen', enabled: true, format: 'brief', feedIds: [], verification: 'strict', sourceMode: 'web',
        targetMinutes: 2, instructions: 'Erzähle eine konkrete Entdeckung, nicht eine Übersicht.',
        researchPrompt: 'Finde eine aktuelle, wenig bekannte Entwicklung zu einem meiner Interessen, die ich wahrscheinlich noch nicht kenne.' },
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
