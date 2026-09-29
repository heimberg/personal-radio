import { test } from 'node:test';
import assert from 'node:assert/strict';
import { exportJWK, generateKeyPair, SignJWT } from 'jose';
import worker from '../server/worker.ts';
import { planTimeline } from '../server/station.ts';
import { activeMood, applyMood, endOfDay } from '../src/domain/mood.ts';
import { ConfigError, defaultStationConfig, parseStationConfig } from '../src/domain/station.ts';
import type { StationConfig } from '../src/domain/station.ts';
import { sqliteD1 } from './d1-sqlite.ts';

const NOW = new Date('2026-09-29T10:15:30Z');
const base = (): StationConfig => ({
  ...defaultStationConfig({ timezone: 'Europe/Zurich' }), music: { between: 1, announce: true, taste: '' }, surprise: 25,
  schedule: [{ id: 'tag', days: [0, 1, 2, 3, 4, 5, 6], from: '00:00', to: '24:00', showIds: ['_block:schlagzeilen', '_block:entdeckung'] }],
});
const withMood = (id: NonNullable<StationConfig['mood']>['id'], until = '2026-09-29T22:00:00Z'): StationConfig => ({ ...base(), mood: { id, until } });

test('a mood leans the plan until midnight and leaves the saved day plan alone', () => {
  // Midnight in Zurich (UTC+2 in September) is 22:00 UTC.
  assert.equal(endOfDay(NOW, 'Europe/Zurich').toISOString(), '2026-09-29T22:00:00.000Z');
  assert.equal(activeMood(withMood('musik'), NOW), 'musik');
  assert.equal(activeMood(withMood('musik', '2026-09-29T10:00:00Z'), NOW), undefined);
  const plain = base();
  assert.equal(applyMood(plain, NOW), plain);

  const quiet = applyMood(withMood('ruhig'), NOW);
  assert.deepEqual(quiet.schedule[0].showIds, ['_block:entdeckung']);
  assert.equal(quiet.surprise, 0);
  assert.equal(quiet.music.between, 2);
  const knowledge = applyMood(withMood('wissen'), NOW);
  assert.deepEqual(knowledge.schedule[0].showIds, ['_block:schlagzeilen', '_block:entdeckung', '_block:hintergrund']);
  const music = applyMood(withMood('musik'), NOW);
  assert.equal(music.music.between, 2);
  assert.ok(music.schedule[0].showIds.includes('_block:musik'));
  assert.equal(applyMood(withMood('ueberraschung'), NOW).surprise, 80);
  assert.equal(applyMood(withMood('aktuell'), NOW).schedule[0].showIds.filter(id => id === '_block:schlagzeilen').length, 1);
  // The stored plan is untouched.
  const stored = withMood('ruhig');
  applyMood(stored, NOW);
  assert.deepEqual(stored.schedule[0].showIds, ['_block:schlagzeilen', '_block:entdeckung']);

  // The planner follows it: «Mehr Musik» puts two songs after a spoken item.
  const ids = (n => () => `p${++n}`)(0);
  const planned = planTimeline({ ...withMood('musik'), horizonMinutes: 20 }, [], null, NOW, ids);
  assert.deepEqual(planned.slice(1, 3).map(item => item.showId), ['_musik', '_musik']);
  assert.throws(() => parseStationConfig({ ...base(), mood: { id: 'laut', until: '2026-09-29T22:00:00Z' } }), ConfigError);
  assert.deepEqual(parseStationConfig(withMood('wissen')).mood, { id: 'wissen', until: '2026-09-29T22:00:00.000Z' });
});

test('mood API: set, shown with the timeline, kept when the settings are saved, cleared', async () => {
  const { privateKey, publicKey } = await generateKeyPair('RS256');
  const jwk = await exportJWK(publicKey); Object.assign(jwk, { kid: 'k1', alg: 'RS256', use: 'sig' });
  const team = 'mood-test.cloudflareaccess.com', aud = 'mood-aud', origin = 'https://private.example';
  const token = await new SignJWT({ email: 'owner@example.test', type: 'app' }).setProtectedHeader({ alg: 'RS256', kid: 'k1' })
    .setIssuer(`https://${team}`).setAudience(aud).setExpirationTime('2m').sign(privateKey);
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async input => {
    if (String(input).endsWith('/cdn-cgi/access/certs')) return Response.json({ keys: [jwk] });
    throw new Error(`Unexpected URL: ${String(input)}`);
  };
  const env = { DB: sqliteD1(), AUDIO: { get: async () => null, put: async () => {}, delete: async () => {} }, PRODUCTION: { send: async () => {} },
    ASSETS: { fetch: async () => new Response('app') }, ACCESS_TEAM_DOMAIN: team, ACCESS_AUD: aud, ALLOWED_EMAIL: 'owner@example.test' };
  const call = (path: string, init: RequestInit = {}) => worker.fetch(new Request(`${origin}${path}`, {
    ...init, headers: { 'Cf-Access-Jwt-Assertion': token, Origin: origin, ...(init.body ? { 'Content-Type': 'application/json' } : {}) },
  }), env as never);
  try {
    assert.equal((await call('/api/mood', { method: 'POST', body: JSON.stringify({ mood: 'musik' }) })).status, 409);
    assert.equal((await call('/api/station', { method: 'PUT', body: JSON.stringify(base()) })).status, 200);
    assert.equal((await call('/api/mood', { method: 'POST', body: JSON.stringify({ mood: 'laut' }) })).status, 400);
    const set = await (await call('/api/mood', { method: 'POST', body: JSON.stringify({ mood: 'musik' }) })).json() as { mood: { id: string; until: string } };
    assert.equal(set.mood.id, 'musik');
    assert.ok(Date.parse(set.mood.until) > Date.now());
    assert.deepEqual(((await (await call('/api/timeline?peek=1')).json()) as { mood?: unknown }).mood, set.mood);
    // Saving the settings (which never send a mood) keeps today's mood.
    assert.equal((await call('/api/station', { method: 'PUT', body: JSON.stringify({ ...base(), name: 'Neu' }) })).status, 200);
    assert.deepEqual(((await (await call('/api/station')).json()) as { config: StationConfig }).config.mood, set.mood);
    assert.deepEqual(await (await call('/api/mood', { method: 'POST', body: JSON.stringify({ mood: null }) })).json(), { mood: null });
    assert.equal(((await (await call('/api/timeline?peek=1')).json()) as { mood?: unknown }).mood, undefined);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
