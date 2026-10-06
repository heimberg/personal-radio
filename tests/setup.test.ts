import { test } from 'node:test';
import assert from 'node:assert/strict';
import { exportJWK, generateKeyPair, SignJWT } from 'jose';
import worker from '../server/worker.ts';
import { AGENTS } from '../src/domain/agents.ts';
import { AGENT_PRESETS } from '../src/domain/agent-presets.ts';
import { FORMATS, MINUTES_LIMITS } from '../src/domain/station.ts';
import type { ShowFormat } from '../src/domain/station.ts';
import { sqliteD1 } from './d1-sqlite.ts';

const ORIGIN = 'https://private.example';

test('the app sets up a new station and reads the editorial agents', async () => {
  const { privateKey, publicKey } = await generateKeyPair('RS256');
  const jwk = await exportJWK(publicKey); Object.assign(jwk, { kid: 'k1', alg: 'RS256', use: 'sig' });
  const team = 'setup-test.cloudflareaccess.com', aud = 'setup-aud';
  const token = await new SignJWT({ email: 'owner@example.test', type: 'app' }).setProtectedHeader({ alg: 'RS256', kid: 'k1' })
    .setIssuer(`https://${team}`).setAudience(aud).setExpirationTime('2m').sign(privateKey);
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async input => {
    if (String(input).endsWith('/cdn-cgi/access/certs')) return Response.json({ keys: [jwk] });
    throw new Error(`Unexpected URL: ${String(input)}`);
  };
  const sent: unknown[] = [];
  const env = { DB: sqliteD1(), AUDIO: { put: async () => {}, get: async () => null, delete: async () => {} },
    PRODUCTION: { send: async (message: unknown) => { sent.push(message); } }, ASSETS: { fetch: async () => new Response('') },
    ACCESS_TEAM_DOMAIN: team, ACCESS_AUD: aud, ALLOWED_EMAIL: 'owner@example.test', MISTRAL_API_KEY: 'mistral', MISTRAL_VOICE_ID: 'voice' };
  const call = (path: string, init: RequestInit = {}) => worker.fetch(new Request(`${ORIGIN}${path}`, {
    ...init, headers: { 'Cf-Access-Jwt-Assertion': token, Origin: ORIGIN, ...(init.body ? { 'Content-Type': 'application/json' } : {}), ...init.headers as Record<string, string> },
  }), env as never);
  try {
    assert.equal((await call('/api/setup', { method: 'POST', body: '{}', headers: { Origin: 'https://evil.example' } })).status, 403);
    const created = await call('/api/setup', { method: 'POST', body: JSON.stringify({ timezone: 'America/New_York',
      interests: ['Raumfahrt', '  Natur  ', 'Raumfahrt', 42], voiceId: 'Kore', taste: 'Indie, Krautrock' }) });
    assert.equal(created.status, 201);
    const { config } = await created.json() as { config: { timezone: string; shows: Array<{ id: string }>; profile: { interests: string[] }; host: { voiceId?: string }; music: { taste: string } } };
    assert.equal(config.timezone, 'America/New_York');
    // The first-start flow's choices are in the new station.
    assert.deepEqual(config.profile.interests, ['Raumfahrt', 'Natur']);
    assert.equal(config.host.voiceId, 'Kore');
    assert.equal(config.music.taste, 'Indie, Krautrock');
    assert.ok(config.shows.some(show => show.id === 'entdecken'));
    assert.equal(((await (await call('/api/station')).json()) as { config: { timezone: string } }).config.timezone, 'America/New_York');
    // A second setup never overwrites the station.
    assert.equal((await call('/api/setup', { method: 'POST', body: '{}' })).status, 409);
    const agents = await (await call('/api/agents')).json() as { agents: Array<{ id: string; instructions: string }>; presets: Array<{ id: string }> };
    assert.deepEqual(agents.agents.map(agent => agent.id), AGENTS.map(agent => agent.id));
    assert.deepEqual(agents.presets.map(preset => preset.id), AGENT_PRESETS.map(preset => preset.id));
    // The app's show editor takes the formats and their lengths from the config check itself.
    const formats = await (await call('/api/formats')).json() as { formats: Array<{ id: ShowFormat; label: string; minMinutes: number; maxMinutes: number; defaultMinutes: number }> };
    assert.deepEqual(formats.formats.map(format => format.id), FORMATS);
    for (const format of formats.formats) {
      assert.deepEqual([format.minMinutes, format.maxMinutes], MINUTES_LIMITS[format.id]);
      assert.ok(format.label && format.minMinutes <= format.defaultMinutes && format.defaultMinutes <= format.maxMinutes, format.id);
    }
    // No web interface: the root says where to go, and after Spotify's login how it went.
    const root = await (await call('/')).text();
    assert.match(root, /in der App/);
    const back = await (await call('/?spotify=fehler&status=4<b>01')).text();
    assert.match(back, /nicht bestätigt.*\(Status 401\)/);
    assert.doesNotMatch(back, /<b>/);
    assert.doesNotMatch(await (await call('/?spotify=<script>')).text(), /<script>/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
