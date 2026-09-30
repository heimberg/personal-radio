import { test } from 'node:test';
import assert from 'node:assert/strict';
import { activeSlot, ConfigError, defaultStationConfig, parseStationConfig } from '../src/domain/station.ts';
import type { StationConfig } from '../src/domain/station.ts';
import type { EditorialDirection, Profile, Script, Source } from '../src/domain/program.ts';
import { StationStore } from '../server/station-store.ts';
import { resolveAgents } from '../src/domain/agents.ts';
import { arrangeTimeline, planTimeline, produceItem, removeItem, scheduleShowNow, shuffleTimeline, tick, toView, transcriptView } from '../server/station.ts';
import { MUSIC_SHOW_ID } from '../src/domain/station.ts';
import type { StationDeps } from '../server/station.ts';
import { PipelineError } from '../server/segment-pipeline.ts';
import { ProviderError } from '../server/providers.ts';
import type { FeedItem } from '../server/feed.ts';
import { sqliteD1 } from './d1-sqlite.ts';

const OWNER = 'owner@example.test';
const NOW = new Date('2026-09-27T08:00:00Z');
const profile: Profile = { topics: ['Wissenschaft'], interests: ['Raumfahrt'], interestWeights: {}, speechMinutes: 2, exploration: 0 };

function config(overrides: Partial<StationConfig> = {}): StationConfig {
  const base = defaultStationConfig({ profile, feeds: [{ name: 'Wissen', url: 'https://feeds.example.test/wissen.xml' }] });
  // Feed-path tests: the web research show is covered separately below.
  base.shows = base.shows.map(show => show.id === 'entdecken' ? { ...show, enabled: false } : show);
  // Songs between items are covered by their own tests.
  base.music = { ...base.music, between: 0 };
  return parseStationConfig({ ...base, ...overrides });
}

function feedItems(count: number): FeedItem[] {
  return Array.from({ length: count }, (_, index) => ({ id: `feed-${index + 1}`, title: `Raumfahrt Meldung ${index + 1}`,
    url: `https://news.example.test/${index + 1}`, excerpt: `Auszug ${index + 1}.`, publishedAt: new Date(Date.parse('2026-09-26T20:00:00Z') - index * 3_600_000).toISOString() }));
}

function harness(options: { items?: FeedItem[]; station?: StationConfig } = {}) {
  const db = sqliteD1(), store = new StationStore(db);
  let clock = NOW, ids = 0;
  const calls: { draft: number; review: number; voice: number; feeds: number; direction?: EditorialDirection } = { draft: 0, review: 0, voice: 0, feeds: 0 };
  const behaviour: { draft?: () => void; review?: () => void; voice?: () => void } = {};
  const bucket = new Map<string, Uint8Array>();
  const deps: StationDeps = {
    store, podcastAvailable: false, now: () => clock, random: () => 0.99, newId: () => `item-${++ids}`,
    fetchFeed: async () => { calls.feeds++; return options.items ?? feedItems(3); },
    reserveFeed: async () => {}, reserveGeneration: async () => {},
    audio: { put: async (key, value) => { bucket.set(key, value); }, delete: async key => { bucket.delete(key); } },
    pipeline: {
      draft: async (_profile: Profile, sources: Source[], _mode, direction?: EditorialDirection): Promise<Script> => {
        calls.draft++; calls.direction = direction; behaviour.draft?.();
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
  assert.throws(broken(c => { c.shows.forEach((show: any) => { show.enabled = false; }); }), /KI-Sprechbeiträge sind Pflicht/);
});

test('older stored configs without name and host get the default persona; host fields are validated', () => {
  const legacy = structuredClone(config()) as any; delete legacy.name; delete legacy.host;
  const parsed = parseStationConfig(legacy);
  assert.equal(parsed.name, 'Personal Radio'); assert.equal(parsed.host.name, 'Mira'); assert.equal(parsed.host.cohostName, 'Jonas');
  assert.throws(() => parseStationConfig({ ...parsed, host: { ...parsed.host, name: '' } }), /host\.name: darf nicht leer sein/);
  assert.throws(() => parseStationConfig({ ...parsed, host: { ...parsed.host, tone: 'x'.repeat(161) } }), /host\.tone/);
  const solo = parseStationConfig({ ...parsed, host: { name: 'Lou', tone: 'trocken', style: 'Nachtradio', instructions: '', cohostName: ' ' } });
  assert.equal(solo.host.cohostName, undefined);
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
  assert.deepEqual(h.calls.direction, { instructions: '', targetMinutes: 2, stationName: 'Personal Radio', persona: config().host, avoidTopics: [], agents: resolveAgents(undefined), listenerNotes: [] });
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

test('stale items leave the program: unfinished ones expire, unheard productions stay in the archive until their audio is released', async () => {
  const h = harness(); await h.setup();
  const [id, other] = (await tick(h.deps, OWNER)).due;
  await produceItem(h.deps, OWNER, id);
  h.advance(13 * 60);
  const result = await tick(h.deps, OWNER);
  assert.equal(result.expired, 10);
  assert.equal((await h.store.getItem(OWNER, id))?.state, 'archived');
  assert.equal((await h.store.getItem(OWNER, other))?.state, 'expired');
  assert.equal(h.bucket.size, 1);
  assert.deepEqual((await h.store.library(OWNER)).map(row => row.id), [id]);
  assert.equal(toView((await h.store.getItem(OWNER, id))!, null).audioUrl, `api/timeline/${id}/audio`);
  assert.equal(result.planned, 10); // fresh program replaces the stale one
  // After the retention period the audio is released and the item leaves the archive.
  h.advance(7 * 24 * 60 + 1);
  await tick(h.deps, OWNER);
  assert.equal(h.bucket.size, 0);
  assert.deepEqual(await h.store.library(OWNER), []);
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

test('show config defaults to Gemini and feeds; dialogs require Gemini; defaults without feeds research the web', () => {
  const legacy = structuredClone(config()) as any;
  delete legacy.shows[0].textProvider; delete legacy.shows[0].sourceMode; delete legacy.shows[0].researchPrompt;
  const parsed = parseStationConfig(legacy);
  assert.deepEqual([parsed.shows[0].textProvider, parsed.shows[0].sourceMode, parsed.shows[0].researchPrompt], ['gemini', 'feeds', '']);
  const dialogWithAsk = structuredClone(parsed) as any; dialogWithAsk.shows[1].textProvider = 'ask';
  assert.throws(() => parseStationConfig(dialogWithAsk), /Dialoge schreibt nur «gemini»/);
  const noFeeds = defaultStationConfig({ profile });
  assert.deepEqual(noFeeds.shows.filter(show => show.enabled).map(show => [show.id, show.sourceMode]), [['entdecken', 'web']]);
});

test('web shows research with Google grounding, remember recent topics and store the search queries', async () => {
  const station = config();
  station.shows = station.shows.map(show => ({ ...show, enabled: show.id === 'entdecken' }));
  const h = harness({ station: parseStationConfig(station) }); await h.setup();
  const requests: any[] = [];
  h.deps.researcher = { research: async request => {
    requests.push(request);
    return { queries: ['neue raumsonde'], sources: [{ id: 'w1', url: 'https://example.org/sonde', title: 'example.org', excerpt: 'Die Sonde startet 2027.', publishedAt: NOW.toISOString(), retrievedAt: NOW.toISOString() }] };
  } };
  const generator = { generate: async () => { throw new Error('the pipeline double is used instead'); } };
  h.deps.generator = (provider, format) => provider === 'gemini' && format === 'brief' ? generator : undefined;
  const due = (await tick(h.deps, OWNER)).due;
  assert.equal(await produceItem(h.deps, OWNER, due[0]), 'ready');
  assert.equal(requests[0].brief, station.shows.find(show => show.id === 'entdecken')!.researchPrompt);
  assert.deepEqual(requests[0].interests, ['Wissenschaft', 'Raumfahrt']);
  assert.deepEqual(requests[0].avoidTopics, []);
  assert.equal(h.calls.feeds, 0);
  const view = toView((await h.store.getItem(OWNER, due[0]))!, station);
  assert.deepEqual(view.searchQueries, ['neue raumsonde']);
  assert.deepEqual(view.sources, [{ title: 'example.org', url: 'https://example.org/sonde' }]);
  // The next draft is told what already ran.
  assert.equal(await produceItem(h.deps, OWNER, due[1]), 'ready');
  assert.deepEqual(requests[1].avoidTopics, ['Beitrag über example.org']);
  assert.deepEqual(h.calls.direction?.avoidTopics, ['Beitrag über example.org']);
  // Without Gemini a web show fails clearly instead of silently using feeds.
  h.deps.researcher = undefined;
  assert.equal(await produceItem(h.deps, OWNER, due[2]), 'failed');
  assert.equal((await h.store.getItem(OWNER, due[2]))?.error, 'GEMINI_NOT_CONFIGURED');
});

test('a show whose text provider is not configured fails with a clear reason', async () => {
  const station = config(); station.shows[0].textProvider = 'ask';
  const h = harness({ station }); await h.setup();
  h.deps.generator = provider => provider === 'gemini' ? { generate: async () => ({ title: '', text: '', sourceIds: [] }) } : undefined;
  const [id] = (await tick(h.deps, OWNER)).due;
  assert.equal(await produceItem(h.deps, OWNER, id), 'failed');
  assert.equal((await h.store.getItem(OWNER, id))?.error, 'ASK_NOT_CONFIGURED');
});

test('rate limits defer the item for the requested time without using an attempt or pausing planning', async () => {
  const station = config();
  station.shows = station.shows.map(show => ({ ...show, enabled: show.id === 'entdecken' }));
  const h = harness({ station: parseStationConfig(station) }); await h.setup();
  let limited = true;
  h.deps.researcher = { research: async () => {
    if (limited) throw new ProviderError('Gemini research', 429, { detail: 'Quota exceeded', retryAfterMs: 30 * 60_000 });
    return { queries: [], sources: [{ id: 'w1', url: 'https://example.org/a', title: 'example.org', excerpt: 'Satz.', publishedAt: NOW.toISOString(), retrievedAt: NOW.toISOString() }] };
  } };
  const due = (await tick(h.deps, OWNER)).due;
  for (const id of due.slice(0, 4)) assert.equal(await produceItem(h.deps, OWNER, id), 'deferred');
  const waiting = await h.store.getItem(OWNER, due[0]);
  assert.equal(waiting?.state, 'planned'); assert.equal(waiting?.attempts, 0);
  assert.equal(waiting?.lease_until, '2026-09-27T08:30:00.000Z');
  assert.equal(waiting?.error, 'Gemini research request failed (429): Quota exceeded');
  assert.equal(await h.store.recentFailures(OWNER, new Date(0)), 0);
  assert.equal((await tick(h.deps, OWNER)).due.length, due.length - 4); // deferred items wait for their lease
  // A short provider delay still waits at least two minutes; afterwards production resumes.
  limited = false; h.advance(31);
  assert.equal(await produceItem(h.deps, OWNER, due[0]), 'ready');
});

test('a rate-limited verifier defers instead of rejecting the draft', async () => {
  const h = harness(); await h.setup();
  const [id] = (await tick(h.deps, OWNER)).due;
  h.behaviour.review = () => { throw new ProviderError('Gemini verification', 429); };
  assert.equal(await produceItem(h.deps, OWNER, id), 'deferred');
  assert.equal((await h.store.getItem(OWNER, id))?.lease_until, '2026-09-27T08:02:00.000Z');
});

test('a manual retry produces recent failures again, restarts waiting ones and lifts the failure pause', async () => {
  const h = harness({ items: [] }); await h.setup();
  const due = (await tick(h.deps, OWNER)).due;
  for (const id of due.slice(0, 3)) assert.equal(await produceItem(h.deps, OWNER, id), 'failed');
  h.deps.researcher = undefined;
  h.behaviour.voice = () => { throw new ProviderError('Mistral', 429); };
  h.deps.fetchFeed = async () => feedItems(3);
  assert.equal(await produceItem(h.deps, OWNER, due[3]), 'deferred');
  assert.equal((await tick(h.deps, OWNER)).planned, 0); // paused by three failures
  assert.deepEqual(await h.store.retryNow(OWNER, NOW), { retried: 3, retired: 0, restarted: 1 });
  for (const id of due.slice(0, 3)) {
    const again = await h.store.getItem(OWNER, id);
    assert.equal(again?.state, 'planned'); assert.equal(again?.error, null); assert.equal(again?.attempts, 0); assert.equal(again?.script_json, null);
  }
  const restarted = await h.store.getItem(OWNER, due[3]);
  assert.equal(restarted?.lease_until, null); assert.equal(restarted?.state, 'voicing');
  const after = await tick(h.deps, OWNER);
  // The pause is lifted: the failed items are due again, and so is the waiting one.
  assert.ok(due.slice(0, 3).every(id => after.due.includes(id)));
  assert.ok(after.due.includes(due[3]));
  h.behaviour.voice = undefined;
  assert.equal(await produceItem(h.deps, OWNER, due[3]), 'ready');
  assert.equal(h.calls.draft, 1); // the approved script was kept
});

test('the host persona\'s voice is used unless the show sets its own; rejections keep their reason', async () => {
  const station = config(); station.host = { ...station.host, voiceId: 'host-voice' };
  const h = harness({ station }); await h.setup();
  const voices: Array<string | undefined> = [];
  h.deps.pipeline.voice = async (_owner, _script, _format, voiceId) => { voices.push(voiceId); return { audio: new Uint8Array([1]), contentType: 'audio/mpeg', ttsCharacters: 1 }; };
  const due = (await tick(h.deps, OWNER)).due;
  await produceItem(h.deps, OWNER, due[0]);
  assert.deepEqual(voices, ['host-voice']);
  h.behaviour.review = () => { throw new PipelineError('REJECTED', 'Nicht belegt: «Mars»'); };
  assert.equal(await produceItem(h.deps, OWNER, due[1]), 'failed');
  assert.equal((await h.store.getItem(OWNER, due[1]))?.error, 'REJECTED: Nicht belegt: «Mars»');
  assert.equal(defaultStationConfig().host.voiceId, 'gemini_Laomedeia');
});

test('failures are summarised, cleaned up on request and purged automatically after a day', async () => {
  const h = harness({ items: [] }); await h.setup();
  const due = (await tick(h.deps, OWNER)).due;
  for (const id of due.slice(0, 3)) await produceItem(h.deps, OWNER, id);
  const summary = await h.store.failureSummary(OWNER);
  assert.equal(summary.count, 3); assert.equal(summary.latestError, 'NO_SOURCES');
  const visible = await h.store.visibleItems(OWNER);
  assert.ok(visible.every(row => row.state !== 'failed' && row.state !== 'expired'));
  assert.equal(visible.length, due.length - 3);
  // Manual cleanup removes all failed and expired rows.
  assert.deepEqual(await h.store.purge(OWNER), { removed: 3, audioKeys: [] });
  assert.equal((await h.store.failureSummary(OWNER)).count, 0);
  // Automatic purge: only rows older than a day go.
  h.db.raw.prepare(`UPDATE timeline_items SET state = 'failed', updated_at = ? WHERE id = ?`).run('2026-09-26T07:00:00.000Z', due[3]);
  h.db.raw.prepare(`UPDATE timeline_items SET state = 'failed', updated_at = ? WHERE id = ?`).run('2026-09-27T07:30:00.000Z', due[4]);
  await tick(h.deps, OWNER);
  assert.equal(await h.store.getItem(OWNER, due[3]), null);
  assert.equal((await h.store.getItem(OWNER, due[4]))?.state, 'failed');
});

test('an artist hour researches, resolves picks on Spotify, writes moderations and voices part by part', async () => {
  const station = config();
  station.shows = station.shows.map(show => show.id === 'kuenstler' ? { ...show, enabled: true, artist: 'Portishead', tracks: 3 } : { ...show, enabled: false });
  const h = harness({ station: parseStationConfig(station) }); await h.setup();
  const dossier = [{ id: 'w1', url: 'https://example.org/p', title: 'example.org', excerpt: 'Dummy erschien 1994.', publishedAt: NOW.toISOString(), retrievedAt: NOW.toISOString() }];
  const researched: string[] = [];
  h.deps.researcher = { research: async request => { researched.push(request.brief); return { sources: dossier, queries: ['portishead dummy'] }; } };
  const spotifyAsked: string[] = [];
  h.deps.catalog = { find: async pick => { spotifyAsked.push(pick.title); return pick.title === 'Unbekannt' ? null : { uri: `spotify:track:${pick.title.replace(/\W/g, '')}`, durationMs: 240_000 }; } };
  let hourInput: any;
  h.deps.musicWriter = {
    pickSubject: async () => { throw new Error('the artist is fixed'); },
    pickTracks: async () => ['Glory Box', 'Unbekannt', 'Roads', 'Sour Times', 'Numb'].map(title => ({ title, artist: 'Portishead', reason: 'r' })),
    pickSongs: async () => [], writeBlock: async () => [],
    writeHour: async input => { hourInput = input; return { title: 'Portishead', intro: { text: 'Willkommen.', sourceIds: ['w1'] },
      tracks: [{ index: 0, text: 'Zu Glory Box.', sourceIds: ['w1'] }, { index: 2, text: 'Zu Sour Times.', sourceIds: [] }], outro: { text: 'Danke.', sourceIds: [] } }; },
  };
  let voiceCalls = 0, failAt = 3;
  h.deps.pipeline.voice = async (_owner, script, _format, voiceId, style) => {
    voiceCalls++;
    if (voiceCalls === failAt) throw new Error('Mistral request failed (503)');
    assert.equal(voiceId, 'gemini_Laomedeia');
    assert.match(style ?? '', /begeisterte Radiomoderatorin/);
    return { audio: new TextEncoder().encode(script.text), contentType: 'audio/mpeg', ttsCharacters: script.text.length };
  };
  // The hour is not in the program clock: "Jetzt produzieren" plans it directly.
  const id = (await scheduleShowNow(h.deps, OWNER, 'kuenstler'))!;
  assert.equal((await h.store.getItem(OWNER, id))?.estimated_minutes, 60);
  assert.equal(await produceItem(h.deps, OWNER, id), 'retry');
  assert.match(researched[0], /Künstler-Stunde über Portishead/);
  assert.deepEqual(spotifyAsked, ['Glory Box', 'Unbekannt', 'Roads', 'Sour Times']); // stops once 3 tracks resolved
  assert.deepEqual(hourInput.picks.map((pick: { title: string }) => pick.title), ['Glory Box', 'Roads', 'Sour Times']);
  assert.equal(h.calls.review, 1);
  // Two parts were voiced before the failure; the retry voices only the rest.
  h.advance(11); failAt = 0;
  assert.equal(await produceItem(h.deps, OWNER, id), 'ready');
  assert.equal(voiceCalls, 5); // intro, Glory Box, (failed), Sour Times, outro
  const view = toView((await h.store.getItem(OWNER, id))!, parseStationConfig(station));
  assert.equal(view.title, 'Portishead'); assert.equal(view.artist, 'Portishead'); assert.equal(view.audioUrl, undefined);
  assert.equal(view.focus, 'artist'); assert.equal(view.subject, 'Portishead');
  assert.equal(hourInput.focus, 'artist'); assert.equal(hourInput.subject, 'Portishead');
  assert.deepEqual(view.parts!.map(part => part.kind === 'track' ? part.title : part.audioUrl), [
    `api/timeline/${id}/audio?part=0`, `api/timeline/${id}/audio?part=1`, 'Glory Box', 'Roads',
    `api/timeline/${id}/audio?part=4`, 'Sour Times', `api/timeline/${id}/audio?part=6`,
  ]);
  assert.equal(h.bucket.size, 4);
  const transcript = transcriptView((await h.store.getItem(OWNER, id))!, null);
  assert.deepEqual(transcript.lines.filter(line => line.song).map(line => line.text), ['Glory Box – Portishead', 'Roads – Portishead', 'Sour Times – Portishead']);
  assert.ok(transcript.lines.filter(line => !line.song).every(line => line.text.trim()));
  // Unheard, the hour moves to the archive with its audio; after the retention period every part is released.
  h.advance(13 * 60);
  await tick(h.deps, OWNER);
  assert.equal(h.bucket.size, 4);
  h.advance(7 * 24 * 60 + 1);
  await tick(h.deps, OWNER);
  assert.equal(h.bucket.size, 0);
  assert.ok(toView((await h.store.getItem(OWNER, id))!, null).parts!.every(part => part.kind === 'track' || !part.audioUrl));
});

test('an artist hour without enough Spotify matches fails with the count; missing Spotify is reported', async () => {
  const station = config();
  station.shows = station.shows.map(show => show.id === 'kuenstler' ? { ...show, enabled: true } : { ...show, enabled: false });
  const h = harness({ station: parseStationConfig(station) }); await h.setup();
  const due = [(await scheduleShowNow(h.deps, OWNER, 'kuenstler'))!];
  h.deps.researcher = { research: async () => ({ sources: [{ id: 'w1', url: 'https://example.org/p', title: 't', excerpt: 'x', publishedAt: NOW.toISOString(), retrievedAt: NOW.toISOString() }], queries: [] }) };
  h.deps.musicWriter = { pickSongs: async () => [], writeBlock: async () => [], pickSubject: async () => ({ subject: 'Björk', reason: 'r' }), pickTracks: async () => [{ title: 'A', artist: 'Björk', reason: '' }, { title: 'B', artist: 'Björk', reason: '' }],
    writeHour: async () => { throw new Error('not reached'); } };
  assert.equal(await produceItem(h.deps, OWNER, due[0]), 'failed');
  assert.equal((await h.store.getItem(OWNER, due[0]))?.error, 'SPOTIFY_NOT_CONFIGURED');
  const id = await scheduleShowNow(h.deps, OWNER, 'kuenstler');
  h.deps.catalog = { find: async pick => pick.title === 'A' ? { uri: 'spotify:track:a', durationMs: 1 } : null };
  assert.equal(await produceItem(h.deps, OWNER, id!), 'failed');
  assert.equal((await h.store.getItem(OWNER, id!))?.error, 'TOO_FEW_TRACKS: 1 von 2 Songs auf Spotify gefunden');
  assert.equal(await scheduleShowNow(h.deps, OWNER, 'gibt-es-nicht'), null);
});

test('a theme hour lets the AI pick a new theme, researches it and programs fitting songs by different artists', async () => {
  const station = config();
  station.shows = station.shows.map(show => show.id === 'thema' ? { ...show, enabled: true, tracks: 3 } : { ...show, enabled: false });
  const parsed = parseStationConfig(station);
  const theme = parsed.shows.find(show => show.id === 'thema')!;
  assert.equal(theme.format, 'theme_hour'); assert.equal(theme.talkSeconds, 120); assert.equal(theme.theme, undefined);
  const h = harness({ station: parsed }); await h.setup();
  const source = { id: 'w1', url: 'https://example.org/mond', title: 'example.org', excerpt: 'Apollo 11 landete 1969.', publishedAt: NOW.toISOString(), retrievedAt: NOW.toISOString() };
  const asked: Array<{ focus: string; avoid: string[] }> = [], briefs: string[] = [];
  let tracksInput: any;
  h.deps.researcher = { research: async request => { briefs.push(request.brief); return { sources: [source], queries: [] }; } };
  h.deps.catalog = { find: async pick => ({ uri: `spotify:track:${pick.title.replace(/\W/g, '')}`, durationMs: 200_000 }) };
  h.deps.musicWriter = {
    pickSongs: async () => [], writeBlock: async () => [],
    pickSubject: async input => { asked.push({ focus: input.focus, avoid: input.avoid }); return { subject: asked.length === 1 ? 'Der Mond' : 'Vulkane', reason: 'r' }; },
    pickTracks: async input => { tracksInput = input; return [['Space Oddity', 'David Bowie'], ['Fly Me to the Moon', 'Frank Sinatra'], ['Walking on the Moon', 'The Police']].map(([title, artist]) => ({ title, artist, reason: 'r' })); },
    writeHour: async input => ({ title: `Themen-Stunde: ${input.subject}`, intro: { text: 'Heute der Mond.', sourceIds: ['w1'] },
      tracks: [0, 1, 2].map(index => ({ index, text: `Kapitel ${index}.`, sourceIds: ['w1'] })), outro: { text: 'Gute Nacht.', sourceIds: [] } }),
  };
  const id = (await scheduleShowNow(h.deps, OWNER, 'thema'))!;
  assert.equal(await produceItem(h.deps, OWNER, id), 'ready');
  assert.deepEqual(asked[0], { focus: 'theme', avoid: [] });
  assert.match(briefs[0], /^Themen-Stunde über Der Mond/);
  assert.equal(tracksInput.focus, 'theme'); assert.equal(tracksInput.subject, 'Der Mond');
  const view = toView((await h.store.getItem(OWNER, id))!, parsed);
  assert.equal(view.focus, 'theme'); assert.equal(view.subject, 'Der Mond'); assert.equal(view.artist, undefined);
  assert.deepEqual(view.parts!.flatMap(part => part.kind === 'track' ? [part.artist] : []), ['David Bowie', 'Frank Sinatra', 'The Police']);
  // The next theme hour avoids the recent theme.
  const next = (await scheduleShowNow(h.deps, OWNER, 'thema'))!;
  assert.equal(await produceItem(h.deps, OWNER, next), 'ready');
  assert.deepEqual(asked[1], { focus: 'theme', avoid: ['Der Mond'] });
});

test('music hour settings: fixed genre or theme, per-kind defaults, Gemini only; old artist hour packages still show', () => {
  const station = config();
  station.shows = [...station.shows.filter(show => show.id !== 'genre'), { id: 'genre', name: 'Genre', enabled: false, format: 'genre_hour', feedIds: [], verification: 'light',
    textProvider: 'gemini', sourceMode: 'web', researchPrompt: '', instructions: '', targetMinutes: 45, genre: ' Krautrock ' } as never];
  const genre = parseStationConfig(station).shows.find(show => show.id === 'genre')!;
  assert.equal(genre.genre, 'Krautrock'); assert.equal(genre.tracks, 10); assert.equal(genre.talkSeconds, 60);
  assert.throws(() => parseStationConfig({ ...station, shows: station.shows.map(show => show.id === 'genre' ? { ...show, textProvider: 'ask' } : show) }), /Musikstunden schreibt nur/);
  assert.throws(() => parseStationConfig({ ...station, shows: station.shows.map(show => show.id === 'genre' ? { ...show, talkSeconds: 200 } : show) }), /talkSeconds/);
  assert.throws(() => parseStationConfig({ ...station, shows: station.shows.map(show => show.id === 'genre' ? { ...show, format: 'jingle' } : show) }), /theme_hour/);
  const legacy = { kind: 'artist_hour', title: 'Björk', artist: 'Björk', text: '', sourceIds: [], parts: [{ kind: 'track', uri: 'spotify:track:x', title: 'Joga', artist: 'Björk', durationMs: 1 }] };
  const view = toView({ id: 'x', seq: 1, show_id: 'kuenstler', planned_at: NOW.toISOString(), state: 'ready', estimated_minutes: 60, script_json: JSON.stringify(legacy) } as never, null);
  assert.equal(view.focus, 'artist'); assert.equal(view.subject, 'Björk'); assert.equal(view.artist, 'Björk');
});

test('music between items: the planner puts the configured number of songs after every spoken item, also across runs', () => {
  let n = 0; const newId = () => `x${++n}`;
  const station = config({ music: { between: 1, announce: true, taste: 'Industrial, Indie, Rock' }, horizonMinutes: 20 });
  const shows = (items: Array<{ showId: string }>) => items.map(item => item.showId === MUSIC_SHOW_ID ? '♫' : item.showId);
  const first = planTimeline(station, [], null, NOW, newId);
  assert.deepEqual(shows(first), ['kurz', '♫', 'kurz', '♫', 'kurz', '♫', 'kurz']);
  assert.equal(first[1].estimatedMinutes, 4);
  // Two songs between items; a run that starts after a spoken item owes its songs first.
  const two = config({ music: { between: 2, announce: true, taste: '' }, horizonMinutes: 20 });
  assert.deepEqual(shows(planTimeline(two, [], { seq: 5, show_id: 'kurz' }, NOW, newId, ['kurz'])), ['♫', '♫', 'kurz', '♫', '♫', 'kurz']);
  assert.deepEqual(shows(planTimeline(two, [], { seq: 5, show_id: MUSIC_SHOW_ID }, NOW, newId, ['kurz', MUSIC_SHOW_ID])), ['♫', 'kurz', '♫', '♫', 'kurz', '♫']);
  // Music hours bring their own music.
  const hours = config({ music: { between: 1, announce: true, taste: '' }, horizonMinutes: 120,
    schedule: [{ id: 'immer', days: [0, 1, 2, 3, 4, 5, 6], from: '00:00', to: '24:00', showIds: ['kuenstler'] }],
    shows: config().shows.map(show => show.id === 'kuenstler' ? { ...show, enabled: true } : show) });
  assert.deepEqual(shows(planTimeline(hours, [], null, NOW, newId)), ['kuenstler', 'kuenstler']);
});

test('a song item: AI picks from taste and reactions, Spotify resolves the first it knows, the host announces it', async () => {
  const station = config({ music: { between: 1, announce: true, taste: 'Industrial, Indie, Rock' } });
  const h = harness({ station }); await h.setup();
  const requests: any[] = [];
  h.deps.catalog = { find: async pick => pick.title === 'Gibt es nicht' ? null : { uri: `spotify:track:${pick.title.replace(/\W/g, '')}`, durationMs: 250_000 } };
  h.deps.musicWriter = {
    pickSubject: async () => { throw new Error('unused'); }, pickTracks: async () => [], writeHour: async () => { throw new Error('unused'); }, writeBlock: async () => [],
    pickSongs: async request => {
      requests.push(request);
      return requests.length === 1
        ? [{ title: 'Gibt es nicht', artist: 'Niemand', announcement: 'x' }, { title: 'Closer', artist: 'Nine Inch Nails', announcement: 'Jetzt: Nine Inch Nails mit Closer.' }]
        : [{ title: 'Hurt', artist: 'Nine Inch Nails', announcement: '' }];
    },
  };
  const voiced: string[] = [];
  h.deps.pipeline.voice = async (_owner, script, _mode, voiceId) => { voiced.push(`${voiceId}: ${script.text}`); return { audio: new Uint8Array([1]), contentType: 'audio/wav', ttsCharacters: 1 }; };
  h.deps.listening = { topArtists: async () => ['Nine Inch Nails', 'Protomartyr'] };
  const planned = planTimeline(station, [], null, NOW, () => 'song-1').filter(item => item.showId === MUSIC_SHOW_ID)[0];
  await h.store.insertItem(OWNER, { ...planned, id: 'song-1' }, NOW);
  assert.equal(await produceItem(h.deps, OWNER, 'song-1'), 'ready');
  assert.equal(requests[0].taste, 'Industrial, Indie, Rock'); assert.equal(requests[0].announce, true);
  assert.deepEqual(requests[0].listens, ['Nine Inch Nails', 'Protomartyr']);
  assert.deepEqual(voiced, ['gemini_Laomedeia: Jetzt: Nine Inch Nails mit Closer.']);
  const view = toView((await h.store.getItem(OWNER, 'song-1'))!, station);
  assert.equal(view.showName, 'Musik'); assert.equal(view.title, 'Nine Inch Nails – Closer'); assert.equal(view.estimatedMinutes, 4);
  assert.deepEqual(view.parts, [{ kind: 'speech', audioUrl: 'api/timeline/song-1/audio?part=0' }, { kind: 'track', spotifyUri: 'spotify:track:Closer', title: 'Closer', artist: 'Nine Inch Nails', durationMs: 250_000 }]);

  // The owner liked it; the next pick knows, and avoids repeating it. Without an announcement only the track plays.
  await h.store.addFeedback(OWNER, { itemId: 'song-1', interests: [], action: 'like', listenedRatio: 1, createdAt: NOW.toISOString() });
  await h.store.saveConfig(OWNER, { ...station, music: { ...station.music, announce: false } }, NOW);
  await h.store.insertItem(OWNER, { ...planned, id: 'song-2', seq: planned.seq + 1 }, NOW);
  assert.equal(await produceItem(h.deps, OWNER, 'song-2'), 'ready');
  assert.deepEqual(requests[1].liked, ['Nine Inch Nails – Closer']); assert.deepEqual(requests[1].avoid, ['Nine Inch Nails – Closer']);
  assert.equal(requests[1].announce, false);
  assert.deepEqual(toView((await h.store.getItem(OWNER, 'song-2'))!, station).parts!.map(part => part.kind), ['track']);
});

test('music settings: stations saved before music keep it off; bounds are checked', () => {
  const legacy = structuredClone(config()) as any; delete legacy.music;
  assert.deepEqual(parseStationConfig(legacy).music, { between: 0, announce: true, taste: '' });
  assert.deepEqual(defaultStationConfig().music, { between: 1, announce: true, taste: '' });
  assert.throws(() => parseStationConfig({ ...legacy, music: { between: 4 } }), /music\.between/);
  assert.throws(() => parseStationConfig({ ...legacy, music: { between: 1, taste: 'x'.repeat(501) } }), /music\.taste/);
});

test('arranging, removing and shuffling the program keeps it consistent and puts songs between spoken items', async () => {
  const station = config({ music: { between: 1, announce: true, taste: '' } });
  const h = harness({ station }); await h.setup();
  const ids: string[] = [];
  for (const [index, showId] of ['kurz', 'kurz', 'kurz', MUSIC_SHOW_ID].entries()) {
    const id = `i${index + 1}`; ids.push(id);
    await h.store.insertItem(OWNER, { id, seq: index + 1, showId, plannedAt: new Date(NOW.getTime() + index * 60_000).toISOString(), estimatedMinutes: showId === MUSIC_SHOW_ID ? 4 : 2 }, NOW);
  }
  const order = async () => (await h.store.openItems(OWNER)).map(row => row.id);
  assert.equal(await arrangeTimeline(h.deps, OWNER, ['i4', 'i1', 'i3', 'i2']), true);
  assert.deepEqual(await order(), ['i4', 'i1', 'i3', 'i2']);
  const open = await h.store.openItems(OWNER);
  assert.deepEqual(open.map(row => row.planned_at), [0, 4, 6, 8].map(minute => new Date(NOW.getTime() + minute * 60_000).toISOString()));
  // A stale order is refused and changes nothing.
  assert.equal(await arrangeTimeline(h.deps, OWNER, ['i1', 'i2']), false);
  assert.deepEqual(await order(), ['i4', 'i1', 'i3', 'i2']);

  h.bucket.set('segments/i3.mp3', new Uint8Array([1]));
  await h.store.update(OWNER, 'i3', { state: 'ready', audio_key: 'segments/i3.mp3' }, NOW);
  assert.equal(await removeItem(h.deps, OWNER, 'i3'), true);
  assert.equal(h.bucket.size, 0);
  assert.deepEqual(await order(), ['i4', 'i1', 'i2']);
  assert.equal(await removeItem(h.deps, OWNER, 'i3'), false);

  // Two spoken items and one song: the song goes between them; nothing needs adding.
  assert.deepEqual(await shuffleTimeline(h.deps, OWNER), []);
  let shows = (await h.store.openItems(OWNER)).map(row => row.show_id);
  assert.deepEqual(shows, ['kurz', MUSIC_SHOW_ID, 'kurz']);
  // A third spoken item needs a second song, which the shuffle adds for production.
  await h.store.insertItem(OWNER, { id: 'i5', seq: 99, showId: 'kurz', plannedAt: NOW.toISOString(), estimatedMinutes: 2 }, NOW);
  const added = await shuffleTimeline(h.deps, OWNER);
  assert.equal(added!.length, 1);
  shows = (await h.store.openItems(OWNER)).map(row => row.show_id);
  assert.deepEqual(shows, ['kurz', MUSIC_SHOW_ID, 'kurz', MUSIC_SHOW_ID, 'kurz']);
  // The planner continues after the arranged tail.
  assert.equal((await h.store.lastItem(OWNER))?.show_id, 'kurz');
});

test('a music hour retries research once and, if search stays empty, is written from general knowledge and marked unverified', async () => {
  const station = config();
  station.shows = station.shows.map(show => show.id === 'kuenstler' ? { ...show, enabled: true, artist: 'Portishead', tracks: 3, verification: 'strict' as const } : { ...show, enabled: false });
  const parsed = parseStationConfig(station);
  const h = harness({ station: parsed }); await h.setup();
  const briefs: string[] = [];
  let writeInput: any, reviewed: string | undefined;
  h.deps.researcher = { research: async request => { briefs.push(request.brief); return { sources: [], queries: [] }; } };
  h.deps.catalog = { find: async pick => ({ uri: `spotify:track:${pick.title}`, durationMs: 200_000 }) };
  h.deps.pipeline.review = async (_script, _sources, policy) => { reviewed = policy; return { approved: true, reasons: [] }; };
  h.deps.musicWriter = {
    pickSubject: async () => { throw new Error('fixed'); }, pickSongs: async () => [], writeBlock: async () => [],
    pickTracks: async () => ['A', 'B', 'C'].map(title => ({ title, artist: 'Portishead', reason: 'r' })),
    writeHour: async input => { writeInput = input; return { title: 'Portishead', intro: { text: 'Hallo.', sourceIds: [] }, tracks: [0, 1, 2].map(index => ({ index, text: `Zu ${String.fromCharCode(65 + index)}.`, sourceIds: [] })), outro: { text: 'Tschüss.', sourceIds: [] } }; },
  };
  const id = (await scheduleShowNow(h.deps, OWNER, 'kuenstler'))!;
  assert.equal(await produceItem(h.deps, OWNER, id), 'ready');
  assert.equal(briefs.length, 3); assert.match(briefs[1], /^Suche mit Google nach: Portishead\./);
  assert.match(briefs[2], /Portishead – A.*Portishead – B.*Portishead – C/s);
  assert.deepEqual(writeInput.sources, []);
  assert.equal(reviewed, 'off');
  assert.equal(toView((await h.store.getItem(OWNER, id))!, parsed).verification, 'off');
});

test('music block settings: defaults, playlist links and IDs, at least one moderation trigger', () => {
  const base = config();
  const withBlock = (block: Record<string, unknown>) => parseStationConfig({ ...base, shows: [...base.shows, { id: 'block', name: 'Morgenmusik', enabled: true, format: 'music_block',
    feedIds: [], verification: 'off', targetMinutes: 30, instructions: '', ...block }] }).shows.at(-1)!;
  const plain = withBlock({});
  assert.deepEqual(plain.groups, [{ name: 'Mein Geschmack', playlists: [], taste: '' }]);
  assert.deepEqual(plain.triggers, { blockStart: true, blockEnd: true, beforeTrack: 1, afterTrack: 0, everyMinutes: 0, groupTransition: true });
  assert.equal(plain.switchAfterTracks, 3); assert.equal(plain.talkSeconds, 20);
  const id = '37i9dQZF1DX4sWSpwq3LiO';
  assert.deepEqual(withBlock({ groups: [{ name: 'Kaffee', playlists: [`https://open.spotify.com/intl-de/playlist/${id}?si=abc`, `spotify:playlist:${id}`, id] }] }).groups,
    [{ name: 'Kaffee', playlists: [id], taste: '' }]);
  assert.throws(() => withBlock({ groups: [{ name: 'X', playlists: ['https://example.org/playlist'] }] }), /groups\[0\]\.playlists\[0\]: Spotify-Playlist-Link/);
  assert.throws(() => withBlock({ groups: [] }), /mindestens eine Gruppe/);
  assert.throws(() => withBlock({ triggers: { blockStart: false, blockEnd: false, beforeTrack: 0, afterTrack: 0, everyMinutes: 0, groupTransition: false } }), /mindestens ein Moderations-Anlass/);
  assert.throws(() => withBlock({ textProvider: 'ask' }), /Musikblöcke moderiert nur «gemini»/);
  assert.throws(() => withBlock({ targetMinutes: 5 }), /10 bis 120 Minuten/);
});

test('a music block rotates playlist and AI groups, speaks where the triggers fire and never shows playlist tracks to the AI', async () => {
  const PLAYLIST = '37i9dQZF1DX4sWSpwq3LiO';
  const station = config({ music: { between: 1, announce: true, taste: 'Indie' } });
  station.shows = [...station.shows.map(show => ({ ...show, enabled: show.id === 'kurz' })), {
    id: 'block', name: 'Morgenmusik', enabled: true, format: 'music_block', feedIds: [], verification: 'off', targetMinutes: 20, instructions: '',
    textProvider: 'gemini', sourceMode: 'web', researchPrompt: '', talkSeconds: 20, switchAfterTracks: 2, switchAfterMinutes: 0,
    groups: [{ name: 'Kaffee', playlists: [PLAYLIST], taste: '' }, { name: 'Entdeckungen', playlists: [], taste: 'Krautrock' }],
    triggers: { blockStart: true, blockEnd: true, beforeTrack: 1, afterTrack: 0, everyMinutes: 0, groupTransition: true },
  }];
  station.schedule = [{ ...station.schedule[0], showIds: ['kurz', 'block'] }];
  station.horizonMinutes = 60;
  const parsed = parseStationConfig(station);
  // A block brings its own music: no songs are planned after it.
  assert.deepEqual(planTimeline(parsed, [], { seq: 1, show_id: 'kurz' }, NOW, (() => { let n = 0; return () => `p${++n}`; })(), ['kurz', MUSIC_SHOW_ID]).map(item => item.showId).slice(0, 3),
    ['block', 'kurz', MUSIC_SHOW_ID]);

  const h = harness({ station: parsed }); await h.setup();
  const secret = Array.from({ length: 5 }, (_, index) => ({ uri: `spotify:track:P${index + 1}`, title: `Geheim ${index + 1}`, artist: 'Privat', durationMs: 180_000 }));
  const loaded: string[] = [];
  h.deps.playlists = { tracks: async (_owner, id) => { loaded.push(id); return secret; } };
  h.deps.catalog = { find: async pick => ({ uri: `spotify:track:${pick.title}`, durationMs: 180_000 }) };
  const songRequests: any[] = [], blockRequests: any[] = [];
  let aiTitle = 0;
  h.deps.musicWriter = {
    pickSubject: async () => { throw new Error('unused'); }, pickTracks: async () => [], writeHour: async () => { throw new Error('unused'); },
    pickSongs: async request => { songRequests.push(request); return Array.from({ length: request.count ?? 3 }, () => ({ title: `A${++aiTitle}`, artist: 'Neu!', announcement: '' })); },
    writeBlock: async request => { blockRequests.push(request); return request.moments.map((_, index) => `Moderation ${index}.`); },
  };
  const spoken: string[] = [];
  h.deps.pipeline.voice = async (_owner, script) => { spoken.push(script.text); return { audio: new Uint8Array([1]), contentType: 'audio/mpeg', ttsCharacters: 1 }; };

  const first = (await scheduleShowNow(h.deps, OWNER, 'block'))!;
  assert.equal(await produceItem(h.deps, OWNER, first), 'ready');
  const view = toView((await h.store.getItem(OWNER, first))!, parsed);
  assert.deepEqual(view.parts!.map(part => part.kind === 'track' ? part.title : 'speech'),
    ['speech', 'Geheim 1', 'Geheim 2', 'speech', 'A1', 'speech', 'A2', 'speech', 'Geheim 3', 'Geheim 4', 'speech']);
  assert.equal(view.title, 'Morgenmusik'); assert.equal(view.subject, 'Kaffee → Entdeckungen'); assert.equal(view.verification, 'off');
  assert.equal(view.estimatedMinutes, 18);
  assert.deepEqual(loaded, [PLAYLIST]);
  const request = blockRequests[0];
  assert.deepEqual(request.moments.map((moment: any) => moment.triggers), [['block_start'], ['group_transition', 'before_track'], ['before_track'], ['group_transition'], ['block_end']]);
  assert.deepEqual(request.moments[1], { triggers: ['group_transition', 'before_track'], fromGroup: 'Kaffee', toGroup: 'Entdeckungen', next: { artist: 'Neu!', title: 'A1' } });
  assert.equal(request.blockName, 'Morgenmusik'); assert.equal(request.nextShow, 'Kurzbeitrag'); assert.equal(request.daytime, 'Morgen');
  assert.equal(songRequests[0].taste, 'Krautrock'); assert.equal(songRequests[0].announce, false);
  // Nothing from the owner's playlists reaches the AI.
  assert.doesNotMatch(JSON.stringify([songRequests, blockRequests]), /Geheim|Privat|spotify:track:P/);
  assert.deepEqual(spoken, ['Moderation 0.', 'Moderation 1.', 'Moderation 2.', 'Moderation 3.', 'Moderation 4.']);

  // The next block continues the rotation and prefers playlist tracks it has not played yet.
  const second = (await scheduleShowNow(h.deps, OWNER, 'block'))!;
  assert.equal(await produceItem(h.deps, OWNER, second), 'ready');
  const tracks = toView((await h.store.getItem(OWNER, second))!, parsed).parts!.flatMap(part => part.kind === 'track' ? [part.title] : []);
  assert.deepEqual(tracks.slice(0, 3), ['A5', 'A6', 'Geheim 5']);
  assert.ok(songRequests[1].avoid.includes('Neu! – A1'));
  assert.doesNotMatch(JSON.stringify(songRequests[1]), /Geheim/);
});

test('a music hour produced by the editorial team: same parts for the app, team summary in the timeline; production is validated', async () => {
  const station = config();
  station.shows = station.shows.map(show => show.id === 'kuenstler' ? { ...show, enabled: true, artist: 'Portishead', tracks: 3, production: 'agents' as const } : { ...show, enabled: false });
  const parsed = parseStationConfig(station);
  assert.equal(parsed.shows.find(show => show.id === 'kuenstler')!.production, 'agents');
  assert.equal(parseStationConfig(config()).shows.find(show => show.id === 'kuenstler')!.production, 'standard');
  assert.throws(() => parseStationConfig({ ...station, shows: station.shows.map(show => show.id === 'kuenstler' ? { ...show, production: 'robots' } : show) }), /production/);
  const h = harness({ station: parsed }); await h.setup();
  const researched: string[] = [];
  h.deps.researcher = { research: async request => { researched.push(request.brief); return { sources: [{ id: 'w1', url: `https://example.org/${researched.length}`, title: 't', excerpt: 'Beleg.', publishedAt: NOW.toISOString(), retrievedAt: NOW.toISOString() }], queries: [] }; } };
  h.deps.catalog = { find: async pick => ({ uri: `spotify:track:${pick.title}`, durationMs: 200_000 }) };
  h.deps.musicWriter = { pickSubject: async () => { throw new Error('fixed'); }, pickTracks: async () => { throw new Error('the team picks'); }, writeHour: async () => { throw new Error('the team writes'); }, pickSongs: async () => [] } as never;
  const hour = (label: string) => ({ title: 'Portishead', intro: { text: `${label} Hallo.`, sourceIds: ['w1'] }, tracks: [0, 1, 2].map(index => ({ index, text: `${label} ${index}.`, sourceIds: [`s${index + 1}w1`] })), outro: { text: 'Tschüss.', sourceIds: [] } });
  h.deps.agentModel = { askJson: async (_system, _input, label) => label === 'Gemini director' ? { title: 'Portishead', angle: 'a', songs: ['A', 'B', 'C'].map(title => ({ title, artist: 'Portishead', role: 'r', question: 'q' })), specialists: [] }
    : label === 'Gemini lyric analyst' ? { themes: 't', mood: 'm', confidence: 'hoch' } : label === 'Gemini fact checker' ? { issues: [] } : hour(label === 'Gemini segment editor' ? 'Entwurf' : 'Final') };
  const id = (await scheduleShowNow(h.deps, OWNER, 'kuenstler'))!;
  assert.equal(await produceItem(h.deps, OWNER, id), 'ready');
  assert.equal(researched.length, 4); // subject dossier plus one per song, no separate standard research
  const view = toView((await h.store.getItem(OWNER, id))!, parsed);
  assert.deepEqual(view.team, { songs: 3, specialists: 0, corrections: 0 });
  assert.deepEqual(view.parts!.map(part => part.kind), ['speech', 'speech', 'track', 'speech', 'track', 'speech', 'track', 'speech']);
  assert.equal(view.verification, 'light');
});
