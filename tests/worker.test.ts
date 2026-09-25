import { test } from 'node:test';
import assert from 'node:assert/strict';
import { exportJWK, generateKeyPair, SignJWT } from 'jose';
import worker from '../server/worker.ts';

test('private worker authenticates Access JWT, verifies evidence, enforces D1 daily limits and returns audio', async () => {
  const { privateKey, publicKey } = await generateKeyPair('RS256');
  const jwk = await exportJWK(publicKey); Object.assign(jwk, { kid: 'worker-test-key', alg: 'RS256', use: 'sig' });
  const team = 'personal-radio-test.cloudflareaccess.com', aud = 'test-audience';
  const token = await new SignJWT({ email: 'owner@example.test', type: 'app' }).setProtectedHeader({ alg: 'RS256', kid: 'worker-test-key' })
    .setIssuer(`https://${team}`).setAudience(aud).setExpirationTime('2m').sign(privateKey);
  const originalFetch = globalThis.fetch; let askCalls = 0, ttsCalls = 0, requestsUsed = 0, charactersUsed = 0;
  globalThis.fetch = async input => {
    const url = String(input);
    if (url.endsWith('/cdn-cgi/access/certs')) return Response.json({ keys: [jwk] });
    if (url.endsWith('/chat/completions')) {
      askCalls++;
      return Response.json({ choices: [{ message: { content: JSON.stringify(askCalls === 1
        ? { title: 'Faktencheck', text: 'Ein Test.', sourceIds: ['s1'] }
        : { approved: true, checks: [{ claim: 'Ein Test', sourceIds: ['s1'], quote: 'Ein Test.', supported: true }], reasons: [] }) } }] });
    }
    if (url.endsWith('/v1/audio/speech')) { ttsCalls++; return Response.json({ audio_data: 'SUQz' }); }
    throw new Error(`Unexpected URL: ${url}`);
  };
  const db = { prepare: (sql: string) => {
    let values: unknown[] = [];
    const statement = { bind: (...args: unknown[]) => { values = args; return statement; }, first: async () => {
      if (sql.includes('daily_requests')) {
        const limit = Number(values[2]); if (requestsUsed >= limit) return null; requestsUsed++; return { requests: requestsUsed };
      }
      if (sql.includes('daily_usage')) {
        const amount = Number(values[2]), limit = Number(values[3]); if (charactersUsed + amount > limit) return null;
        charactersUsed += amount; return { characters: charactersUsed };
      }
      throw new Error('Unexpected SQL');
    } };
    return statement;
  } };
  const env = { DB: db, ASSETS: { fetch: async () => new Response('app') }, ACCESS_TEAM_DOMAIN: team, ACCESS_AUD: aud,
    ALLOWED_EMAIL: 'owner@example.test', DAILY_GENERATIONS: '1', DAILY_TTS_CHARACTERS: '12000',
    ASK_BASE_URL: 'https://ask.example/api/v1', ASK_API_KEY: 'ask-secret', ASK_MODEL: 'test', MISTRAL_API_KEY: 'mistral-secret', MISTRAL_VOICE_ID: 'voice' };
  try {
    const makeRequest = (key: string) => new Request('https://private.example/api/segments', { method: 'POST',
      headers: { Origin: 'https://private.example', 'Content-Type': 'application/json', 'Cf-Access-Jwt-Assertion': token, 'Idempotency-Key': key },
      body: JSON.stringify({ profile: { topics: ['Wissenschaft'], speechMinutes: 2, exploration: 10 }, sources: [
        { id: 's1', url: 'https://example.test/source', title: 'Testquelle', publishedAt: '2026-09-25', retrievedAt: '2026-09-25', excerpt: 'Ein Test.' },
      ] }) });
    const foreign = makeRequest('request-key-foreign');
    const foreignHeaders = new Headers(foreign.headers); foreignHeaders.set('Origin', 'https://attacker.example');
    assert.equal((await worker.fetch(new Request(foreign, { headers: foreignHeaders }), env as never)).status, 403);
    assert.equal(requestsUsed, 0); assert.equal(askCalls, 0);
    const response = await worker.fetch(makeRequest('request-key-0001'), env as never);
    assert.equal(response.status, 200); assert.equal(response.headers.get('Content-Type'), 'audio/mpeg');
    assert.equal(new TextDecoder().decode(await response.arrayBuffer()), 'ID3');
    assert.equal(askCalls, 2); assert.equal(ttsCalls, 1); assert.equal(requestsUsed, 1); assert.equal(charactersUsed, 9);
    const limited = await worker.fetch(makeRequest('request-key-0002'), env as never);
    assert.equal(limited.status, 429); assert.equal(askCalls, 2);
  } finally { globalThis.fetch = originalFetch; }
});

test('private worker rejects missing Access identity before database access', async () => {
  let dbCalls = 0;
  const env = { DB: { prepare: () => { dbCalls++; throw new Error('must not access database'); } }, ASSETS: { fetch: async () => new Response('app') },
    ACCESS_TEAM_DOMAIN: 'team.cloudflareaccess.com', ACCESS_AUD: 'aud', ALLOWED_EMAIL: 'owner@example.test' };
  const base = { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: 'https://private.example' }, body: '{}' };
  assert.equal((await worker.fetch(new Request('https://private.example/api/segments', base), env as never)).status, 401);
  assert.equal(dbCalls, 0);
  assert.equal((await worker.fetch(new Request('https://private.example/'), env as never)).status, 401);
});
