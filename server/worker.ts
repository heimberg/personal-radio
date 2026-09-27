import { createRemoteJWKSet, jwtVerify } from 'jose';
import { SegmentPipeline, PipelineError, type CharacterBudgetStore } from './segment-pipeline.ts';
import { AskEditorialVerifier, AskTextGenerator, FallbackVerifier, GeminiBriefGenerator, GeminiEditorialVerifier, GeminiPodcastGenerator, GeminiPodcastSpeechSynthesizer, GeminiResearcher, GeminiSpeechSynthesizer, GEMINI_VOICES, MistralSpeechSynthesizer, ProviderError, VoiceRouter } from './providers.ts';
import type { Researcher } from './providers.ts';
import type { EditorialVerifier } from './segment-pipeline.ts';
import type { TextGenerator } from '../src/domain/program.ts';
import type { Profile, Source } from '../src/domain/program.ts';
import { fetchFeed, FeedError, validateFeedUrl } from './feed.ts';
import { listMistralVoices } from './mistral-voices.ts';
import { StationStore } from './station-store.ts';
import type { D1Database } from './station-store.ts';
import { produceItem, scheduleShowNow, tick, toView } from './station.ts';
import { GeminiMusicWriter, SpotifyCatalog } from './music.ts';
import type { MusicCatalog, MusicWriter } from './music.ts';
import type { AudioBucket, StationDeps } from './station.ts';
import { ConfigError, parseStationConfig } from '../src/domain/station.ts';
import type { FeedbackAction } from '../src/domain/recommendation.ts';

interface StoredAudio { body: ReadableStream; size: number; httpEtag: string; range?: { offset?: number; length?: number; suffix?: number } }
interface AudioStore extends AudioBucket { get(key: string, options?: { range?: Headers }): Promise<StoredAudio | null> }
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
  DAILY_TTS_CHARACTERS?: string;
  DAILY_GENERATIONS?: string;
  DAILY_FEED_REQUESTS?: string;
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
  GEMINI_VOICE_A?: string;
  GEMINI_VOICE_B?: string;
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
    if (!env.ACCESS_SERVICE_TOKEN_ID?.trim()) return refuse('service_token_not_configured');
    if (serviceToken !== env.ACCESS_SERVICE_TOKEN_ID.trim()) return refuse('service_token_not_allowed');
    return { owner: env.ALLOWED_EMAIL.toLowerCase() };
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
function providersFor(env: Environment): Providers {
  let providers = providerCache.get(env.DB as object);
  if (!providers) {
    const askConfig = { baseUrl: env.ASK_BASE_URL, key: env.ASK_API_KEY, model: env.ASK_MODEL };
    const askReady = Boolean(env.ASK_BASE_URL && env.ASK_API_KEY && env.ASK_MODEL);
    const gemini = env.GEMINI_API_KEY ? { key: env.GEMINI_API_KEY, model: env.GEMINI_TEXT_MODEL } : undefined;
    const unavailable: EditorialVerifier = { verify: async () => { throw new ProviderError('No verifier configured'); } };
    providers = {
      ...(askReady ? { ask: new AskTextGenerator(askConfig) } : {}),
      ...(gemini ? {
        geminiBrief: new GeminiBriefGenerator(gemini), geminiDialog: new GeminiPodcastGenerator(gemini),
        researcher: new GeminiResearcher({ key: gemini.key, model: env.GEMINI_RESEARCH_MODEL || gemini.model }),
      } : {}),
      verifier: askReady && gemini ? new FallbackVerifier(new AskEditorialVerifier(askConfig), new GeminiEditorialVerifier(gemini))
        : askReady ? new AskEditorialVerifier(askConfig) : gemini ? new GeminiEditorialVerifier(gemini) : unavailable,
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
      }), env.GEMINI_API_KEY ? new GeminiSpeechSynthesizer({ key: env.GEMINI_API_KEY, model: env.GEMINI_TTS_MODEL }) : undefined),
      providers.verifier,
      new D1CharacterBudget(env.DB, Math.max(1, Number(env.DAILY_TTS_CHARACTERS) || 12_000)),
      4,
      env.GEMINI_API_KEY ? {
        text: providers.geminiDialog!,
        speech: new GeminiPodcastSpeechSynthesizer({ key: env.GEMINI_API_KEY, model: env.GEMINI_TTS_MODEL, voiceA: env.GEMINI_VOICE_A, voiceB: env.GEMINI_VOICE_B }),
      } : undefined,
    );
    pipelines.set(env.DB as object, pipeline);
  }
  return pipeline;
}

const musicCache = new WeakMap<object, { writer?: MusicWriter; catalog?: MusicCatalog }>();
function musicFor(env: Environment) {
  let music = musicCache.get(env.DB as object);
  if (!music) {
    music = {
      ...(env.GEMINI_API_KEY ? { writer: new GeminiMusicWriter({ key: env.GEMINI_API_KEY, model: env.GEMINI_TEXT_MODEL }) } : {}),
      ...(env.SPOTIFY_CLIENT_ID && env.SPOTIFY_CLIENT_SECRET
        ? { catalog: new SpotifyCatalog({ clientId: env.SPOTIFY_CLIENT_ID, clientSecret: env.SPOTIFY_CLIENT_SECRET, market: env.SPOTIFY_MARKET }) } : {}),
    };
    musicCache.set(env.DB as object, music);
  }
  return music;
}

function stationDeps(env: Environment): StationDeps {
  return {
    store: new StationStore(env.DB), pipeline: pipelineFor(env), audio: env.AUDIO,
    fetchFeed: url => fetchFeed(url),
    reserveFeed: owner => new D1FeedCounter(env.DB).reserve(owner, Math.max(1, Number(env.DAILY_FEED_REQUESTS) || 60)),
    reserveGeneration: owner => new D1DailyCounter(env.DB).reserve(owner, Math.max(1, Number(env.DAILY_GENERATIONS) || 24)),
    podcastAvailable: Boolean(env.GEMINI_API_KEY), now: () => new Date(),
    generator: (provider, format) => {
      const providers = providersFor(env);
      if (provider === 'ask') return format === 'brief' ? providers.ask : undefined;
      return format === 'podcast' ? providers.geminiDialog : providers.geminiBrief;
    },
    researcher: providersFor(env).researcher,
    musicWriter: musicFor(env).writer,
    catalog: musicFor(env).catalog,
  };
}

/** Plans the program and hands due items to the production queue. */
async function refreshProgram(env: Environment, owner: string, requireListener: boolean) {
  const result = await tick(stationDeps(env), owner, { requireListener });
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
      const config = parseStationConfig(body.value);
      await store.saveConfig(owner, config, new Date());
      return json({ config }, 200);
    } catch (error) {
      if (error instanceof ConfigError) return json({ error: 'invalid_config', detail: error.message }, 400);
      throw error;
    }
  }
  if (url.pathname === '/api/timeline') {
    if (request.method !== 'GET') return json({ error: 'method_not_allowed' }, 405);
    const config = await store.getConfig(owner);
    await store.touch(owner, new Date());
    // The Spotify client ID is public; the app needs it to connect to the Spotify app (App Remote).
    const spotify = env.SPOTIFY_CLIENT_ID ? { spotify: { clientId: env.SPOTIFY_CLIENT_ID } } : {};
    return json({ items: (await store.visibleItems(owner)).map(row => toView(row, config)), failures: await store.failureSummary(owner), ...spotify }, 200);
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
  const produce = url.pathname.match(/^\/api\/shows\/([a-z0-9-]{1,40})\/produce$/);
  if (produce) {
    if (request.method !== 'POST') return json({ error: 'method_not_allowed' }, 405);
    if (!sameOrigin) return json({ error: 'origin_rejected' }, 403);
    await store.touch(owner, new Date());
    const itemId = await scheduleShowNow(stationDeps(env), owner, produce[1]);
    if (!itemId) return json({ error: 'unknown_show' }, 404);
    await env.PRODUCTION.send({ owner, itemId });
    return json({ itemId }, 200);
  }
  const match = url.pathname.match(/^\/api\/timeline\/([A-Za-z0-9-]{1,64})\/(audio|feedback)$/);
  if (!match) return null;
  const row = await store.getItem(owner, match[1]);
  if (!row) return json({ error: 'not_found' }, 404);
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
  await store.addFeedback(owner, { itemId: row.id, interests, action: action as FeedbackAction, listenedRatio, createdAt: now.toISOString() });
  if ((action === 'complete' || action === 'skip') && row.state === 'ready') await store.update(owner, row.id, { state: action === 'complete' ? 'played' : 'skipped' }, now);
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
        for (const table of ['daily_requests', 'daily_usage', 'daily_feed_requests']) {
          await env.DB.prepare(`DELETE FROM ${table} WHERE owner_id = ? AND utc_day = ?`).bind(owner, utcDay).run();
        }
      } catch { return json({ error: 'quota_reset_unavailable' }, 503); }
      return json({ reset: true, utcDay }, 200);
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

  /** Cron: keep the single owner's program filled ahead of playback. */
  async scheduled(_controller: unknown, env: Environment, ctx: ExecutionContext) {
    const owner = env.ALLOWED_EMAIL?.toLowerCase();
    if (!owner) return;
    ctx.waitUntil(refreshProgram(env, owner, true).catch(error => console.error('program refresh failed', error instanceof Error ? error.message.slice(0, 160) : 'unknown')));
  },

  /** Queue consumer: produce one timeline item per message. Retries are driven by the item's state, not the queue. */
  async queue(batch: QueueBatch, env: Environment) {
    const owner = env.ALLOWED_EMAIL?.toLowerCase();
    for (const message of batch.messages) {
      const body = message.body as Partial<ProductionMessage> | null;
      if (owner && body?.owner === owner && typeof body.itemId === 'string') {
        try { await produceItem(stationDeps(env), owner, body.itemId); }
        catch (error) { console.error('segment production failed', error instanceof Error ? error.message.slice(0, 160) : 'unknown'); }
      }
      message.ack();
    }
  },
};
