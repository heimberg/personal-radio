import { StationStore } from '../station-store.ts';
import { showNameOf } from '../station.ts';
import { stationSounds } from '../../src/domain/station.ts';
import { PlayStore } from '../play.ts';
import { linkerFacts, linkerKey, linkerSystem, linkerText, silentWav } from '../linker.ts';
import { forKids, isKids, parseListeners } from '../listeners.ts';
import { FamilyStore } from '../family.ts';
import { json } from '../http.ts';
import type { Environment, AudioStore } from '../http.ts';
import { D1LinkerCounter } from '../counters.ts';
import { membersOf, pipelineFor, musicFor } from '../services.ts';

/** Live transitions are made for one moment; after two days they are removed from the bucket. */
export async function pruneLinkers(audio: AudioStore, now: Date) {
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
export async function linker(env: Environment, store: StationStore, owner: string, url: URL): Promise<Response> {
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
