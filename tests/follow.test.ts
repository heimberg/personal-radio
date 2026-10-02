import { test } from 'node:test';
import assert from 'node:assert/strict';
import { defaultStationConfig, parseStationConfig } from '../src/domain/station.ts';
import type { EditorialDirection, Profile, Script, Source } from '../src/domain/program.ts';
import { StationStore } from '../server/station-store.ts';
import { AnswerError, answerAbout, produceItem, tick, toView } from '../server/station.ts';
import type { StationDeps } from '../server/station.ts';
import { BookmarkStore, FollowStore, MAX_FOLLOWED } from '../server/follow.ts';
import { blockViews } from '../src/domain/blocks.ts';
import { sqliteD1 } from './d1-sqlite.ts';
import { exportJWK, generateKeyPair, SignJWT } from 'jose';
import worker from '../server/worker.ts';

const OWNER = 'owner@example.test';
// Thursday 10:00 in Zurich; Friday 17:00.
const THURSDAY = new Date('2026-10-01T08:00:00Z'), FRIDAY = new Date('2026-10-02T15:00:00Z');
const profile: Profile = { topics: ['Wissenschaft'], interests: ['Raumfahrt'], interestWeights: {}, speechMinutes: 2, exploration: 0 };
const source = (id: string, excerpt: string): Source => ({ id, url: `https://example.test/${id}`, title: `Quelle ${id}`, excerpt, publishedAt: THURSDAY.toISOString(), retrievedAt: THURSDAY.toISOString() });

function harness(answers: { novelty?: unknown; answer?: unknown[] } = {}) {
  const db = sqliteD1(), store = new StationStore(db), follows = new FollowStore(db);
  let ids = 0, now = THURSDAY;
  const asked: Array<{ system: string; input: any }> = [], researched: string[] = [], drafts: Array<{ direction?: EditorialDirection }> = [], voiced: Script[] = [];
  const answerQueue = [...(answers.answer ?? [])];
  const deps: StationDeps = {
    store, podcastAvailable: false, now: () => now, random: () => 0.99, newId: () => `id-${++ids}`,
    fetchFeed: async () => [], reserveFeed: async () => {}, reserveGeneration: async () => {},
    audio: { put: async () => {}, delete: async () => {} },
    follows,
    listening: { topArtists: async () => ['Portishead', 'Massive Attack'] },
    agentModel: { askJson: async (system, input) => {
      asked.push({ system, input });
      if (system.includes('verfolgten Thema')) return answers.novelty ?? { neu: true, was: 'Der Reaktor lief erstmals zehn Minuten stabil.' };
      if (system.includes('eine Frage gestellt')) return answerQueue.shift() ?? { answerable: true, text: 'Weil die Sonde viel Treibstoff braucht.', sourceIds: ['s1'] };
      return {};
    } },
    researcher: { research: async request => { researched.push(request.brief); return { sources: [source('r1', 'Neu: Reaktor lief zehn Minuten.')], queries: [] }; } },
    pipeline: {
      draft: async (_profile, sources, _mode, direction): Promise<Script> => { drafts.push({ direction }); return { title: 'Neues', text: 'Neu ist …', sourceIds: [sources[0].id] }; },
      review: async () => ({ approved: true, reasons: [] }),
      voice: async (_owner, script) => { voiced.push(script); return { audio: new Uint8Array([1]), contentType: 'audio/mpeg' as const, ttsCharacters: 1 }; },
    },
  };
  const base = defaultStationConfig({ profile, feeds: [] });
  base.music = { ...base.music, between: 0 }; base.surprise = 0; base.timezone = 'Europe/Zurich';
  base.schedule = [{ id: 'nie', days: [0], from: '03:00', to: '03:30', showIds: ['entdecken'] }];
  const config = parseStationConfig(base);
  return { db, store, follows, deps, asked, researched, drafts, voiced, config, setup: () => store.saveConfig(OWNER, config, THURSDAY), at: (date: Date) => { now = date; } };
}

const items = async (store: StationStore, show: string) => (await store.recentItems(OWNER, 50)).filter(row => row.show_id === show);

test('Dranbleiben checks a followed topic once a day and only speaks when something is new', async () => {
  const h = harness(); await h.setup();
  const topic = (await h.follows.add(OWNER, 'Kernfusion', THURSDAY))!;
  assert.equal((await h.follows.add(OWNER, 'kernfusion', THURSDAY))!.id, topic.id); // no duplicates
  await tick(h.deps, OWNER);
  const [check] = await items(h.store, '_block:dranbleiben');
  assert.equal(toView(check, h.config).showName, 'Dranbleiben: Kernfusion');
  await tick(h.deps, OWNER);
  assert.equal((await items(h.store, '_block:dranbleiben')).length, 1); // once a day

  assert.equal(await produceItem(h.deps, OWNER, check.id), 'ready');
  assert.match(h.researched[0], /Neue Entwicklungen zu «Kernfusion» seit dem 2026-09-24/);
  assert.equal(h.asked[0].input.bisher, 'noch nichts');
  assert.match(h.drafts[0].direction?.instructions ?? '', /Bisher bekannt: noch nichts\. Neu ist: Der Reaktor lief erstmals zehn Minuten stabil\./);
  const after = (await h.follows.get(OWNER, topic.id))!;
  assert.equal(after.known, 'Der Reaktor lief erstmals zehn Minuten stabil.');
  assert.equal(after.reportedAt, THURSDAY.toISOString());

  // The next day nothing is new: the check leaves quietly, nothing is spoken.
  const quiet = harness({ novelty: { neu: false, was: '' } }); await quiet.setup();
  await quiet.follows.add(OWNER, 'Kernfusion', THURSDAY);
  await tick(quiet.deps, OWNER);
  const [silent] = await items(quiet.store, '_block:dranbleiben');
  assert.equal(await produceItem(quiet.deps, OWNER, silent.id), 'skipped');
  assert.equal((await quiet.store.getItem(OWNER, silent.id))?.state, 'expired');
  assert.equal(quiet.voiced.length, 0);

  // Not at night; a removed topic is not checked.
  const night = harness(); await night.setup(); night.at(new Date('2026-10-01T21:00:00Z'));
  await night.follows.add(OWNER, 'Mars', THURSDAY);
  await tick(night.deps, OWNER);
  assert.equal((await items(night.store, '_block:dranbleiben')).length, 0);
  assert.equal(await h.follows.remove(OWNER, topic.id), true);
  for (let i = 0; i < MAX_FOLLOWED; i++) assert.ok(await h.follows.add(OWNER, `Thema ${i}`, THURSDAY));
  assert.equal(await h.follows.add(OWNER, 'Eins zu viel', THURSDAY), null);
});

test('Nachfragen answers from the item, searches when it does not suffice, and the answer plays right after it', async () => {
  const h = harness({ answer: [{ answerable: false, text: '' }, { answerable: true, text: 'Der Reaktor lief zehn Minuten.', sourceIds: ['r1'] }] }); await h.setup();
  await h.store.insertItem(OWNER, { id: 'item', seq: 1, showId: '_block:hintergrund', plannedAt: THURSDAY.toISOString(), estimatedMinutes: 3 }, THURSDAY);
  await h.store.update(OWNER, 'item', { state: 'ready', script_json: JSON.stringify({ title: 'Kernfusion', text: 'Ein <laugh> Beitrag.', sourceIds: ['s1'] }),
    sources_json: JSON.stringify([source('s1', 'Belegt.')]) }, THURSDAY);
  await h.store.insertItem(OWNER, { id: 'next', seq: 2, showId: '_block:wetter', plannedAt: THURSDAY.toISOString(), estimatedMinutes: 1 }, THURSDAY);
  const answer = (await answerAbout(h.deps, OWNER, 'item', 'Wie lange lief der Reaktor?'))!;
  assert.equal(answer.text, 'Der Reaktor lief zehn Minuten.');
  assert.equal(h.asked[0].input.beitrag.text, 'Ein Beitrag.');
  assert.deepEqual(h.asked[0].input.quellen.map((item: any) => item.id), ['s1']);
  assert.match(h.researched[0], /Wie lange lief der Reaktor\? \(im Zusammenhang mit «Kernfusion»\)/);
  const reply = (await h.store.getItem(OWNER, answer.itemId))!;
  assert.equal(reply.state, 'ready');
  assert.equal(toView(reply, h.config).title, 'Nachgefragt: Wie lange lief der Reaktor?');
  assert.deepEqual(toView(reply, h.config).sources, [{ title: 'Quelle r1', url: 'https://example.test/r1' }]);
  assert.deepEqual((await h.store.openItems(OWNER)).map(row => row.id), ['item', answer.itemId, 'next']);

  // Nothing found anywhere: it says so honestly.
  const none = harness({ answer: [{ answerable: false, text: '' }, { answerable: false, text: '' }] }); await none.setup();
  await none.store.insertItem(OWNER, { id: 'item', seq: 1, showId: '_block:hintergrund', plannedAt: THURSDAY.toISOString(), estimatedMinutes: 3 }, THURSDAY);
  await none.store.update(OWNER, 'item', { state: 'played', script_json: JSON.stringify({ title: 'Kernfusion', text: 'Text.', sourceIds: [] }), sources_json: '[]' }, THURSDAY);
  assert.match((await answerAbout(none.deps, OWNER, 'item', 'Warum?'))!.text, /nichts Verlässliches gefunden/);

  // Songs and hours are not asked about (no playlist data to the AI).
  await h.store.insertItem(OWNER, { id: 'song', seq: 3, showId: '_musik', plannedAt: THURSDAY.toISOString(), estimatedMinutes: 3 }, THURSDAY);
  await h.store.update(OWNER, 'song', { state: 'ready', script_json: JSON.stringify({ kind: 'song', title: 'Song', text: '', sourceIds: [], parts: [] }) }, THURSDAY);
  await assert.rejects(answerAbout(h.deps, OWNER, 'song', 'Wer singt?'), (error: unknown) => error instanceof AnswerError && error.code === 'NOT_SPOKEN');
  assert.equal(await answerAbout(h.deps, OWNER, 'nope', 'Warum?'), null);
});

test('Konzerte: on Friday afternoon once a week, researched for the Spotify top artists near the station', async () => {
  const h = harness(); await h.setup();
  assert.ok(blockViews(h.config).some(block => block.id === 'konzerte'));
  await tick(h.deps, OWNER); // Thursday: nothing
  assert.equal((await items(h.store, '_block:konzerte')).length, 0);
  h.at(FRIDAY);
  await tick(h.deps, OWNER); await tick(h.deps, OWNER);
  const concerts = await items(h.store, '_block:konzerte');
  assert.equal(concerts.length, 1);
  assert.equal(await produceItem(h.deps, OWNER, concerts[0].id), 'ready');
  assert.match(h.researched[0], /Konzerte in den nächsten vier Monaten in der Schweiz.*von diesen Künstlern: Portishead, Massive Attack/);

  // Without a Spotify profile there is nothing to look for.
  const plain = harness(); await plain.setup(); plain.deps.listening = { topArtists: async () => [] }; plain.at(FRIDAY);
  await tick(plain.deps, OWNER);
  assert.equal((await items(plain.store, '_block:konzerte')).length, 0);
});

test('Merken keeps title and web sources on a reading list, once per item', async () => {
  const bookmarks = new BookmarkStore(sqliteD1());
  const entry = { itemId: 'a', title: 'Kernfusion', showName: 'Hintergrund', sources: [{ title: 'Quelle', url: 'https://example.test/a' }, { title: 'Plan', url: '' }] };
  await bookmarks.add(OWNER, entry, THURSDAY);
  await bookmarks.add(OWNER, entry, FRIDAY);
  const list = await bookmarks.list(OWNER);
  assert.deepEqual(list, [{ itemId: 'a', title: 'Kernfusion', showName: 'Hintergrund', sources: [{ title: 'Quelle', url: 'https://example.test/a' }], at: THURSDAY.toISOString() }]);
  assert.equal(await bookmarks.remove(OWNER, 'a'), true);
  assert.equal(await bookmarks.remove(OWNER, 'a'), false);
});

test('the reading list, followed topics and questions through the Worker', async () => {
  const { privateKey, publicKey } = await generateKeyPair('RS256');
  const jwk = await exportJWK(publicKey); Object.assign(jwk, { kid: 'kb', alg: 'RS256', use: 'sig' });
  const team = 'follow-test.cloudflareaccess.com', aud = 'follow-aud', ORIGIN = 'https://private.example';
  const token = await new SignJWT({ email: OWNER, type: 'app' }).setProtectedHeader({ alg: 'RS256', kid: 'kb' }).setIssuer(`https://${team}`).setAudience(aud).setExpirationTime('2m').sign(privateKey);
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async input => {
    if (String(input).endsWith('/cdn-cgi/access/certs')) return Response.json({ keys: [jwk] });
    throw new Error(`Unexpected URL: ${String(input)}`);
  };
  const db = sqliteD1();
  const env = { DB: db, AUDIO: { get: async () => null, put: async () => {}, delete: async () => {} }, PRODUCTION: { send: async () => {} },
    ASSETS: { fetch: async () => new Response('app') }, ACCESS_TEAM_DOMAIN: team, ACCESS_AUD: aud, ALLOWED_EMAIL: OWNER, MISTRAL_API_KEY: 'm', MISTRAL_VOICE_ID: 'v' };
  const call = (path: string, method = 'GET', body?: unknown) => worker.fetch(new Request(`${ORIGIN}${path}`, { method,
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    headers: { 'Cf-Access-Jwt-Assertion': token, Origin: ORIGIN, ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}) } }), env as never);
  try {
    const store = new StationStore(db);
    await store.saveConfig(OWNER, parseStationConfig(defaultStationConfig()), THURSDAY);
    await store.insertItem(OWNER, { id: 'item', seq: 1, showId: '_block:hintergrund', plannedAt: THURSDAY.toISOString(), estimatedMinutes: 3 }, THURSDAY);
    await store.update(OWNER, 'item', { state: 'played', script_json: JSON.stringify({ title: 'Kernfusion', text: 'Text.', sourceIds: ['s1'] }),
      sources_json: JSON.stringify([source('s1', 'Belegt.')]) }, THURSDAY);
    await store.insertItem(OWNER, { id: 'song', seq: 2, showId: '_musik', plannedAt: THURSDAY.toISOString(), estimatedMinutes: 3 }, THURSDAY);
    await store.update(OWNER, 'song', { state: 'ready', script_json: JSON.stringify({ kind: 'song', title: 'Song', text: '', sourceIds: [], parts: [] }) }, THURSDAY);

    assert.equal((await call('/api/timeline/item/bookmark', 'POST')).status, 200);
    assert.deepEqual(((await (await call('/api/bookmarks')).json()) as any).bookmarks.map((entry: any) => [entry.itemId, entry.title, entry.sources.length]), [['item', 'Kernfusion', 1]]);
    assert.equal((await call('/api/bookmarks/item', 'DELETE')).status, 200);
    assert.equal((await call('/api/bookmarks/item', 'DELETE')).status, 404);

    const added = (await (await call('/api/follow', 'POST', { topic: '  Kernfusion ' })).json()) as any;
    assert.equal(added.topic.topic, 'Kernfusion'); assert.equal(added.topic.known, undefined);
    assert.equal((await call('/api/follow', 'POST', { topic: 'x' })).status, 400);
    assert.deepEqual(((await (await call('/api/follow')).json()) as any).topics.map((topic: any) => topic.topic), ['Kernfusion']);
    assert.equal((await call(`/api/follow/${added.topic.id}`, 'DELETE')).status, 200);

    // Questions: not about a song, not without Gemini, not empty.
    assert.equal((await call('/api/timeline/song/ask', 'POST', { text: 'Wer singt das?' })).status, 409);
    assert.deepEqual(await (await call('/api/timeline/item/ask', 'POST', { text: 'Warum?' })).json(), { error: 'gemini_not_configured' });
    assert.equal((await call('/api/timeline/item/ask', 'POST', { text: ' ' })).status, 400);
  } finally { globalThis.fetch = originalFetch; }
});
