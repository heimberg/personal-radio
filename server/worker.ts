/** The Worker: authentication and routing (routes live in server/routes/), the cron and the production queue. */
import { produceItem } from './station.ts';
import { allOwners, listenersOf } from './listeners.ts';
import { json } from './http.ts';
import type { Environment, ProductionMessage, QueueBatch, ExecutionContext } from './http.ts';
import { authenticate } from './auth.ts';
import { stationDeps, refreshProgram } from './services.ts';
import { pruneLinkers } from './routes/linker.ts';
import { pruneDatabase } from './retention.ts';
import { backupStation } from './backups.ts';
import { familyRoutes } from './routes/family.ts';
import { listeningRoutes, landingPage } from './routes/spotify.ts';
import { voiceRoutes } from './routes/voices.ts';
import { studioRoutes } from './routes/studio.ts';
import { listenerRoutes } from './routes/listener.ts';
import { programRoutes } from './routes/program.ts';
import { itemRoutes } from './routes/items.ts';
import { segmentRoutes } from './routes/segments.ts';
import { inviteRoutes, joinRoutes } from './routes/invites.ts';
import { devRoutes } from './routes/dev.ts';
import { withCallContext } from './trace.ts';

/** One authenticated request of [owner]. */
async function route(request: Request, env: Environment, owner: string, url: URL, ctx?: ExecutionContext): Promise<Response> {
  if (url.pathname === '/') return landingPage(url);
  if (!url.pathname.startsWith('/api/')) return env.ASSETS.fetch(request);
  if (url.pathname === '/api/testing/reset-daily-limits') {
    if (request.method !== 'POST') return json({ error: 'method_not_allowed' }, 405);
    if (request.headers.get('Origin') !== url.origin) return json({ error: 'origin_rejected' }, 403);
    const utcDay = new Date().toISOString().slice(0, 10);
    try {
      for (const table of ['daily_requests', 'daily_usage', 'daily_feed_requests', 'daily_linker_requests']) {
        await env.DB.prepare(`DELETE FROM ${table} WHERE owner_id = ? AND utc_day = ?`).bind(owner, utcDay).run();
      }
    } catch { return json({ error: 'quota_reset_unavailable' }, 503); }
    return json({ reset: true, utcDay }, 200);
  }
  for (const routes of [inviteRoutes, devRoutes, voiceRoutes, studioRoutes, familyRoutes, listeningRoutes, listenerRoutes, programRoutes, itemRoutes]) {
    const response = await routes(request, env, owner, url, ctx);
    if (response) return response;
  }
  if (url.pathname !== '/api/segments') return json({ error: 'not_found' }, 404);
  return segmentRoutes(request, env, owner, url);
}

export default {
  async fetch(request: Request, env: Environment, ctx?: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    // Joining by invitation happens before there is a token: Access lets `/join` through (see the docs).
    if (url.pathname === '/join' || url.pathname.startsWith('/join/')) return joinRoutes(request, env, url);
    const auth = await authenticate(request, env);
    if (auth.owner === null) return json({ error: 'unauthorized', reason: auth.reason }, 401);
    const owner = auth.owner;
    // Provider calls made for this request (and the work it hands to waitUntil) belong to this station.
    return withCallContext({ owner }, () => route(request, env, owner, url, ctx));
  },

  /** Cron: keep every station's program filled ahead of playback (each only while its listener listens). */
  async scheduled(_controller: unknown, env: Environment, ctx: ExecutionContext) {
    const owners = allOwners(env.ALLOWED_EMAIL, await listenersOf(env));
    if (!owners.length) return;
    const now = new Date();
    ctx.waitUntil(pruneLinkers(env.AUDIO, now).catch(() => { /* Cleanup is retried on the next run. */ }));
    // Once a night: old logs, counters and markers leave the database.
    if (now.getUTCHours() === 3 && now.getUTCMinutes() < 10) ctx.waitUntil(pruneDatabase(env.DB, now).catch(error => console.error('database cleanup failed', error instanceof Error ? error.message.slice(0, 160) : 'unknown')));
    // Sunday night: a copy of every station's settings, the newest eight kept.
    if (now.getUTCDay() === 0 && now.getUTCHours() === 3 && now.getUTCMinutes() < 10) {
      for (const owner of owners) ctx.waitUntil(backupStation(env, owner, now).catch(error => console.error('backup failed', error instanceof Error ? error.message.slice(0, 160) : 'unknown')));
    }
    for (const owner of owners) {
      ctx.waitUntil(withCallContext({ owner }, () => refreshProgram(env, owner, true)).catch(error => console.error('program refresh failed', error instanceof Error ? error.message.slice(0, 160) : 'unknown')));
    }
  },

  /** Queue consumer: produce one timeline item per message. Retries are driven by the item's state, not the queue. */
  async queue(batch: QueueBatch, env: Environment) {
    const owners = new Set(allOwners(env.ALLOWED_EMAIL, await listenersOf(env)));
    for (const message of batch.messages) {
      const body = message.body as Partial<ProductionMessage> | null;
      const owner = body?.owner;
      if (typeof owner === 'string' && owners.has(owner) && typeof body?.itemId === 'string') {
        const deps = stationDeps(env, owner);
        try {
          // A long hour is voiced in several invocations: the next part follows in a new message.
          if (await withCallContext({ owner, itemId: body.itemId }, () => produceItem(deps, owner, body.itemId!)) === 'continue') await env.PRODUCTION.send({ owner, itemId: body.itemId });
        } catch (error) {
          const detail = error instanceof Error ? error.message.slice(0, 300) : 'unknown';
          console.error('segment production failed', detail.slice(0, 160));
          await deps.store.logError(owner, 'queue', detail, new Date(), body.itemId).catch(() => { /* The log is best effort. */ });
        }
      }
      message.ack();
    }
  },
};
