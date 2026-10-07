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

test('the final edit rewrites for the ear; the jury sends it back with its notes', async () => {
  const first = { title: 'Klarer', text: 'Ein klarer Satz. Und noch ein kurzer Satz dazu, gut hörbar.', sourceIds: ['s1'] };
  const second = { title: 'Am klarsten', text: 'Radio Melchnau. Ein klarer Einstieg, ein Gedanke pro Satz, gut.', sourceIds: ['s1'] };
  const { fake, calls } = editor({ polish: [first, second], judge: [marks(2.8, 'Einstieg schwach'), marks(4.2)] });
  const result = await finishScript(fake, draft, sources, undefined, context);
  assert.equal(result.title, 'Am klarsten');
  assert.equal(result.quality?.overall, 4.2);
  assert.deepEqual(result.interestTags, ['Raumfahrt']);
  assert.deepEqual(calls, [{ step: 'polish', notes: undefined }, { step: 'judge' }, { step: 'polish', notes: 'Einstieg schwach' }, { step: 'judge' }]);
  assert.deepEqual(result.quality?.rounds, [2.8, 4.2]);
});

test('every note is worked in, but only a revision the jury marks at least as good is kept', async () => {
  const one = { title: 'Eins', text: 'Ein klarer Satz. Und noch ein kurzer Satz dazu, gut hörbar.', sourceIds: ['s1'] };
  const two = { title: 'Zwei', text: 'Ein klarer Einstieg. Ein Gedanke pro Satz, und gut hörbar dazu.', sourceIds: ['s1'] };
  const three = { title: 'Drei', text: 'Ein schwacher Einstieg, der wieder holpert und zu lang wird, leider.', sourceIds: ['s1'] };
  // Well above the bar, the notes are still worked in; an equally good revision stays.
  const kept = editor({ polish: [one, two, three], judge: [marks(4.4, 'Einschub streichen'), marks(4.4, 'Schluss schärfen'), marks(4.5)] });
  const result = await finishScript(kept.fake, draft, sources, undefined, context);
  assert.deepEqual(kept.calls.filter(call => call.step === 'polish').map(call => call.notes), [undefined, 'Einschub streichen', 'Schluss schärfen']);
  assert.equal(result.title, 'Drei');
  assert.deepEqual(result.quality?.rounds, [4.4, 4.4, 4.5]);
  // A worse revision is dropped: the next round works the same notes into the better text again, told what went wrong.
  const dropped = editor({
    polish: [one, two, three],
    judge: [{ ...marks(3.6, 'Einschub streichen'), research: 'Wer die Wässerer heute sind' }, marks(3.4, 'holpert'), marks(3.8)],
  });
  const worse = await finishScript(dropped.fake, draft, sources, undefined, context);
  const notes = dropped.calls.filter(call => call.step === 'polish').map(call => call.notes);
  assert.equal(notes[1], 'Einschub streichen');
  assert.match(notes[2] ?? '', /^Einschub streichen \(Ein früherer Versuch.*3\.4 statt 3\.6, die Jury dazu: holpert/);
  assert.equal(worse.title, 'Drei');
  assert.equal(worse.quality?.overall, 3.8);
  assert.deepEqual(worse.quality?.rounds, [3.6, 3.8]);
  assert.equal(worse.quality?.research, 'Wer die Wässerer heute sind');
  // Never worse than the first version, however the revisions turn out.
  const never = editor({ polish: [one, two, three], judge: [marks(3.2, 'Einstieg'), marks(2.8, 'a'), marks(2.0, 'b')] });
  const first = await finishScript(never.fake, draft, sources, undefined, context);
  assert.equal(first.title, 'Eins');
  assert.equal(first.quality?.overall, 3.2);
  // «Keine» is nothing to fix.
  assert.equal(parseQuality(marks(4, 'Keine.')).notes, '');
  assert.equal(parseQuality(marks(4, '–')).notes, '');
  assert.equal(parseQuality(marks(4, 'Gut so.')).notes, '');
  assert.equal(parseQuality(marks(4, 'Keinen Einschub am Anfang')).notes, 'Keinen Einschub am Anfang');
});

test('below the jury\'s bar after two rounds, the editor keeps revising (two more at most)', async () => {
  const texts = ['Eins', 'Zwei', 'Drei', 'Vier', 'Fünf', 'Sechs'].map(title => ({ title, text: `${title}: ein klarer Satz. Und noch ein kurzer Satz dazu, gut hörbar.`, sourceIds: ['s1'] }));
  // Still 3.2 after two rounds (bar 3.5): a third round lifts it over the bar, and there it stops.
  const lifted = editor({ polish: texts.slice(), judge: [marks(2.6, 'a'), marks(3.0, 'b'), marks(3.2, 'c'), marks(3.6, 'd'), marks(3.8, 'e')] });
  const better = await finishScript(lifted.fake, draft, sources, undefined, context);
  assert.deepEqual(better.quality?.rounds, [2.6, 3.0, 3.2, 3.6]);
  assert.equal(better.title, 'Vier');
  // Never above the bar: four revisions at most; a worse one is dropped and the next round starts from the better text.
  const stuck = editor({ polish: texts.slice(), judge: [marks(2.6, 'a'), marks(2.8, 'b'), marks(1.6, 'kaputt'), marks(3.0, 'c'), marks(3.1, 'd'), marks(3.9, 'zu spät')] });
  const result = await finishScript(stuck.fake, draft, sources, undefined, context);
  assert.deepEqual(stuck.calls.filter(call => call.step === 'polish').map(call => (call.notes ?? '').slice(0, 1)), ['', 'a', 'b', 'b', 'c']);
  assert.deepEqual(result.quality?.rounds, [2.6, 2.8, 3.0, 3.1]);
  assert.equal(result.title, 'Fünf');
});

test('with the jury\'s notes the editor may cut whole passages; the jury keeps fixes and missing research apart', async () => {
  const { GeminiScriptEditor } = await import('../server/editing.ts');
  const asked: string[] = [];
  const gemini = new GeminiScriptEditor(async system => { asked.push(system); return {}; });
  await gemini.polish(draft, sources, undefined, context, 'Den Einschub streichen');
  await gemini.polish(draft, sources, undefined, context);
  await gemini.judge(draft, sources, undefined);
  assert.match(asked[0], /Setze jeden einzelnen Hinweis der Jury.*darfst du ganze Passagen streichen.*Hinweise der Jury, die du beheben sollst: Den Einschub streichen/);
  assert.match(asked[1], /Behalte alle Tatsachen/);
  assert.match(asked[2], /gehört in research/);
  assert.deepEqual(parseQuality({ ...marks(4), notes: 'a', research: '  Wer   heute? ' }).research, 'Wer heute?');
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

test('a topic field that came up twice in a day and a half is named as crowded; older ones and single ones are not', async () => {
  const { recentTopics, FIELD_PREFIX } = await import('../server/station/produce.ts');
  const { avoidTopicsPrompt } = await import('../server/providers.ts');
  const now = new Date('2026-10-06T12:00:00Z');
  const row = (title: string, tags: string[], hoursAgo: number) => ({ state: 'played', updated_at: new Date(now.getTime() - hoursAgo * 3_600_000).toISOString(),
    script_json: JSON.stringify({ title, text: 'x', sourceIds: [], interestTags: tags }) });
  const rows = [row('Alt', ['KI'], 60), row('Chips', ['KI', 'Technik'], 20), row('Roboter', ['KI'], 5), row('Mond', ['Raumfahrt'], 2)];
  const deps = { now: () => now, store: { recentItems: async () => rows } } as never;
  const topics = await recentTopics(deps, 'o');
  assert.deepEqual(topics.filter(topic => topic.startsWith(FIELD_PREFIX)), [`${FIELD_PREFIX}KI`]);
  assert.deepEqual(topics.filter(topic => !topic.startsWith(FIELD_PREFIX)), ['Mond', 'Roboter', 'Chips', 'Alt']);
  const prompt = avoidTopicsPrompt({ avoidTopics: topics });
  assert.match(prompt, /wiederhole sie nicht, ausser es gibt wirklich Neues: «Mond», «Roboter», «Chips», «Alt»\./);
  assert.match(prompt, /Themenfelder kamen in den letzten anderthalb Tagen schon mehrfach vor; .*«KI»\./);
  assert.doesNotMatch(prompt, /«Themenfeld/);
});

test('for music moderation the jury knows announcements are short and facts come only from the song research', async () => {
  const { GeminiScriptEditor } = await import('../server/editing.ts');
  const asked: string[] = [];
  const gemini = new GeminiScriptEditor(async system => { asked.push(system); return {}; });
  await gemini.judge(draft, sources, { music: true });
  await gemini.judge(draft, sources, undefined);
  assert.match(asked[0], /Musikmoderation zwischen Songs.*Jahr und Album aufzuzählen/);
  assert.doesNotMatch(asked[1], /Musikmoderation/);
});
