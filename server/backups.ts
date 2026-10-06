import { StationStore } from './station-store.ts';
import { ConfigError, parseStationConfig } from '../src/domain/station.ts';
import { json, readJson } from './http.ts';
import type { Environment } from './http.ts';

/** How many weekly copies of a station's settings are kept. */
export const BACKUPS_KEPT = 8;
const DATE = /^\d{4}-\d{2}-\d{2}(-vorher)?$/;

/** The bucket folder of one owner: a hash, so no email address ends up in a key. */
export async function backupFolder(owner: string): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(owner)));
  return `backups/${Array.from(digest.slice(0, 8), byte => byte.toString(16).padStart(2, '0')).join('')}/`;
}

/** The copies of [owner], newest first (`2026-10-04`, or `…-vorher` for the state before a restore). */
export async function listBackups(env: Environment, owner: string): Promise<string[]> {
  if (!env.AUDIO.list) return [];
  const prefix = await backupFolder(owner);
  const { objects } = await env.AUDIO.list({ prefix, limit: 100 });
  return objects.map(object => object.key.slice(prefix.length).replace(/\.json$/, '')).filter(name => DATE.test(name)).sort().reverse();
}

/** Copies the station's settings (shows, day plan, agents, feeds …) to R2 and keeps the newest [BACKUPS_KEPT]. */
export async function backupStation(env: Environment, owner: string, now: Date, name = now.toISOString().slice(0, 10)): Promise<boolean> {
  const config = await new StationStore(env.DB).getConfig(owner);
  if (!config) return false;
  const prefix = await backupFolder(owner);
  await env.AUDIO.put(`${prefix}${name}.json`, new TextEncoder().encode(JSON.stringify(config)), { httpMetadata: { contentType: 'application/json' } });
  for (const old of (await listBackups(env, owner)).slice(BACKUPS_KEPT)) await env.AUDIO.delete(`${prefix}${old}.json`);
  return true;
}

/** `GET /api/backups` lists, `POST /api/backups` copies now, `POST /api/backups/restore {name}` brings a copy back. */
export async function backupRoutes(request: Request, env: Environment, owner: string, url: URL, sameOrigin: boolean): Promise<Response> {
  if (url.pathname === '/api/backups' && request.method === 'GET') return json({ backups: await listBackups(env, owner) }, 200);
  if (request.method !== 'POST') return json({ error: 'method_not_allowed' }, 405);
  if (!sameOrigin) return json({ error: 'origin_rejected' }, 403);
  const now = new Date();
  if (url.pathname === '/api/backups') {
    return await backupStation(env, owner, now) ? json({ backups: await listBackups(env, owner) }, 200) : json({ error: 'not_configured' }, 409);
  }
  const body = await readJson(request, 256);
  if (body.error) return body.error;
  const name = (body.value as { name?: unknown } | null)?.name;
  if (typeof name !== 'string' || !DATE.test(name)) return json({ error: 'invalid_backup' }, 400);
  const object = await env.AUDIO.get(`${await backupFolder(owner)}${name}.json`);
  if (!object) return json({ error: 'not_found' }, 404);
  let config;
  try { config = parseStationConfig(JSON.parse(await new Response(object.body).text())); }
  catch (error) {
    if (error instanceof ConfigError || error instanceof SyntaxError) return json({ error: 'invalid_backup', detail: error.message.slice(0, 200) }, 400);
    throw error;
  }
  // What is there now is kept too, so a restore can be undone.
  await backupStation(env, owner, now, `${now.toISOString().slice(0, 10)}-vorher`);
  const store = new StationStore(env.DB), current = await store.getConfig(owner);
  // Today's mood belongs to today, not to the copy.
  const { mood: _mood, ...restored } = config;
  await store.saveConfig(owner, current?.mood ? { ...restored, mood: current.mood } : restored, now);
  return json({ config: await store.getConfig(owner) }, 200);
}
