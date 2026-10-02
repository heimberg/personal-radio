import { test } from 'node:test';
import assert from 'node:assert/strict';
import { defaultStationConfig, parseStationConfig } from '../src/domain/station.ts';
import type { EditorialDirection, Profile, Script, Source } from '../src/domain/program.ts';
import { StationStore } from '../server/station-store.ts';
import type { TimelineRow } from '../server/station-store.ts';
import { addBlock, produceItem, tick } from '../server/station.ts';
import type { StationDeps } from '../server/station.ts';
import { blockViews } from '../src/domain/blocks.ts';
import { REVIEW_SHOW, reviewSources, reviewable } from '../server/review.ts';
import { PlayStore } from '../server/play.ts';
import { sqliteD1 } from './d1-sqlite.ts';

const OWNER = 'owner@example.test';
// Sunday, 10:00 in Zurich.
const SUNDAY = new Date('2026-10-04T08:00:00Z');
const profile: Profile = { topics: ['Wissenschaft'], interests: ['Raumfahrt'], interestWeights: {}, speechMinutes: 2, exploration: 0 };

function harness() {
  const db = sqliteD1(), store = new StationStore(db), play = new PlayStore(db);
  let ids = 0, now = SUNDAY;
  const drafts: Array<{ sources: Source[]; direction?: EditorialDirection }> = [];
  const deps: StationDeps = {
    store, podcastAvailable: false, now: () => now, random: () => 0.99, newId: () => `id-${++ids}`,
    fetchFeed: async () => [], reserveFeed: async () => {}, reserveGeneration: async () => {},
    audio: { put: async () => {}, delete: async () => {} },
    week: (owner, since) => play.week(owner, since),
    pipeline: {
      draft: async (_profile, sources, _mode, direction): Promise<Script> => { drafts.push({ sources, direction }); return { title: 'Deine Woche', text: 'Was für eine Woche.', sourceIds: ['w1'] }; },
      review: async () => ({ approved: true, reasons: [] }),
      voice: async () => ({ audio: new Uint8Array([1]), contentType: 'audio/mpeg' as const, ttsCharacters: 1 }),
    },
  };
  const base = defaultStationConfig({ profile, feeds: [] });
  base.music = { ...base.music, between: 0 }; base.surprise = 0; base.timezone = 'Europe/Zurich';
  base.schedule = [{ id: 'nie', days: [3], from: '03:00', to: '03:30', showIds: ['entdecken'] }];
  const config = parseStationConfig(base);
  let seq = 0;
  /** A heard item: spoken by default, or a music hour / a song. */
  const heard = async (id: string, script: Record<string, unknown>, options: { show?: string; research?: unknown; daysAgo?: number } = {}) => {
    const at = new Date(SUNDAY.getTime() - (options.daysAgo ?? 1) * 86_400_000);
    await store.insertItem(OWNER, { id, seq: ++seq, showId: options.show ?? '_block:hintergrund', plannedAt: at.toISOString(), estimatedMinutes: 3 }, at);
    await store.update(OWNER, id, { state: 'played', script_json: JSON.stringify(script), ...(options.research ? { research_json: JSON.stringify(options.research) } : {}) }, at);
  };
  return { db, store, play, deps, drafts, config, heard, setup: () => store.saveConfig(OWNER, config, SUNDAY), at: (date: Date) => { now = date; } };
}

const reviews = async (store: StationStore) => (await store.recentItems(OWNER, 50)).filter(row => row.show_id === REVIEW_SHOW);

test('the Wochenrückblick joins the program on Sunday morning once, written from what was heard, questions and stickers', async () => {
  const h = harness(); await h.setup();
  assert.ok(blockViews(h.config).some(block => block.id === 'rueckblick'));
  await h.heard('a', { title: 'Mars-Sonde gestartet', text: 'Die Sonde <laugh> startet 2027.', sourceIds: [] });
  await h.heard('b', { title: 'Kapitel 2', text: 'Fini geht zum See.', sourceIds: [] }, { show: '_series:x',
    research: { series: 'x', episode: 1, total: 5, seriesTitle: 'Fini', kind: 'geschichte',
      choice: { question: 'Wohin?', options: [{ label: 'Höhle', emoji: '🕳️' }, { label: 'See', emoji: '🌊' }], picked: 1, by: 'listener' } } });
  // Songs and music hours stay out (no Spotify data to the AI); so does anything older than a week.
  await h.heard('song', { kind: 'song', title: 'Song', text: '', sourceIds: [], parts: [{ kind: 'track', title: 'Geheim', artist: 'X' }] }, { show: '_musik' });
  await h.heard('hour', { kind: 'music_hour', title: 'Krautrock', text: 'Can.', sourceIds: [], parts: [] }, { show: '_block:genre' });
  await h.heard('old', { title: 'Alte Meldung', text: 'Längst vorbei.', sourceIds: [] }, { daysAgo: 9 });

  // Two spoken items are not enough for a review.
  await tick(h.deps, OWNER);
  assert.equal((await reviews(h.store)).length, 0);

  await h.heard('c', { title: 'Wahlen in Bern', text: 'Das Parlament hat gewählt.', sourceIds: [] }, { research: { quiz: { question: 'Wer?', options: ['A', 'B', 'C'], correct: 0, answered: 0 } } });
  await h.play.addQuestion(OWNER, 'Warum ist der Himmel blau?', new Date(SUNDAY.getTime() - 86_400_000));
  await h.play.award(OWNER, 'quiz', new Date(SUNDAY.getTime() - 86_400_000), () => 0);
  // Saturday: nothing yet.
  h.at(new Date('2026-10-03T08:00:00Z'));
  await tick(h.deps, OWNER);
  assert.equal((await reviews(h.store)).length, 0);
  // Sunday at 10: once.
  h.at(SUNDAY);
  await tick(h.deps, OWNER);
  await tick(h.deps, OWNER);
  const [review] = await reviews(h.store);
  assert.ok(review);
  assert.equal((await reviews(h.store)).length, 1);

  assert.equal(await produceItem(h.deps, OWNER, review.id), 'ready');
  const { sources, direction } = h.drafts[0];
  assert.deepEqual(sources.map(source => source.title), ['Mars-Sonde gestartet', 'Kapitel 2', 'Wahlen in Bern', 'Diese Woche']);
  assert.equal(sources[0].excerpt, 'Die Sonde startet 2027.');
  assert.match(sources[1].excerpt, /Mitmach-Entscheidung: «See»/);
  assert.match(sources[2].excerpt, /Quizfrage: Wer\? \(richtig beantwortet\)/);
  assert.match(sources[3].excerpt, /Frage ans Radio: «Warum ist der Himmel blau\?» \(noch nicht beantwortet\)\nNeue Sticker im Album: 🦊 Fuchs/);
  assert.ok(!JSON.stringify(sources).includes('Geheim') && !JSON.stringify(sources).includes('Krautrock') && !JSON.stringify(sources).includes('Alte Meldung'));
  assert.match(direction?.instructions ?? '', /Rückblick auf die Woche/);
  assert.deepEqual(direction?.avoidTopics, []);

  // A week later it comes again; a review never reviews itself.
  await h.store.update(OWNER, review.id, { state: 'played' }, SUNDAY);
  assert.equal(reviewable((await h.store.getItem(OWNER, review.id))!), false);
});

test('the Wochenrückblick can be added any day from the palette; without anything heard it has nothing to say', async () => {
  const h = harness(); await h.setup();
  h.at(new Date('2026-10-01T08:00:00Z'));
  const id = (await addBlock(h.deps, OWNER, 'rueckblick'))!;
  assert.equal(await produceItem(h.deps, OWNER, id), 'failed');
  assert.equal((await h.store.getItem(OWNER, id))?.error, 'NO_SOURCES');
  assert.deepEqual(reviewSources([] as TimelineRow[], { questions: [], stickers: [] }, h.deps.now()), []);
});
