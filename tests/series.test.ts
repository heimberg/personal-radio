import { test } from 'node:test';
import assert from 'node:assert/strict';
import { defaultStationConfig, parseStationConfig } from '../src/domain/station.ts';
import type { EditorialDirection, Profile, Script, Source } from '../src/domain/program.ts';
import { StationStore } from '../server/station-store.ts';
import { addBlock, produceItem, removeItem, SeriesError, startSeries, stopSeries, tick, toView, transcriptView } from '../server/station.ts';
import type { StationDeps } from '../server/station.ts';
import { blockViews } from '../src/domain/blocks.ts';
import { outlinePrompt, parseOutline, recapOf } from '../src/domain/series.ts';
import { KIDS_RULES, forKids } from '../server/listeners.ts';
import { briefSystemPrompt } from '../server/providers.ts';
import { sqliteD1 } from './d1-sqlite.ts';

const OWNER = 'owner@example.test';
const NOW = new Date('2026-10-01T08:00:00Z');
const profile: Profile = { topics: ['Wissenschaft'], interests: ['Raumfahrt'], interestWeights: {}, speechMinutes: 2, exploration: 0 };

const outline = (count: number) => ({ title: 'Die Drachen-Saga', episodes: Array.from({ length: count }, (_, i) => ({ title: `Kapitel ${i + 1}`, idea: `Was in Kapitel ${i + 1} passiert.` })) });

function station(kids = false) {
  const base = defaultStationConfig({ profile, feeds: [] });
  // Only the series is under test: no rotation of other shows into the program.
  base.music = { ...base.music, between: 0 }; base.surprise = 0;
  base.schedule = [{ id: 'nie', days: [0], from: '03:00', to: '03:30', showIds: ['entdecken'] }]; // Thursday morning: nothing else planned
  const config = parseStationConfig(base);
  return kids ? forKids(config) : config;
}

function harness(options: { kids?: boolean; episodes?: number; outlineAnswer?: unknown } = {}) {
  const db = sqliteD1(), store = new StationStore(db);
  let ids = 0;
  const asked: Array<{ system: string; input: any }> = [], drafts: Array<{ sources: Source[]; direction?: EditorialDirection }> = [], research: string[] = [];
  const deps: StationDeps = {
    store, podcastAvailable: false, now: () => NOW, random: () => 0.99, newId: () => `id-${++ids}`,
    fetchFeed: async () => [], reserveFeed: async () => {}, reserveGeneration: async () => {},
    audio: { put: async () => {}, delete: async () => {} },
    agentModel: { askJson: async (system, input) => { asked.push({ system, input }); return options.outlineAnswer ?? outline(Number(/genau (\d+) Folgen/.exec(system)?.[1] ?? 3)); } },
    researcher: { research: async request => { research.push(request.brief); return { sources: [{ id: 's1', url: 'https://example.test/a', title: 'Quelle', excerpt: 'Belegt.', publishedAt: NOW.toISOString(), retrievedAt: NOW.toISOString() }], queries: ['suche'] }; } },
    pipeline: {
      draft: async (_profile, sources, _mode, direction): Promise<Script> => {
        drafts.push({ sources, direction });
        return { title: `Kapitel ${drafts.length}`, text: `Text von Kapitel ${drafts.length} <laugh> mit Drache Fini.`, sourceIds: [sources[0].id], interestTags: [] };
      },
      review: async () => ({ approved: true, reasons: [] }),
      voice: async () => ({ audio: new Uint8Array([1]), contentType: 'audio/mpeg' as const, ttsCharacters: 1 }),
    },
  };
  const config = station(options.kids);
  const setup = () => store.saveConfig(OWNER, config, NOW);
  const seriesItems = async () => (await store.recentItems(OWNER, 50)).filter(row => row.show_id.startsWith('_series:'));
  return { store, deps, asked, drafts, research, config, setup, seriesItems };
}

test('a story series plans its chapters, tells each from the plan and continues once the last one was heard', async () => {
  const h = harness(); await h.setup();
  const firstId = (await startSeries(h.deps, OWNER, h.config, 'geschichte', 'ein Drache, der Angst vor Feuer hat', 3)).itemId;
  assert.match(h.asked[0].system, /Fortsetzungsgeschichte/); assert.match(h.asked[0].system, /genau 3 Folgen/);
  assert.equal(h.asked[0].input.thema, 'ein Drache, der Angst vor Feuer hat');
  let [series] = await h.store.listSeries(OWNER);
  assert.equal(series.title, 'Die Drachen-Saga'); assert.equal(series.scheduled, 1); assert.equal(series.state, 'active');

  // Chapter 1: written from the plan (no research), as a story, introduced as the start of the series.
  assert.equal(await produceItem(h.deps, OWNER, firstId), 'ready');
  assert.equal(h.research.length, 0);
  assert.deepEqual(h.drafts[0].sources.map(source => source.id), ['serie']);
  assert.match(h.drafts[0].sources[0].excerpt, /Folge 2: Kapitel 2 – Was in Kapitel 2 passiert/);
  assert.equal(h.drafts[0].direction?.story, true);
  assert.match(h.drafts[0].direction?.instructions ?? '', /Folge 1 von 3.*Stelle die Serie zu Beginn/);
  assert.match(h.drafts[0].direction?.instructions ?? '', /Ausblick auf die nächste Folge «Kapitel 2»/);
  const first = (await h.store.getItem(OWNER, firstId))!;
  const view = toView(first, h.config);
  assert.equal(view.showName, 'Die Drachen-Saga · Folge 1/3');
  assert.deepEqual(view.series, { id: series.id, episode: 1, total: 3, kind: 'geschichte' });
  assert.equal(view.sources, undefined); // The plan is not a source to list.
  assert.deepEqual(transcriptView(first, h.config).sources, []);
  [series] = await h.store.listSeries(OWNER);
  assert.equal(series.recaps[0], 'Kapitel 1: Text von Kapitel 1 mit Drache Fini.');

  // Not heard yet: no second chapter.
  await tick(h.deps, OWNER);
  assert.equal((await h.seriesItems()).length, 1);
  await h.store.update(OWNER, firstId, { state: 'played' }, NOW);
  await tick(h.deps, OWNER);
  const second = (await h.seriesItems()).find(row => row.id !== firstId)!;
  assert.equal(await produceItem(h.deps, OWNER, second.id), 'ready');
  assert.match(h.drafts[1].direction?.instructions ?? '', /Folge 2 von 3.*Was bisher geschah.*Kapitel 1: Text von Kapitel 1/);
  assert.match(h.drafts[1].sources[0].excerpt, /Bisher erzählt:\nKapitel 1: Text von Kapitel 1/);

  // Removed unheard: the same chapter comes again.
  assert.ok(await removeItem(h.deps, OWNER, second.id));
  await tick(h.deps, OWNER);
  const again = (await h.seriesItems()).filter(row => row.state === 'planned');
  assert.equal(again.length, 1);
  assert.equal(JSON.parse(again[0].research_json!).episode, 1);

  // Heard to the end: the last chapter closes the story and the series is done.
  await h.store.update(OWNER, again[0].id, { state: 'played' }, NOW);
  await tick(h.deps, OWNER);
  const last = (await h.seriesItems()).find(row => row.state === 'planned')!;
  assert.equal(await produceItem(h.deps, OWNER, last.id), 'ready');
  assert.match(h.drafts.at(-1)!.direction?.instructions ?? '', /letzte Folge/);
  await h.store.update(OWNER, last.id, { state: 'skipped' }, NOW);
  await tick(h.deps, OWNER);
  [series] = await h.store.listSeries(OWNER);
  assert.equal(series.state, 'done');
  assert.equal((await h.seriesItems()).filter(row => row.state === 'planned').length, 0);
});

test('a knowledge series researches each episode; stopping it removes the open episode', async () => {
  const h = harness({ episodes: 5 }); await h.setup();
  const { seriesId, itemId } = await startSeries(h.deps, OWNER, h.config, 'wissen', 'Geschichte des Internets');
  assert.match(h.asked[0].system, /Wissensserie/);
  assert.equal(await produceItem(h.deps, OWNER, itemId), 'ready');
  assert.match(h.research[0], /Folge 1 «Kapitel 1» der Serie «Die Drachen-Saga» \(Thema: Geschichte des Internets\)/);
  assert.equal(h.drafts[0].direction?.story, undefined);
  // Without dialog voices the episode is told by the host alone.
  assert.equal(toView((await h.store.getItem(OWNER, itemId))!, h.config).series?.kind, 'wissen');
  assert.deepEqual(JSON.parse((await h.store.getItem(OWNER, itemId))!.research_json!).queries, ['suche']);
  await h.store.update(OWNER, itemId, { state: 'played' }, NOW);
  await tick(h.deps, OWNER);
  const open = (await h.seriesItems()).find(row => row.state === 'planned')!;
  assert.ok(await stopSeries(h.deps, OWNER, seriesId));
  assert.equal((await h.store.getItem(OWNER, open.id))?.state, 'expired');
  await tick(h.deps, OWNER);
  assert.equal((await h.seriesItems()).filter(row => row.state === 'planned').length, 0);
  assert.equal((await h.store.getSeries(OWNER, seriesId))?.state, 'stopped');
  assert.equal(await stopSeries(h.deps, OWNER, 'unknown'), false);
});

test('a child\'s series follows the kids rules; a broken outline or a missing model is refused', async () => {
  const kids = harness({ kids: true }); await kids.setup();
  await startSeries(kids.deps, OWNER, kids.config, 'geschichte', 'Pferde');
  assert.ok(kids.asked[0].system.includes(KIDS_RULES));

  const broken = harness({ outlineAnswer: { title: 'Halb', episodes: [{ title: 'Eins', idea: 'x' }] } }); await broken.setup();
  await assert.rejects(startSeries(broken.deps, OWNER, broken.config, 'wissen', 'Mond'), (error: unknown) => error instanceof SeriesError && error.code === 'NO_OUTLINE');
  assert.equal((await broken.store.listSeries(OWNER)).length, 0);
  const plain = harness(); await plain.setup();
  delete plain.deps.agentModel;
  await assert.rejects(startSeries(plain.deps, OWNER, plain.config, 'wissen', 'Mond'), (error: unknown) => error instanceof SeriesError && error.code === 'NOT_CONFIGURED');
});

test('outline, recap, palette and story prompt', () => {
  assert.throws(() => parseOutline({ title: 'T', episodes: [{ title: 'A', idea: 'a' }] }, 3), /incomplete/);
  assert.equal(parseOutline({ title: ' T ', episodes: [1, 2, 3, 4].map(n => ({ title: `F${n}`, idea: `I${n}` })) }, 3).episodes.length, 3);
  assert.match(outlinePrompt('geschichte', 5, 'REGELN'), /REGELN.*genau 5 Folgen/);
  assert.equal(recapOf('Titel', `${'Wort '.repeat(200)}`).length <= 520, true);
  assert.equal(recapOf('Titel', 'Hallo <laugh> |mhm| Welt'), 'Titel: Hallo Welt');
  const palette = blockViews(station()).map(block => block.id);
  assert.ok(palette.includes('serie') && palette.includes('geschichte'));
  assert.match(briefSystemPrompt({ story: true, targetMinutes: 6 }), /frei erfundenen Hörgeschichte.*etwa 780 Wörter/);
  assert.match(briefSystemPrompt({ targetMinutes: 6 }), /Keine neuen Fakten erfinden/);
});

test('the palette entries start a series with five episodes', async () => {
  const h = harness(); await h.setup();
  const itemId = (await addBlock(h.deps, OWNER, 'serie', 'Mond'))!;
  const [series] = await h.store.listSeries(OWNER);
  assert.equal(series.kind, 'wissen'); assert.equal(series.episodes.length, 5); assert.equal(series.subject, 'Mond');
  assert.equal(toView((await h.store.getItem(OWNER, itemId))!, h.config).showName, 'Die Drachen-Saga · Folge 1/5');
});
