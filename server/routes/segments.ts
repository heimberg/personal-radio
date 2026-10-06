import { PipelineError } from '../segment-pipeline.ts';
import { generationLimit, listenersOf } from '../listeners.ts';
import type { Profile, Source } from '../../src/domain/program.ts';
import { json, statusFor } from '../http.ts';
import type { Environment } from '../http.ts';
import { D1DailyCounter } from '../counters.ts';
import { pipelineFor } from '../services.ts';

/** `POST /api/segments`: one segment from given sources, made and voiced on the spot (not stored). */
export async function segmentRoutes(request: Request, env: Environment, owner: string, url: URL): Promise<Response> {
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
  try { await new D1DailyCounter(env.DB).reserve(owner, generationLimit(owner, await listenersOf(env), Math.max(1, Number(env.DAILY_GENERATIONS) || 24))); }
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
}
