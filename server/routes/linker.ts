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
 * asks (or earlier, see [prepareLinker]) and kept for replays. Anything that fails plays a moment of silence
 * instead, so the program never stalls on a transition.
 */
export async function linker(env: Environment, store: StationStore, owner: string, url: URL): Promise<Response> {
  const audio = (bytes: Uint8Array, type: string) =>
    new Response(bytes as BodyInit, { headers: { 'Content-Type': type, 'Content-Length': String(bytes.byteLength), 'Cache-Control': 'private, max-age=86400' } });
  const quiet = () => audio(silence ??= silentWav(), 'audio/wav');
  const after = url.searchParams.get('after'), next = url.searchParams.get('next') ?? '';
  if (!LINKER_ID.test(next) || after !== null && !LINKER_ID.test(after)) return json({ error: 'invalid_request' }, 400);
  try {
    const made = await makeLinker(env, store, owner, after, next, true);
    if (!made) return quiet();
    if ('body' in made) return new Response(made.body, { headers: { 'Content-Type': made.type, 'Content-Length': String(made.size), 'Cache-Control': 'private, max-age=86400' } });
    return audio(made.bytes, made.type);
  } catch (error) {
    console.error('linker failed', error instanceof Error ? error.message.slice(0, 160) : 'unknown');
    await store.logError(owner, 'linker', error instanceof Error ? error.message : 'unknown', new Date(), next || undefined).catch(() => { /* Best effort. */ });
    return quiet();
  }
}

/**
 * Writes and voices the transition from [after] into the item that follows it in the program, as soon as
 * [after] starts playing, so the app finds it ready instead of waiting seconds for it. A transition that
 * would carry a greeting or a question is left to the app's own request: those are read only once.
 */
export async function prepareLinker(env: Environment, store: StationStore, owner: string, after: string): Promise<void> {
  try {
    const open = await store.visibleItems(owner);
    const index = open.findIndex(row => row.id === after);
    const next = index >= 0 ? open[index + 1] : undefined;
    if (!next || !LINKER_ID.test(after) || !LINKER_ID.test(next.id)) return;
    await makeLinker(env, store, owner, after, next.id, false);
  } catch (error) {
    await store.logError(owner, 'linker', `vorbereiten: ${error instanceof Error ? error.message : 'unknown'}`, new Date(), after).catch(() => { /* Best effort. */ });
  }
}

/** The transition from the bucket, or newly made (and kept); null when there is none to make. */
async function makeLinker(env: Environment, store: StationStore, owner: string, after: string | null, next: string, personal: boolean):
  Promise<{ bytes: Uint8Array; type: string } | { body: ReadableStream; size: number; type: string } | null> {
  const stored = await store.getConfig(owner), writer = musicFor(env).writer;
  const config = stored && isKids(owner, parseListeners(env.LISTENERS)) ? forKids(stored) : stored;
  if (!config || !stationSounds(config).linker || !writer) return null;
  const [nextRow, before] = await Promise.all([store.getItem(owner, next), after ? store.getItem(owner, after) : Promise.resolve(null)]);
  if (!nextRow) return null;
  const now = new Date(), voice = `${config.host.voiceId ?? ''}|${config.host.voiceStyle ?? ''}|${stationSounds(config).musicBed}`;
  // A family greeting waiting for this listener is read in this transition (and never comes from the cache).
  const family = new FamilyStore(env.DB), greeting = await family.pendingGreeting(owner, now);
  const from = greeting ? membersOf(env).find(member => member.owner === greeting.sender)?.name ?? 'der Familie' : '';
  // A question to the radio is answered in a transition without a greeting (one thing at a time).
  const play = new PlayStore(env.DB), question = greeting ? null : await play.pendingQuestion(owner, now);
  if (!personal && (greeting || question)) return null;
  const asker = question ? membersOf(env).find(member => member.owner === owner)?.name ?? '' : '';
  const key = linkerKey(now.toISOString().slice(0, 10), after, next, voice + (greeting ? `|g${greeting.id}` : '') + (question ? `|q${question.id}` : ''));
  for (const [suffix, type] of [['.wav', 'audio/wav'], ['.mp3', 'audio/mpeg']] as const) {
    const cached = await env.AUDIO.get(key + suffix);
    if (cached) return { body: cached.body, size: cached.size, type };
  }
  await new D1LinkerCounter(env.DB).reserve(owner, Math.max(1, Number(env.DAILY_LINKERS) || 40));
  const facts = { ...linkerFacts(config, before, nextRow, showNameOf(nextRow.show_id, config), now), ...(greeting ? { greeting: { from, text: greeting.text } } : {}),
    ...(question ? { question: { from: asker, text: question.text } } : {}) };
  const text = linkerText(await writer.askJson(linkerSystem(config, !facts.before || facts.before.music, !!greeting, !!question), facts, 'Gemini linker', 0.8),
    greeting ? 640 : question ? 900 : 320);
  if (!text) return null;
  const voiced = await pipelineFor(env).voice(owner, { title: 'Übergang', text, sourceIds: [] }, 'brief', config.host.voiceId, config.host.voiceStyle,
    { reserve: false, bed: stationSounds(config).musicBed, lite: true });
  await env.AUDIO.put(key + (voiced.contentType === 'audio/wav' ? '.wav' : '.mp3'), voiced.audio, { httpMetadata: { contentType: voiced.contentType } });
  if (greeting) await family.markAired(greeting.id, now);
  if (question) await play.answered(question.id, text, now);
  return { bytes: voiced.audio, type: voiced.contentType };
}
