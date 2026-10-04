import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sqliteD1 } from './d1-sqlite.ts';
import { InviteStore, JOIN_ATTEMPTS_PER_HOUR, cloudflareIssuer, newCode, normalizeCode, ownerKey } from '../server/invites.ts';
import type { TokenIssuer } from '../server/invites.ts';
import { forgetListeners, listenersOf, listenersNow } from '../server/listeners.ts';
import { familyMembers } from '../server/family.ts';
import { inviteRoutes, joinRoutes } from '../server/routes/invites.ts';
import type { Environment } from '../server/http.ts';

const OWNER = 'owner@example.test';
const NOW = new Date('2026-10-04T12:00:00Z');

function fakeIssuer() {
  const created: string[] = [], revoked: string[] = [];
  const issuer: TokenIssuer = {
    async create(name) { created.push(name); const n = created.length; return { id: `tok-${n}`, clientId: `client-${n}.access`, clientSecret: `secret-${n}` }; },
    async revoke(id) { revoked.push(id); },
  };
  return { issuer, created, revoked };
}

function env(db = sqliteD1(), extra: Partial<Environment> = {}): Environment {
  forgetListeners();
  const apk = new TextEncoder().encode('APK');
  return { DB: db, ALLOWED_EMAIL: OWNER, AUDIO: { get: async (key: string) => key === 'app/personal-radio.apk' ? { body: apk } : null }, ...extra } as unknown as Environment;
}

test('codes are 16 unambiguous characters in four groups; typing them loosely still matches', () => {
  const code = newCode();
  assert.match(code, /^[A-HJKMNP-Z2-9]{4}(-[A-HJKMNP-Z2-9]{4}){3}$/);
  assert.equal(normalizeCode(code.toLowerCase().replace(/-/g, ' ')), code.replace(/-/g, ''));
  assert.equal(ownerKey('Jürg Müller'), 'juerg-mueller');
  assert.equal(ownerKey('Ö'), 'oe');
  assert.equal(ownerKey('!'), 'hoerer-x');
});

test('an invitation works once, makes a token and a listener; guests stay outside the family, children get their rules', async () => {
  const db = sqliteD1(), store = new InviteStore(db), { issuer, created } = fakeIssuer();
  const lea = await store.create('Lea', 'kids', NOW);
  const tom = await store.create('Tom', 'guest', NOW);
  const joined = await store.redeem(lea.code.toLowerCase(), issuer, new Set([OWNER]), NOW);
  assert.deepEqual(joined, { clientId: 'client-1.access', clientSecret: 'secret-1', name: 'Lea' });
  assert.equal(await store.redeem(lea.code, issuer, new Set(), NOW), null, 'single use');
  await store.redeem(tom.code, issuer, new Set(), NOW);
  assert.deepEqual(created, ['Radio · Lea', 'Radio · Tom']);
  const e = env(db);
  const listeners = await listenersOf(e);
  assert.deepEqual(listeners.get('client-1.access'), { owner: 'listener:lea', kids: true, guest: false, name: 'Lea' });
  assert.equal(listeners.get('client-2.access')?.guest, true);
  assert.ok(listenersNow(e).get('client-1.access')?.kids, 'production sees the child without waiting');
  assert.deepEqual(familyMembers(OWNER, listeners).map(member => member.name), ['Papa', 'Lea']);
  // Expired invitations no longer open.
  const old = await store.create('Max', 'family', new Date('2026-09-01T00:00:00Z'));
  assert.equal(await store.redeem(old.code, issuer, new Set(), NOW), null);
});

test('a second listener with the same name gets a free owner ID; a failed token leaves the invitation usable', async () => {
  const db = sqliteD1(), store = new InviteStore(db), { issuer } = fakeIssuer();
  const first = await store.create('Lea', 'family', NOW), second = await store.create('Lea', 'family', NOW);
  await store.redeem(first.code, issuer, new Set(), NOW);
  await store.redeem(second.code, issuer, new Set(['listener:lea']), NOW);
  assert.deepEqual((await store.listeners()).map(row => row.owner_id), ['listener:lea', 'listener:lea-2']);
  const third = await store.create('Mia', 'family', NOW);
  const failing: TokenIssuer = { create: async () => { throw new Error('API down'); }, revoke: async () => {} };
  await assert.rejects(store.redeem(third.code, failing, new Set(), NOW), /API down/);
  assert.ok(await store.open(third.code, NOW), 'still open after the failure');
});

test('the owner hands out, lists and revokes; nobody else may', async () => {
  const db = sqliteD1(), e = env(db), { issuer, revoked } = fakeIssuer();
  const call = (method: string, path: string, body?: unknown, owner = OWNER, withIssuer: TokenIssuer | null = issuer) =>
    inviteRoutes(new Request(`https://radio.example${path}`, { method, ...(body ? { body: JSON.stringify(body) } : {}), headers: { Origin: 'https://radio.example', ...(body ? { 'Content-Type': 'application/json' } : {}) } }), e, owner, new URL(`https://radio.example${path}`), undefined, withIssuer);
  assert.equal((await call('GET', '/api/invites', undefined, 'listener:lea'))!.status, 403);
  const foreign = await inviteRoutes(new Request('https://radio.example/api/invites', { method: 'POST', body: '{}', headers: { Origin: 'https://evil.example', 'Content-Type': 'application/json' } }), e, OWNER, new URL('https://radio.example/api/invites'), undefined, issuer);
  assert.equal(foreign!.status, 403);
  assert.equal((await call('POST', '/api/invites', { name: 'Lea', kind: 'kids' }, OWNER, null))!.status, 409);
  assert.equal((await call('POST', '/api/invites', { name: 'L', kind: 'kids' }))!.status, 400);
  const made = await (await call('POST', '/api/invites', { name: 'Lea', kind: 'kids' }))!.json() as { id: string; code: string; link: string };
  assert.match(made.link, /^https:\/\/radio\.example\/join\?code=[A-Z0-9-]{19}$/);
  await new InviteStore(db).redeem(made.code, issuer, new Set(), new Date());
  const listed = await (await call('GET', '/api/invites'))!.json() as { ready: boolean; invites: Array<{ usedAt: string | null }>; listeners: Array<{ key: string; removable: boolean }> };
  assert.equal(listed.ready, true);
  assert.ok(listed.invites[0].usedAt);
  assert.deepEqual(listed.listeners.map(item => [item.key, item.removable]), [['lea', true]]);
  assert.equal((await call('DELETE', '/api/listeners/lea'))!.status, 200);
  assert.deepEqual(revoked, ['tok-1']);
  assert.equal((await listenersOf(e)).size, 0, 'access is gone at once');
  const open = await (await call('POST', '/api/invites', { name: 'Tom', kind: 'guest' }))!.json() as { id: string };
  assert.equal((await call('DELETE', `/api/invites/${open.id}`))!.status, 200);
});

test('the join page, the app download and redeeming need a valid code; guessing is cut off', async () => {
  const db = sqliteD1(), e = env(db), { issuer } = fakeIssuer();
  const { code } = await new InviteStore(db).create('Lea <3', 'family', NOW);
  const get = (path: string, ip = '1.2.3.4') => joinRoutes(new Request(`https://radio.example${path}`, { headers: { 'CF-Connecting-IP': ip } }), e, new URL(`https://radio.example${path}`), issuer);
  const page = await (await get(`/join?code=${code}`)).text();
  assert.match(page, /Hallo Lea &lt;3/);
  assert.match(page, /personal-radio:\/\/join\?code=[A-Z0-9-]{19}&amp;url=https%3A%2F%2Fradio\.example/);
  assert.equal((await get(`/join/apk?code=${code}`)).headers.get('Content-Type'), 'application/vnd.android.package-archive');
  assert.equal((await get('/join/apk?code=AAAA-AAAA-AAAA-AAAA')).status, 404);
  const redeem = (body: unknown, ip = '5.6.7.8') => joinRoutes(new Request('https://radio.example/join/redeem', { method: 'POST', body: JSON.stringify(body), headers: { 'Content-Type': 'application/json', 'CF-Connecting-IP': ip } }), e, new URL('https://radio.example/join/redeem'), issuer);
  const joined = await (await redeem({ code })).json() as { baseUrl: string; clientId: string; clientSecret: string };
  assert.deepEqual(joined, { baseUrl: 'https://radio.example', clientId: 'client-1.access', clientSecret: 'secret-1', name: 'Lea <3' });
  assert.equal((await redeem({ code })).status, 404, 'used');
  for (let n = 0; n < JOIN_ATTEMPTS_PER_HOUR; n++) await redeem({ code: 'BBBB-BBBB-BBBB-BBBB' }, '9.9.9.9');
  assert.equal((await redeem({ code: 'BBBB-BBBB-BBBB-BBBB' }, '9.9.9.9')).status, 429);
  assert.equal((await redeem({ code: 'short' })).status, 400);
});

test('the Cloudflare issuer creates a year-long token and treats a missing one as revoked', async () => {
  const calls: Array<{ url: string; method: string; body?: string }> = [];
  const fetcher = (async (url: string, init: RequestInit) => {
    calls.push({ url, method: init.method!, body: init.body as string | undefined });
    if (init.method === 'POST') return Response.json({ success: true, result: { id: 'tid', client_id: 'cid.access', client_secret: 'sec' } });
    return new Response('', { status: 404 });
  }) as typeof fetch;
  assert.equal(cloudflareIssuer({}), null);
  assert.equal(cloudflareIssuer({ CF_ACCOUNT_ID: 'not-an-id', CF_ACCESS_API_TOKEN: 't' }), null);
  const issuer = cloudflareIssuer({ CF_ACCOUNT_ID: 'a'.repeat(32), CF_ACCESS_API_TOKEN: 't' }, fetcher)!;
  assert.deepEqual(await issuer.create('Radio · Lea'), { id: 'tid', clientId: 'cid.access', clientSecret: 'sec' });
  await issuer.revoke('tid');
  assert.equal(calls[0].url, `https://api.cloudflare.com/client/v4/accounts/${'a'.repeat(32)}/access/service_tokens`);
  assert.deepEqual(JSON.parse(calls[0].body!), { name: 'Radio · Lea', duration: '8760h' });
  assert.equal(calls[1].method, 'DELETE');
});

test('the worker answers /join without an Access token, and everything else still needs one', async () => {
  const { default: worker } = await import('../server/worker.ts');
  const e = env();
  assert.equal((await worker.fetch(new Request('https://radio.example/join?code=AAAA-AAAA-AAAA-AAAA'), e)).status, 404);
  assert.equal((await worker.fetch(new Request('https://radio.example/api/invites'), e)).status, 401);
});
