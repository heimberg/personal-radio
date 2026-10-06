import { json, readJson } from '../http.ts';
import type { Environment } from '../http.ts';
import { StationStore } from '../station-store.ts';
import { allOwners, listenersOf, parseListeners, type ListenerKind } from '../listeners.ts';
import { InviteStore, KINDS, cloudflareIssuer, normalizeCode, type TokenIssuer } from '../invites.ts';
import { eraseStation } from '../erase.ts';
import { avatarKey } from '../family.ts';
import { costsByOwner, priceList } from '../costs.ts';
import { healthCheck } from '../health.ts';

const APP_APK = 'app/personal-radio.apk';

const escape = (text: string) => text.replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]!);
const clientIp = (request: Request) => request.headers.get('CF-Connecting-IP') ?? 'unknown';

/**
 * The owner's side: hand out invitations, see who joined, take access away. Listeners from the
 * `LISTENERS` secret are listed too, but only the secret can change them.
 */
export async function inviteRoutes(request: Request, env: Environment, owner: string, url: URL, _ctx?: unknown, issuer: TokenIssuer | null = cloudflareIssuer(env)): Promise<Response | null> {
  if (url.pathname !== '/api/invites' && !url.pathname.startsWith('/api/invites/') && !url.pathname.startsWith('/api/listeners/')) return null;
  if (owner !== env.ALLOWED_EMAIL?.toLowerCase()) return json({ error: 'owner_only' }, 403);
  // Like every write: only from the app (its Origin), never from another site.
  if (request.method !== 'GET' && request.headers.get('Origin') !== url.origin) return json({ error: 'origin_rejected' }, 403);
  const invites = new InviteStore(env.DB), now = new Date();
  if (url.pathname === '/api/invites' && request.method === 'GET') {
    const since = new Date(now.getTime() - 6 * 86_400_000).toISOString().slice(0, 10), today = now.toISOString().slice(0, 10);
    const [open, joined, generations, speech, costs] = await Promise.all([invites.list(now), invites.listeners(),
      env.DB.prepare('SELECT owner_id, utc_day, requests FROM daily_requests WHERE utc_day >= ?').bind(since).all<{ owner_id: string; utc_day: string; requests: number }>(),
      env.DB.prepare('SELECT owner_id, utc_day, characters FROM daily_usage WHERE utc_day >= ?').bind(since).all<{ owner_id: string; utc_day: string; characters: number }>(),
      costsByOwner(env.DB, now, priceList(env))]);
    // What each station used: productions and spoken characters, today and over seven days, and an estimate of its costs.
    const usage = (station: string) => {
      const mine = <T extends { owner_id: string; utc_day: string }>(rows: T[]) => rows.filter(row => row.owner_id === station);
      const g = mine(generations.results), c = mine(speech.results);
      return { today: { generations: g.filter(row => row.utc_day === today).reduce((sum, row) => sum + Number(row.requests), 0), characters: c.filter(row => row.utc_day === today).reduce((sum, row) => sum + Number(row.characters), 0) },
        week: { generations: g.reduce((sum, row) => sum + Number(row.requests), 0), characters: c.reduce((sum, row) => sum + Number(row.characters), 0) },
        costs: costs.get(station) ?? { today: 0, month: 0 } };
    };
    const fallback = Math.max(1, Number(env.DAILY_GENERATIONS) || 24);
    const fromSecret = [...parseListeners(env.LISTENERS).values()].map(listener => ({
      key: listener.owner.slice('listener:'.length), name: listener.owner.slice('listener:'.length), kind: listener.kids ? 'kids' : 'family', removable: false,
      limit: fallback, usage: usage(listener.owner),
    }));
    return json({
      ready: !!issuer,
      invites: open.map(row => ({ id: row.id, name: row.name, kind: row.kind, expiresAt: row.expires_at, usedAt: row.used_at,
        expired: !row.used_at && row.expires_at <= now.toISOString() })),
      listeners: [...fromSecret, ...joined.map(row => ({ key: row.owner_id.slice('listener:'.length), name: row.name, kind: row.kind, since: row.created_at, removable: true,
        limit: row.daily_generations ?? fallback, ownLimit: row.daily_generations ?? null, usage: usage(row.owner_id) }))],
      own: { limit: fallback, usage: usage(owner) },
    }, 200);
  }
  if (url.pathname === '/api/invites' && request.method === 'POST') {
    if (!issuer) return json({ error: 'invites_not_configured', detail: 'Im Worker fehlen CF_ACCOUNT_ID und CF_ACCESS_API_TOKEN (siehe Anleitung).' }, 409);
    const body = await readJson(request, 2_000);
    if (body.error) return body.error;
    const input = (body.value ?? {}) as { name?: unknown; kind?: unknown };
    const name = typeof input.name === 'string' ? input.name.replace(/\s+/g, ' ').trim().slice(0, 30) : '';
    const kind = KINDS.includes(input.kind as ListenerKind) ? input.kind as ListenerKind : null;
    if (name.length < 2 || !kind) return json({ error: 'invalid_invite', detail: 'Name (2–30 Zeichen) und Art (Familie, Kind oder Gast) angeben.' }, 400);
    const created = await invites.create(name, kind, now);
    return json({ id: created.id, code: created.code, expiresAt: created.expiresAt, link: `${url.origin}/join?code=${created.code}` }, 200);
  }
  const inviteMatch = url.pathname.match(/^\/api\/invites\/([0-9a-f-]{36})$/);
  if (inviteMatch && request.method === 'DELETE') return await invites.remove(inviteMatch[1]) ? json({ removed: true }, 200) : json({ error: 'not_found' }, 404);
  const listenerMatch = url.pathname.match(/^\/api\/listeners\/([a-z0-9-]{2,40})$/);
  if (listenerMatch && request.method === 'PATCH') {
    const body = await readJson(request, 500);
    if (body.error) return body.error;
    const raw = (body.value as { dailyGenerations?: unknown } | undefined)?.dailyGenerations;
    const limit = raw === null ? null : Number(raw);
    if (limit !== null && (!Number.isInteger(limit) || limit < 1 || limit > 500)) return json({ error: 'invalid_limit', detail: 'Zwischen 1 und 500 Produktionen pro Tag.' }, 400);
    return await invites.setLimit(`listener:${listenerMatch[1]}`, limit) ? json({ dailyGenerations: limit }, 200) : json({ error: 'not_found' }, 404);
  }
  if (listenerMatch && request.method === 'DELETE') {
    if (!issuer) return json({ error: 'invites_not_configured' }, 409);
    const station = `listener:${listenerMatch[1]}`;
    if (!await invites.removeListener(station, issuer)) return json({ error: 'not_found' }, 404);
    // «Auch alle Daten löschen»: the station goes too, not just the access.
    if (url.searchParams.get('data') === '1') {
      const erased = await eraseStation(env.DB, env.AUDIO, station, avatarKey({ key: listenerMatch[1], owner: station, name: '', kids: false }));
      return json({ removed: true, erased }, 200);
    }
    return json({ removed: true }, 200);
  }
  return json({ error: 'method_not_allowed' }, 405);
}

function page(title: string, body: string, status = 200): Response {
  const html = `<!doctype html><html lang="de"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex"><title>${escape(title)}</title><style>body{margin:0;min-height:100vh;display:grid;place-items:center;background:#F3F4F0;color:#16171B;font:17px/1.5 system-ui,sans-serif}
main{max-width:30rem;padding:24px}h1{font:900 36px/1 system-ui,sans-serif;text-transform:uppercase;letter-spacing:-0.5px;margin:0 0 16px}
ol{padding-left:1.2em}li{margin:0 0 14px}a.button{display:inline-block;margin-top:6px;padding:12px 18px;border-radius:999px;background:#16171B;color:#fff;text-decoration:none;font-weight:700}
code{font:700 20px/1.4 ui-monospace,monospace;letter-spacing:1px;background:#fff;padding:6px 10px;border-radius:8px;display:inline-block}small{color:#5C5F66}
@media (prefers-color-scheme: dark){body{background:#121316;color:#ECEDEF}a.button{background:#ECEDEF;color:#121316}code{background:#24262B}small{color:#A0A3AA}}</style></head>
<body><main>${body}</main></body></html>`;
  return new Response(html, { status, headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer' } });
}

/**
 * The public part (Access lets `/join` through): the invitation page, the app download for a valid code,
 * and redeeming a code. Wrong codes count against the caller's address, so codes cannot be guessed.
 */
export async function joinRoutes(request: Request, env: Environment, url: URL, issuer: TokenIssuer | null = cloudflareIssuer(env)): Promise<Response> {
  const invites = new InviteStore(env.DB), now = new Date(), ip = clientIp(request);
  const wrong = async () => { await invites.attempt(ip, now); };
  if (url.pathname === '/join/health') {
    if (request.method !== 'GET') return json({ error: 'method_not_allowed' }, 405);
    const health = await healthCheck(env);
    return json(health, health.ok ? 200 : 503);
  }
  if (url.pathname === '/join/redeem') {
    if (request.method !== 'POST') return json({ error: 'method_not_allowed' }, 405);
    if (await invites.blocked(ip, now)) return json({ error: 'too_many_attempts', detail: 'Zu viele falsche Codes. Versuch es in einer Stunde wieder.' }, 429);
    if (!issuer) return json({ error: 'invites_not_configured' }, 503);
    const body = await readJson(request, 1_000);
    if (body.error) return body.error;
    const code = typeof (body.value as { code?: unknown } | undefined)?.code === 'string' ? normalizeCode((body.value as { code: string }).code) : '';
    if (code.length !== 16) { await wrong(); return json({ error: 'invalid_code', detail: 'Der Code hat 16 Zeichen, z. B. K7QM-…' }, 400); }
    const taken = new Set(allOwners(env.ALLOWED_EMAIL, await listenersOf(env)));
    let joined;
    try { joined = await invites.redeem(code, issuer, taken, now); }
    catch (error) {
      console.error('join failed', error instanceof Error ? error.message.slice(0, 160) : 'unknown');
      await new StationStore(env.DB).logError(env.ALLOWED_EMAIL?.toLowerCase() ?? '', 'invite', error instanceof Error ? error.message : 'unknown', now).catch(() => {});
      return json({ error: 'join_failed', detail: 'Die Einladung konnte gerade nicht eingelöst werden. Versuch es später nochmals.' }, 502);
    }
    if (!joined) { await wrong(); return json({ error: 'invalid_code', detail: 'Dieser Code ist unbekannt, abgelaufen oder schon benutzt.' }, 404); }
    return json({ baseUrl: url.origin, clientId: joined.clientId, clientSecret: joined.clientSecret, name: joined.name }, 200);
  }
  const code = normalizeCode(url.searchParams.get('code') ?? '');
  const valid = code.length === 16 && !await invites.blocked(ip, now) ? await invites.open(code, now) : null;
  if (url.pathname === '/join/apk') {
    if (!valid) { if (code) await wrong(); return json({ error: 'invalid_code' }, 404); }
    const object = await env.AUDIO.get(APP_APK);
    if (!object) return json({ error: 'not_found' }, 404);
    return new Response(object.body, { headers: { 'Content-Type': 'application/vnd.android.package-archive',
      'Content-Disposition': 'attachment; filename="personal-radio.apk"', 'Cache-Control': 'no-store' } });
  }
  if (url.pathname !== '/join') return json({ error: 'not_found' }, 404);
  if (!valid) {
    if (code) await wrong();
    return page('Einladung', `<h1>Einladung</h1><p>Dieser Einladungslink ist unbekannt, abgelaufen oder schon benutzt. Bitte frag nach einem neuen.</p>`, 404);
  }
  const station = (await new StationStore(env.DB).getConfig(env.ALLOWED_EMAIL?.toLowerCase() ?? ''))?.name?.trim() || 'Personal Radio';
  const grouped = code.match(/.{4}/g)!.join('-');
  const appLink = `personal-radio://join?code=${grouped}&url=${encodeURIComponent(url.origin)}`;
  return page(`Einladung · ${station}`, `<h1>${escape(station)}</h1>
<p>Hallo ${escape(valid.name)}, du bist eingeladen: ein eigenes Radio, das für dich Beiträge und Musik zusammenstellt.</p>
<ol>
<li>App laden und installieren (Android). Erlaube dem Browser einmalig das Installieren.<br><a class="button" href="/join/apk?code=${grouped}">App herunterladen</a></li>
<li>App öffnen. Dann hier tippen, damit sie dich gleich anmeldet:<br><a class="button" href="${escape(appLink)}">In der App beitreten</a></li>
</ol>
<p><small>Klappt der Knopf nicht? In der App «Ich habe eine Einladung» wählen und diesen Link einfügen oder den Code eintippen:</small><br><code>${grouped}</code></p>
<p><small>Die Einladung gilt einmal und bis ${escape(new Date(valid.expires_at).toLocaleDateString('de-CH', { timeZone: 'Europe/Zurich' }))}.</small></p>`);
}
