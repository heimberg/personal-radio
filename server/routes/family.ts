import { StationStore } from '../station-store.ts';
import { toView } from '../station.ts';
import { FamilyStore, avatarImage, avatarKey, copyItem, mayCopyInto } from '../family.ts';
import { json, readJson } from '../http.ts';
import { prepareLinker } from './linker.ts';
import type { Environment, ExecutionContext } from '../http.ts';
import { membersOf, audioObjects } from '../services.ts';

/**
 * Family: who is there and what they hear, the chat, sharing an item into another member's program,
 * listening along, and greetings the host reads on air.
 */
export async function familyRoutes(request: Request, env: Environment, owner: string, url: URL, ctx?: ExecutionContext): Promise<Response | null> {
  if (!url.pathname.startsWith('/api/family')) return null;
  const members = await membersOf(env), me = members.find(member => member.owner === owner);
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
      // The app reports each item as it starts: the transition into the following one is made now, after the response.
      const prepare = prepareLinker(env, store, owner, row.id);
      if (ctx) ctx.waitUntil(prepare); else await prepare;
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
