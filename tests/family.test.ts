import { test } from 'node:test';
import assert from 'node:assert/strict';
import { exportJWK, generateKeyPair, SignJWT } from 'jose';
import worker from '../server/worker.ts';
import { StationStore } from '../server/station-store.ts';
import { FamilyStore, familyMembers, mayCopyInto } from '../server/family.ts';
import { parseListeners } from '../server/listeners.ts';
import { linkerSystem, linkerText } from '../server/linker.ts';
import { defaultStationConfig, parseStationConfig } from '../src/domain/station.ts';
import { sqliteD1 } from './d1-sqlite.ts';

const ORIGIN = 'https://private.example';
const NOW = new Date('2026-10-01T08:00:00Z');

function memoryBucket() {
  const objects = new Map<string, Uint8Array>();
  return {
    objects,
    put: async (key: string, value: Uint8Array) => { objects.set(key, value); },
    delete: async (key: string) => { objects.delete(key); },
    get: async (key: string) => {
      const value = objects.get(key);
      return value ? { body: new Blob([value as Uint8Array<ArrayBuffer>]).stream(), size: value.length, httpEtag: '"e"', httpMetadata: { contentType: 'audio/mpeg' } } : null;
    },
  };
}

test('family members: the owner (named as configured) and every listener by name', () => {
  const listeners = parseListeners('lea-app.access=lea:kids; tom-app.access=tom');
  const members = familyMembers('Owner@Example.test', listeners);
  assert.deepEqual(members.map(member => [member.key, member.name, member.kids]), [['owner', 'Papa', false], ['lea', 'Lea', true], ['tom', 'Tom', false]]);
  assert.equal(members[0].owner, 'owner@example.test');
  assert.equal(familyMembers('o@x.test', listeners, ' Mami ')[0].name, 'Mami');
  // A child's station only takes what the owner shares.
  assert.equal(mayCopyInto(members[0], members[1]), true);
  assert.equal(mayCopyInto(members[2], members[1]), false);
  assert.equal(mayCopyInto(members[1], members[2]), true);
});

test('greetings wait until a live transition reads them, then they are done', async () => {
  const family = new FamilyStore(sqliteD1());
  await family.addGreeting('owner@example.test', 'listener:lea', 'Schlaf gut!', NOW);
  await family.addGreeting('owner@example.test', 'listener:lea', 'Und träum was Schönes.', new Date(NOW.getTime() + 1000));
  const first = (await family.pendingGreeting('listener:lea', NOW))!;
  assert.equal(first.text, 'Schlaf gut!');
  await family.markAired(first.id, NOW);
  assert.equal((await family.pendingGreeting('listener:lea', NOW))?.text, 'Und träum was Schönes.');
  // Older than two days: no longer read.
  assert.equal(await family.pendingGreeting('listener:lea', new Date(NOW.getTime() + 3 * 86_400_000)), null);
  const config = parseStationConfig(defaultStationConfig());
  assert.match(linkerSystem(config, false, true), /Zuerst kommt ein Gruss.*höchstens 80 Wörter/);
  assert.doesNotMatch(linkerSystem(config, false), /Gruss/);
  const long = `${'Liebe Lea, '.repeat(40)}Gute Nacht. Und jetzt Musik.`;
  assert.equal(linkerText({ text: long }), null); // too long without sentences for the normal limit …
  assert.ok((linkerText({ text: `${'Ein Satz. '.repeat(50)}` }, 640) ?? '').length > 320); // … a greeting may be longer
});

test('family through the Worker: chat with unread count, sharing with audio, listening along, greetings, kids protected', async () => {
  const { privateKey, publicKey } = await generateKeyPair('RS256');
  const jwk = await exportJWK(publicKey); Object.assign(jwk, { kid: 'kf', alg: 'RS256', use: 'sig' });
  const team = 'family-test.cloudflareaccess.com', aud = 'family-aud';
  const sign = (name: string) => new SignJWT({ type: 'app', common_name: name }).setProtectedHeader({ alg: 'RS256', kid: 'kf' })
    .setIssuer(`https://${team}`).setAudience(aud).setExpirationTime('2m').sign(privateKey);
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async input => {
    if (String(input).endsWith('/cdn-cgi/access/certs')) return Response.json({ keys: [jwk] });
    throw new Error(`Unexpected URL: ${String(input)}`);
  };
  const audio = memoryBucket(), db = sqliteD1();
  const env = { DB: db, AUDIO: audio, PRODUCTION: { send: async () => {} }, ASSETS: { fetch: async () => new Response('app') },
    ACCESS_TEAM_DOMAIN: team, ACCESS_AUD: aud, ALLOWED_EMAIL: 'owner@example.test', ACCESS_SERVICE_TOKEN_ID: 'radio-app.access',
    LISTENERS: 'lea-app.access=lea:kids; tom-app.access=tom' };
  const tokens = { owner: await sign('radio-app.access'), lea: await sign('lea-app.access'), tom: await sign('tom-app.access') };
  const call = (who: keyof typeof tokens, path: string, body?: unknown) => worker.fetch(new Request(`${ORIGIN}${path}`, body === undefined
    ? { headers: { 'Cf-Access-Jwt-Assertion': tokens[who] } }
    : { method: 'POST', body: JSON.stringify(body), headers: { 'Cf-Access-Jwt-Assertion': tokens[who], Origin: ORIGIN, 'Content-Type': 'application/json' } }), env as never);
  const get = async (who: keyof typeof tokens) => (await (await call(who, '/api/family')).json()) as any;
  try {
    // A produced item of the owner's, with its audio.
    const store = new StationStore(db);
    for (const owner of ['owner@example.test', 'listener:lea', 'listener:tom']) await store.saveConfig(owner, parseStationConfig(defaultStationConfig()), NOW);
    await store.insertItem('owner@example.test', { id: 'item-1', seq: 1, showId: '_block:hintergrund', plannedAt: NOW.toISOString(), estimatedMinutes: 5 }, NOW);
    await store.update('owner@example.test', 'item-1', { state: 'played', audio_key: 'segments/item-1.mp3', content_type: 'audio/mpeg',
      script_json: JSON.stringify({ title: 'Kernfusion erklärt', text: 'Text.', sourceIds: ['s1'] }), sources_json: '[]' }, NOW);
    await audio.put('segments/item-1.mp3', new Uint8Array([7, 7, 7]));

    const family = await get('owner');
    assert.equal(family.me, 'owner');
    assert.deepEqual(family.members.map((member: any) => [member.key, member.name, member.me]), [['owner', 'Papa', true], ['lea', 'Lea', false], ['tom', 'Tom', false]]);
    assert.ok(!JSON.stringify(family).includes('owner@example.test')); // names only, never the email

    // Chat: Lea sees Papa's message as unread (also in her timeline, for the badge) until she reads it.
    assert.equal((await call('owner', '/api/family/messages', { text: '  Hallo   zusammen! ' })).status, 200);
    assert.equal((await call('owner', '/api/family/messages', { text: '   ' })).status, 400);
    let lea = await get('lea');
    assert.deepEqual(lea.messages.map((message: any) => [message.fromName, message.kind, message.text]), [['Papa', 'text', 'Hallo zusammen!']]);
    assert.equal(lea.unread, 1);
    assert.deepEqual(((await (await call('lea', '/api/timeline?peek=1')).json()) as any).family, { unread: 1, latest: { id: lea.messages[0].id, line: 'Papa: Hallo zusammen!' } });
    await call('lea', '/api/family/read', { lastId: lea.messages[0].id });
    assert.equal((await get('lea')).unread, 0);
    assert.equal((await get('owner')).unread, 0); // own messages are never unread

    // Sharing: a copy with its own audio lands in Lea's program, marked with who shared it.
    const shared = await call('owner', '/api/family/share', { itemId: 'item-1', to: 'lea' });
    assert.equal(shared.status, 200);
    const copyId = ((await shared.json()) as { itemId: string }).itemId;
    const leaItems = ((await (await call('lea', '/api/timeline?peek=1')).json()) as any).items;
    const copy = leaItems.find((item: any) => item.id === copyId);
    assert.equal(copy.state, 'ready'); assert.equal(copy.sharedBy, 'Papa'); assert.equal(copy.title, 'Kernfusion erklärt'); assert.equal(copy.showName, 'Hintergrund');
    assert.deepEqual([...audio.objects.get(`segments/${copyId}.mp3`)!], [7, 7, 7]);
    lea = await get('lea');
    assert.deepEqual(lea.messages.at(-1), { ...lea.messages.at(-1), kind: 'share', fromName: 'Papa', toName: 'Lea', text: 'Kernfusion erklärt' });
    assert.equal(((await (await call('lea', '/api/timeline?peek=1')).json()) as any).family.latest.line, 'Papa hat «Kernfusion erklärt» mit Lea geteilt');
    // Only the owner may put something into a child's station; unknown items cannot be shared.
    assert.equal((await call('tom', '/api/family/share', { itemId: 'item-1', to: 'lea' })).status, 403);
    assert.equal((await call('owner', '/api/family/share', { itemId: 'nope', to: 'tom' })).status, 409);
    assert.equal((await call('owner', '/api/family/share', { itemId: 'item-1', to: 'owner' })).status, 400);

    // Who hears what, and listening along.
    assert.equal((await call('owner', '/api/family/presence', { itemId: 'item-1' })).status, 200);
    const tom = await get('tom');
    assert.equal(tom.members.find((member: any) => member.key === 'owner').nowPlaying, 'Kernfusion erklärt');
    assert.equal((await call('tom', '/api/family/listen', { member: 'owner' })).status, 200);
    const tomItems = ((await (await call('tom', '/api/timeline?peek=1')).json()) as any).items;
    assert.equal(tomItems.filter((item: any) => item.sharedBy === 'Papa').length, 1);
    assert.equal((await call('lea', '/api/family/listen', { member: 'tom' })).status, 403); // a child takes nothing from others
    assert.equal((await call('tom', '/api/family/listen', { member: 'lea' })).status, 409); // Lea hears nothing right now

    // A greeting: in the chat right away, on air in Lea's next live transition.
    assert.equal((await call('owner', '/api/family/greet', { to: 'lea', text: 'Schlaf gut, Lea!' })).status, 200);
    assert.equal((await new FamilyStore(db).pendingGreeting('listener:lea', new Date()))?.text, 'Schlaf gut, Lea!');
    assert.equal((await get('lea')).messages.at(-1).kind, 'greeting');
    assert.equal((await call('owner', '/api/family/greet', { to: 'lea', text: '' })).status, 400);
    assert.equal((await worker.fetch(new Request(`${ORIGIN}/api/family/messages`, { method: 'POST', body: '{"text":"x"}',
      headers: { 'Cf-Access-Jwt-Assertion': tokens.owner, 'Content-Type': 'application/json' } }), env as never)).status, 403); // no Origin
  } finally { globalThis.fetch = originalFetch; }
});
