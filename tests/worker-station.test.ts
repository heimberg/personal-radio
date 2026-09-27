import { test } from 'node:test';
import assert from 'node:assert/strict';
import { exportJWK, generateKeyPair, SignJWT } from 'jose';
import worker from '../server/worker.ts';
import { defaultStationConfig } from '../src/domain/station.ts';
import { sqliteD1 } from './d1-sqlite.ts';

const ORIGIN = 'https://private.example';

function memoryBucket() {
  const objects = new Map<string, Uint8Array>();
  return {
    objects,
    put: async (key: string, value: Uint8Array) => { objects.set(key, value); },
    delete: async (key: string) => { objects.delete(key); },
    get: async (key: string, options?: { range?: Headers }) => {
      const value = objects.get(key);
      if (!value) return null;
      const match = options?.range?.get('Range')?.match(/^bytes=(\d+)-(\d+)$/);
      const offset = match ? Number(match[1]) : 0, length = match ? Number(match[2]) - offset + 1 : value.length;
      return { body: new Blob([value.slice(offset, offset + length)]).stream(), size: value.length, httpEtag: '"etag"',
        ...(match ? { range: { offset, length } } : {}) };
    },
  };
}

test('station API: configure, plan, produce via queue, stream audio with ranges and record feedback', async () => {
  const { privateKey, publicKey } = await generateKeyPair('RS256');
  const jwk = await exportJWK(publicKey); Object.assign(jwk, { kid: 'k1', alg: 'RS256', use: 'sig' });
  const team = 'station-test.cloudflareaccess.com', aud = 'station-aud';
  const token = await new SignJWT({ email: 'Owner@Example.test', type: 'app' }).setProtectedHeader({ alg: 'RS256', kid: 'k1' })
    .setIssuer(`https://${team}`).setAudience(aud).setExpirationTime('2m').sign(privateKey);
  let askCalls = 0;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async input => {
    const url = String(input);
    if (url.endsWith('/cdn-cgi/access/certs')) return Response.json({ keys: [jwk] });
    if (url === 'https://feeds.example.test/wissen.xml') {
      return new Response(`<rss><item><title>Raumfahrt heute</title><link>https://news.example.test/a</link><description>Die Sonde ist gelandet.</description><pubDate>${new Date().toUTCString()}</pubDate></item></rss>`,
        { headers: { 'Content-Type': 'application/rss+xml' } });
    }
    if (url.endsWith('/chat/completions')) {
      askCalls++;
      return Response.json({ choices: [{ message: { content: JSON.stringify(askCalls % 2 === 1
        ? { title: 'Gelandet', text: 'Die Sonde ist gelandet.', sourceIds: ['s1'], interestTags: ['Raumfahrt'] }
        : { approved: true, checks: [{ claim: 'Sonde gelandet', sourceIds: ['s1'], quote: 'Die Sonde ist gelandet.', supported: true }], reasons: [] }) } }] });
    }
    if (url.endsWith('/v1/audio/speech')) return Response.json({ audio_data: 'SUQz' });
    throw new Error(`Unexpected URL: ${url}`);
  };
  const sent: Array<{ owner: string; itemId: string }> = [];
  const audio = memoryBucket();
  const env = { DB: sqliteD1(), AUDIO: audio, PRODUCTION: { send: async (message: { owner: string; itemId: string }) => { sent.push(message); } },
    ASSETS: { fetch: async () => new Response('app') }, ACCESS_TEAM_DOMAIN: team, ACCESS_AUD: aud, ALLOWED_EMAIL: 'owner@example.test',
    ASK_BASE_URL: 'https://ask.example/api/v1', ASK_API_KEY: 'ask', ASK_MODEL: 'test', MISTRAL_API_KEY: 'mistral', MISTRAL_VOICE_ID: 'voice' };
  const call = (path: string, init: RequestInit = {}) => worker.fetch(new Request(`${ORIGIN}${path}`, {
    ...init, headers: { 'Cf-Access-Jwt-Assertion': token, Origin: ORIGIN, ...(init.body ? { 'Content-Type': 'application/json' } : {}), ...init.headers as Record<string, string> },
  }), env as never);
  try {
    assert.deepEqual(await (await call('/api/station')).json(), { config: null });
    const station = defaultStationConfig({ profile: { topics: [], interests: ['Raumfahrt'], interestWeights: {}, speechMinutes: 2, exploration: 0 },
      feeds: [{ name: 'Wissen', url: 'https://feeds.example.test/wissen.xml' }] });
    const invalid = await call('/api/station', { method: 'PUT', body: JSON.stringify({ ...station, horizonMinutes: 500 }) });
    assert.equal(invalid.status, 400); assert.match((await invalid.json()).detail, /horizonMinutes/);
    assert.equal((await call('/api/station', { method: 'PUT', body: JSON.stringify(station), headers: { Origin: 'https://evil.example' } })).status, 403);
    assert.equal((await call('/api/station', { method: 'PUT', body: JSON.stringify(station) })).status, 200);

    const plan = await (await call('/api/timeline/plan', { method: 'POST' })).json();
    assert.deepEqual(plan, { planned: 10, queued: 10, expired: 0 });
    assert.equal(sent.length, 10); assert.equal(sent[0].owner, 'owner@example.test');

    const acks: string[] = [];
    await worker.queue({ messages: [{ body: sent[0], ack: () => acks.push(sent[0].itemId) }, { body: { owner: 'intruder@example.test', itemId: sent[1].itemId }, ack: () => acks.push('foreign') }] }, env as never);
    assert.deepEqual(acks, [sent[0].itemId, 'foreign']);

    const { items } = await (await call('/api/timeline')).json() as { items: Array<{ id: string; state: string; title?: string; audioUrl?: string; sources?: unknown[] }> };
    assert.equal(items.length, 10);
    assert.equal(items[0].state, 'ready'); assert.equal(items[0].title, 'Gelandet');
    assert.deepEqual(items[0].sources, [{ title: 'Raumfahrt heute', url: 'https://news.example.test/a' }]);
    assert.equal(items[1].state, 'planned'); // the foreign message was ignored

    const full = await call(`/${items[0].audioUrl}`);
    assert.equal(full.status, 200); assert.equal(full.headers.get('Content-Type'), 'audio/mpeg');
    assert.equal(await full.text(), 'ID3');
    const partial = await call(`/${items[0].audioUrl}`, { headers: { Range: 'bytes=1-2' } });
    assert.equal(partial.status, 206); assert.equal(partial.headers.get('Content-Range'), 'bytes 1-2/3'); assert.equal(await partial.text(), 'D3');
    assert.equal((await call(`/api/timeline/${items[1].id}/audio`)).status, 404);

    assert.equal((await call(`/api/timeline/${items[0].id}/feedback`, { method: 'POST', body: JSON.stringify({ action: 'meh', listenedRatio: 1 }) })).status, 400);
    assert.equal((await call(`/api/timeline/${items[0].id}/feedback`, { method: 'POST', body: JSON.stringify({ action: 'complete', listenedRatio: 1 }) })).status, 200);
    const after = await (await call('/api/timeline')).json() as { items: Array<{ state: string }> };
    assert.equal(after.items[0].state, 'played');
    assert.equal(env.DB.raw.prepare('SELECT COUNT(*) AS n FROM feedback_events').get()?.n, 1);

    // Cron uses the configured owner, who just listened: 9 open items (18 min) get 1 more, and all 10 unproduced items are queued.
    const pending: Promise<unknown>[] = [];
    await worker.scheduled({}, env as never, { waitUntil: promise => { pending.push(promise); } });
    await Promise.all(pending);
    assert.equal(sent.length, 10 + 10);
  } finally { globalThis.fetch = originalFetch; }
});
