import { test } from 'node:test';
import assert from 'node:assert/strict';
import { exportJWK, generateKeyPair, SignJWT } from 'jose';
import worker from '../server/worker.ts';
import { defaultStationConfig, parseStationConfig } from '../src/domain/station.ts';
import type { Profile } from '../src/domain/program.ts';
import { BLOCKS, blockShow, blockViews, allBlockViews } from '../src/domain/blocks.ts';
import { featureOn, parseFeatures, parseHiddenBlocks } from '../src/domain/features.ts';
import { StationStore } from '../server/station-store.ts';
import { addPlaceStory, tick, PLACES_PER_DAY } from '../server/station.ts';
import type { StationDeps } from '../server/station.ts';
import { reverseGeocode } from '../server/places.ts';
import { sqliteD1 } from './d1-sqlite.ts';

const OWNER = 'owner@example.test';
const FRIDAY = new Date('2026-10-02T15:00:00Z');
const profile: Profile = { topics: ['Wissenschaft'], interests: ['Raumfahrt'], interestWeights: {}, speechMinutes: 2, exploration: 0 };
const config = (extra: Record<string, unknown> = {}) => parseStationConfig({ ...defaultStationConfig({ profile, feeds: [] }), timezone: 'Europe/Zurich', surprise: 0,
  schedule: [{ id: 'nie', days: [0], from: '03:00', to: '03:30', showIds: ['entdecken'] }], ...extra });
const block = (id: string) => BLOCKS.find(item => item.id === id)!;

test('Streitgespräch and Weltpresse research their topic, or pick one themselves', () => {
  const base = config();
  const debate = blockShow(block('streitgespraech'), base, 'Tempo 30');
  assert.equal(debate.format, 'podcast');
  assert.match(debate.researchPrompt, /dafür und dagegen zu: «Tempo 30»/);
  assert.match(debate.instructions, /erste Stimme vertritt Pro, die zweite Contra.*ohne Partei zu ergreifen/);
  assert.match(blockShow(block('streitgespraech'), base).researchPrompt, /umstrittenes Thema in der Schweiz/);
  const press = blockShow(block('weltpresse'), base, 'die Wahlen in den USA');
  assert.match(press.researchPrompt, /verschiedenen Ländern.*über «die Wahlen in den USA»/);
  assert.match(blockShow(block('weltpresse'), base).researchPrompt, /wichtigste internationale Thema dieser Woche/);
  assert.match(blockShow(block('ortsgeschichte'), base, 'Melchnau, Bern').researchPrompt, /zu «Melchnau, Bern»/);
  // Ortsgeschichten come from the app, not from the palette.
  assert.ok(!blockViews(base).some(item => item.id === 'ortsgeschichte'));
  assert.ok(blockViews(base).some(item => item.id === 'weltpresse'));
});

test('features: defaults, settings kept in the station, hidden blocks left out of the palette only', () => {
  const plain = config();
  assert.deepEqual(['review', 'concerts', 'follow', 'quiz', 'places', 'linker'].map(id => featureOn(plain, id as never)), [true, true, true, true, false, true]);
  const set = config({ features: { review: false, places: true, nonsense: true, quiz: 'ja' }, hiddenBlocks: ['wetter', 'kuenstler', '../x', 'wetter'], sounds: { ident: true, hourChange: true, linker: false } });
  assert.deepEqual(set.features, { review: false, places: true });
  assert.deepEqual(set.hiddenBlocks, ['wetter', 'kuenstler']);
  assert.equal(featureOn(set, 'review'), false); assert.equal(featureOn(set, 'places'), true); assert.equal(featureOn(set, 'linker'), false);
  assert.ok(!blockViews(set).some(item => item.id === 'wetter'));
  assert.ok(allBlockViews(set).some(item => item.id === 'wetter'));
  assert.equal(parseFeatures({ linker: true }), undefined); // live transitions live in `sounds`
  assert.equal(parseHiddenBlocks([]), undefined);
});

function deps(store: StationStore, now: Date): StationDeps {
  let ids = 0;
  return {
    store, podcastAvailable: true, now: () => now, random: () => 0.99, newId: () => `id-${++ids}`,
    fetchFeed: async () => [], reserveFeed: async () => {}, reserveGeneration: async () => {},
    audio: { put: async () => {}, delete: async () => {} },
    listening: { topArtists: async () => ['Portishead'] },
    pipeline: { draft: async () => { throw new Error('unused'); }, review: async () => ({ approved: true, reasons: [] }), voice: async () => { throw new Error('unused'); } },
  };
}

test('a switched-off feature stays quiet: no concerts on Friday', async () => {
  const store = new StationStore(sqliteD1());
  await store.saveConfig(OWNER, config({ features: { concerts: false } }), FRIDAY);
  await tick(deps(store, FRIDAY), OWNER);
  assert.equal((await store.recentItems(OWNER, 20)).filter(row => row.show_id === '_block:konzerte').length, 0);
});

test('Ortsgeschichten: only when switched on, each place once a month, one waiting at a time, a few a day', async () => {
  const store = new StationStore(sqliteD1());
  await store.saveConfig(OWNER, config(), FRIDAY);
  const d = deps(store, FRIDAY);
  assert.deepEqual(await addPlaceStory(d, OWNER, 'Melchnau, Bern'), { skipped: 'off' });
  await store.saveConfig(OWNER, config({ features: { places: true } }), FRIDAY);
  const first = await addPlaceStory(d, OWNER, 'Melchnau, Bern');
  assert.ok('itemId' in first);
  const row = (await store.getItem(OWNER, (first as { itemId: string }).itemId))!;
  assert.equal(row.show_id, '_block:ortsgeschichte');
  assert.deepEqual(JSON.parse(row.research_json!), { subjectOverride: 'Melchnau, Bern', place: 'Melchnau, Bern' });
  assert.deepEqual(await addPlaceStory(d, OWNER, 'Melchnau, Bern'), { skipped: 'known' });
  // While one waits, a new place gets none (no stories back to back on a drive).
  assert.deepEqual(await addPlaceStory(d, OWNER, 'Wynau, Bern'), { skipped: 'waiting' });
  const heard = async (result: { itemId: string } | { skipped: string }) => {
    assert.ok('itemId' in result);
    await store.update(OWNER, result.itemId, { state: 'played' }, FRIDAY);
  };
  await heard(first);
  for (let i = 1; i < PLACES_PER_DAY; i++) await heard(await addPlaceStory(d, OWNER, `Ort ${i}`));
  assert.deepEqual(await addPlaceStory(d, OWNER, 'Noch einer'), { skipped: 'enough' });
});

test('reverse geocoding names the village with its canton', async () => {
  let asked = '';
  const place = await reverseGeocode(47.1834, 7.8521, async (input, init) => {
    asked = String(input);
    assert.match(String((init?.headers as Record<string, string>)['User-Agent']), /personal-radio/);
    return Response.json({ address: { village: 'Melchnau', state: 'Bern', country: 'Schweiz' } });
  });
  assert.deepEqual(place, { name: 'Melchnau', label: 'Melchnau, Bern' });
  assert.match(asked, /nominatim\.openstreetmap\.org\/reverse\?format=jsonv2&zoom=14&accept-language=de&lat=47\.1834&lon=7\.8521/);
  assert.equal(await reverseGeocode(0, 0, async () => Response.json({ address: {} })), null);
});

test('features and place stories through the Worker', async () => {
  const { privateKey, publicKey } = await generateKeyPair('RS256');
  const jwk = await exportJWK(publicKey); Object.assign(jwk, { kid: 'kf', alg: 'RS256', use: 'sig' });
  const team = 'features-test.cloudflareaccess.com', aud = 'features-aud', ORIGIN = 'https://private.example';
  const token = await new SignJWT({ email: OWNER, type: 'app' }).setProtectedHeader({ alg: 'RS256', kid: 'kf' }).setIssuer(`https://${team}`).setAudience(aud).setExpirationTime('2m').sign(privateKey);
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async input => {
    if (String(input).endsWith('/cdn-cgi/access/certs')) return Response.json({ keys: [jwk] });
    if (String(input).startsWith('https://nominatim.openstreetmap.org/')) return Response.json({ address: { town: 'Langenthal', state: 'Bern' } });
    throw new Error(`Unexpected URL: ${String(input)}`);
  };
  const db = sqliteD1(), sent: unknown[] = [];
  const env = { DB: db, AUDIO: { get: async () => null, put: async () => {}, delete: async () => {} }, PRODUCTION: { send: async (message: unknown) => { sent.push(message); } },
    ASSETS: { fetch: async () => new Response('app') }, ACCESS_TEAM_DOMAIN: team, ACCESS_AUD: aud, ALLOWED_EMAIL: OWNER, MISTRAL_API_KEY: 'm', MISTRAL_VOICE_ID: 'v' };
  const call = (path: string, method = 'GET', body?: unknown) => worker.fetch(new Request(`${ORIGIN}${path}`, { method,
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    headers: { 'Cf-Access-Jwt-Assertion': token, Origin: ORIGIN, ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}) } }), env as never);
  try {
    await new StationStore(db).saveConfig(OWNER, config(), FRIDAY);
    const listed = (await (await call('/api/features')).json()) as any;
    assert.deepEqual(listed.features.map((feature: any) => feature.id), ['linker', 'review', 'follow', 'concerts', 'places']); // no quiz for grown-ups
    assert.equal(listed.blocks.find((item: any) => item.id === 'wetter').visible, true);
    // Off before switched on.
    assert.equal((await call('/api/places/story', 'POST', { latitude: 47.21, longitude: 7.79 })).status, 409);
    const saved = (await (await call('/api/features', 'PUT', { features: { places: true, review: false, linker: false }, hiddenBlocks: ['wetter'] })).json()) as any;
    assert.equal(saved.features.find((feature: any) => feature.id === 'places').enabled, true);
    assert.equal(saved.features.find((feature: any) => feature.id === 'linker').enabled, false);
    assert.equal(saved.blocks.find((item: any) => item.id === 'wetter').visible, false);
    const stored = (await new StationStore(db).getConfig(OWNER))!;
    assert.deepEqual(stored.features, { places: true, review: false });
    assert.equal(stored.sounds?.linker, false);
    assert.ok(!((await (await call('/api/blocks')).json()) as any).blocks.some((item: any) => item.id === 'wetter'));

    const story = (await (await call('/api/places/story', 'POST', { latitude: 47.21, longitude: 7.79 })).json()) as any;
    assert.equal(story.place, 'Langenthal, Bern'); assert.ok(story.itemId);
    assert.equal(sent.length, 1);
    assert.deepEqual(await (await call('/api/places/story', 'POST', { latitude: 47.21, longitude: 7.79 })).json(), { place: 'Langenthal, Bern', skipped: 'known' });
    assert.equal((await call('/api/places/story', 'POST', { latitude: 'x', longitude: 7 })).status, 400);
  } finally { globalThis.fetch = originalFetch; }
});

test('an own show named like a built-in block appears once in the palette, unless that block is hidden', () => {
  const base = config();
  const shows = [...base.shows, { ...base.shows[0], id: 'meine-kuenstler', name: 'Künstler-Stunde', enabled: true }, { ...base.shows[0], id: 'eigen', name: 'Meine Sendung', enabled: true }];
  const palette = blockViews({ ...base, shows });
  assert.equal(palette.filter(item => item.name === 'Künstler-Stunde').length, 1);
  assert.ok(palette.some(item => item.id === 'kuenstler'));
  assert.ok(palette.some(item => item.id === 'show:eigen'));
  // With the block hidden, the own show is the only way to insert it.
  assert.ok(blockViews({ ...base, shows, hiddenBlocks: ['kuenstler'] }).some(item => item.id === 'show:meine-kuenstler'));
});
