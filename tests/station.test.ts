import { test } from 'node:test';
import assert from 'node:assert/strict';
import { activeSlot, ConfigError, defaultStationConfig, parseStationConfig } from '../src/domain/station.ts';
import type { StationConfig } from '../src/domain/station.ts';
import type { Profile, Script, Source } from '../src/domain/program.ts';
import { StationStore } from '../server/station-store.ts';
import { planTimeline, produceItem, tick, toView } from '../server/station.ts';
import type { StationDeps } from '../server/station.ts';
import { PipelineError } from '../server/segment-pipeline.ts';
import type { FeedItem } from '../server/feed.ts';
import { sqliteD1 } from './d1-sqlite.ts';

const OWNER = 'owner@example.test';
const NOW = new Date('2026-09-27T08:00:00Z');
const profile: Profile = { topics: ['Wissenschaft'], interests: ['Raumfahrt'], interestWeights: {}, speechMinutes: 2, exploration: 0 };

function config(overrides: Partial<StationConfig> = {}): StationConfig {
  const base = defaultStationConfig({ profile, feeds: [{ name: 'Wissen', url: 'https://feeds.example.test/wissen.xml' }] });
  return parseStationConfig({ ...base, ...overrides });
}

function feedItems(count: number): FeedItem[] {
  return Array.from({ length: count }, (_, index) => ({ id: `feed-${index + 1}`, title: `Raumfahrt Meldung ${index + 1}`,
    url: `https://news.example.test/${index + 1}`, excerpt: `Auszug ${index + 1}.`, publishedAt: new Date(Date.parse('2026-09-26T20:00:00Z') - index * 3_600_000).toISOString() }));
}

function harness(options: { items?: FeedItem[]; station?: StationConfig } = {}) {
  const db = sqliteD1(), store = new StationStore(db);
  let clock = NOW, ids = 0;
  const calls = { draft: 0, review: 0, voice: 0, feeds: 0 };
  const behaviour: { draft?: () => void; review?: () => void; voice?: () => void } = {};
  const bucket = new Map<string, Uint8Array>();
  const deps: StationDeps = {
    store, podcastAvailable: false, now: () => clock, random: () => 0.99, newId: () => `item-${++ids}`,
    fetchFeed: async () => { calls.feeds++; return options.items ?? feedItems(3); },
    reserveFeed: async () => {}, reserveGeneration: async () => {},
    audio: { put: async (key, value) => { bucket.set(key, value); }, delete: async key => { bucket.delete(key); } },
    pipeline: {
      draft: async (_profile: Profile, sources: Source[]): Promise<Script> => {
        calls.draft++; behaviour.draft?.();
        return { title: `Beitrag über ${sources[0].title}`, text: 'Gesprochener Text.', sourceIds: sources.map(s => s.id), interestTags: ['Raumfahrt'] };
      },
      review: async () => { calls.review++; behaviour.review?.(); return { approved: true, reasons: [] }; },
      voice: async () => { calls.voice++; behaviour.voice?.(); return { audio: new Uint8Array([1, 2, 3]), contentType: 'audio/mpeg' as const, ttsCharacters: 18 }; },
    },
  };
  const setup = async () => { await store.saveConfig(OWNER, options.station ?? config(), NOW); };
  return { db, store, deps, calls, behaviour, bucket, setup, advance: (minutes: number) => { clock = new Date(clock.getTime() + minutes * 60_000); } };
}

test('station config validates references, bounds and time zones with readable paths', () => {
  const valid = config();
  assert.equal(valid.shows[0].targetMinutes, 2);
  assert.deepEqual(valid.shows[0].feedIds, ['feed-1']);
  const broken = (patch: (c: any) => void) => { const c = structuredClone(valid) as any; patch(c); return () => parseStationConfig(c); };
  assert.throws(broken(c => { c.shows[0].feedIds = ['unknown']; }), /shows\[0\]\.feedIds\[0\]: unbekannter Feed/);
  assert.throws(broken(c => { c.shows[0].targetMinutes = 5; }), /1 bis 2 Minuten/);
  assert.throws(broken(c => { c.schedule[0].from = '25:00'; }), ConfigError);
  assert.throws(broken(c => { c.schedule[0].showIds = ['nope']; }), /unbekannte Sendung/);
  assert.throws(broken(c => { c.timezone = 'Mars/Olympus'; }), /Zeitzone/);
  assert.throws(broken(c => { c.shows[1].id = 'kurz'; }), /doppelt/);
});

test('schedule slots are evaluated in the station time zone', () => {
  const station = config({ schedule: [{ id: 'nacht', days: [1], from: '00:00', to: '01:00', showIds: ['kurz'] }] });
  assert.equal(activeSlot(station, new Date('2026-09-27T22:30:00Z'))?.id, 'nacht'); // Monday 00:30 in Zurich
  assert.equal(activeSlot(station, new Date('2026-09-27T21:30:00Z')), undefined); // Sunday 23:30 in Zurich
});

test('planner fills the horizon, rotates enabled shows and continues after existing items', () => {
  const station = config({ horizonMinutes: 20 });
  station.shows[1].enabled = true;
  let n = 0; const newId = () => `p${++n}`;
  const planned = planTimeline(station, [], null, NOW, newId);
  assert.deepEqual(planned.map(item => item.showId), ['kurz', 'dialog', 'kurz', 'dialog', 'kurz', 'dialog']);
  assert.deepEqual(planned.map(item => item.seq), [1, 2, 3, 4, 5, 6]);
  assert.equal(planned[1].plannedAt, '2026-09-27T08:02:00.000Z');
  const more = planTimeline(station, [{ estimated_minutes: 18 }], { seq: 9, show_id: 'kurz' }, NOW, newId);
  assert.deepEqual(more.map(item => [item.seq, item.showId]), [[10, 'dialog']]);
  station.shows[1].enabled = false;
  assert.ok(planTimeline(station, [], null, NOW, newId).every(item => item.showId === 'kurz'));
  const closed = config({ schedule: [{ id: 'abend', days: [0, 1, 2, 3, 4, 5, 6], from: '20:00', to: '22:00', showIds: ['kurz'] }] });
  assert.deepEqual(planTimeline(closed, [], null, NOW, newId), []);
});

test('tick plans, production stores audio in the bucket and marks sources as covered', async () => {
  const h = harness(); await h.setup();
  const result = await tick(h.deps, OWNER);
  assert.equal(result.planned, 10); // 20-minute default horizon with 2-minute shows
  assert.equal(result.due.length, 10);
  assert.equal(await produceItem(h.deps, OWNER, result.due[0]), 'ready');
  const ready = await h.store.getItem(OWNER, result.due[0]);
  assert.equal(ready?.state, 'ready'); assert.equal(ready?.audio_key, `segments/${result.due[0]}.mp3`);
  assert.deepEqual([...h.bucket.keys()], [`segments/${result.due[0]}.mp3`]);
  const view = toView(ready!, config());
  assert.equal(view.title, 'Beitrag über Raumfahrt Meldung 1'); assert.equal(view.audioUrl, `api/timeline/${result.due[0]}/audio`);
  assert.deepEqual(view.sources, [{ title: 'Raumfahrt Meldung 1', url: 'https://news.example.test/1' }]);
  // The next segment picks the next unused article rather than retelling the first one.
  assert.equal(await produceItem(h.deps, OWNER, result.due[1]), 'ready');
  assert.equal(toView((await h.store.getItem(OWNER, result.due[1]))!, config()).sources?.[0].url, 'https://news.example.test/2');
  // The program is full while open items cover the horizon.
  assert.equal((await tick(h.deps, OWNER)).planned, 0);
});

test('a leased item is not produced twice concurrently', async () => {
  const h = harness(); await h.setup();
  const [id] = (await tick(h.deps, OWNER)).due;
  let release!: () => void; const gate = new Promise<void>(resolve => { release = resolve; });
  h.deps.pipeline.voice = async () => { await gate; return { audio: new Uint8Array([1]), contentType: 'audio/mpeg', ttsCharacters: 1 }; };
  const first = produceItem(h.deps, OWNER, id);
  await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(await produceItem(h.deps, OWNER, id), 'skipped');
  release(); assert.equal(await first, 'ready');
});

test('a transient TTS failure keeps the approved script and retries only speech after back-off', async () => {
  const h = harness(); await h.setup();
  const [id] = (await tick(h.deps, OWNER)).due;
  h.behaviour.voice = () => { throw new Error('Mistral request failed (503)'); };
  assert.equal(await produceItem(h.deps, OWNER, id), 'retry');
  const waiting = await h.store.getItem(OWNER, id);
  assert.equal(waiting?.state, 'voicing'); assert.equal(waiting?.attempts, 1); assert.match(waiting?.error ?? '', /503/);
  assert.equal(await produceItem(h.deps, OWNER, id), 'skipped'); // still backing off
  h.behaviour.voice = undefined; h.advance(11);
  assert.equal(await produceItem(h.deps, OWNER, id), 'ready');
  assert.deepEqual({ draft: h.calls.draft, review: h.calls.review, voice: h.calls.voice }, { draft: 1, review: 1, voice: 2 });
});

test('rejections fail permanently, exhausted budgets defer to the next UTC day, repeated errors give up', async () => {
  const h = harness(); await h.setup();
  const due = (await tick(h.deps, OWNER)).due;
  h.behaviour.review = () => { throw new PipelineError('REJECTED'); };
  assert.equal(await produceItem(h.deps, OWNER, due[0]), 'failed');
  assert.equal((await h.store.getItem(OWNER, due[0]))?.error, 'REJECTED');
  h.behaviour.review = undefined;
  h.behaviour.voice = () => { throw new PipelineError('BUDGET_EXCEEDED'); };
  assert.equal(await produceItem(h.deps, OWNER, due[1]), 'deferred');
  assert.equal((await h.store.getItem(OWNER, due[1]))?.lease_until, '2026-09-28T00:00:00.000Z');
  h.behaviour.voice = () => { throw new Error('network'); };
  for (let attempt = 0; attempt < 3; attempt++) { await produceItem(h.deps, OWNER, due[2]); h.advance(60); }
  const gaveUp = await h.store.getItem(OWNER, due[2]);
  assert.equal(gaveUp?.state, 'failed'); assert.equal(gaveUp?.attempts, 3);
});

test('no fresh articles fails the item; three recent failures pause planning', async () => {
  const h = harness({ items: [] }); await h.setup();
  const due = (await tick(h.deps, OWNER)).due;
  for (const id of due.slice(0, 3)) assert.equal(await produceItem(h.deps, OWNER, id), 'failed');
  assert.equal((await h.store.getItem(OWNER, due[0]))?.error, 'NO_SOURCES');
  h.db.raw.exec(`DELETE FROM timeline_items WHERE state = 'planned'`);
  assert.equal((await tick(h.deps, OWNER)).planned, 0);
  h.advance(61);
  assert.ok((await tick(h.deps, OWNER)).planned > 0);
});

test('stale unplayed items expire and release their audio', async () => {
  const h = harness(); await h.setup();
  const [id] = (await tick(h.deps, OWNER)).due;
  await produceItem(h.deps, OWNER, id);
  h.advance(13 * 60);
  const result = await tick(h.deps, OWNER);
  assert.equal(result.expired, 10);
  assert.equal((await h.store.getItem(OWNER, id))?.state, 'expired');
  assert.equal(h.bucket.size, 0);
  assert.equal(result.planned, 10); // fresh program replaces the stale one
});

test('the cron plans new content only while the owner has listened recently', async () => {
  const h = harness(); await h.setup();
  assert.equal((await tick(h.deps, OWNER, { requireListener: true })).planned, 0);
  await h.store.touch(OWNER, NOW);
  h.advance(179);
  assert.equal((await tick(h.deps, OWNER, { requireListener: true })).planned, 10);
  h.db.raw.exec('DELETE FROM timeline_items');
  h.advance(2);
  assert.equal((await tick(h.deps, OWNER, { requireListener: true })).planned, 0);
});

test('feedback events round-trip for server-side learning', async () => {
  const h = harness(); await h.setup();
  await h.store.addFeedback(OWNER, { itemId: 'a', interests: ['Raumfahrt'], action: 'like', listenedRatio: 1, createdAt: NOW.toISOString() });
  assert.deepEqual(await h.store.feedback(OWNER), [{ itemId: 'a', interests: ['Raumfahrt'], action: 'like', listenedRatio: 1, createdAt: NOW.toISOString() }]);
});
