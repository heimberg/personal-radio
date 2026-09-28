import { test } from 'node:test';
import assert from 'node:assert/strict';
import { defaultStationConfig, parseStationConfig } from '../src/domain/station.ts';
import type { EditorialDirection, Script, Source } from '../src/domain/program.ts';
import { BLOCKS, blockViews } from '../src/domain/blocks.ts';
import { StationStore } from '../server/station-store.ts';
import { addBlock, planTimeline, produceItem, scheduleShowNow, toView } from '../server/station.ts';
import type { StationDeps } from '../server/station.ts';
import { sqliteD1 } from './d1-sqlite.ts';

const NOW = new Date('2026-09-28T05:30:00Z');
/** A spoken show of the default station. */
const BRIEF = defaultStationConfig().shows.find(show => show.format === 'brief')!.id;
const BERN = { name: 'Bern', latitude: 46.948, longitude: 7.4474 };
const source = (id: string, title: string): Source => ({ id, url: `https://example.org/${id}`, title, excerpt: title, publishedAt: NOW.toISOString(), retrievedAt: NOW.toISOString() });

function station(feeds = false) {
  const base = defaultStationConfig({ timezone: 'Europe/Zurich', feeds: feeds ? [{ name: 'Nachrichten', url: 'https://news.example/rss' }] : [] });
  return parseStationConfig({ ...base, location: BERN, music: { ...base.music, between: 0, taste: 'Industrial' } });
}

function harness(config = station()) {
  const store = new StationStore(sqliteD1());
  let ids = 0;
  const seen: { direction?: EditorialDirection; sources: Source[]; research: string[] } = { sources: [], research: [] };
  const deps: StationDeps = {
    store, podcastAvailable: true, now: () => NOW, newId: () => `item-${++ids}`,
    fetchFeed: async () => [
      { id: 'a', title: 'Alt', url: 'https://news.example/alt', excerpt: 'alt', publishedAt: '2026-09-25T05:00:00Z' },
      { id: 'b', title: 'Neu 1', url: 'https://news.example/1', excerpt: 'eins', publishedAt: '2026-09-28T04:00:00Z' },
      { id: 'c', title: 'Neu 2', url: 'https://news.example/2', excerpt: 'zwei', publishedAt: '2026-09-28T05:00:00Z' },
    ],
    reserveFeed: async () => {}, reserveGeneration: async () => {},
    audio: { put: async () => {}, delete: async () => {} },
    weather: { report: async () => ({ text: 'Wetter in Bern: sonnig.', source: source('wetter', 'Wetter Bern') }) },
    researcher: { research: async input => { seen.research.push(input.brief); return { sources: [source('w1', 'Web 1'), source('w2', 'Web 2')], queries: [] }; } },
    pipeline: {
      draft: async (_profile, sources, _mode, direction): Promise<Script> => { seen.direction = direction; seen.sources = sources; return { title: 'Beitrag', text: 'Text.', sourceIds: [] }; },
      review: async () => ({ approved: true, reasons: [] }),
      voice: async () => ({ audio: new Uint8Array([1]), contentType: 'audio/mpeg' as const, ttsCharacters: 5 }),
    },
  };
  return { store, deps, seen, setup: () => store.saveConfig('o', config, NOW) };
}

test('the block list offers the catalog, one song and the owner\'s active shows, with a subject only where it matters', () => {
  const views = blockViews(station());
  assert.deepEqual(views.slice(0, BLOCKS.length).map(view => view.id), BLOCKS.map(block => block.id));
  assert.ok(views.some(view => view.id === 'song' && view.music));
  const own = views.filter(view => view.own);
  assert.ok(own.length > 0 && own.every(view => view.id.startsWith('show:')));
  assert.equal(views.find(view => view.id === 'wetter')?.input, undefined);
  assert.equal(views.find(view => view.id === 'kuenstler')?.input?.label, 'Künstler oder Band');
});

test('a weather block comes right after the playing item and is produced with date, time and weather as evidence', async () => {
  const h = harness(); await h.setup();
  const first = (await scheduleShowNow(h.deps, 'o', BRIEF))!;
  const second = (await scheduleShowNow(h.deps, 'o', BRIEF))!;
  const id = (await addBlock(h.deps, 'o', 'wetter', 'ignoriert', first))!;
  assert.deepEqual((await h.store.openItems('o')).map(item => item.id), [first, id, second]);
  assert.equal(toView((await h.store.getItem('o', id))!, null).showName, 'Wetter');
  assert.equal(await produceItem(h.deps, 'o', id), 'ready');
  assert.match(h.seen.direction!.instructions!, /Heute ist Montag, 28\. September 2026, es ist 07:30 Uhr\. Das aktuelle Wetter steht in der Quelle «wetter»\./);
  assert.deepEqual(h.seen.sources.map(item => item.id), ['wetter']);
  // Without a place the weather cannot be told.
  await h.store.saveConfig('o', parseStationConfig({ ...station(), location: undefined }), NOW);
  const other = (await addBlock(h.deps, 'o', 'wetter'))!;
  assert.equal(await produceItem(h.deps, 'o', other), 'failed');
  assert.equal((await h.store.getItem('o', other))?.error, 'NO_LOCATION');
});

test('headlines come from the owner\'s feeds (newest first, last 36 hours) or, without feeds, from a web search', async () => {
  const withFeeds = harness(station(true)); await withFeeds.setup();
  const id = (await addBlock(withFeeds.deps, 'o', 'schlagzeilen'))!;
  assert.equal(await produceItem(withFeeds.deps, 'o', id), 'ready');
  assert.deepEqual(withFeeds.seen.sources.map(item => [item.id, item.title]), [['h1', 'Neu 2'], ['h2', 'Neu 1']]);
  assert.match(withFeeds.seen.direction!.instructions!, /Quellen «h1» bis «h2»/);

  const web = harness(); await web.setup();
  const other = (await addBlock(web.deps, 'o', 'schlagzeilen'))!;
  assert.equal(await produceItem(web.deps, 'o', other), 'ready');
  assert.deepEqual(web.seen.sources.map(item => item.id), ['h1', 'h2']);
  assert.match(web.seen.research[0], /Die wichtigsten Nachrichten von heute, 28\. September 2026/);
});

test('a discovery block researches the word the owner typed; unknown blocks are refused', async () => {
  const h = harness(); await h.setup();
  const id = (await addBlock(h.deps, 'o', 'entdeckung', 'Tiefsee'))!;
  assert.equal(await produceItem(h.deps, 'o', id), 'ready');
  assert.match(h.seen.research[0], /Recherchiere zum Thema «Tiefsee»/);
  assert.equal(await addBlock(h.deps, 'o', 'gibt-es-nicht'), null);
  assert.equal(await addBlock(h.deps, 'o', 'show:gibt-es-nicht'), null);
  const song = (await addBlock(h.deps, 'o', 'song'))!;
  assert.equal((await h.store.openItems('o'))[0].id, song);
});

test('a day plan of blocks: slots take blocks, the planner rotates them with songs in between, and it counts as spoken content', () => {
  const base = station();
  const plan = parseStationConfig({ ...base, music: { ...base.music, between: 1 }, shows: base.shows.map(show => ({ ...show, enabled: false })),
    schedule: [{ id: 'morgen', days: [0, 1, 2, 3, 4, 5, 6], from: '00:00', to: '24:00', showIds: ['_block:morgen', '_block:entdeckung'] }] });
  let n = 0;
  const planned = planTimeline({ ...plan, horizonMinutes: 20 }, [], null, NOW, () => `p${++n}`);
  assert.deepEqual(planned.map(item => item.showId), ['_block:morgen', '_musik', '_block:entdeckung', '_musik', '_block:morgen', '_musik', '_block:entdeckung']);
  assert.throws(() => parseStationConfig({ ...plan, schedule: [{ ...plan.schedule[0], showIds: ['_block:Kein Baustein'] }] }), /unbekannte Sendung/);
  assert.throws(() => parseStationConfig({ ...plan, schedule: [] }), /KI-Sprechbeiträge sind Pflicht/);
});
