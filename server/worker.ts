import { createRemoteJWKSet, jwtVerify } from 'jose';
import { SegmentPipeline, PipelineError, type CharacterBudgetStore } from './segment-pipeline.ts';
import { AskEditorialVerifier, AskTextGenerator, GeminiPodcastGenerator, GeminiPodcastSpeechSynthesizer, MistralSpeechSynthesizer } from './providers.ts';
import type { Profile, Source } from '../src/domain/program.ts';
import { fetchFeed, FeedError, validateFeedUrl } from './feed.ts';

interface D1Statement { bind(...values: unknown[]): D1Statement; first<T>(): Promise<T | null> }
interface D1Database { prepare(query: string): D1Statement }
interface DailyCounter { reserve(ownerId: string, limit: number): Promise<void> }
interface Environment {
  DB: D1Database;
  ASSETS: { fetch(request: Request): Promise<Response> };
  ACCESS_TEAM_DOMAIN: string;
  ACCESS_AUD: string;
  ALLOWED_EMAIL: string;
  DAILY_TTS_CHARACTERS?: string;
  DAILY_GENERATIONS?: string;
  DAILY_FEED_REQUESTS?: string;
  ASK_BASE_URL: string;
  ASK_API_KEY: string;
  ASK_MODEL: string;
  MISTRAL_API_KEY: string;
  MISTRAL_VOICE_ID: string;
  GEMINI_API_KEY?: string;
  GEMINI_TEXT_MODEL?: string;
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

async function authenticate(request: Request, env: Environment): Promise<string | null> {
  const assertion = request.headers.get('Cf-Access-Jwt-Assertion');
  if (!assertion || !env.ACCESS_TEAM_DOMAIN || !env.ACCESS_AUD || !env.ALLOWED_EMAIL) return null;
  try {
    const issuer = `https://${env.ACCESS_TEAM_DOMAIN}`;
    const jwks = createRemoteJWKSet(new URL(`${issuer}/cdn-cgi/access/certs`));
    const { payload } = await jwtVerify(assertion, jwks, { issuer, audience: env.ACCESS_AUD });
    const email = typeof payload.email === 'string' ? payload.email.toLowerCase() : '';
    if (!email || email !== env.ALLOWED_EMAIL.toLowerCase() || payload.type !== 'app') return null;
    return email;
  } catch { return null; }
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

export default {
  async fetch(request: Request, env: Environment): Promise<Response> {
    const url = new URL(request.url);
    const owner = await authenticate(request, env);
    if (!owner) return json({ error: 'unauthorized' }, 401);
    if (!url.pathname.startsWith('/api/')) return env.ASSETS.fetch(request);
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
    if (url.pathname !== '/api/segments') return json({ error: 'not_found' }, 404);
    if (request.method !== 'POST') return json({ error: 'method_not_allowed' }, 405);
    if (request.headers.get('Origin') !== url.origin) return json({ error: 'origin_rejected' }, 403);
    const length = Number(request.headers.get('Content-Length') ?? 0);
    if (length > 32_768) return json({ error: 'request_too_large' }, 413);
    if (request.headers.get('Content-Type')?.split(';')[0]?.trim().toLowerCase() !== 'application/json') return json({ error: 'json_required' }, 415);
    let input: { profile?: Profile; sources?: Source[]; mode?: 'brief' | 'podcast' };
    try {
      const raw = await request.text();
      if (new TextEncoder().encode(raw).byteLength > 32_768) return json({ error: 'request_too_large' }, 413);
      input = JSON.parse(raw);
    } catch { return json({ error: 'invalid_json' }, 400); }
    const mode = input.mode ?? 'brief';
    if (mode !== 'brief' && mode !== 'podcast') return json({ error: 'invalid_mode' }, 400);
    if (mode === 'podcast' && !env.GEMINI_API_KEY) return json({ error: 'podcast_provider_not_configured' }, 503);
    try { await new D1DailyCounter(env.DB).reserve(owner, Math.max(1, Number(env.DAILY_GENERATIONS) || 24)); }
    catch (error) {
      if (error instanceof PipelineError && error.code === 'BUDGET_EXCEEDED') return json({ error: 'daily_generation_limit' }, 429);
      return json({ error: 'quota_storage_unavailable' }, 503);
    }
    const idempotencyKey = request.headers.get('Idempotency-Key') ?? '';
    try {
      let pipeline = pipelines.get(env.DB as object);
      if (!pipeline) {
        pipeline = new SegmentPipeline(
          new AskTextGenerator({ baseUrl: env.ASK_BASE_URL, key: env.ASK_API_KEY, model: env.ASK_MODEL }),
          new MistralSpeechSynthesizer({ key: env.MISTRAL_API_KEY, voiceId: env.MISTRAL_VOICE_ID }),
          new AskEditorialVerifier({ baseUrl: env.ASK_BASE_URL, key: env.ASK_API_KEY, model: env.ASK_MODEL }),
          new D1CharacterBudget(env.DB, Math.max(1, Number(env.DAILY_TTS_CHARACTERS) || 12_000)),
          4,
          env.GEMINI_API_KEY ? {
            text: new GeminiPodcastGenerator({ key: env.GEMINI_API_KEY, model: env.GEMINI_TEXT_MODEL }),
            speech: new GeminiPodcastSpeechSynthesizer({ key: env.GEMINI_API_KEY, model: env.GEMINI_TTS_MODEL, voiceA: env.GEMINI_VOICE_A, voiceB: env.GEMINI_VOICE_B }),
          } : undefined,
        );
        pipelines.set(env.DB as object, pipeline);
      }
      const result = await pipeline.prepare(owner, idempotencyKey, input.profile as Profile, input.sources as Source[], mode);
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
      return json({ error: status === 502 ? 'generation_failed' : (error as Error).message }, status);
    }
  },
};
