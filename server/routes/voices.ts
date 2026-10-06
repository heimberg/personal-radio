import { GeminiVoiceCatalog, GEMINI_VOICES, pcmToWav } from '../providers.ts';
import { dailyGenerationLimit } from '../budget.ts';
import { generationLimit, listenersOf } from '../listeners.ts';
import { listMistralVoices } from '../mistral-voices.ts';
import { StationStore } from '../station-store.ts';
import { previewKey, previewText } from '../sounds.ts';
import { json, readJson, statusFor } from '../http.ts';
import type { Environment } from '../http.ts';
import { D1DailyCounter } from '../counters.ts';
import { voiceSampleKey, metered, pipelineFor } from '../services.ts';

/** Voices for the studio: samples, the catalog, and own voices (designed, or cloned with consent). */
export async function voiceRoutes(request: Request, env: Environment, owner: string, url: URL): Promise<Response | null> {
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
      await new D1DailyCounter(env.DB).reserve(owner, await dailyGenerationLimit(env, owner, await listenersOf(env)));
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
  return null;
}
