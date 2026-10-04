/** The Worker's bindings and settings, and the small helpers every route uses. */
import { PipelineError } from './segment-pipeline.ts';
import type { D1Database } from './station-store.ts';
import type { AudioBucket } from './station.ts';

export interface StoredAudio { body: ReadableStream; size: number; httpEtag: string; range?: { offset?: number; length?: number; suffix?: number } }
export interface AudioStore extends AudioBucket {
  get(key: string, options?: { range?: Headers }): Promise<StoredAudio | null>;
  list?(options: { prefix: string; limit?: number }): Promise<{ objects: Array<{ key: string }> }>;
}
export interface ProductionQueue { send(message: ProductionMessage): Promise<void> }
export interface ProductionMessage { owner: string; itemId: string }
export interface QueueBatch { messages: Array<{ body: unknown; ack(): void }> }
export interface ExecutionContext { waitUntil(promise: Promise<unknown>): void }
export interface DailyCounter { reserve(ownerId: string, limit: number): Promise<void> }
export interface Environment {
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
  /** The cheaper model for scoring, transitions, quiz, story choices and the novelty check; empty turns it off. */
  GEMINI_LITE_MODEL?: string;
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
  /** `on` stores speech as MP3; it needs Workers Paid with a higher CPU limit (see wrangler.toml). */
  SPEECH_MP3?: string;
  /** How the family tab names the owner (default «Papa»). */
  OWNER_NAME?: string;
}

export function json(body: unknown, status: number) {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' } });
}

export function statusFor(error: unknown) {
  if (error instanceof PipelineError) {
    if (error.code === 'INVALID_INPUT') return 400;
    if (error.code === 'BUDGET_EXCEEDED' || error.code === 'TOO_MANY_REQUESTS') return 429;
    if (error.code === 'REJECTED') return 422;
    if (error.code === 'IDEMPOTENCY_CONFLICT') return 409;
  }
  return 502;
}

export async function readJson(request: Request, maxBytes: number): Promise<{ value?: unknown; error?: Response }> {
  if (Number(request.headers.get('Content-Length') ?? 0) > maxBytes) return { error: json({ error: 'request_too_large' }, 413) };
  if (request.headers.get('Content-Type')?.split(';')[0]?.trim().toLowerCase() !== 'application/json') return { error: json({ error: 'json_required' }, 415) };
  const raw = await request.text();
  if (new TextEncoder().encode(raw).byteLength > maxBytes) return { error: json({ error: 'request_too_large' }, 413) };
  try { return { value: JSON.parse(raw) }; } catch { return { error: json({ error: 'invalid_json' }, 400) }; }
}
