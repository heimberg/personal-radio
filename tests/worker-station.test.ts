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
    // No surprises: the worker plans with Math.random, and the test expects the feed brief.
    station.surprise = 0;
    // This environment only has ASK: the feed show writes with ASK, the web research show stays off.
    station.shows = station.shows.map(show => show.id === 'kurz' ? { ...show, textProvider: 'ask' } : show.id === 'entdecken' ? { ...show, enabled: false } : show);
    station.host = { ...station.host, voiceId: 'voice-test' };
    station.music = { ...station.music, between: 0 }; // Songs need Gemini and Spotify, which this environment lacks.
    station.surprise = 0; // Surprises are drawn at random; this run checks the plain rotation.
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
    assert.equal(((await (await call('/api/timeline')).json()) as { spotify?: unknown }).spotify, undefined);

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
    // The archive lists what can still be heard; listening again does not count twice, a rating does.
    const library = await (await call('/api/library')).json() as { items: Array<{ id: string; state: string; audioUrl?: string }>; retentionDays: number };
    assert.deepEqual(library.items.map(item => [item.id, item.state, item.audioUrl]), [[items[0].id, 'played', items[0].audioUrl]]);
    assert.equal(library.retentionDays, 7);
    assert.equal((await call(`/api/timeline/${items[0].id}/feedback`, { method: 'POST', body: JSON.stringify({ action: 'skip', listenedRatio: 0.1 }) })).status, 200);
    assert.equal(env.DB.raw.prepare('SELECT COUNT(*) AS n FROM feedback_events').get()?.n, 1);
    assert.equal(((await (await call('/api/timeline')).json()) as { items: Array<{ state: string }> }).items[0].state, 'played');
    assert.equal((await call(`/api/timeline/${items[0].id}/feedback`, { method: 'POST', body: JSON.stringify({ action: 'like', listenedRatio: 1 }) })).status, 200);
    assert.equal(env.DB.raw.prepare('SELECT COUNT(*) AS n FROM feedback_events').get()?.n, 2);
    env.DB.raw.prepare('DELETE FROM feedback_events WHERE action = ?').run('like');
    // A reason after 👎 steers the prompts from the second time on; insights show it with marks and usage.
    const reason = (body: unknown) => call(`/api/timeline/${items[0].id}/reason`, { method: 'POST', body: JSON.stringify(body) });
    assert.equal((await reason({ reason: 'too_long' })).status, 409);
    assert.equal((await call(`/api/timeline/${items[0].id}/feedback`, { method: 'POST', body: JSON.stringify({ action: 'dislike', listenedRatio: 1 }) })).status, 200);
    assert.equal((await reason({ reason: 'egal' })).status, 400);
    assert.equal((await reason({ reason: 'too_long' })).status, 200);
    let insights = await (await call('/api/insights')).json() as any;
    assert.deepEqual(insights.reasons, [{ reason: 'too_long', count: 1, label: 'Zu lang', active: false }]);
    assert.deepEqual(insights.notes, []);
    assert.ok(insights.usage.days[0].models.some((model: any) => model.provider === 'ask' && model.model === 'test' && model.calls >= 2));
    assert.equal(insights.usage.limits.generations, 24);
    assert.equal((await call('/api/insights/reasons', { method: 'DELETE' })).status, 200);
    insights = await (await call('/api/insights')).json() as any;
    assert.deepEqual(insights.reasons, []);
    env.DB.raw.prepare('DELETE FROM feedback_events WHERE action = ?').run('dislike');
    // Station sound: the timeline names the sounds; jingle and time signal are generated, the hour is spoken once and kept.
    const sounds = ((await (await call('/api/timeline')).json()) as { sounds: Record<string, string> }).sounds;
    // Without Gemini there are no live transitions: the timeline offers none, the route answers with silence.
    assert.deepEqual(sounds, { identUrl: 'api/sounds/ident.wav', identUrls: [0, 1, 2, 3].map(n => `api/sounds/ident/${n}.wav`), newsUrl: 'api/sounds/news.wav',
      signalUrl: 'api/sounds/pips.wav', hourUrl: 'api/sounds/hour/' });
    const ident = await call('/api/sounds/ident.wav');
    assert.equal(ident.headers.get('Content-Type'), 'audio/wav');
    assert.ok((await ident.arrayBuffer()).byteLength > 40_000);
    assert.equal((await call('/api/sounds/ident/3.wav')).status, 200);
    assert.equal((await call('/api/sounds/ident/4.wav')).status, 404);
    assert.equal((await call('/api/sounds/news.wav')).headers.get('Content-Type'), 'audio/wav');
    assert.equal((await call('/api/linker?next=no%20id')).status, 400);
    const quiet = await call(`/api/linker?after=${items[0].id}&next=${items[1].id}`);
    assert.equal(quiet.headers.get('Content-Type'), 'audio/wav');
    assert.equal((await quiet.arrayBuffer()).byteLength, 44 + 2 * Math.round(22_050 / 4));
    assert.equal((await call('/api/sounds/hour/24')).status, 404);
    const hour = await call('/api/sounds/hour/8');
    assert.equal(hour.status, 200);
    assert.ok([...audio.objects.keys()].some(key => /^sounds\/hour-[a-z0-9]+-8\.mp3$/.test(key)));
    assert.equal((await call('/api/sounds/hour/8')).status, 200);
    // Voice sample for the studio: spoken once per voice, style and names, then served from the bucket.
    assert.equal((await call('/api/voices/preview?voice=bad%20id')).status, 400);
    const sample = await call('/api/voices/preview?voice=voice-test&style=warm');
    assert.equal(sample.status, 200); assert.equal(sample.headers.get('Content-Type'), 'audio/mpeg');
    assert.ok([...audio.objects.keys()].some(key => /^sounds\/preview-[a-z0-9]+\.mp3$/.test(key)));
    // «Mehr dazu» queues a follow-up right after the item.
    const queued = sent.length;
    const deeper = await call(`/api/timeline/${items[0].id}/more`, { method: 'POST' });
    assert.equal(deeper.status, 200);
    assert.equal(sent.length, queued + 1);
    assert.equal(sent.at(-1)!.itemId, ((await deeper.json()) as { itemId: string }).itemId);
    (env.DB as any).raw.prepare(`DELETE FROM timeline_items WHERE show_id = '_block:vertiefung'`).run();
    sent.pop();
    // Changing an agent is logged for the quality trend.
    const stored = ((await (await call('/api/station')).json()) as { config: any }).config;
    assert.equal((await call('/api/station', { method: 'PUT', body: JSON.stringify({ ...stored, agents: { jury: { threshold: 4 } } }) })).status, 200);
    assert.deepEqual(((await (await call('/api/insights')).json()) as any).changes.map((change: any) => change.agents), [['Qualitäts-Jury']]);
    // In-app updates: nothing published yet, then the build CI stored.
    assert.equal((await call('/api/app/latest')).status, 404);
    await env.AUDIO.put('app/latest.json', new TextEncoder().encode('{"versionCode":110,"versionName":"0.2.110","sha256":"ab","size":3}'));
    await env.AUDIO.put('app/personal-radio.apk', new Uint8Array([80, 75, 3]));
    assert.deepEqual(await (await call('/api/app/latest')).json(), { versionCode: 110, versionName: '0.2.110', sha256: 'ab', size: 3 });
    const apk = await call('/api/app/apk');
    assert.equal(apk.headers.get('Content-Type'), 'application/vnd.android.package-archive');
    assert.deepEqual([...new Uint8Array(await apk.arrayBuffer())], [80, 75, 3]);
    // Reading along: the spoken text and the sources of an item.
    const transcript = await (await call(`/api/timeline/${items[0].id}/script`)).json() as { title: string; lines: Array<{ text: string }>; sources: unknown[] };
    assert.equal(transcript.title, 'Gelandet');
    assert.ok(transcript.lines.length >= 1 && transcript.lines.every(line => line.text.trim()));
    assert.deepEqual(transcript.sources, [{ title: 'Raumfahrt heute', url: 'https://news.example.test/a' }]);
    // Deleting from the archive removes the item and its audio; it can no longer be played.
    const kept = new Map(env.AUDIO.objects);
    assert.equal((await call(`/api/timeline/${items[0].id}/delete`, { method: 'POST' })).status, 200);
    assert.deepEqual(((await (await call('/api/library')).json()) as { items: unknown[] }).items, []);
    assert.equal((await call(`/${items[0].audioUrl}`)).status, 404);
    assert.ok(env.AUDIO.objects.size < kept.size);
    assert.equal((await call(`/api/timeline/${items[0].id}/delete`, { method: 'POST' })).status, 404);
    // Failures are summarised, not listed, and the cleanup route deletes them.
    (env.DB as any).raw.prepare(`UPDATE timeline_items SET state = 'failed', error = 'NO_SOURCES' WHERE id = ?`).run(items[1].id);
    const withFailure = await (await call('/api/timeline')).json() as { items: Array<{ id: string }>; failures: { count: number; latestError: string } };
    assert.equal(withFailure.failures.count, 1); assert.equal(withFailure.failures.latestError, 'NO_SOURCES');
    assert.ok(!withFailure.items.some(item => item.id === items[1].id));
    assert.deepEqual(await (await call('/api/timeline/cleanup', { method: 'POST' })).json(), { removed: 1 });
    assert.equal(((await (await call('/api/timeline')).json()) as { failures: { count: number } }).failures.count, 0);
    assert.equal(env.DB.raw.prepare('SELECT COUNT(*) AS n FROM feedback_events').get()?.n, 1);

    // Cron uses the configured owner, who just listened: 9 open items (18 min) get 1 more, and all 10 unproduced items are queued.
    const pending: Promise<unknown>[] = [];
    await worker.scheduled({}, env as never, { waitUntil: promise => { pending.push(promise); } });
    await Promise.all(pending);
    assert.equal(sent.length, 10 + 10);

    // An own show as a block: the app encodes the colon of "show:<id>" in the path.
    const own = await call('/api/blocks/show%3Akurz/add', { method: 'POST', body: JSON.stringify({ after: 'end' }) });
    assert.equal(own.status, 200);
    assert.ok(((await own.json()) as { itemId?: string }).itemId);
  } finally { globalThis.fetch = originalFetch; }
});

test('Gemini-only setup: web research, Gemini draft and Gemini verification without ASK', async () => {
  const { privateKey, publicKey } = await generateKeyPair('RS256');
  const jwk = await exportJWK(publicKey); Object.assign(jwk, { kid: 'k2', alg: 'RS256', use: 'sig' });
  const team = 'gemini-test.cloudflareaccess.com', aud = 'gemini-aud';
  const token = await new SignJWT({ email: 'owner@example.test', type: 'app' }).setProtectedHeader({ alg: 'RS256', kid: 'k2' })
    .setIssuer(`https://${team}`).setAudience(aud).setExpirationTime('2m').sign(privateKey);
  const calls: string[] = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    const url = String(input);
    if (url.endsWith('/cdn-cgi/access/certs')) return Response.json({ keys: [jwk] });
    if (url.includes('generativelanguage.googleapis.com/v1beta/voices')) {
      calls.push(`voices ${init?.method ?? 'GET'}`);
      if (init?.method === 'POST') return Response.json({ id: 'voice_designed1' });
      return Response.json({ voices: new URL(url).searchParams.get('type') === 'prompted' ? [{ id: 'voice_designed1', display_name: 'Studio-Mira' }] : [] });
    }
    if (url.includes('generativelanguage.googleapis.com')) {
      const body = JSON.parse(String(init?.body));
      const system = body.systemInstruction.parts[0].text as string;
      const reply = (text: string, groundingMetadata?: unknown) => Response.json({ candidates: [{ content: { parts: [{ text }] }, ...(groundingMetadata ? { groundingMetadata } : {}) }] });
      if (body.tools) {
        calls.push('research');
        return reply('Die Sonde startet 2027.', { webSearchQueries: ['sonde 2027'], groundingChunks: [{ web: { uri: 'https://example.org/sonde', title: 'example.org' } }],
          groundingSupports: [{ segment: { text: 'Die Sonde startet 2027.' }, groundingChunkIndices: [0] }] });
      }
      if (system.startsWith('Prüfe')) {
        calls.push('verify');
        return reply(JSON.stringify({ approved: true, checks: [{ claim: 'Start 2027', sourceIds: ['w1'], quote: 'Die Sonde startet 2027.', supported: true }], reasons: [] }));
      }
      if (system.startsWith('Du bist die Qualitätsjury')) {
        calls.push('jury');
        return reply(JSON.stringify({ hook: 4, clarity: 4, facts: 5, novelty: 4, length: 4, notes: 'gut' }));
      }
      calls.push(system.startsWith('Du bist Schlussredaktion') ? 'edit' : 'draft');
      return reply(JSON.stringify({ title: 'Start 2027', text: 'Die Sonde startet 2027.', sourceIds: ['w1'] }));
    }
    if (url.endsWith('/v1/audio/speech')) { calls.push('tts'); return Response.json({ audio_data: 'SUQz' }); }
    throw new Error(`Unexpected URL: ${url}`);
  };
  const sent: Array<{ owner: string; itemId: string }> = [];
  const env = { DB: sqliteD1(), AUDIO: memoryBucket(), PRODUCTION: { send: async (message: { owner: string; itemId: string }) => { sent.push(message); } },
    ASSETS: { fetch: async () => new Response('app') }, ACCESS_TEAM_DOMAIN: team, ACCESS_AUD: aud, ALLOWED_EMAIL: 'owner@example.test',
    ASK_BASE_URL: 'https://ask.example/api/v1', ASK_MODEL: 'ask-base', GEMINI_API_KEY: 'gemini', MISTRAL_API_KEY: 'mistral', MISTRAL_VOICE_ID: 'voice' };
  const call = (path: string, init: RequestInit = {}) => worker.fetch(new Request(`${ORIGIN}${path}`, {
    ...init, headers: { 'Cf-Access-Jwt-Assertion': token, Origin: ORIGIN, ...(init.body ? { 'Content-Type': 'application/json' } : {}) },
  }), env as never);
  try {
    // No surprises: the worker plans with Math.random, and the test expects the brief first.
    const station = { ...defaultStationConfig({ profile: { topics: [], interests: ['Raumfahrt'], interestWeights: {}, speechMinutes: 2, exploration: 0 }, voiceId: 'voice-test' }), surprise: 0 };
    assert.equal((await call('/api/station', { method: 'PUT', body: JSON.stringify(station) })).status, 200);
    await call('/api/timeline/plan', { method: 'POST' });
    await worker.queue({ messages: [{ body: sent[0], ack: () => {} }] }, env as never);
    // The final edit and the jury run between the draft and the evidence check.
    assert.deepEqual(calls, ['research', 'draft', 'edit', 'jury', 'verify', 'tts']);
    const { items } = await (await call('/api/timeline')).json() as { items: Array<{ state: string; title?: string; searchQueries?: string[]; sources?: unknown[] }> };
    assert.equal(items[0].state, 'ready'); assert.equal(items[0].title, 'Start 2027');
    assert.deepEqual(items[0].searchQueries, ['sonde 2027']);
    assert.deepEqual(items[0].sources, [{ title: 'example.org', url: 'https://example.org/sonde' }]);
    // Live transition: written and voiced on request, kept in the bucket, served from there the second time.
    const { items: open, sounds } = await (await call('/api/timeline')).json() as { items: Array<{ id: string }>; sounds: { linkerUrl?: string } };
    assert.equal(sounds.linkerUrl, 'api/linker');
    calls.length = 0;
    const link = await call(`/${sounds.linkerUrl}?after=${open[0].id}&next=${open[1].id}`);
    assert.equal(link.headers.get('Content-Type'), 'audio/mpeg');
    assert.deepEqual(calls, ['draft', 'tts']);
    assert.ok([...env.AUDIO.objects.keys()].some(key => key.startsWith(`linkers/${new Date().toISOString().slice(0, 10)}/${open[0].id}-${open[1].id}-`)));
    assert.equal((await call(`/${sounds.linkerUrl}?after=${open[0].id}&next=${open[1].id}`)).headers.get('Content-Type'), 'audio/mpeg');
    assert.deepEqual(calls, ['draft', 'tts']);
    // Voices: own voices first, then the prebuilt ones; a designed voice comes back with its station ID.
    const { voices } = await (await call('/api/voices')).json() as { voices: Array<{ id: string; group: string }> };
    assert.deepEqual(voices[0], { id: 'gemini_voice_designed1', name: 'Studio-Mira', group: 'own' });
    assert.ok(voices.some(voice => voice.id === 'gemini_Kore' && voice.group === 'standard'));
    const designed = await call('/api/voices/design', { method: 'POST', body: JSON.stringify({ name: 'Mira', description: 'warme, ruhige Moderatorin' }) });
    assert.deepEqual(await designed.json(), { voice: { id: 'gemini_voice_designed1', name: 'Mira', group: 'own' } });
    assert.equal((await call('/api/voices/design', { method: 'POST', body: JSON.stringify({ name: 'Mira', description: 'kurz' }) })).status, 400);
    assert.equal((await call('/api/voices/clone', { method: 'POST', body: JSON.stringify({ name: 'Ich' }) })).status, 400);
    assert.equal((await call('/api/voices/gemini_voice_designed1', { method: 'DELETE' })).status, 200);
  } finally { globalThis.fetch = originalFetch; }
});

test('the Android app authenticates with an Access service token and acts as the owner', async () => {
  const { privateKey, publicKey } = await generateKeyPair('RS256');
  const jwk = await exportJWK(publicKey); Object.assign(jwk, { kid: 'k3', alg: 'RS256', use: 'sig' });
  const team = 'service-test.cloudflareaccess.com', aud = 'service-aud';
  const sign = (claims: Record<string, unknown>) => new SignJWT(claims).setProtectedHeader({ alg: 'RS256', kid: 'k3' })
    .setIssuer(`https://${team}`).setAudience(aud).setExpirationTime('2m').sign(privateKey);
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async input => {
    if (String(input).endsWith('/cdn-cgi/access/certs')) return Response.json({ keys: [jwk] });
    throw new Error(`Unexpected URL: ${String(input)}`);
  };
  const env = { DB: sqliteD1(), AUDIO: memoryBucket(), PRODUCTION: { send: async () => {} }, ASSETS: { fetch: async () => new Response('app') },
    ACCESS_TEAM_DOMAIN: team, ACCESS_AUD: aud, ALLOWED_EMAIL: 'Owner@Example.test', ACCESS_SERVICE_TOKEN_ID: 'radio-app.access' };
  const station = (token: string, extra: Record<string, string> = {}) => worker.fetch(new Request(`${ORIGIN}/api/station`, {
    headers: { 'Cf-Access-Jwt-Assertion': token, ...extra } }), env as never);
  try {
    const app = await sign({ type: 'app', common_name: 'radio-app.access' });
    assert.equal((await station(app)).status, 200);
    await (env.DB as any).raw.prepare(`INSERT INTO station_config (owner_id, config_json, updated_at) VALUES ('owner@example.test', ?, '2026-09-27')`)
      .run(JSON.stringify(defaultStationConfig()));
    assert.equal(((await (await station(app)).json()) as { config: { name: string } | null }).config?.name, 'Personal Radio'); // same owner as the browser login
    // A further listener has their own token and their own station.
    const listenerEnv = { ...env, LISTENERS: 'lea-app.access=lea:kids; bad entry' };
    const lea = await sign({ type: 'app', common_name: 'lea-app.access' });
    const leaStation = await worker.fetch(new Request(`${ORIGIN}/api/station`, { headers: { 'Cf-Access-Jwt-Assertion': lea } }), listenerEnv as never);
    assert.equal(leaStation.status, 200);
    assert.deepEqual(await leaStation.json(), { config: null });
    const leaSaved = await worker.fetch(new Request(`${ORIGIN}/api/station`, { method: 'PUT', body: JSON.stringify({ ...defaultStationConfig(), name: 'Radio Lea' }),
      headers: { 'Cf-Access-Jwt-Assertion': lea, Origin: ORIGIN, 'Content-Type': 'application/json' } }), listenerEnv as never);
    assert.equal(leaSaved.status, 200);
    assert.equal((env.DB as any).raw.prepare(`SELECT COUNT(*) AS n FROM station_config WHERE owner_id = 'listener:lea'`).get().n, 1);
    // The owner still sees their own station; Lea's stored settings stay as she wrote them (the rules only apply in production).
    assert.equal(((await (await worker.fetch(new Request(`${ORIGIN}/api/station`, { headers: { 'Cf-Access-Jwt-Assertion': app } }), listenerEnv as never)).json()) as { config: { name: string } }).config.name, 'Personal Radio');
    assert.ok(!JSON.stringify(JSON.parse((env.DB as any).raw.prepare(`SELECT config_json FROM station_config WHERE owner_id = 'listener:lea'`).get().config_json)).includes('11 Jahren'));
    const foreign = await station(await sign({ type: 'app', common_name: 'other.access' }));
    assert.equal(foreign.status, 401);
    assert.deepEqual(await foreign.json(), { error: 'unauthorized', reason: 'service_token_not_allowed' });
    assert.equal((await station(await sign({ type: 'org', common_name: 'radio-app.access' }))).status, 401);
    const withoutConfiguredToken = { ...env, ACCESS_SERVICE_TOKEN_ID: undefined };
    const unconfigured = await worker.fetch(new Request(`${ORIGIN}/api/station`, { headers: { 'Cf-Access-Jwt-Assertion': app } }), withoutConfiguredToken as never);
    assert.equal(unconfigured.status, 401);
    assert.equal(((await unconfigured.json()) as { reason: string }).reason, 'service_token_not_configured');

    // The app's background check only peeks: it does not count as listening, so the cron does not plan paid content.
    const timeline = (query: string) => worker.fetch(new Request(`${ORIGIN}/api/timeline${query}`, { headers: { 'Cf-Access-Jwt-Assertion': app } }), env as never);
    const seen = () => (env.DB as any).raw.prepare('SELECT COUNT(*) AS n FROM station_activity').get().n;
    assert.equal((await timeline('?peek=1')).status, 200);
    assert.equal(seen(), 0);
    await timeline('');
    assert.equal(seen(), 1);

    // Spotify listening profile: the state is kept on the server (the login may finish in the system browser);
    // an unknown or reused state is refused, a refusal at Spotify is named.
    const spotifyEnv = { ...env, SPOTIFY_CLIENT_ID: 'sid', SPOTIFY_CLIENT_SECRET: 'ssecret' };
    const spotify = (path: string, init: RequestInit = {}) => worker.fetch(new Request(`${ORIGIN}${path}`, { ...init, headers: { 'Cf-Access-Jwt-Assertion': app, ...(init.headers ?? {}) } }), spotifyEnv as never);
    const connect = await spotify('/api/spotify/connect');
    assert.equal(connect.status, 302);
    const location = new URL(connect.headers.get('Location')!);
    assert.equal(location.origin, 'https://accounts.spotify.com');
    assert.equal(location.searchParams.get('redirect_uri'), `${ORIGIN}/api/spotify/callback`);
    const state = location.searchParams.get('state')!;
    assert.equal(connect.headers.get('Set-Cookie'), null);
    const forged = await spotify('/api/spotify/callback?code=c&state=erfunden');
    assert.equal(forged.headers.get('Location'), `${ORIGIN}/?spotify=abgelaufen`);
    const denied = await spotify(`/api/spotify/callback?error=access_denied&state=${state}`);
    assert.equal(denied.headers.get('Location'), `${ORIGIN}/?spotify=verweigert`);
    // The state is single-use: after the refusal it no longer connects.
    assert.equal((await spotify(`/api/spotify/callback?code=c&state=${state}`)).headers.get('Location'), `${ORIGIN}/?spotify=abgelaufen`);
    // A fresh login that Spotify's token endpoint rejects names the status; one that succeeds connects.
    const second = new URL((await spotify('/api/spotify/connect')).headers.get('Location')!).searchParams.get('state')!;
    const third = new URL((await spotify('/api/spotify/connect')).headers.get('Location')!).searchParams.get('state')!;
    assert.equal((await spotify(`/api/spotify/callback?code=c&state=${second}`)).headers.get('Location'), `${ORIGIN}/?spotify=abgelaufen`); // replaced by the newer one
    const beforeFetch = globalThis.fetch;
    globalThis.fetch = async (input, init) => String(input) === 'https://accounts.spotify.com/api/token' ? new Response('{}', { status: 400 }) : beforeFetch(input, init);
    assert.equal((await spotify(`/api/spotify/callback?code=c&state=${third}`)).headers.get('Location'), `${ORIGIN}/?spotify=fehler&status=400`);
    const fourth = new URL((await spotify('/api/spotify/connect')).headers.get('Location')!).searchParams.get('state')!;
    globalThis.fetch = async (input, init) => String(input) === 'https://accounts.spotify.com/api/token' ? Response.json({ access_token: 'a', refresh_token: 'r' }) : beforeFetch(input, init);
    assert.equal((await spotify(`/api/spotify/callback?code=c&state=${fourth}`)).headers.get('Location'), `${ORIGIN}/?spotify=verbunden`);
    globalThis.fetch = beforeFetch;
    assert.equal(((await (await spotify('/api/spotify/profile')).json()) as { connected: boolean }).connected, true);
    (env.DB as any).raw.prepare('DELETE FROM spotify_listening').run();
    assert.deepEqual(await (await spotify('/api/spotify/profile')).json(), { connected: false, artists: [] });
    assert.equal((await spotify('/api/spotify/disconnect', { method: 'POST' })).status, 403); // no Origin
    assert.equal((await station(app, {})).status, 200);
    assert.equal((await worker.fetch(new Request(`${ORIGIN}/api/spotify/profile`, { headers: { 'Cf-Access-Jwt-Assertion': app } }), env as never)).status, 404);
  } finally { globalThis.fetch = originalFetch; }
});

test('artist hour through the Worker: produce now, queue, parts in the timeline and audio per spoken part', async () => {
  const { privateKey, publicKey } = await generateKeyPair('RS256');
  const jwk = await exportJWK(publicKey); Object.assign(jwk, { kid: 'k4', alg: 'RS256', use: 'sig' });
  const team = 'hour-test.cloudflareaccess.com', aud = 'hour-aud';
  const token = await new SignJWT({ email: 'owner@example.test', type: 'app' }).setProtectedHeader({ alg: 'RS256', kid: 'k4' })
    .setIssuer(`https://${team}`).setAudience(aud).setExpirationTime('2m').sign(privateKey);
  const originalFetch = globalThis.fetch;
  const spotifySeen: string[] = [];
  let researchCalls = 0;
  let moderationPrompt = '';
  globalThis.fetch = async (input, init) => {
    const url = String(input);
    if (url.endsWith('/cdn-cgi/access/certs')) return Response.json({ keys: [jwk] });
    const reply = (value: unknown, groundingMetadata?: unknown) => Response.json({ candidates: [{ content: { parts: [{ text: typeof value === 'string' ? value : JSON.stringify(value) }] }, ...(groundingMetadata ? { groundingMetadata } : {}) }] });
    if (url.includes('generativelanguage.googleapis.com')) {
      const body = JSON.parse(String(init?.body));
      const system = body.systemInstruction.parts[0].text as string;
      if (body.tools) { researchCalls++; return reply('Dummy erschien 1994.', { webSearchQueries: ['portishead'], groundingChunks: [{ web: { uri: 'https://example.org/p', title: 'example.org' } }],
        groundingSupports: [{ segment: { text: 'Dummy erschien 1994.' }, groundingChunkIndices: [0] }] }); }
      if (system.includes('Regisseur dieser deutschsprachigen Musikstunde')) { moderationPrompt = system; return reply({ title: 'Portishead', intro: { text: 'Willkommen.', sourceIds: ['w1'] },
        tracks: [0, 1, 2].map(index => ({ index, text: `Song ${index}.`, sourceIds: ['w1'] })), outro: { text: 'Danke.', sourceIds: [] } }); }
      if (system.startsWith('Du stellst die Songliste')) return reply({ tracks: ['Glory Box', 'Roads', 'Sour Times'].map(title => ({ title, artist: 'Portishead', reason: 'r' })) });
      throw new Error(`Unexpected Gemini call: ${system.slice(0, 40)}`);
    }
    if (url === 'https://accounts.spotify.com/api/token') return Response.json({ access_token: 'app', expires_in: 3600 });
    if (url.startsWith('https://api.spotify.com/v1/search')) {
      const q = new URL(url).searchParams.get('q')!; spotifySeen.push(q);
      const title = /^track:(.+) artist:/.exec(q)![1];
      return Response.json({ tracks: { items: [{ uri: `spotify:track:${title.replace(/\W/g, '')}`, name: title, duration_ms: 200000, artists: [{ name: 'Portishead' }] }] } });
    }
    if (url.endsWith('/v1/audio/speech')) return Response.json({ audio_data: 'SUQz' });
    throw new Error(`Unexpected URL: ${url}`);
  };
  const sent: Array<{ owner: string; itemId: string }> = [];
  const env = { DB: sqliteD1(), AUDIO: memoryBucket(), PRODUCTION: { send: async (message: { owner: string; itemId: string }) => { sent.push(message); } },
    ASSETS: { fetch: async () => new Response('app') }, ACCESS_TEAM_DOMAIN: team, ACCESS_AUD: aud, ALLOWED_EMAIL: 'owner@example.test',
    GEMINI_API_KEY: 'gemini', MISTRAL_API_KEY: 'mistral', SPOTIFY_CLIENT_ID: 'id', SPOTIFY_CLIENT_SECRET: 'secret' };
  const call = (path: string, init: RequestInit = {}) => worker.fetch(new Request(`${ORIGIN}${path}`, {
    ...init, headers: { 'Cf-Access-Jwt-Assertion': token, Origin: ORIGIN, ...(init.body ? { 'Content-Type': 'application/json' } : {}) },
  }), env as never);
  try {
    const station = { ...defaultStationConfig({ voiceId: 'voice-test' }), surprise: 0 };
    station.shows = station.shows.map(show => show.id === 'kuenstler' ? { ...show, artist: 'Bristol Trip-Hop', tracks: 3 } : show);
    assert.equal((await call('/api/station', { method: 'PUT', body: JSON.stringify(station) })).status, 200);
    assert.equal((await call('/api/shows/gibt-es-nicht/produce', { method: 'POST' })).status, 404);
    assert.equal((await call('/api/shows/kuenstler/produce', { method: 'POST', body: JSON.stringify({ subject: 'x'.repeat(201) }) })).status, 400);
    const { itemId } = await (await call('/api/shows/kuenstler/produce', { method: 'POST', body: JSON.stringify({ subject: 'Portishead' }) })).json() as { itemId: string };
    assert.deepEqual(sent.map(message => message.itemId), [itemId]);
    await worker.queue({ messages: [{ body: sent[0], ack: () => {} }] }, env as never);
    const { items, spotify } = await (await call('/api/timeline')).json() as { spotify?: { clientId: string }; items: Array<{ id: string; state: string; artist?: string; parts?: Array<{ kind: string; audioUrl?: string; spotifyUri?: string }> }> };
    assert.deepEqual(spotify, { clientId: 'id' });
    const hour = items.find(item => item.id === itemId)!;
    assert.equal(hour.state, 'ready', JSON.stringify(hour)); assert.equal(hour.artist, 'Portishead');
    assert.equal(researchCalls, 2, 'first the broad dossier, then research of confirmed individual tracks');
    assert.match(moderationPrompt, /genau einen eigenen Moderationsbeitrag/);
    assert.equal(spotifySeen.length, 3);
    assert.deepEqual(hour.parts!.map(part => part.kind), ['speech', 'speech', 'track', 'speech', 'track', 'speech', 'track', 'speech']);
    assert.equal(hour.parts![2].spotifyUri, 'spotify:track:GloryBox');
    const audio = await call(`/${hour.parts![0].audioUrl}`);
    assert.equal(audio.status, 200); assert.equal(await audio.text(), 'ID3');
    assert.equal((await call(`/api/timeline/${itemId}/audio?part=2`)).status, 404); // a track has no audio of ours
  } finally { globalThis.fetch = originalFetch; }
});
