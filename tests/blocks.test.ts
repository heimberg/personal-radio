import { test } from 'node:test';
import assert from 'node:assert/strict';
import { defaultStationConfig, parseStationConfig } from '../src/domain/station.ts';
import type { EditorialDirection, Script, Source } from '../src/domain/program.ts';
import { BLOCKS, blockViews, drawSurprise } from '../src/domain/blocks.ts';
import { StationStore } from '../server/station-store.ts';
import { addBlock, addFollowUp, planTimeline, produceItem, scheduleShowNow, swapItem, tick, toView } from '../server/station.ts';
import { briefSystemPrompt } from '../server/providers.ts';
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
  const db = sqliteD1();
  const store = new StationStore(db);
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
  return { db, store, deps, seen, setup: () => store.saveConfig('o', config, NOW) };
}

test('the block list offers the catalog, one song and the owner\'s active shows, with a subject only where it matters', () => {
  const views = blockViews(station());
  const offered = BLOCKS.filter(block => !block.hidden);
  assert.deepEqual(views.slice(0, offered.length).map(view => view.id), offered.map(block => block.id));
  assert.ok(!views.some(view => view.id === 'vertiefung'));
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
  // From the program, a new block goes behind everything open.
  const last = (await addBlock(h.deps, 'o', 'wetter', undefined, 'end'))!;
  assert.deepEqual((await h.store.openItems('o')).map(item => item.id), [first, id, second, last]);
  assert.equal(toView((await h.store.getItem('o', id))!, null).showName, 'Wetter');
  assert.equal(await produceItem(h.deps, 'o', id), 'ready');
  // The last step stays recorded, but a finished item shows no progress.
  const produced = (await h.store.getItem('o', id))!;
  assert.equal(produced.stage, 'voicing');
  assert.equal(toView(produced, null).stage, undefined);
  const running = { ...produced, state: 'planned' as const, stage: 'writing', lease_until: new Date(Date.now() + 60_000).toISOString() };
  assert.equal(toView(running, null).stage, 'writing');
  assert.equal(toView({ ...running, error: 'TIMEOUT' }, null).stage, undefined, 'a retry waiting with an error shows none');
  assert.match(h.seen.direction!.instructions!, /Heute ist Montag, 28\. September 2026; der Beitrag läuft voraussichtlich am Morgen\. Das aktuelle Wetter steht in der Quelle «wetter»\./);
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

test('«Mehr dazu» places a follow-up right after the item; it starts from its sources and knows what was said', async () => {
  const h = harness(); await h.setup();
  const first = (await scheduleShowNow(h.deps, 'o', BRIEF))!;
  const second = (await scheduleShowNow(h.deps, 'o', BRIEF))!;
  const weather = (await addBlock(h.deps, 'o', 'wetter', undefined, first))!;
  assert.equal(await produceItem(h.deps, 'o', weather), 'ready');
  assert.equal(await addFollowUp(h.deps, 'o', 'unbekannt'), null);
  const deeper = (await addFollowUp(h.deps, 'o', weather))!;
  assert.deepEqual((await h.store.openItems('o')).map(item => item.id), [first, weather, deeper, second]);
  assert.equal(toView((await h.store.getItem('o', deeper))!, null).showName, 'Vertiefung');
  assert.equal(await produceItem(h.deps, 'o', deeper), 'ready');
  assert.deepEqual(h.seen.sources.map(item => [item.id, item.title]), [['p1', 'Wetter Bern'], ['w1', 'Web 1'], ['w2', 'Web 2']]);
  assert.match(h.seen.direction!.instructions!, /Der vorherige Beitrag hiess «Beitrag» und sagte bereits: «Text\.»/);
  assert.match(h.seen.research.at(-1)!, /Hintergründe, Ursachen, Folgen und neue Aspekte zu «Beitrag»/);
  // The hidden block is not offered and cannot be added directly.
  assert.equal(await addBlock(h.deps, 'o', 'vertiefung'), null);
});

test('«Neu von deinen Künstlern» plays new releases newest first and the moderation names each one as new', async () => {
  const h = harness(); await h.setup();
  let moments: unknown;
  const releases = [
    { uri: 'spotify:track:new1', title: 'Neuer Song', artist: 'Band A', durationMs: 200_000 },
    { uri: 'spotify:track:new2', title: 'Zweiter Song', artist: 'Band B', durationMs: 200_000 },
  ];
  h.deps.catalog = { find: async () => null };
  h.deps.playlists = { tracks: async () => [], releases: async () => releases };
  h.deps.musicWriter = {
    pickSubject: async () => ({ subject: '', reason: '' }), pickTracks: async () => [], writeHour: async () => { throw new Error('no'); }, pickSongs: async () => [],
    writeBlock: async input => { moments = input.moments; return input.moments.map((_, index) => `Moderation ${index}`); },
  };
  const id = (await addBlock(h.deps, 'o', 'neu'))!;
  assert.equal(await produceItem(h.deps, 'o', id), 'ready');
  const view = toView((await h.store.getItem('o', id))!, null);
  assert.deepEqual(view.parts?.filter(part => part.kind === 'track').map(part => part.kind === 'track' && part.spotifyUri), ['spotify:track:new1', 'spotify:track:new2']);
  // The owner's decision (29.09.2026): new releases are named; playlist tracks still never are.
  assert.deepEqual((moments as Array<{ next?: unknown }>).flatMap(moment => moment.next ? [moment.next] : []),
    [{ artist: 'Band A', title: 'Neuer Song', release: true }, { artist: 'Band B', title: 'Zweiter Song', release: true }]);
  assert.equal(view.showName, 'Neu von deinen Künstlern');
});

test('pre-produced items: time of day of the expected air time, no clock time, and late time-bound items leave the program', async () => {
  const h = harness(); await h.setup();
  // Planned for the evening (19:30 in Zurich): the note names the evening, never a clock time.
  const weather = (await addBlock(h.deps, 'o', 'wetter'))!;
  h.db.prepare('UPDATE timeline_items SET planned_at = ? WHERE id = ?').bind('2026-09-28T17:30:00.000Z', weather).run();
  assert.equal(await produceItem(h.deps, 'o', weather), 'ready');
  assert.match(h.seen.direction!.instructions!, /läuft voraussichtlich am Abend/);
  assert.doesNotMatch(h.seen.direction!.instructions!, /\d{1,2}:\d{2}/);
  const discovery = (await addBlock(h.deps, 'o', 'entdeckung', 'Tiefsee'))!;
  assert.equal(await produceItem(h.deps, 'o', discovery), 'ready');
  // Three hours past their air time: the weather is archived, the timeless discovery stays.
  for (const id of [weather, discovery]) h.db.prepare('UPDATE timeline_items SET planned_at = ? WHERE id = ?').bind('2026-09-28T02:00:00.000Z', id).run();
  await tick(h.deps, 'o');
  assert.equal((await h.store.getItem('o', weather))!.state, 'archived');
  assert.equal((await h.store.getItem('o', discovery))!.state, 'ready');
  assert.match(briefSystemPrompt(undefined), /vorproduziert und läuft später: nenne keine Uhrzeit/);
});

test('🎲 surprises: the planner mixes them in by the level, «Überraschung» draws one, «Anders» swaps any item in place', async () => {
  const base = station();
  // Level 0: never. Level 100 with a low draw: the turn becomes a surprise, and songs still follow it.
  const draws = (...values: number[]) => { let index = 0; return () => values[index++ % values.length]; };
  const plan = (surprise: number, random: () => number) => planTimeline({ ...base, surprise, music: { ...base.music, between: 1 } }, [], null, NOW, (() => { let n = 0; return () => `p${++n}`; })(), [], random);
  assert.ok(plan(0, draws(0)).every(item => !item.showId.startsWith('_block:') || !BLOCKS.find(block => `_block:${block.id}` === item.showId)?.surprise));
  const planned = plan(100, draws(0.1, 0.0));
  assert.ok(BLOCKS.find(block => `_block:${block.id}` === planned[0].showId)?.surprise);
  assert.equal(planned[1].showId, '_musik');
  // The draw: regional only with a location, a whole hour only from level 50, never the kind just played.
  const noPlace = parseStationConfig({ ...defaultStationConfig({ timezone: 'Europe/Zurich' }), surprise: 25 });
  for (let i = 0; i < 40; i++) {
    const block = drawSurprise(noPlace, () => i / 40, '_block:zufallsfund');
    assert.ok(block.id !== 'um-die-ecke' && block.id !== 'ueberraschungsstunde' && block.id !== 'zufallsfund');
  }
  assert.throws(() => parseStationConfig({ ...base, surprise: 101 }), /surprise/);

  const h = harness(parseStationConfig({ ...base, surprise: 25 })); await h.setup();
  h.deps.random = () => 0;
  const first = (await scheduleShowNow(h.deps, 'o', BRIEF))!;
  const surprise = (await addBlock(h.deps, 'o', 'ueberraschung', undefined, first))!;
  const second = (await scheduleShowNow(h.deps, 'o', BRIEF))!;
  const row = (await h.store.getItem('o', surprise))!;
  assert.equal(toView(row, null).surprise, true);
  const swapped = (await swapItem(h.deps, 'o', surprise))!;
  assert.deepEqual((await h.store.openItems('o')).map(item => item.id), [first, swapped, second]);
  assert.notEqual((await h.store.getItem('o', swapped))!.show_id, row.show_id);
  assert.equal((await h.store.getItem('o', surprise))!.state, 'expired');
  // Any other item gives way to a surprise at its place; gone items cannot be swapped.
  const instead = (await swapItem(h.deps, 'o', second))!;
  assert.deepEqual((await h.store.openItems('o')).map(item => item.id), [first, swapped, instead]);
  assert.equal(toView((await h.store.getItem('o', instead))!, null).surprise, true);
  assert.equal(await swapItem(h.deps, 'o', second), null);
  assert.ok(blockViews(base).some(view => view.id === 'ueberraschung'));
  assert.ok(!blockViews(base).some(view => view.id === 'zufallsfund'));
});
