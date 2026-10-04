import { StationStore } from '../station-store.ts';
import { OpenMeteo } from '../tools.ts';
import { addPlaceStory } from '../station.ts';
import { stationSounds } from '../../src/domain/station.ts';
import { PlayStore, albumView } from '../play.ts';
import { BookmarkStore, FollowStore, MAX_FOLLOWED } from '../follow.ts';
import { reverseGeocode, validCoordinate } from '../places.ts';
import { featureOn } from '../../src/domain/features.ts';
import { membersOf } from '../services.ts';
import { FamilyStore } from '../family.ts';
import { json, readJson } from '../http.ts';
import type { Environment } from '../http.ts';
import { stationDeps, refreshProgram } from '../services.ts';

/** What a listener does beside listening: places, the reading list, followed topics, stickers, questions. */
export async function listenerRoutes(request: Request, env: Environment, owner: string, url: URL): Promise<Response | null> {
  const store = new StationStore(env.DB);
  const sameOrigin = request.headers.get('Origin') === url.origin;
  if (url.pathname === '/api/places') {
    if (request.method !== 'GET') return json({ error: 'method_not_allowed' }, 405);
    const name = (url.searchParams.get('name') ?? '').trim().slice(0, 80);
    if (name.length < 2) return json({ places: [] }, 200);
    try { return json({ places: await new OpenMeteo().places(name) }, 200); }
    catch { return json({ error: 'places_unavailable' }, 502); }
  }
  // Ortsgeschichten: the app reports a new place; its story joins the program (once a month per place).
  if (url.pathname === '/api/places/story') {
    if (request.method !== 'POST') return json({ error: 'method_not_allowed' }, 405);
    if (!sameOrigin) return json({ error: 'origin_rejected' }, 403);
    const body = await readJson(request, 512);
    if (body.error) return body.error;
    const { latitude, longitude } = (body.value ?? {}) as { latitude?: unknown; longitude?: unknown };
    if (!validCoordinate(latitude, longitude)) return json({ error: 'invalid_location' }, 400);
    const config = await store.getConfig(owner);
    if (!config || !featureOn(config, 'places')) return json({ error: 'feature_off' }, 409);
    let place;
    try { place = await reverseGeocode(latitude, longitude as number); } catch { place = null; }
    if (!place) return json({ skipped: 'no_place' }, 200);
    const result = await addPlaceStory(stationDeps(env, owner), owner, place.label);
    if ('itemId' in result) await env.PRODUCTION.send({ owner, itemId: result.itemId });
    return json({ place: place.label, ...result }, 200);
  }
  // Merken: the reading list.
  if (url.pathname === '/api/bookmarks') {
    if (request.method !== 'GET') return json({ error: 'method_not_allowed' }, 405);
    return json({ bookmarks: await new BookmarkStore(env.DB).list(owner) }, 200);
  }
  const bookmarkMatch = url.pathname.match(/^\/api\/bookmarks\/([A-Za-z0-9-]{1,64})$/);
  if (bookmarkMatch) {
    if (request.method !== 'DELETE') return json({ error: 'method_not_allowed' }, 405);
    if (!sameOrigin) return json({ error: 'origin_rejected' }, 403);
    return await new BookmarkStore(env.DB).remove(owner, bookmarkMatch[1]) ? json({ removed: true }, 200) : json({ error: 'not_found' }, 404);
  }
  // Dranbleiben: the topics the listener follows.
  if (url.pathname === '/api/follow') {
    const follows = new FollowStore(env.DB);
    if (request.method === 'GET') return json({ topics: (await follows.list(owner)).map(({ known: _known, ...topic }) => topic), max: MAX_FOLLOWED }, 200);
    if (request.method !== 'POST') return json({ error: 'method_not_allowed' }, 405);
    if (!sameOrigin) return json({ error: 'origin_rejected' }, 403);
    const body = await readJson(request, 1024);
    if (body.error) return body.error;
    const raw = (body.value as { topic?: unknown } | null)?.topic;
    const topic = typeof raw === 'string' ? raw.replace(/\s+/g, ' ').trim().slice(0, 120) : '';
    if (topic.length < 2) return json({ error: 'invalid_topic' }, 400);
    const added = await follows.add(owner, topic, new Date());
    if (!added) return json({ error: 'too_many_topics', max: MAX_FOLLOWED }, 409);
    // The first check runs right away (within the day's hours), so the listener hears soon what is new.
    await refreshProgram(env, owner, false);
    const { known: _known, ...view } = added;
    return json({ topic: view }, 200);
  }
  const followMatch = url.pathname.match(/^\/api\/follow\/(\d{1,9})$/);
  if (followMatch) {
    if (request.method !== 'DELETE') return json({ error: 'method_not_allowed' }, 405);
    if (!sameOrigin) return json({ error: 'origin_rejected' }, 403);
    return await new FollowStore(env.DB).remove(owner, Number(followMatch[1])) ? json({ removed: true }, 200) : json({ error: 'not_found' }, 404);
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
    const members = await membersOf(env);
    if (members.length > 1 && members.some(member => member.owner === owner)) await new FamilyStore(env.DB).addMessage(owner, 'text', `❓ Frage ans Radio: ${text}`, now);
    return json({ id }, 200);
  }
  return null;
}
