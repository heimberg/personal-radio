import { test } from 'node:test';
import assert from 'node:assert/strict';
import { defaultStationConfig, parseStationConfig } from '../src/domain/station.ts';
import type { Script, Source } from '../src/domain/program.ts';
import { StationStore } from '../server/station-store.ts';
import { addBlock, produceItem, scheduleShowNow, transcriptView } from '../server/station.ts';
import type { StationDeps } from '../server/station.ts';
import { finishScript, parseQuality } from '../server/editing.ts';
import type { ScriptEditor, StationContext } from '../server/editing.ts';
import { sqliteD1 } from './d1-sqlite.ts';
import { PipelineError } from '../server/segment-pipeline.ts';

const NOW = new Date('2026-09-28T05:30:00Z');
const sources: Source[] = [{ id: 's1', url: 'https://example.org/a', title: 'Quelle', excerpt: 'Fakt.', publishedAt: NOW.toISOString(), retrievedAt: NOW.toISOString() }];
const draft: Script = { title: 'Entwurf', text: 'Das ist ein etwas holpriger Entwurf mit vielen Wörtern darin.', sourceIds: ['s1'], interestTags: ['Raumfahrt'] };
const context: StationContext = { stationName: 'Radio Melchnau', when: 'Montag, 07:30', afterMusic: true };
const marks = (overall: number, notes = '') => ({ hook: overall, clarity: overall, facts: overall, novelty: overall, length: overall, notes });

function editor(replies: { polish: unknown[]; judge: unknown[] }) {
  const calls: Array<{ step: string; notes?: string }> = [];
  const fake: ScriptEditor = {
    polish: async (_script, _sources, _direction, _context, notes) => { calls.push({ step: 'polish', notes }); const reply = replies.polish.shift(); if (reply instanceof Error) throw reply; return reply; },
    judge: async () => { calls.push({ step: 'judge' }); const reply = replies.judge.shift(); if (reply instanceof Error) throw reply; return reply; },
  };
  return { fake, calls };
}

test('the final edit rewrites for the ear; below the bar the jury sends it back once with its notes', async () => {
  const first = { title: 'Klarer', text: 'Ein klarer Satz. Und noch ein kurzer Satz dazu, gut hörbar.', sourceIds: ['s1'] };
  const second = { title: 'Am klarsten', text: 'Radio Melchnau. Ein klarer Einstieg, ein Gedanke pro Satz, gut.', sourceIds: ['s1'] };
  const { fake, calls } = editor({ polish: [first, second], judge: [marks(2.8, 'Einstieg schwach'), marks(4.2)] });
  const result = await finishScript(fake, draft, sources, undefined, context);
  assert.equal(result.title, 'Am klarsten');
  assert.equal(result.quality?.overall, 4.2);
  assert.deepEqual(result.interestTags, ['Raumfahrt']);
  assert.deepEqual(calls, [{ step: 'polish', notes: undefined }, { step: 'judge' }, { step: 'polish', notes: 'Einstieg schwach' }, { step: 'judge' }]);
});

test('a rewrite that breaks the contract keeps the draft; a failing jury leaves no marks', async () => {
  // Unknown source, a dialog out of a brief, a text cut in half: all fall back to the draft.
  for (const broken of [{ ...draft, sourceIds: ['erfunden'] }, { ...draft, turns: [{ speaker: 'host-a', text: 'a' }, { speaker: 'host-b', text: 'b' }], text: 'a b' },
    { ...draft, text: 'Zu kurz.' }]) {
    const { fake } = editor({ polish: [broken], judge: [new Error('down')] });
    const result = await finishScript(fake, draft, sources, undefined, context);
    assert.equal(result.text, draft.text);
    assert.equal(result.quality, undefined);
  }
  assert.throws(() => parseQuality({ hook: 3 }), /quality clarity missing/);
  assert.deepEqual(parseQuality({ ...marks(9), notes: ' x ' }), { hook: 5, clarity: 5, facts: 5, novelty: 5, length: 5, overall: 5, notes: 'x' });
});

test('production runs the final edit with the program around the item; the transcript shows the marks', async () => {
  const base = defaultStationConfig({ timezone: 'Europe/Zurich' });
  const config = parseStationConfig({ ...base, name: 'Radio Melchnau', location: { name: 'Bern', latitude: 46.9, longitude: 7.4 }, music: { ...base.music, between: 0 } });
  const store = new StationStore(sqliteD1());
  await store.saveConfig('o', config, NOW);
  let ids = 0, seen: StationContext | undefined, reviewed: Script | undefined;
  const deps: StationDeps = {
    store, podcastAvailable: false, now: () => NOW, newId: () => `i${++ids}`,
    fetchFeed: async () => [], reserveFeed: async () => {}, reserveGeneration: async () => {},
    audio: { put: async () => {}, delete: async () => {} },
    weather: { report: async () => ({ text: 'sonnig', source: { ...sources[0], id: 'wetter' } }) },
    editor: {
      polish: async (script, _sources, _direction, given) => { seen = given; return { ...script, text: `${script.text} Geschliffen.` }; },
      judge: async () => marks(4),
    },
    pipeline: {
      draft: async (): Promise<Script> => ({ title: 'Wetter', text: 'Heute scheint in Bern die Sonne, morgen auch.', sourceIds: ['wetter'] }),
      review: async script => { reviewed = script; return { approved: true, reasons: [] }; },
      voice: async () => ({ audio: new Uint8Array([1]), contentType: 'audio/mpeg' as const, ttsCharacters: 5 }),
    },
  };
  const song = (await scheduleShowNow(deps, 'o', '_musik'))!;
  const id = (await addBlock(deps, 'o', 'wetter', undefined, song))!;
  assert.equal(await produceItem(deps, 'o', id), 'ready');
  assert.deepEqual(seen, { stationName: 'Radio Melchnau', when: 'Montag, am Morgen', afterMusic: true, live: true });
  assert.match(reviewed!.text, /Geschliffen\.$/);
  assert.equal(transcriptView((await store.getItem('o', id))!, config).quality?.overall, 4);
  assert.deepEqual((await store.qualityLog('o', new Date(0))).map(entry => [entry.showId, entry.overall]), [['_block:wetter', 4]]);
});

test('a rejected fact check gets one repair: the editor drops the unsupported claim, the check runs again', async () => {
  const base = defaultStationConfig({ timezone: 'Europe/Zurich' });
  const config = parseStationConfig({ ...base, location: { name: 'Bern', latitude: 46.9, longitude: 7.4 }, music: { ...base.music, between: 0 } });
  const store = new StationStore(sqliteD1());
  await store.saveConfig('o', config, NOW);
  let ids = 0, reviews = 0;
  const notes: Array<string | undefined> = [];
  const deps = (rejectTwice: boolean): StationDeps => ({
    store, podcastAvailable: false, now: () => NOW, newId: () => `i${++ids}`,
    fetchFeed: async () => [], reserveFeed: async () => {}, reserveGeneration: async () => {},
    audio: { put: async () => {}, delete: async () => {} },
    weather: { report: async () => ({ text: 'sonnig', source: { ...sources[0], id: 'wetter' } }) },
    editor: {
      polish: async (script, _sources, _direction, _context, note) => { notes.push(note); return { ...script, text: note ? 'Heute scheint in Bern die Sonne.' : script.text }; },
      judge: async () => marks(4),
    },
    pipeline: {
      draft: async (): Promise<Script> => ({ title: 'Wetter', text: 'Heute scheint in Bern die Sonne, morgen schneit es sicher.', sourceIds: ['wetter'] }),
      review: async () => {
        reviews++;
        if (reviews === 1 || rejectTwice) throw new PipelineError('REJECTED', 'Nicht belegt: «morgen schneit es»');
        return { approved: true, reasons: [] };
      },
      voice: async () => ({ audio: new Uint8Array([1]), contentType: 'audio/mpeg' as const, ttsCharacters: 5 }),
    },
  });
  const id = (await addBlock(deps(false), 'o', 'wetter'))!;
  assert.equal(await produceItem(deps(false), 'o', id), 'ready');
  assert.equal(reviews, 2);
  assert.match(notes.at(-1)!, /Nicht belegt: «morgen schneit es»/);
  assert.equal(transcriptView((await store.getItem('o', id))!, config).lines[0].text, 'Heute scheint in Bern die Sonne.');
  // Rejected again after the repair: the item fails with the check's reason.
  reviews = 0;
  const other = (await addBlock(deps(true), 'o', 'wetter'))!;
  assert.equal(await produceItem(deps(true), 'o', other), 'failed');
  assert.equal(reviews, 2);
  assert.match((await store.getItem('o', other))!.error!, /REJECTED/);
});
