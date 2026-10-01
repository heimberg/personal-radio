import { createRemoteJWKSet, jwtVerify } from 'jose';
import { SegmentPipeline, PipelineError, type CharacterBudgetStore } from './segment-pipeline.ts';
import { AskEditorialVerifier, AskTextGenerator, FallbackVerifier, GeminiBriefGenerator, GeminiEditorialVerifier, GeminiPodcastGenerator, GeminiPodcastSpeechSynthesizer, GeminiResearcher, GeminiSpeechSynthesizer, GeminiVoiceCatalog, GEMINI_VOICES, MistralSpeechSynthesizer, ProviderError, VoiceRouter, pcmToWav } from './providers.ts';
import type { Researcher } from './providers.ts';
import type { EditorialVerifier } from './segment-pipeline.ts';
import type { TextGenerator } from '../src/domain/program.ts';
import type { Profile, Source } from '../src/domain/program.ts';
import { fetchFeed, FeedError, validateFeedUrl } from './feed.ts';
import { listMistralVoices } from './mistral-voices.ts';
import { StationStore } from './station-store.ts';
import type { D1Database } from './station-store.ts';
import { OpenMeteo } from './tools.ts';
import { GeminiScriptEditor } from './editing.ts';
import { blockViews } from '../src/domain/blocks.ts';
import { AUDIO_RETENTION_DAYS, SeriesError, addBlock, addFollowUp, arrangeTimeline, deleteItem, produceItem, removeItem, scheduleShowNow, seriesView, shuffleTimeline, showNameOf, stopSeries, swapItem, tick, toView, transcriptView, trialAgent, answerQuiz, chooseStory } from './station.ts';
import { GeminiMusicWriter, SpotifyCatalog } from './music.ts';
import { SpotifyListening } from './listening.ts';
import { D1StepRunner } from './agentic/steps.ts';
import type { MusicCatalog, MusicWriter, PlaylistSource } from './music.ts';
import type { AudioBucket, StationDeps, TrialAgent } from './station.ts';
import { ConfigError, MOOD_IDS, parseStationConfig, stationSounds } from '../src/domain/station.ts';
import type { MoodId, StationConfig } from '../src/domain/station.ts';
import { activeMood, endOfDay } from '../src/domain/mood.ts';
import { AGENTS, parseAgentConfig } from '../src/domain/agents.ts';
import { meteredFetch, usageSummary } from './usage.ts';
import { PlayStore, albumView } from './play.ts';
import { SERIES_PREFIX } from '../src/domain/series.ts';
import { IDENT_VARIANTS, hourKey, hourText, identJingle, newsOpener, previewKey, previewText, timeSignal } from './sounds.ts';
import { linkerFacts, linkerKey, linkerSystem, linkerText, silentWav } from './linker.ts';
import { allOwners, forKids, isKids, parseListeners } from './listeners.ts';
import { FamilyStore, avatarImage, avatarKey, copyItem, familyMembers, mayCopyInto, messageLine } from './family.ts';
import type { AudioObjects, Member } from './family.ts';

const identAudio: Array<Uint8Array | undefined> = [];
let signalAudio: Uint8Array | undefined, newsAudio: Uint8Array | undefined;
import { FEEDBACK_REASONS, NOTE_MIN_COUNT, NOTE_WINDOW_DAYS, isFeedbackReason, listenerNotes } from '../src/domain/listener-notes.ts';
import type { FeedbackAction } from '../src/domain/recommendation.ts';

interface StoredAudio { body: ReadableStream; size: number; httpEtag: string; range?: { offset?: number; length?: number; suffix?: number } }
interface AudioStore extends AudioBucket {
  get(key: string, options?: { range?: Headers }): Promise<StoredAudio | null>;
  list?(options: { prefix: string; limit?: number }): Promise<{ objects: Array<{ key: string }> }>;
}
interface ProductionQueue { send(message: ProductionMessage): Promise<void> }
interface ProductionMessage { owner: string; itemId: string }
interface QueueBatch { messages: Array<{ body: unknown; ack(): void }> }
interface ExecutionContext { waitUntil(promise: Promise<unknown>): void }
interface DailyCounter { reserve(ownerId: string, limit: number): Promise<void> }
interface Environment {
  DB: D1Database;
  ASSETS: { fetch(request: Request): Promise<Response> };
  AUDIO: AudioStore;
  PRODUCTION: ProductionQueue;
  ACCESS_TEAM_DOMAIN: string;
  ACCESS_AUD: string;
  ALLOWED_EMAIL: string;
  /** Client ID of the Access service token used by the Android app; its requests act as the owner. */
  ACCESS_SERVICE_TOKEN_ID?: string;
  /** Further listeners, each with their own service token and station: `<client ID>=<name>[:kids]; …` (see server/listeners.ts). */
  LISTENERS?: string;
  DAILY_TTS_CHARACTERS?: string;
  DAILY_GENERATIONS?: string;
  DAILY_FEED_REQUESTS?: string;
  DAILY_LINKERS?: string;
  ASK_BASE_URL: string;
  ASK_API_KEY: string;
  ASK_MODEL: string;
  MISTRAL_API_KEY: string;
  MISTRAL_VOICE_ID?: string;
  MISTRAL_TTS_MODEL?: string;
  GEMINI_API_KEY?: string;
  GEMINI_TEXT_MODEL?: string;
  GEMINI_RESEARCH_MODEL?: string;
  /** Spotify app credentials for track search (client credentials, no user login). */
  SPOTIFY_CLIENT_ID?: string;
  SPOTIFY_CLIENT_SECRET?: string;
  SPOTIFY_MARKET?: string;
  GEMINI_TTS_MODEL?: string;
  /** The cheaper voice model for live transitions and the hour announcement. */
  GEMINI_TTS_LITE_MODEL?: string;
  /** Requests a day Google allows GEMINI_TTS_MODEL on this key's tier (100 on Tier 1); only shown in the usage overview. */
  GEMINI_TTS_DAILY_REQUESTS?: string;
  GEMINI_VOICE_A?: string;
  GEMINI_VOICE_B?: string;
  /** How the family tab names the owner (default «Papa»). */
  OWNER_NAME?: string;
}

class D1CharacterBudget implements CharacterBudgetStore {
  private db: D1Database;
  private dailyLimit: number;
  constructor(db: D1Database, dailyLimit: number) { this.db = db; this.dailyLimit = dailyLimit; }
  async reserve(ownerId: string, characters: number) {
    const day = new Date().toISOString().slice(0, 10);
    // A single conditional UPSERT is atomic across concurrent Worker instances.
    const result = await this.db.prepare(`INSERT INTO daily_usage (owner_id, utc_day, characters)
      VALUES (?, ?, ?) ON CONFLICT(owner_id, utc_day) DO UPDATE
      SET characters = daily_usage.characters + excluded.characters
      WHERE daily_usage.characters + excluded.characters <= ? RETURNING characters`)
      .bind(ownerId, day, characters, this.dailyLimit).first<{ characters: number }>();
    if (!result) throw new PipelineError('BUDGET_EXCEEDED');
  }
}

class D1DailyCounter implements DailyCounter {
  private db: D1Database;
  constructor(db: D1Database) { this.db = db; }
  async reserve(ownerId: string, limit: number) {
    const day = new Date().toISOString().slice(0, 10);
    const result = await this.db.prepare(`INSERT INTO daily_requests (owner_id, utc_day, requests)
      VALUES (?, ?, 1) ON CONFLICT(owner_id, utc_day) DO UPDATE
      SET requests = daily_requests.requests + 1
      WHERE daily_requests.requests < ? RETURNING requests`)
      .bind(ownerId, day, limit).first<{ requests: number }>();
    if (!result) throw new PipelineError('BUDGET_EXCEEDED');
  }
}

class D1FeedCounter implements DailyCounter {
  private db: D1Database;
  constructor(db: D1Database) { this.db = db; }
  async reserve(ownerId: string, limit: number) {
    const day = new Date().toISOString().slice(0, 10);
    const result = await this.db.prepare(`INSERT INTO daily_feed_requests (owner_id, utc_day, requests)
      VALUES (?, ?, 1) ON CONFLICT(owner_id, utc_day) DO UPDATE
      SET requests = daily_feed_requests.requests + 1
      WHERE daily_feed_requests.requests < ? RETURNING requests`)
      .bind(ownerId, day, limit).first<{ requests: number }>();
    if (!result) throw new PipelineError('BUDGET_EXCEEDED');
  }
}

class D1LinkerCounter implements DailyCounter {
  private db: D1Database;
  constructor(db: D1Database) { this.db = db; }
  async reserve(ownerId: string, limit: number) {
    const day = new Date().toISOString().slice(0, 10);
    const result = await this.db.prepare(`INSERT INTO daily_linker_requests (owner_id, utc_day, requests)
      VALUES (?, ?, 1) ON CONFLICT(owner_id, utc_day) DO UPDATE
      SET requests = daily_linker_requests.requests + 1
      WHERE daily_linker_requests.requests < ? RETURNING requests`)
      .bind(ownerId, day, limit).first<{ requests: number }>();
    if (!result) throw new PipelineError('BUDGET_EXCEEDED');
  }
}

/** Live transitions are made for one moment; after two days they are removed from the bucket. */
async function pruneLinkers(audio: AudioStore, now: Date) {
  if (!audio.list) return;
  const keep = new Date(now.getTime() - 2 * 86_400_000).toISOString().slice(0, 10);
  const { objects } = await audio.list({ prefix: 'linkers/', limit: 200 });
  for (const object of objects) if (object.key.slice('linkers/'.length, 'linkers/'.length + 10) < keep) await audio.delete(object.key);
}

let silence: Uint8Array | undefined;
const LINKER_ID = /^[a-zA-Z0-9_-]{1,80}$/;

/**
 * `GET /api/linker?after=&next=`: the host's live transition into [next], written and voiced when the app
 * asks (shortly before it airs) and kept for replays. Anything that fails plays a moment of silence
 * instead, so the program never stalls on a transition.
 */
async function linker(env: Environment, store: StationStore, owner: string, url: URL): Promise<Response> {
  const audio = (bytes: Uint8Array, type: string) =>
    new Response(bytes as BodyInit, { headers: { 'Content-Type': type, 'Content-Length': String(bytes.byteLength), 'Cache-Control': 'private, max-age=86400' } });
  const quiet = () => audio(silence ??= silentWav(), 'audio/wav');
  const after = url.searchParams.get('after'), next = url.searchParams.get('next') ?? '';
  if (!LINKER_ID.test(next) || after !== null && !LINKER_ID.test(after)) return json({ error: 'invalid_request' }, 400);
  try {
    const stored = await store.getConfig(owner), writer = musicFor(env).writer;
    const config = stored && isKids(owner, parseListeners(env.LISTENERS)) ? forKids(stored) : stored;
    if (!config || !stationSounds(config).linker || !writer) return quiet();
    const [nextRow, before] = await Promise.all([store.getItem(owner, next), after ? store.getItem(owner, after) : Promise.resolve(null)]);
    if (!nextRow) return quiet();
    const now = new Date(), voice = `${config.host.voiceId ?? ''}|${config.host.voiceStyle ?? ''}|${stationSounds(config).musicBed}`;
    // A family greeting waiting for this listener is read in this transition (and never comes from the cache).
    const family = new FamilyStore(env.DB), greeting = await family.pendingGreeting(owner, now);
    const from = greeting ? membersOf(env).find(member => member.owner === greeting.sender)?.name ?? 'der Familie' : '';
    // A question to the radio is answered in a transition without a greeting (one thing at a time).
    const play = new PlayStore(env.DB), question = greeting ? null : await play.pendingQuestion(owner, now);
    const asker = question ? membersOf(env).find(member => member.owner === owner)?.name ?? '' : '';
    const key = linkerKey(now.toISOString().slice(0, 10), after, next, voice + (greeting ? `|g${greeting.id}` : '') + (question ? `|q${question.id}` : ''));
    for (const [suffix, type] of [['.wav', 'audio/wav'], ['.mp3', 'audio/mpeg']] as const) {
      const stored = await env.AUDIO.get(key + suffix);
      if (stored) return new Response(stored.body, { headers: { 'Content-Type': type, 'Content-Length': String(stored.size), 'Cache-Control': 'private, max-age=86400' } });
    }
    await new D1LinkerCounter(env.DB).reserve(owner, Math.max(1, Number(env.DAILY_LINKERS) || 40));
    const facts = { ...linkerFacts(config, before, nextRow, showNameOf(nextRow.show_id, config), now), ...(greeting ? { greeting: { from, text: greeting.text } } : {}),
      ...(question ? { question: { from: asker, text: question.text } } : {}) };
    const text = linkerText(await writer.askJson(linkerSystem(config, !facts.before || facts.before.music, !!greeting, !!question), facts, 'Gemini linker', 0.8),
      greeting ? 640 : question ? 900 : 320);
    if (!text) return quiet();
    const voiced = await pipelineFor(env).voice(owner, { title: 'Übergang', text, sourceIds: [] }, 'brief', config.host.voiceId, config.host.voiceStyle,
      { reserve: false, bed: stationSounds(config).musicBed, lite: true });
    await env.AUDIO.put(key + (voiced.contentType === 'audio/wav' ? '.wav' : '.mp3'), voiced.audio, { httpMetadata: { contentType: voiced.contentType } });
    if (greeting) await family.markAired(greeting.id, now);
    if (question) await play.answered(question.id, text, now);
    return audio(voiced.audio, voiced.contentType);
  } catch (error) {
    console.error('linker failed', error instanceof Error ? error.message.slice(0, 160) : 'unknown');
    return quiet();
  }
}

/** Everyone on this Worker: the owner and the listeners. */
const membersOf = (env: Environment): Member[] => familyMembers(env.ALLOWED_EMAIL ?? '', parseListeners(env.LISTENERS), env.OWNER_NAME);

/** R2 objects as the family copy reads them. */
const audioObjects = (env: Environment): AudioObjects => ({
  get: async key => {
    const object = await env.AUDIO.get(key);
    return object ? { arrayBuffer: () => new Response(object.body).arrayBuffer(), httpMetadata: (object as { httpMetadata?: { contentType?: string } }).httpMetadata } : null;
  },
  put: (key, value, options) => env.AUDIO.put(key, value, options),
});

/**
 * Family: who is there and what they hear, the chat, sharing an item into another member's program,
 * listening along, and greetings the host reads on air.
 */
async function familyRoutes(request: Request, env: Environment, owner: string, url: URL): Promise<Response | null> {
  if (!url.pathname.startsWith('/api/family')) return null;
  const members = membersOf(env), me = members.find(member => member.owner === owner);
  if (!me) return json({ error: 'not_found' }, 404);
  const family = new FamilyStore(env.DB), store = new StationStore(env.DB), now = new Date();
  const nameOf = (id: string | null) => members.find(member => member.owner === id);
  // Profile pictures: anyone in the family sees them; each member sets or removes only their own.
  const avatarMatch = url.pathname.match(/^\/api\/family\/avatar\/([a-z0-9._-]{1,40})$/);
  if (avatarMatch) {
    if (request.method !== 'GET') return json({ error: 'method_not_allowed' }, 405);
    const member = members.find(item => item.key === avatarMatch[1]);
    const object = member ? await env.AUDIO.get(avatarKey(member)) : null;
    if (!object) return json({ error: 'not_found' }, 404);
    // The URL carries the version, so the picture can be cached until it changes.
    return new Response(object.body, { headers: { 'Content-Type': (object as { httpMetadata?: { contentType?: string } }).httpMetadata?.contentType ?? 'image/jpeg',
      'Content-Length': String(object.size), 'Cache-Control': 'private, max-age=31536000, immutable' } });
  }
  if (url.pathname === '/api/family/avatar') {
    if (request.method !== 'PUT' && request.method !== 'DELETE') return json({ error: 'method_not_allowed' }, 405);
    if (request.headers.get('Origin') !== url.origin) return json({ error: 'origin_rejected' }, 403);
    if (request.method === 'DELETE') {
      await env.AUDIO.delete(avatarKey(me));
      await family.setAvatar(owner, null);
      return json({ removed: true }, 200);
    }
    const body = await readJson(request, 420_000);
    if (body.error) return body.error;
    const image = avatarImage((body.value as { image?: unknown } | undefined)?.image);
    if (!image) return json({ error: 'invalid_image', detail: 'Bild als JPEG oder PNG, höchstens etwa 300 KB' }, 400);
    await env.AUDIO.put(avatarKey(me), image.bytes, { httpMetadata: { contentType: image.contentType } });
    const version = String(now.getTime());
    await family.setAvatar(owner, version);
    return json({ avatarUrl: `api/family/avatar/${me.key}?v=${version}` }, 200);
  }
  if (url.pathname === '/api/family') {
    if (request.method !== 'GET') return json({ error: 'method_not_allowed' }, 405);
    const [messages, avatars] = await Promise.all([family.messages(), family.avatars()]);
    return json({
      me: me.key,
      members: await Promise.all(members.map(async member => {
        const [playing, seen] = await Promise.all([family.presence(member.owner, now), store.lastSeen(member.owner)]);
        const avatar = avatars.get(member.owner);
        return { key: member.key, name: member.name, kids: member.kids, me: member.key === me.key,
          ...(avatar ? { avatarUrl: `api/family/avatar/${member.key}?v=${avatar}` } : {}),
          ...(playing ? { nowPlaying: playing.title } : {}), ...(seen ? { lastSeen: seen.toISOString() } : {}) };
      })),
      messages: messages.map(message => ({ id: message.id, from: nameOf(message.sender)?.key ?? '', fromName: nameOf(message.sender)?.name ?? 'Unbekannt',
        ...(message.recipient ? { to: nameOf(message.recipient)?.key ?? '', toName: nameOf(message.recipient)?.name ?? '' } : {}),
        kind: message.kind, text: message.text, at: message.created_at })),
      unread: await family.unread(owner),
    }, 200);
  }
  if (request.method !== 'POST') return json({ error: 'method_not_allowed' }, 405);
  if (request.headers.get('Origin') !== url.origin) return json({ error: 'origin_rejected' }, 403);
  const body = await readJson(request, 4096);
  if (body.error) return body.error;
  const input = (body.value ?? {}) as Record<string, unknown>;
  const text = (max: number) => typeof input.text === 'string' ? input.text.replace(/\s+/g, ' ').trim().slice(0, max) : '';
  const other = () => typeof input.to === 'string' ? members.find(member => member.key === input.to && member.key !== me.key) : undefined;
  switch (url.pathname) {
    case '/api/family/messages': {
      const message = text(500);
      if (!message) return json({ error: 'invalid_message' }, 400);
      const id = await family.addMessage(owner, 'text', message, now);
      await family.markRead(owner, id);
      return json({ id }, 200);
    }
    case '/api/family/read': {
      if (!Number.isInteger(input.lastId)) return json({ error: 'invalid_read' }, 400);
      await family.markRead(owner, input.lastId as number);
      return json({ ok: true }, 200);
    }
    case '/api/family/presence': {
      const row = typeof input.itemId === 'string' ? await store.getItem(owner, input.itemId) : null;
      if (!row) return json({ error: 'not_found' }, 404);
      const view = toView(row, await store.getConfig(owner));
      await family.setPresence(owner, row.id, (view.title ?? view.showName).slice(0, 160), new Date(now.getTime() + Math.min(120, row.estimated_minutes + 5) * 60_000));
      return json({ ok: true }, 200);
    }
    case '/api/family/share': {
      const to = other();
      if (!to || typeof input.itemId !== 'string') return json({ error: 'invalid_share' }, 400);
      if (!mayCopyInto(me, to)) return json({ error: 'kids_only_from_owner' }, 403);
      const copied = await copyItem({ store, owner, config: await store.getConfig(owner) }, input.itemId, { store, owner: to.owner }, audioObjects(env), me.name, now, crypto.randomUUID());
      if (!copied) return json({ error: 'not_shareable' }, 409);
      await family.addMessage(owner, 'share', copied.title, now, to.owner);
      return json({ itemId: copied.id }, 200);
    }
    case '/api/family/listen': {
      const from = typeof input.member === 'string' ? members.find(member => member.key === input.member && member.key !== me.key) : undefined;
      if (!from) return json({ error: 'invalid_member' }, 400);
      if (!mayCopyInto(from, me)) return json({ error: 'kids_only_from_owner' }, 403);
      const playing = await family.presence(from.owner, now);
      if (!playing) return json({ error: 'not_playing' }, 409);
      const copied = await copyItem({ store, owner: from.owner, config: await store.getConfig(from.owner) }, playing.itemId, { store, owner }, audioObjects(env), from.name, now, crypto.randomUUID());
      return copied ? json({ itemId: copied.id }, 200) : json({ error: 'not_shareable' }, 409);
    }
    case '/api/family/greet': {
      const to = other(), greeting = text(200);
      if (!to || !greeting) return json({ error: 'invalid_greeting' }, 400);
      await family.addGreeting(owner, to.owner, greeting, now);
      await family.addMessage(owner, 'greeting', greeting, now, to.owner);
      return json({ ok: true }, 200);
    }
    default: return json({ error: 'not_found' }, 404);
  }
}

/** Where Google's sample of an own voice is kept. */
const voiceSampleKey = (voiceId: string) => `sounds/voice-sample-${voiceId}`;

const pipelines = new WeakMap<object, SegmentPipeline>();

function json(body: unknown, status: number) {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' } });
}

// Reused per isolate so the Access signing keys are not fetched on every request.
const jwksByIssuer = new Map<string, ReturnType<typeof createRemoteJWKSet>>();

/** The owner, or why the request was refused. Reasons only name settings, never token values. */
type Auth = { owner: string } | { owner: null; reason: string };

async function authenticate(request: Request, env: Environment): Promise<Auth> {
  const refuse = (reason: string): Auth => ({ owner: null, reason });
  const assertion = request.headers.get('Cf-Access-Jwt-Assertion');
  if (!env.ACCESS_TEAM_DOMAIN || !env.ACCESS_AUD || !env.ALLOWED_EMAIL) return refuse('access_not_configured');
  if (!assertion) return refuse('no_access_token');
  try {
    const issuer = `https://${env.ACCESS_TEAM_DOMAIN}`;
    let jwks = jwksByIssuer.get(issuer);
    if (!jwks) { jwks = createRemoteJWKSet(new URL(`${issuer}/cdn-cgi/access/certs`)); jwksByIssuer.set(issuer, jwks); }
    const { payload } = await jwtVerify(assertion, jwks, { issuer, audience: env.ACCESS_AUD });
    if (payload.type !== 'app') return refuse('wrong_token_type');
    const email = typeof payload.email === 'string' ? payload.email.toLowerCase() : '';
    if (email) return email === env.ALLOWED_EMAIL.toLowerCase() ? { owner: email } : refuse('email_not_allowed');
    // Service tokens carry no email; Access puts the token's client ID into common_name.
    const serviceToken = typeof payload.common_name === 'string' ? payload.common_name.trim() : '';
    if (!serviceToken) return refuse('no_identity');
    if (env.ACCESS_SERVICE_TOKEN_ID?.trim() && serviceToken === env.ACCESS_SERVICE_TOKEN_ID.trim()) return { owner: env.ALLOWED_EMAIL.toLowerCase() };
    // Further listeners each have their own token, and with it their own station.
    const listener = parseListeners(env.LISTENERS).get(serviceToken);
    if (listener) return { owner: listener.owner };
    if (!env.ACCESS_SERVICE_TOKEN_ID?.trim()) return refuse('service_token_not_configured');
    return refuse('service_token_not_allowed');
  } catch { return refuse('invalid_access_token'); }
}

function statusFor(error: unknown) {
  if (error instanceof PipelineError) {
    if (error.code === 'INVALID_INPUT') return 400;
    if (error.code === 'BUDGET_EXCEEDED' || error.code === 'TOO_MANY_REQUESTS') return 429;
    if (error.code === 'REJECTED') return 422;
    if (error.code === 'IDEMPOTENCY_CONFLICT') return 409;
  }
  return 502;
}

interface Providers { ask?: TextGenerator; geminiBrief?: TextGenerator; geminiDialog?: TextGenerator; researcher?: Researcher; verifier: EditorialVerifier }
const providerCache = new WeakMap<object, Providers>();

/** ASK is optional: Gemini writes by default; ASK, when configured, is the independent second model that verifies. */
/** Provider requests go through one counting fetch per database, for the daily usage overview. */
const meters = new WeakMap<object, typeof fetch>();
function metered(env: Environment): typeof fetch {
  let meter = meters.get(env.DB as object);
  if (!meter) {
    let askHost: string | undefined;
    try { askHost = env.ASK_BASE_URL ? new URL(env.ASK_BASE_URL).hostname : undefined; } catch { /* Invalid ASK URL: the provider refuses it anyway. */ }
    meter = meteredFetch(env.DB, { askHost });
    meters.set(env.DB as object, meter);
  }
  return meter;
}

function providersFor(env: Environment): Providers {
  let providers = providerCache.get(env.DB as object);
  if (!providers) {
    const counted = metered(env);
    const askConfig = { baseUrl: env.ASK_BASE_URL, key: env.ASK_API_KEY, model: env.ASK_MODEL };
    const askReady = Boolean(env.ASK_BASE_URL && env.ASK_API_KEY && env.ASK_MODEL);
    const gemini = env.GEMINI_API_KEY ? { key: env.GEMINI_API_KEY, model: env.GEMINI_TEXT_MODEL } : undefined;
    const unavailable: EditorialVerifier = { verify: async () => { throw new ProviderError('No verifier configured'); } };
    providers = {
      ...(askReady ? { ask: new AskTextGenerator(askConfig, counted) } : {}),
      ...(gemini ? {
        geminiBrief: new GeminiBriefGenerator(gemini, counted), geminiDialog: new GeminiPodcastGenerator(gemini, counted),
        researcher: new GeminiResearcher({ key: gemini.key, model: env.GEMINI_RESEARCH_MODEL || gemini.model }, counted),
      } : {}),
      verifier: askReady && gemini ? new FallbackVerifier(new AskEditorialVerifier(askConfig, counted), new GeminiEditorialVerifier(gemini, counted))
        : askReady ? new AskEditorialVerifier(askConfig, counted) : gemini ? new GeminiEditorialVerifier(gemini, counted) : unavailable,
    };
    providerCache.set(env.DB as object, providers);
  }
  return providers;
}

function pipelineFor(env: Environment): SegmentPipeline {
  let pipeline = pipelines.get(env.DB as object);
  if (!pipeline) {
    const providers = providersFor(env);
    const missing: TextGenerator = { generate: async () => { throw new ProviderError('No text provider configured'); } };
    pipeline = new SegmentPipeline(
      // The manual single-segment tool keeps ASK when present and otherwise uses Gemini.
      providers.ask ?? providers.geminiBrief ?? missing,
      new VoiceRouter(new MistralSpeechSynthesizer({
        // Kerstin is the bundled German reference voice, so a missing setting never blocks speech.
        key: env.MISTRAL_API_KEY, voiceId: env.MISTRAL_VOICE_ID || 'de_kerstin_cc0', model: env.MISTRAL_TTS_MODEL,
        referenceAudio: async () => {
          const response = await env.ASSETS.fetch(new Request('https://assets.local/audio/kerstin-reference.flac'));
          if (!response.ok) throw new Error('German reference audio unavailable');
          return new Uint8Array(await response.arrayBuffer());
        },
      }, metered(env)), env.GEMINI_API_KEY ? new GeminiSpeechSynthesizer({ key: env.GEMINI_API_KEY, model: env.GEMINI_TTS_MODEL, liteModel: env.GEMINI_TTS_LITE_MODEL }, metered(env)) : undefined),
      providers.verifier,
      new D1CharacterBudget(env.DB, Math.max(1, Number(env.DAILY_TTS_CHARACTERS) || 12_000)),
      4,
      env.GEMINI_API_KEY ? {
        text: providers.geminiDialog!,
        speech: new GeminiPodcastSpeechSynthesizer({ key: env.GEMINI_API_KEY, model: env.GEMINI_TTS_MODEL, liteModel: env.GEMINI_TTS_LITE_MODEL, voiceA: env.GEMINI_VOICE_A, voiceB: env.GEMINI_VOICE_B }, metered(env)),
      } : undefined,
    );
    pipelines.set(env.DB as object, pipeline);
  }
  return pipeline;
}

const musicCache = new WeakMap<object, { writer?: GeminiMusicWriter; catalog?: MusicCatalog; cleanCatalog?: MusicCatalog }>();
function musicFor(env: Environment) {
  let music = musicCache.get(env.DB as object);
  if (!music) {
    const spotify = env.SPOTIFY_CLIENT_ID && env.SPOTIFY_CLIENT_SECRET ? { clientId: env.SPOTIFY_CLIENT_ID, clientSecret: env.SPOTIFY_CLIENT_SECRET, market: env.SPOTIFY_MARKET } : null;
    music = {
      ...(env.GEMINI_API_KEY ? { writer: new GeminiMusicWriter({ key: env.GEMINI_API_KEY, model: env.GEMINI_TEXT_MODEL }, metered(env)) } : {}),
      ...(spotify ? { catalog: new SpotifyCatalog(spotify), cleanCatalog: new SpotifyCatalog({ ...spotify, clean: true }) } : {}),
    };
    musicCache.set(env.DB as object, music);
  }
  return music;
}

/** Production for one station; a child's station gets its rules and never an explicit track. */
function stationDeps(env: Environment, owner: string): StationDeps {
  const kids = isKids(owner, parseListeners(env.LISTENERS));
  const catalog = kids ? musicFor(env).cleanCatalog : musicFor(env).catalog;
  return {
    store: new StationStore(env.DB, kids ? forKids : undefined), pipeline: pipelineFor(env), audio: env.AUDIO,
    fetchFeed: url => fetchFeed(url),
    reserveFeed: owner => new D1FeedCounter(env.DB).reserve(owner, Math.max(1, Number(env.DAILY_FEED_REQUESTS) || 60)),
    reserveGeneration: owner => new D1DailyCounter(env.DB).reserve(owner, Math.max(1, Number(env.DAILY_GENERATIONS) || 24)),
    podcastAvailable: Boolean(env.GEMINI_API_KEY), now: () => new Date(), random: Math.random,
    generator: (provider, format) => {
      const providers = providersFor(env);
      if (provider === 'ask') return format === 'brief' ? providers.ask : undefined;
      return format === 'podcast' ? providers.geminiDialog : providers.geminiBrief;
    },
    researcher: providersFor(env).researcher,
    weather: new OpenMeteo(),
    musicWriter: musicFor(env).writer,
    // The final edit and the quality jury use the same Gemini JSON calls as the music desk.
    ...(musicFor(env).writer ? { editor: new GeminiScriptEditor((system, input, label, temperature) => musicFor(env).writer!.askJson(system, input, label, temperature)) } : {}),
    ...(musicFor(env).writer ? { agentModel: musicFor(env).writer } : {}),
    agentSteps: (owner, runId) => new D1StepRunner(env.DB, owner, runId),
    catalog,
    ...(listeningFor(env) ? { listening: listeningFor(env)! } : {}),
    ...(catalog instanceof SpotifyCatalog ? { playlists: playlistsFor(catalog, listeningFor(env)) } : {}),
  };
}

/** Releases younger than this count as new for the «Neu von deinen Künstlern» block. */
const RELEASE_DAYS = 60;

/** The owner's token reads private playlists; without a connection (or when refused) the app token reads public ones. */
function playlistsFor(catalog: SpotifyCatalog, listening: SpotifyListening | null): PlaylistSource {
  return {
    tracks: async (owner, id) => {
      const token = listening ? await listening.accessToken(owner) : null;
      if (token) {
        try { return await catalog.playlistTracks(id, token); }
        catch (error) { if (!(error instanceof ProviderError) || ![401, 403, 404].includes(error.status ?? 0)) throw error; }
      }
      return catalog.playlistTracks(id);
    },
    releases: async owner => {
      const artists = listening ? await listening.topArtists(owner, new Date()) : [];
      if (!artists.length) throw new Error('Spotify-Hörprofil nicht verbunden oder noch ohne Top-Künstler');
      return catalog.newReleases(artists, new Date(Date.now() - RELEASE_DAYS * 86_400_000));
    },
  };
}

function listeningFor(env: Environment): SpotifyListening | null {
  return env.SPOTIFY_CLIENT_ID && env.SPOTIFY_CLIENT_SECRET ? new SpotifyListening(env.DB, { clientId: env.SPOTIFY_CLIENT_ID, clientSecret: env.SPOTIFY_CLIENT_SECRET }) : null;
}

/** Connecting the owner's Spotify listening profile (authorization code flow; the secret stays in the Worker). */
async function listeningRoutes(request: Request, env: Environment, owner: string, url: URL): Promise<Response | null> {
  if (!url.pathname.startsWith('/api/spotify/')) return null;
  const listening = listeningFor(env);
  if (!listening) return json({ error: 'spotify_not_configured' }, 404);
  const redirectUri = `${url.origin}/api/spotify/callback`;
  if (url.pathname === '/api/spotify/profile' && request.method === 'GET') return json(await listening.status(owner), 200);
  if (url.pathname === '/api/spotify/connect' && request.method === 'GET') {
    // The state is kept on the server for the authenticated owner: the app opens Spotify's login in the
    // system browser, which does not share the app's cookies, so a state cookie would never come back.
    const state = await listening.beginConnect(owner, new Date());
    return new Response(null, { status: 302, headers: { Location: listening.authorizeUrl(redirectUri, state), 'Cache-Control': 'no-store' } });
  }
  if (url.pathname === '/api/spotify/callback' && request.method === 'GET') {
    const done = (result: string, status?: number) => new Response(null, { status: 302, headers: {
      Location: `${url.origin}/?spotify=${result}${status ? `&status=${status}` : ''}`, 'Cache-Control': 'no-store',
    } });
    const code = url.searchParams.get('code'), state = url.searchParams.get('state');
    const known = state ? await listening.takeState(owner, state, new Date()) : false;
    if (url.searchParams.get('error')) return done('verweigert');
    if (!code || !known) return done('abgelaufen');
    try { await listening.connect(owner, code, redirectUri, new Date()); return done('verbunden'); }
    catch (error) { return done('fehler', error instanceof ProviderError ? error.status : undefined); }
  }
  if (url.pathname === '/api/spotify/disconnect' && request.method === 'POST') {
    if (request.headers.get('Origin') !== url.origin) return json({ error: 'origin_rejected' }, 403);
    await listening.disconnect(owner);
    return json({ connected: false }, 200);
  }
  return json({ error: 'not_found' }, 404);
}

/** Plans the program and hands due items to the production queue. */
async function refreshProgram(env: Environment, owner: string, requireListener: boolean) {
  const result = await tick(stationDeps(env, owner), owner, { requireListener });
  for (const itemId of result.due) await env.PRODUCTION.send({ owner, itemId });
  return result;
}

async function readJson(request: Request, maxBytes: number): Promise<{ value?: unknown; error?: Response }> {
  if (Number(request.headers.get('Content-Length') ?? 0) > maxBytes) return { error: json({ error: 'request_too_large' }, 413) };
  if (request.headers.get('Content-Type')?.split(';')[0]?.trim().toLowerCase() !== 'application/json') return { error: json({ error: 'json_required' }, 415) };
  const raw = await request.text();
  if (new TextEncoder().encode(raw).byteLength > maxBytes) return { error: json({ error: 'request_too_large' }, 413) };
  try { return { value: JSON.parse(raw) }; } catch { return { error: json({ error: 'invalid_json' }, 400) }; }
}

const APP_APK = 'app/personal-radio.apk', APP_LATEST = 'app/latest.json';

async function stationRoutes(request: Request, env: Environment, owner: string, url: URL): Promise<Response | null> {
  const store = new StationStore(env.DB);
  const sameOrigin = request.headers.get('Origin') === url.origin;
  if (url.pathname === '/api/station') {
    if (request.method === 'GET') return json({ config: await store.getConfig(owner) }, 200);
    if (request.method !== 'PUT') return json({ error: 'method_not_allowed' }, 405);
    if (!sameOrigin) return json({ error: 'origin_rejected' }, 403);
    const body = await readJson(request, 65_536);
    if (body.error) return body.error;
    try {
      // Today's mood is set in the app (POST /api/mood); saving the settings keeps it.
      const { mood: _mood, ...parsed } = parseStationConfig(body.value);
      const before = await store.getConfig(owner), now = new Date();
      const config: StationConfig = before?.mood ? { ...parsed, mood: before.mood } : parsed;
      const changed = AGENTS.filter(agent => JSON.stringify(before?.agents?.[agent.id] ?? null) !== JSON.stringify(config.agents?.[agent.id] ?? null)).map(agent => agent.name);
      await store.saveConfig(owner, config, now);
      if (before && changed.length) await store.logAgentChange(owner, now, changed);
      return json({ config }, 200);
    } catch (error) {
      if (error instanceof ConfigError) return json({ error: 'invalid_config', detail: error.message }, 400);
      throw error;
    }
  }
  if (url.pathname === '/api/mood') {
    if (request.method !== 'POST') return json({ error: 'method_not_allowed' }, 405);
    if (!sameOrigin) return json({ error: 'origin_rejected' }, 403);
    const body = await readJson(request, 256);
    if (body.error) return body.error;
    const id = (body.value as { mood?: unknown } | null)?.mood ?? null;
    if (id !== null && !MOOD_IDS.includes(id as MoodId)) return json({ error: 'invalid_mood' }, 400);
    const config = await store.getConfig(owner), now = new Date();
    if (!config) return json({ error: 'not_configured' }, 409);
    // A mood holds until midnight in the station's time zone; null clears it.
    const { mood: _old, ...rest } = config;
    const next: StationConfig = id === null ? rest : { ...rest, mood: { id: id as MoodId, until: endOfDay(now, config.timezone).toISOString() } };
    await store.saveConfig(owner, next, now);
    return json({ mood: next.mood ?? null }, 200);
  }
  if (url.pathname === '/api/timeline') {
    if (request.method !== 'GET') return json({ error: 'method_not_allowed' }, 405);
    const config = await store.getConfig(owner);
    // A background check for notifications only looks; it must not count as listening (no paid planning).
    if (url.searchParams.get('peek') !== '1') await store.touch(owner, new Date());
    // The Spotify client ID is public; the app needs it to connect to the Spotify app (App Remote).
    const spotify = env.SPOTIFY_CLIENT_ID ? { spotify: { clientId: env.SPOTIFY_CLIENT_ID } } : {};
    const sounds = config ? stationSounds(config) : { ident: false, hourChange: false, linker: false };
    const idents = Array.from({ length: IDENT_VARIANTS }, (_, variant) => `api/sounds/ident/${variant}.wav`);
    const mood = config && activeMood(config, new Date()) ? { mood: config.mood } : {};
    // Unread family messages, for the badge on the family tab and the notification.
    const familyStore = new FamilyStore(env.DB);
    const [unread, latest] = parseListeners(env.LISTENERS).size ? await Promise.all([familyStore.unread(owner), familyStore.latestUnread(owner)]) : [0, null];
    const family = parseListeners(env.LISTENERS).size ? { family: { unread, ...(latest ? { latest: { id: latest.id, line: messageLine(latest, membersOf(env)) } } : {}) } } : {};
    // Mitmachen: how many stickers, whether this is a child's station, and whether questions can be answered on air.
    const kids = isKids(owner, parseListeners(env.LISTENERS)), stickers = (await new PlayStore(env.DB).stickers(owner)).length;
    const play = { play: { stickers, kids, ask: !!(sounds.linker && env.GEMINI_API_KEY) } };
    return json({ items: (await store.visibleItems(owner)).map(row => toView(row, config)), failures: await store.failureSummary(owner), ...spotify, ...mood, ...family, ...play,
      sounds: {
        ...(sounds.ident ? { identUrl: 'api/sounds/ident.wav', identUrls: idents, newsUrl: 'api/sounds/news.wav' } : {}),
        ...(sounds.hourChange ? { signalUrl: 'api/sounds/pips.wav', hourUrl: 'api/sounds/hour/' } : {}),
        ...(sounds.linker && env.GEMINI_API_KEY ? { linkerUrl: 'api/linker' } : {}),
      } }, 200);
  }
  if (url.pathname === '/api/linker') {
    if (request.method !== 'GET') return json({ error: 'method_not_allowed' }, 405);
    return linker(env, store, owner, url);
  }
  const identMatch = url.pathname.match(/^\/api\/sounds\/ident(?:\/(\d))?\.wav$/);
  if (identMatch || url.pathname === '/api/sounds/pips.wav' || url.pathname === '/api/sounds/news.wav') {
    if (request.method !== 'GET') return json({ error: 'method_not_allowed' }, 405);
    const variant = Number(identMatch?.[1] ?? 0);
    if (identMatch && variant >= IDENT_VARIANTS) return json({ error: 'not_found' }, 404);
    const audio = identMatch ? (identAudio[variant] ??= identJingle(variant))
      : url.pathname.endsWith('news.wav') ? (newsAudio ??= newsOpener()) : (signalAudio ??= timeSignal());
    return new Response(audio as BodyInit, { headers: { 'Content-Type': 'audio/wav', 'Content-Length': String(audio.byteLength), 'Cache-Control': 'private, max-age=604800' } });
  }
  const hourMatch = url.pathname.match(/^\/api\/sounds\/hour\/(\d{1,2})$/);
  if (hourMatch) {
    if (request.method !== 'GET') return json({ error: 'method_not_allowed' }, 405);
    const hour = Number(hourMatch[1]), config = await store.getConfig(owner);
    if (hour > 23 || !config) return json({ error: 'not_found' }, 404);
    // Recorded once per hour, voice and station name; later requests read it from the bucket.
    const key = hourKey(hour, `${config.host.voiceId ?? ''}|${config.host.voiceStyle ?? ''}`, config.name);
    for (const [suffix, type] of [['.mp3', 'audio/mpeg'], ['.wav', 'audio/wav']] as const) {
      const stored = await env.AUDIO.get(key + suffix);
      if (stored) return new Response(stored.body, { headers: { 'Content-Type': type, 'Content-Length': String(stored.size), 'Cache-Control': 'private, max-age=86400' } });
    }
    try {
      const voiced = await pipelineFor(env).voice(owner, { title: 'Zeitansage', text: hourText(hour, config.name), sourceIds: [] }, 'brief', config.host.voiceId, config.host.voiceStyle, { lite: true });
      await env.AUDIO.put(key + (voiced.contentType === 'audio/wav' ? '.wav' : '.mp3'), voiced.audio, { httpMetadata: { contentType: voiced.contentType } });
      return new Response(voiced.audio as BodyInit, { headers: { 'Content-Type': voiced.contentType, 'Content-Length': String(voiced.audio.byteLength), 'Cache-Control': 'private, max-age=86400' } });
    } catch (error) { return json({ error: 'voice_failed' }, statusFor(error)); }
  }
  if (url.pathname === '/api/places') {
    if (request.method !== 'GET') return json({ error: 'method_not_allowed' }, 405);
    const name = (url.searchParams.get('name') ?? '').trim().slice(0, 80);
    if (name.length < 2) return json({ places: [] }, 200);
    try { return json({ places: await new OpenMeteo().places(name) }, 200); }
    catch { return json({ error: 'places_unavailable' }, 502); }
  }
  // In-app updates: CI stores the signed APK and its description next to the audio (key prefix app/).
  if (url.pathname === '/api/app/latest' || url.pathname === '/api/app/apk') {
    if (request.method !== 'GET') return json({ error: 'method_not_allowed' }, 405);
    const object = await env.AUDIO.get(url.pathname === '/api/app/apk' ? APP_APK : APP_LATEST);
    if (!object) return json({ error: 'no_app_build' }, 404);
    if (url.pathname === '/api/app/latest') return json(await new Response(object.body).json(), 200);
    return new Response(object.body, { headers: {
      'Content-Type': 'application/vnd.android.package-archive', 'Content-Length': String(object.size),
      'Content-Disposition': 'attachment; filename="personal-radio.apk"', 'Cache-Control': 'no-store',
    } });
  }
  if (url.pathname === '/api/blocks') {
    if (request.method !== 'GET') return json({ error: 'method_not_allowed' }, 405);
    const config = await store.getConfig(owner);
    return json({ blocks: config ? blockViews(config) : [] }, 200);
  }
  // Clients may encode the colon of an own show's block id ("show%3A<id>").
  // Series: the running and recent ones, and ending one.
  if (url.pathname === '/api/series') {
    if (request.method !== 'GET') return json({ error: 'method_not_allowed' }, 405);
    return json({ series: (await store.listSeries(owner)).map(seriesView) }, 200);
  }
  // The sticker album: every sticker, and which ones the listener has.
  if (url.pathname === '/api/stickers') {
    if (request.method !== 'GET') return json({ error: 'method_not_allowed' }, 405);
    return json(albumView(await new PlayStore(env.DB).stickers(owner)), 200);
  }
  // «Frag das Radio»: a question the host answers in the next live transition; the family sees it in the chat.
  if (url.pathname === '/api/questions') {
    const play = new PlayStore(env.DB);
    if (request.method === 'GET') return json({ questions: await play.questions(owner) }, 200);
    if (request.method !== 'POST') return json({ error: 'method_not_allowed' }, 405);
    if (!sameOrigin) return json({ error: 'origin_rejected' }, 403);
    const body = await readJson(request, 1024);
    if (body.error) return body.error;
    const raw = (body.value as { text?: unknown } | null)?.text;
    const text = typeof raw === 'string' ? raw.replace(/\s+/g, ' ').trim().slice(0, 200) : '';
    if (text.length < 3) return json({ error: 'invalid_question' }, 400);
    const config = await store.getConfig(owner);
    if (!config || !stationSounds(config).linker || !env.GEMINI_API_KEY) return json({ error: 'linker_off' }, 409);
    const now = new Date();
    const id = await play.addQuestion(owner, text, now);
    if (parseListeners(env.LISTENERS).size) await new FamilyStore(env.DB).addMessage(owner, 'text', `❓ Frage ans Radio: ${text}`, now);
    return json({ id }, 200);
  }
  const stopMatch = url.pathname.match(/^\/api\/series\/([A-Za-z0-9-]{1,64})\/stop$/);
  if (stopMatch) {
    if (request.method !== 'POST') return json({ error: 'method_not_allowed' }, 405);
    if (!sameOrigin) return json({ error: 'origin_rejected' }, 403);
    return await stopSeries(stationDeps(env, owner), owner, stopMatch[1]) ? json({ stopped: stopMatch[1] }, 200) : json({ error: 'not_found' }, 404);
  }
  const addBlockMatch = url.pathname.replace(/%3A/gi, ':').match(/^\/api\/blocks\/(song|[a-z0-9-]{1,40}|show:[a-z0-9-]{1,40})\/add$/);
  if (addBlockMatch) {
    if (request.method !== 'POST') return json({ error: 'method_not_allowed' }, 405);
    if (!sameOrigin) return json({ error: 'origin_rejected' }, 403);
    const body = await readJson(request, 2048);
    if (body.error) return body.error;
    const { subject, after } = (body.value ?? {}) as { subject?: unknown; after?: unknown };
    if ((subject !== undefined && typeof subject !== 'string') || (after !== undefined && typeof after !== 'string')) return json({ error: 'invalid_block' }, 400);
    let itemId: string | null;
    try { itemId = await addBlock(stationDeps(env, owner), owner, addBlockMatch[1], subject as string | undefined, after as string | undefined); }
    catch (error) {
      // Starting a series plans it first; that call can fail like a production.
      if (error instanceof SeriesError) return json({ error: error.code === 'NOT_CONFIGURED' ? 'gemini_not_configured' : 'series_outline_failed' }, error.code === 'NOT_CONFIGURED' ? 409 : 502);
      if (error instanceof PipelineError || error instanceof ProviderError) return json({ error: 'series_failed' }, error instanceof ProviderError && error.status === 429 ? 429 : statusFor(error));
      throw error;
    }
    if (!itemId) return json({ error: 'unknown_block' }, 404);
    await env.PRODUCTION.send({ owner, itemId });
    return json({ itemId }, 200);
  }
  if (url.pathname === '/api/insights') {
    if (request.method !== 'GET') return json({ error: 'method_not_allowed' }, 405);
    const now = new Date(), since = new Date(now.getTime() - 30 * 86_400_000);
    const [counts, quality, changes, usage, config] = await Promise.all([
      store.reasonCounts(owner, new Date(now.getTime() - NOTE_WINDOW_DAYS * 86_400_000)), store.qualityLog(owner, since), store.agentChanges(owner, since),
      usageSummary(env.DB, owner, now, 14, { generations: Math.max(1, Number(env.DAILY_GENERATIONS) || 24), ttsCharacters: Math.max(1, Number(env.DAILY_TTS_CHARACTERS) || 12_000) },
        env.GEMINI_API_KEY ? { model: env.GEMINI_TTS_MODEL || 'gemini-3.8-flash-tts', liteModel: env.GEMINI_TTS_LITE_MODEL || 'gemini-3.8-flash-lite-tts', dailyRequests: Math.max(1, Number(env.GEMINI_TTS_DAILY_REQUESTS) || 100) } : undefined),
      store.getConfig(owner),
    ]);
    return json({
      reasons: counts.map(item => ({ ...item, label: FEEDBACK_REASONS[item.reason].label, active: item.count >= NOTE_MIN_COUNT })),
      notes: listenerNotes(counts),
      quality: quality.map(entry => ({ ...entry, showName: showNameOf(entry.showId, config) })),
      changes, usage, timezone: config?.timezone ?? 'UTC',
    }, 200);
  }
  if (url.pathname === '/api/insights/reasons') {
    if (request.method !== 'DELETE') return json({ error: 'method_not_allowed' }, 405);
    if (!sameOrigin) return json({ error: 'origin_rejected' }, 403);
    await store.clearReasons(owner);
    return json({ ok: true }, 200);
  }
  if (url.pathname === '/api/agents/trial') {
    if (request.method !== 'POST') return json({ error: 'method_not_allowed' }, 405);
    if (!sameOrigin) return json({ error: 'origin_rejected' }, 403);
    const body = await readJson(request, 65_536);
    if (body.error) return body.error;
    const { agent, agents } = (body.value ?? {}) as { agent?: unknown; agents?: unknown };
    if (!AGENTS.some(item => item.trial && item.id === agent)) return json({ error: 'invalid_agent' }, 400);
    let draft;
    try { draft = parseAgentConfig(agents, (path, expected) => { throw new ConfigError(`${path}: ${expected}`); }); }
    catch (error) {
      if (error instanceof ConfigError) return json({ error: 'invalid_config', detail: error.message }, 400);
      throw error;
    }
    const result = await trialAgent(stationDeps(env, owner), owner, agent as TrialAgent, draft);
    return json(result, result.ok ? 200 : result.error === 'NO_ITEM' ? 404 : result.error === 'NOT_CONFIGURED' ? 409 : 502);
  }
  if (url.pathname === '/api/library') {
    if (request.method !== 'GET') return json({ error: 'method_not_allowed' }, 405);
    const config = await store.getConfig(owner);
    return json({ items: (await store.library(owner)).map(row => toView(row, config)), retentionDays: AUDIO_RETENTION_DAYS }, 200);
  }
  if (url.pathname === '/api/timeline/cleanup') {
    if (request.method !== 'POST') return json({ error: 'method_not_allowed' }, 405);
    if (!sameOrigin) return json({ error: 'origin_rejected' }, 403);
    const { removed, audioKeys } = await store.purge(owner);
    for (const key of audioKeys) await env.AUDIO.delete(key);
    return json({ removed }, 200);
  }
  if (url.pathname === '/api/timeline/plan') {
    if (request.method !== 'POST') return json({ error: 'method_not_allowed' }, 405);
    if (!sameOrigin) return json({ error: 'origin_rejected' }, 403);
    await store.touch(owner, new Date());
    const result = await refreshProgram(env, owner, false);
    return json({ planned: result.planned, queued: result.due.length, expired: result.expired }, 200);
  }
  if (url.pathname === '/api/timeline/retry') {
    if (request.method !== 'POST') return json({ error: 'method_not_allowed' }, 405);
    if (!sameOrigin) return json({ error: 'origin_rejected' }, 403);
    const now = new Date();
    await store.touch(owner, now);
    const reset = await store.retryNow(owner, now);
    const result = await refreshProgram(env, owner, false);
    return json({ ...reset, planned: result.planned, queued: result.due.length }, 200);
  }
  if (url.pathname === '/api/timeline/arrange') {
    if (request.method !== 'POST') return json({ error: 'method_not_allowed' }, 405);
    if (!sameOrigin) return json({ error: 'origin_rejected' }, 403);
    const body = await readJson(request, 16_384);
    if (body.error) return body.error;
    const order = (body.value as { order?: unknown } | undefined)?.order;
    if (!Array.isArray(order) || !order.every(id => typeof id === 'string')) return json({ error: 'invalid_order' }, 400);
    // A stale order (the program changed meanwhile) is refused, and the cockpit reloads.
    return await arrangeTimeline(stationDeps(env, owner), owner, order as string[]) ? json({ ok: true }, 200) : json({ error: 'stale_order' }, 409);
  }
  if (url.pathname === '/api/timeline/shuffle') {
    if (request.method !== 'POST') return json({ error: 'method_not_allowed' }, 405);
    if (!sameOrigin) return json({ error: 'origin_rejected' }, 403);
    const added = await shuffleTimeline(stationDeps(env, owner), owner);
    if (!added) return json({ error: 'not_configured' }, 404);
    for (const itemId of added) await env.PRODUCTION.send({ owner, itemId });
    return json({ added: added.length }, 200);
  }
  const produce = url.pathname.match(/^\/api\/shows\/(_musik|[a-z0-9-]{1,40})\/produce$/);
  if (produce) {
    if (request.method !== 'POST') return json({ error: 'method_not_allowed' }, 405);
    if (!sameOrigin) return json({ error: 'origin_rejected' }, 403);
    await store.touch(owner, new Date());
    let subject: string | undefined;
    if (request.headers.get('Content-Type')?.split(';')[0]?.trim().toLowerCase() === 'application/json') {
      const body = await readJson(request, 1024);
      if (body.error) return body.error;
      const value = (body.value ?? {}) as { subject?: unknown };
      if (value.subject !== undefined && (typeof value.subject !== 'string' || value.subject.trim().length > 200)) return json({ error: 'invalid_subject' }, 400);
      subject = typeof value.subject === 'string' ? value.subject.trim() || undefined : undefined;
    }
    const itemId = await scheduleShowNow(stationDeps(env, owner), owner, produce[1], subject);
    if (!itemId) return json({ error: 'unknown_show' }, 404);
    await env.PRODUCTION.send({ owner, itemId });
    return json({ itemId }, 200);
  }
  const match = url.pathname.match(/^\/api\/timeline\/([A-Za-z0-9-]{1,64})\/(audio|feedback|reason|more|swap|remove|delete|script|choice|quiz)$/);
  if (!match) return null;
  const row = await store.getItem(owner, match[1]);
  if (!row) return json({ error: 'not_found' }, 404);
  // Mitmachen: choosing how a story goes on, answering a quiz question; both can earn a sticker.
  if (match[2] === 'choice' || match[2] === 'quiz') {
    if (request.method !== 'POST') return json({ error: 'method_not_allowed' }, 405);
    if (!sameOrigin) return json({ error: 'origin_rejected' }, 403);
    const body = await readJson(request, 256);
    if (body.error) return body.error;
    const picked = (body.value as { option?: unknown } | null)?.option;
    if (!Number.isInteger(picked)) return json({ error: 'invalid_option' }, 400);
    const deps = stationDeps(env, owner), play = new PlayStore(env.DB), now = new Date();
    if (match[2] === 'choice') {
      const result = await chooseStory(deps, owner, row.id, picked as number);
      if (!result) return json({ error: 'no_choice' }, 409);
      const sticker = result.fresh ? await play.award(owner, 'choice', now) : undefined;
      // The next episode joins the program right away when this one was already heard.
      if (result.fresh) await refreshProgram(env, owner, false);
      return json({ picked: result.choice.picked, ...(sticker ? { sticker } : {}) }, 200);
    }
    const result = await answerQuiz(deps, owner, row.id, picked as number);
    if (!result) return json({ error: 'no_quiz' }, 409);
    const sticker = result.right && result.fresh ? await play.award(owner, 'quiz', now) : undefined;
    return json({ right: result.right, correct: result.quiz.correct, ...(sticker ? { sticker } : {}) }, 200);
  }
  if (match[2] === 'script') {
    if (request.method !== 'GET') return json({ error: 'method_not_allowed' }, 405);
    return json(transcriptView(row, await store.getConfig(owner)), 200);
  }
  if (match[2] === 'swap') {
    if (request.method !== 'POST') return json({ error: 'method_not_allowed' }, 405);
    if (!sameOrigin) return json({ error: 'origin_rejected' }, 403);
    const itemId = await swapItem(stationDeps(env, owner), owner, row.id);
    if (!itemId) return json({ error: 'not_swappable' }, 409);
    await env.PRODUCTION.send({ owner, itemId });
    return json({ itemId }, 200);
  }
  if (match[2] === 'more') {
    if (request.method !== 'POST') return json({ error: 'method_not_allowed' }, 405);
    if (!sameOrigin) return json({ error: 'origin_rejected' }, 403);
    const itemId = await addFollowUp(stationDeps(env, owner), owner, row.id);
    if (!itemId) return json({ error: 'not_deepenable' }, 409);
    await env.PRODUCTION.send({ owner, itemId });
    return json({ itemId }, 200);
  }
  if (match[2] === 'reason') {
    if (request.method !== 'POST') return json({ error: 'method_not_allowed' }, 405);
    if (!sameOrigin) return json({ error: 'origin_rejected' }, 403);
    const body = await readJson(request, 256);
    if (body.error) return body.error;
    const reason = (body.value as { reason?: unknown } | null)?.reason;
    if (!isFeedbackReason(reason)) return json({ error: 'invalid_reason' }, 400);
    return await store.setReason(owner, row.id, reason) ? json({ ok: true }, 200) : json({ error: 'no_dislike' }, 409);
  }
  if (match[2] === 'delete') {
    if (request.method !== 'POST') return json({ error: 'method_not_allowed' }, 405);
    if (!sameOrigin) return json({ error: 'origin_rejected' }, 403);
    return await deleteItem(stationDeps(env, owner), owner, row.id) ? json({ ok: true }, 200) : json({ error: 'not_deletable' }, 409);
  }
  if (match[2] === 'remove') {
    if (request.method !== 'POST') return json({ error: 'method_not_allowed' }, 405);
    if (!sameOrigin) return json({ error: 'origin_rejected' }, 403);
    return await removeItem(stationDeps(env, owner), owner, row.id) ? json({ ok: true }, 200) : json({ error: 'not_open' }, 409);
  }
  if (match[2] === 'audio') {
    if (request.method !== 'GET') return json({ error: 'method_not_allowed' }, 405);
    // Artist hours keep one file per spoken part: ?part=<index into the hour's parts>.
    let key = row.audio_key, contentType = row.content_type;
    const part = url.searchParams.get('part');
    if (part !== null) {
      let parts: Array<{ kind?: string; audioKey?: string; contentType?: string }> = [];
      try { parts = (JSON.parse(row.script_json ?? '{}') as { parts?: typeof parts }).parts ?? []; } catch { /* No parts. */ }
      const chosen = /^\d{1,3}$/.test(part) ? parts[Number(part)] : undefined;
      key = chosen?.kind === 'speech' && chosen.audioKey ? chosen.audioKey : null;
      contentType = chosen?.contentType ?? 'audio/mpeg';
    }
    if (!key || row.state === 'expired') return json({ error: 'audio_unavailable' }, 404);
    const wantsRange = request.headers.has('Range');
    let object: StoredAudio | null;
    try { object = await env.AUDIO.get(key, wantsRange ? { range: request.headers } : undefined); }
    catch { return new Response(null, { status: 416 }); }
    if (!object) return json({ error: 'audio_unavailable' }, 404);
    const headers = new Headers({ 'Content-Type': contentType ?? 'audio/mpeg', 'Accept-Ranges': 'bytes', 'Cache-Control': 'private, max-age=86400', ETag: object.httpEtag });
    if (wantsRange && object.range) {
      const { offset, length, suffix } = object.range;
      const start = suffix !== undefined ? object.size - suffix : offset ?? 0;
      const size = suffix !== undefined ? suffix : length ?? object.size - start;
      headers.set('Content-Range', `bytes ${start}-${start + size - 1}/${object.size}`); headers.set('Content-Length', String(size));
      return new Response(object.body, { status: 206, headers });
    }
    headers.set('Content-Length', String(object.size));
    return new Response(object.body, { headers });
  }
  if (request.method !== 'POST') return json({ error: 'method_not_allowed' }, 405);
  if (!sameOrigin) return json({ error: 'origin_rejected' }, 403);
  const body = await readJson(request, 1024);
  if (body.error) return body.error;
  const { action, listenedRatio } = (body.value ?? {}) as { action?: unknown; listenedRatio?: unknown };
  if (!['like', 'dislike', 'skip', 'complete'].includes(String(action)) || typeof listenedRatio !== 'number' || !(listenedRatio >= 0 && listenedRatio <= 1)) {
    return json({ error: 'invalid_feedback' }, 400);
  }
  let interests: string[] = [];
  try { interests = (JSON.parse(row.script_json ?? '{}') as { interestTags?: string[] }).interestTags ?? []; } catch { /* Feedback without tags still marks playback. */ }
  const now = new Date();
  // Listening again from the archive does not count twice; ratings always count.
  const listening = action === 'complete' || action === 'skip';
  if (listening && row.state !== 'ready' && row.state !== 'archived') return json({ ok: true }, 200);
  await store.addFeedback(owner, { itemId: row.id, interests, action: action as FeedbackAction, listenedRatio, createdAt: now.toISOString() });
  if (listening) await store.update(owner, row.id, { state: action === 'complete' ? 'played' : 'skipped' }, now);
  // On a child's station every episode heard to the end earns a sticker.
  if (action === 'complete' && row.show_id.startsWith(SERIES_PREFIX) && isKids(owner, parseListeners(env.LISTENERS))) {
    return json({ ok: true, sticker: await new PlayStore(env.DB).award(owner, 'episode', now) }, 200);
  }
  return json({ ok: true }, 200);
}

export default {
  async fetch(request: Request, env: Environment): Promise<Response> {
    const url = new URL(request.url);
    const auth = await authenticate(request, env);
    if (auth.owner === null) return json({ error: 'unauthorized', reason: auth.reason }, 401);
    const owner = auth.owner;
    if (!url.pathname.startsWith('/api/')) return env.ASSETS.fetch(request);
    if (url.pathname === '/api/testing/reset-daily-limits') {
      if (request.method !== 'POST') return json({ error: 'method_not_allowed' }, 405);
      if (request.headers.get('Origin') !== url.origin) return json({ error: 'origin_rejected' }, 403);
      const utcDay = new Date().toISOString().slice(0, 10);
      try {
        for (const table of ['daily_requests', 'daily_usage', 'daily_feed_requests', 'daily_linker_requests']) {
          await env.DB.prepare(`DELETE FROM ${table} WHERE owner_id = ? AND utc_day = ?`).bind(owner, utcDay).run();
        }
      } catch { return json({ error: 'quota_reset_unavailable' }, 503); }
      return json({ reset: true, utcDay }, 200);
    }
    // A voice sample for the studio: the host introduces the station in the chosen voice and style; kept in the bucket.
    if (url.pathname === '/api/voices/preview') {
      if (request.method !== 'GET') return json({ error: 'method_not_allowed' }, 405);
      const voice = url.searchParams.get('voice') ?? '', style = (url.searchParams.get('style') ?? '').trim().slice(0, 300);
      if (!/^[A-Za-z0-9_-]{1,170}$/.test(voice)) return json({ error: 'invalid_voice' }, 400);
      const config = await new StationStore(env.DB).getConfig(owner);
      const text = previewText(config?.host.name ?? '', config?.name ?? ''), key = previewKey(voice, style, text);
      for (const [suffix, type] of [['.wav', 'audio/wav'], ['.mp3', 'audio/mpeg']] as const) {
        const stored = await env.AUDIO.get(key + suffix);
        if (stored) return new Response(stored.body, { headers: { 'Content-Type': type, 'Content-Length': String(stored.size), 'Cache-Control': 'private, max-age=86400' } });
      }
      try {
        const voiced = await pipelineFor(env).voice(owner, { title: 'Hörprobe', text, sourceIds: [] }, 'brief', voice, style || undefined);
        await env.AUDIO.put(key + (voiced.contentType === 'audio/wav' ? '.wav' : '.mp3'), voiced.audio, { httpMetadata: { contentType: voiced.contentType } });
        return new Response(voiced.audio as BodyInit, { headers: { 'Content-Type': voiced.contentType, 'Content-Length': String(voiced.audio.byteLength), 'Cache-Control': 'private, max-age=86400' } });
      } catch (error) {
        // A designed voice still has Google's sample; otherwise the reason goes back to the studio.
        const fallback = await env.AUDIO.get(voiceSampleKey(voice));
        if (fallback) return new Response(fallback.body, { headers: { 'Content-Type': (fallback as { httpMetadata?: { contentType?: string } }).httpMetadata?.contentType ?? 'audio/wav',
          'Content-Length': String(fallback.size), 'Cache-Control': 'no-store', 'X-Voice-Sample': 'google' } });
        console.error('voice preview failed', error instanceof Error ? error.message.slice(0, 200) : 'unknown');
        return json({ error: 'voice_failed', detail: (error instanceof Error ? error.message : 'unbekannt').replace(/\s+/g, ' ').slice(0, 200) }, statusFor(error));
      }
    }
    // All voices for the studio: the prebuilt Gemini voices, own (designed or cloned) and German library voices, then Mistral.
    if (url.pathname === '/api/voices') {
      if (request.method !== 'GET') return json({ error: 'method_not_allowed' }, 405);
      const standard = env.GEMINI_API_KEY ? GEMINI_VOICES.map(voice => ({ id: `gemini_${voice.name}`, name: `${voice.name} · ${voice.character}`, group: 'standard', gender: voice.gender })) : [];
      const [google, mistral] = await Promise.all([
        env.GEMINI_API_KEY ? new GeminiVoiceCatalog({ key: env.GEMINI_API_KEY, model: env.GEMINI_TTS_MODEL }, metered(env)).list(url.searchParams.get('search') ?? '').catch(() => []) : Promise.resolve([]),
        listMistralVoices().then(voices => voices.map(voice => ({ id: voice.id, name: voice.name, group: 'mistral' }))).catch(() => []),
      ]);
      const own = google.filter(voice => voice.group === 'own'), library = google.filter(voice => voice.group === 'library');
      return json({ voices: [...own, ...standard, ...library, ...mistral] }, 200);
    }
    // Own voices: designed from a description or cloned from a recording with the speaker's consent.
    const voiceAction = url.pathname.match(/^\/api\/voices\/(design|clone|gemini_voice_[A-Za-z0-9_-]{1,160})$/);
    if (voiceAction && voiceAction[1] !== 'preview') {
      if (request.headers.get('Origin') !== url.origin) return json({ error: 'origin_rejected' }, 403);
      if (!env.GEMINI_API_KEY) return json({ error: 'gemini_not_configured' }, 409);
      const catalog = new GeminiVoiceCatalog({ key: env.GEMINI_API_KEY, model: env.GEMINI_TTS_MODEL }, metered(env));
      const action = voiceAction[1];
      if (action !== 'design' && action !== 'clone') {
        if (request.method !== 'DELETE') return json({ error: 'method_not_allowed' }, 405);
        try { await catalog.remove(action); return json({ removed: action }, 200); }
        catch (error) { return json({ error: 'voice_failed', detail: error instanceof Error ? error.message.slice(0, 200) : undefined }, statusFor(error)); }
      }
      if (request.method !== 'POST') return json({ error: 'method_not_allowed' }, 405);
      const body = await readJson(request, action === 'clone' ? 12_000_000 : 4096);
      if (body.error) return body.error;
      const input = (body.value ?? {}) as Record<string, unknown>;
      const name = typeof input.name === 'string' ? input.name.trim().slice(0, 60) : '';
      if (!name) return json({ error: 'invalid_voice', detail: 'Name fehlt' }, 400);
      const wav = (value: unknown) => typeof value === 'string' && value.length > 1000 && value.length < 6_000_000 && /^[A-Za-z0-9+/]+={0,2}$/.test(value);
      if (action === 'design') {
        const description = typeof input.description === 'string' ? input.description.trim().slice(0, 600) : '';
        if (description.length < 10) return json({ error: 'invalid_voice', detail: 'Beschreibung zu kurz' }, 400);
        if (input.gender !== undefined && input.gender !== 'female' && input.gender !== 'male') return json({ error: 'invalid_voice', detail: 'gender' }, 400);
      } else if (!wav(input.source) || !wav(input.consent)) return json({ error: 'invalid_voice', detail: 'Aufnahmen fehlen oder sind zu lang' }, 400);
      try {
        // A new voice is a paid call: it counts like a production.
        await new D1DailyCounter(env.DB).reserve(owner, Math.max(1, Number(env.DAILY_GENERATIONS) || 24));
        const voice = action === 'design'
          ? await catalog.design({ name, description: String(input.description).trim().slice(0, 600), ...(input.gender ? { gender: input.gender as 'female' | 'male' } : {}) })
          : await catalog.replicate({ name, source: input.source as string, consent: input.consent as string });
        // Google's own sample of a new voice is kept: the studio plays it when a sample of ours cannot be made.
        const { sample, ...listed } = voice;
        if (sample) {
          const bytes = Uint8Array.from(atob(sample.data), char => char.charCodeAt(0));
          // Raw PCM (audio/L16) becomes a WAV file, so every player can play it.
          const raw = /L16|pcm/i.test(sample.mimeType) && String.fromCharCode(...bytes.subarray(0, 4)) !== 'RIFF';
          await env.AUDIO.put(voiceSampleKey(voice.id), raw ? pcmToWav(bytes, Number(/rate=(\d+)/.exec(sample.mimeType)?.[1]) || 24_000) : bytes,
            { httpMetadata: { contentType: raw ? 'audio/wav' : sample.mimeType.split(';')[0] } });
        }
        return json({ voice: listed }, 200);
      } catch (error) { return json({ error: 'voice_failed', detail: error instanceof Error ? error.message.slice(0, 200) : undefined }, statusFor(error)); }
    }
    if (url.pathname === '/api/mistral-voices') {
      if (request.method !== 'GET') return json({ error: 'method_not_allowed' }, 405);
      if (request.headers.get('Origin') && request.headers.get('Origin') !== url.origin) return json({ error: 'origin_rejected' }, 403);
      // Gemini voices are expressive and follow the host's delivery style; listed first when available.
      const gemini = env.GEMINI_API_KEY ? GEMINI_VOICES.map(voice => ({ id: `gemini_${voice.name}`, name: `${voice.name} · ${voice.character} (Gemini)`, type: 'preset', languages: ['de-DE'], gender: voice.gender })) : [];
      try { return json({ voices: [...gemini, ...(await listMistralVoices()).map(voice => ({ ...voice, name: `${voice.name} (Mistral)` }))] }, 200); }
      catch { return json({ error: 'voice_catalog_unavailable' }, 502); }
    }
    if (url.pathname === '/api/feed-items') {
      if (request.method !== 'POST') return json({ error: 'method_not_allowed' }, 405);
      if (request.headers.get('Origin') !== url.origin) return json({ error: 'origin_rejected' }, 403);
      if (Number(request.headers.get('Content-Length') ?? 0) > 4096) return json({ error: 'request_too_large' }, 413);
      if (request.headers.get('Content-Type')?.split(';')[0]?.trim().toLowerCase() !== 'application/json') return json({ error: 'json_required' }, 415);
      try {
        const raw = await request.text();
        if (new TextEncoder().encode(raw).byteLength > 4096) return json({ error: 'request_too_large' }, 413);
        let body: { url?: unknown };
        try { body = JSON.parse(raw) as { url?: unknown }; } catch { return json({ error: 'invalid_json' }, 400); }
        try { validateFeedUrl(body.url); } catch { return json({ error: 'invalid_feed_url' }, 400); }
        try { await new D1FeedCounter(env.DB).reserve(owner, Math.max(1, Number(env.DAILY_FEED_REQUESTS) || 60)); }
        catch (error) {
          if (error instanceof PipelineError && error.code === 'BUDGET_EXCEEDED') return json({ error: 'feed_daily_limit' }, 429);
          return json({ error: 'feed_quota_unavailable' }, 503);
        }
        return json({ items: await fetchFeed(body.url) }, 200);
      } catch (error) {
        const status = error instanceof FeedError ? error.code === 'INVALID_FEED_URL' ? 400 : 422 : 502;
        const code = error instanceof FeedError ? error.code.toLowerCase() : 'feed_unavailable';
        return json({ error: code }, status);
      }
    }
    const familyResponse = await familyRoutes(request, env, owner, url);
    if (familyResponse) return familyResponse;
    const listeningResponse = await listeningRoutes(request, env, owner, url);
    if (listeningResponse) return listeningResponse;
    const stationResponse = await stationRoutes(request, env, owner, url);
    if (stationResponse) return stationResponse;
    if (url.pathname !== '/api/segments') return json({ error: 'not_found' }, 404);
    if (request.method !== 'POST') return json({ error: 'method_not_allowed' }, 405);
    if (request.headers.get('Origin') !== url.origin) return json({ error: 'origin_rejected' }, 403);
    const length = Number(request.headers.get('Content-Length') ?? 0);
    if (length > 32_768) return json({ error: 'request_too_large' }, 413);
    if (request.headers.get('Content-Type')?.split(';')[0]?.trim().toLowerCase() !== 'application/json') return json({ error: 'json_required' }, 415);
    let input: { profile?: Profile; sources?: Source[]; mode?: 'brief' | 'podcast'; voiceId?: unknown };
    try {
      const raw = await request.text();
      if (new TextEncoder().encode(raw).byteLength > 32_768) return json({ error: 'request_too_large' }, 413);
      input = JSON.parse(raw);
    } catch { return json({ error: 'invalid_json' }, 400); }
    const mode = input.mode ?? 'brief';
    if (mode !== 'brief' && mode !== 'podcast') return json({ error: 'invalid_mode' }, 400);
    if (input.voiceId !== undefined && (typeof input.voiceId !== 'string' || !/^[A-Za-z0-9_-]{1,100}$/.test(input.voiceId))) return json({ error: 'invalid_voice' }, 400);
    if (mode === 'podcast' && !env.GEMINI_API_KEY) return json({ error: 'podcast_provider_not_configured' }, 503);
    try { await new D1DailyCounter(env.DB).reserve(owner, Math.max(1, Number(env.DAILY_GENERATIONS) || 24)); }
    catch (error) {
      if (error instanceof PipelineError && error.code === 'BUDGET_EXCEEDED') return json({ error: 'daily_generation_limit' }, 429);
      return json({ error: 'quota_storage_unavailable' }, 503);
    }
    const idempotencyKey = request.headers.get('Idempotency-Key') ?? '';
    try {
      const pipeline = pipelineFor(env);
      const result = await pipeline.prepare(owner, idempotencyKey, input.profile as Profile, input.sources as Source[], mode, input.voiceId as string | undefined);
      const audioBuffer = new ArrayBuffer(result.audio.byteLength);
      new Uint8Array(audioBuffer).set(result.audio);
      return new Response(audioBuffer, { headers: {
        'Content-Type': result.contentType, 'Cache-Control': 'no-store', 'X-TTS-Characters': String(result.ttsCharacters), 'X-Audio-Mode': result.mode,
        'X-Script-Title': encodeURIComponent(result.script.title),
        'X-Script-Source-Ids': result.script.sourceIds.join(','),
        'X-Script-Interest-Tags': (result.script.interestTags ?? []).join(','),
      } });
    } catch (error) {
      const status = statusFor(error);
      const detail = error instanceof Error ? error.message.slice(0, 160) : 'unknown_error';
      console.error('segment generation failed', detail);
      return json(status === 502
        ? { error: 'generation_failed', detail }
        : { error: (error as Error).message }, status);
    }
  },

  /** Cron: keep every station's program filled ahead of playback (each only while its listener listens). */
  async scheduled(_controller: unknown, env: Environment, ctx: ExecutionContext) {
    const owners = allOwners(env.ALLOWED_EMAIL, parseListeners(env.LISTENERS));
    if (!owners.length) return;
    ctx.waitUntil(pruneLinkers(env.AUDIO, new Date()).catch(() => { /* Cleanup is retried on the next run. */ }));
    for (const owner of owners) {
      ctx.waitUntil(refreshProgram(env, owner, true).catch(error => console.error('program refresh failed', error instanceof Error ? error.message.slice(0, 160) : 'unknown')));
    }
  },

  /** Queue consumer: produce one timeline item per message. Retries are driven by the item's state, not the queue. */
  async queue(batch: QueueBatch, env: Environment) {
    const owners = new Set(allOwners(env.ALLOWED_EMAIL, parseListeners(env.LISTENERS)));
    for (const message of batch.messages) {
      const body = message.body as Partial<ProductionMessage> | null;
      const owner = body?.owner;
      if (typeof owner === 'string' && owners.has(owner) && typeof body?.itemId === 'string') {
        try { await produceItem(stationDeps(env, owner), owner, body.itemId); }
        catch (error) { console.error('segment production failed', error instanceof Error ? error.message.slice(0, 160) : 'unknown'); }
      }
      message.ack();
    }
  },
};
