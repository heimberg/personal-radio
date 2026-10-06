import { json } from '../http.ts';
import type { Environment } from '../http.ts';
import { llmCalls } from '../usage.ts';
import { familyMembers } from '../family.ts';
import { listenersOf } from '../listeners.ts';

/**
 * The owner's developer view: every provider call of the last two days (all stations on this Worker),
 * newest first, with what went out and came back. Only the owner may look.
 */
export async function devRoutes(request: Request, env: Environment, owner: string, url: URL): Promise<Response | null> {
  if (url.pathname !== '/api/dev/calls') return null;
  if (request.method !== 'GET') return json({ error: 'method_not_allowed' }, 405);
  if (owner !== env.ALLOWED_EMAIL?.toLowerCase()) return json({ error: 'owner_only' }, 403);
  const before = Number(url.searchParams.get('before')) || undefined;
  const calls = await llmCalls(env.DB, { before, limit: 50, failed: url.searchParams.get('failed') === '1' });
  // Stations by name, never by email; guests appear by their invited name too.
  const listeners = await listenersOf(env);
  const names = new Map(familyMembers(env.ALLOWED_EMAIL ?? '', listeners, env.OWNER_NAME).map(member => [member.owner, member.name]));
  for (const listener of listeners.values()) if (!names.has(listener.owner)) names.set(listener.owner, listener.name ?? listener.owner.slice('listener:'.length));
  return json({ calls: calls.map(({ owner: station, ...call }) => ({ ...call, station: station ? names.get(station) ?? 'Unbekannt' : null })) }, 200);
}
