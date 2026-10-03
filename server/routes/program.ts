import { PipelineError } from '../segment-pipeline.ts';
import { ProviderError } from '../providers.ts';
import { StationStore } from '../station-store.ts';
import { blockViews } from '../../src/domain/blocks.ts';
import { AUDIO_RETENTION_DAYS, SeriesError, addBlock, arrangeTimeline, scheduleShowNow, seriesView, shuffleTimeline, stopSeries, toView } from '../station.ts';
import { stationSounds } from '../../src/domain/station.ts';
import { activeMood } from '../../src/domain/mood.ts';
import { PlayStore } from '../play.ts';
import { IDENT_VARIANTS, hourKey, hourText, identJingle, newsOpener, timeSignal } from '../sounds.ts';
import { isKids, parseListeners } from '../listeners.ts';
import { FamilyStore, messageLine } from '../family.ts';
import { json, readJson, statusFor } from '../http.ts';
import type { Environment } from '../http.ts';
import { membersOf, pipelineFor, stationDeps, refreshProgram } from '../services.ts';
import { linker } from './linker.ts';

const identAudio: Array<Uint8Array | undefined> = [];
let signalAudio: Uint8Array | undefined, newsAudio: Uint8Array | undefined;

const APP_APK = 'app/personal-radio.apk', APP_LATEST = 'app/latest.json';

/** The program: the timeline, transitions and sounds, blocks and series, planning and producing. */
export async function programRoutes(request: Request, env: Environment, owner: string, url: URL): Promise<Response | null> {
  const store = new StationStore(env.DB);
  const sameOrigin = request.headers.get('Origin') === url.origin;
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
    return unchangedOr(request, json({ items: (await store.visibleItems(owner)).map(row => toView(row, config)), failures: await store.failureSummary(owner), ...spotify, ...mood, ...family, ...play,
      sounds: {
        ...(sounds.ident ? { identUrl: 'api/sounds/ident.wav', identUrls: idents, newsUrl: 'api/sounds/news.wav' } : {}),
        ...(sounds.hourChange ? { signalUrl: 'api/sounds/pips.wav', hourUrl: 'api/sounds/hour/' } : {}),
        ...(sounds.linker && env.GEMINI_API_KEY ? { linkerUrl: 'api/linker' } : {}),
      } }, 200));
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
  // Series: the running and recent ones, and ending one.
  if (url.pathname === '/api/series') {
    if (request.method !== 'GET') return json({ error: 'method_not_allowed' }, 405);
    return json({ series: (await store.listSeries(owner)).map(seriesView) }, 200);
  }
  const stopMatch = url.pathname.match(/^\/api\/series\/([A-Za-z0-9-]{1,64})\/stop$/);
  if (stopMatch) {
    if (request.method !== 'POST') return json({ error: 'method_not_allowed' }, 405);
    if (!sameOrigin) return json({ error: 'origin_rejected' }, 403);
    return await stopSeries(stationDeps(env, owner), owner, stopMatch[1]) ? json({ stopped: stopMatch[1] }, 200) : json({ error: 'not_found' }, 404);
  }
  // Clients may encode the colon of an own show's block id ("show%3A<id>").
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
    // A stale order (the program changed meanwhile) is refused, and the app reloads.
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
  return null;
}


/**
 * The app asks for the program every half minute; most of the time nothing changed. The answer carries a
 * hash of its body as ETag, and a request that names the same one gets «304 Not Modified» without a body.
 */
async function unchangedOr(request: Request, response: Response): Promise<Response> {
  const body = await response.text();
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(body)));
  const etag = `"${Array.from(digest.slice(0, 12), byte => byte.toString(16).padStart(2, '0')).join('')}"`;
  const headers = new Headers(response.headers);
  headers.set('ETag', etag);
  if (request.headers.get('If-None-Match') === etag) return new Response(null, { status: 304, headers });
  return new Response(body, { status: response.status, headers });
}
