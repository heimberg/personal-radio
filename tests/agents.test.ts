import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AGENTS, agentOf, parseAgentConfig, resolveAgents } from '../src/domain/agents.ts';
import { ConfigError, defaultStationConfig, parseStationConfig } from '../src/domain/station.ts';
import { defaultProfile } from '../src/domain/program.ts';
import type { Script, Source } from '../src/domain/program.ts';
import { GeminiBriefGenerator, GeminiEditorialVerifier, GeminiResearcher } from '../server/providers.ts';
import { finishScript } from '../server/editing.ts';
import type { ScriptEditor, StationContext } from '../server/editing.ts';
import { GeminiScriptEditor } from '../server/editing.ts';
import { StationStore } from '../server/station-store.ts';
import { trialAgent } from '../server/station.ts';
import type { StationDeps } from '../server/station.ts';
import { sqliteD1 } from './d1-sqlite.ts';
import { listenerNotes } from '../src/domain/listener-notes.ts';
import { AGENT_PRESETS, activePreset, applyPreset } from '../src/domain/agent-presets.ts';

const NOW = new Date('2026-09-28T05:30:00Z');
const sources: Source[] = [{ id: 's1', url: 'https://example.org/a', title: 'Quelle', excerpt: 'Ein Fakt.', publishedAt: NOW.toISOString(), retrievedAt: NOW.toISOString() }];
const geminiText = (text: string) => Response.json({ candidates: [{ content: { parts: [{ text }] } }] });
const fail = (path: string, expected: string): never => { throw new ConfigError(`${path}: ${expected}`); };
const context: StationContext = { stationName: 'Radio', when: 'Montag, 07:30', afterMusic: false };
const marks = (overall: number, notes = 'mehr Tempo') => ({ hook: overall, clarity: overall, facts: overall, novelty: overall, length: overall, notes });

test('only changes from the defaults are stored; unknown agents and unsafe values are refused', () => {
  const writer = AGENTS.find(agent => agent.id === 'writer')!;
  assert.equal(parseAgentConfig({ writer: { instructions: ` ${writer.instructions} `, temperature: writer.temperature } }, fail), undefined);
  assert.deepEqual(parseAgentConfig({ writer: { instructions: ' Kurz und trocken. ', temperature: 0.123 }, jury: { enabled: false, threshold: 4 } }, fail),
    { writer: { instructions: 'Kurz und trocken.', temperature: 0.12 }, jury: { enabled: false, threshold: 4 } });
  assert.throws(() => parseAgentConfig({ spion: {} }, fail), /agents\.spion: bekannter Agent/);
  assert.throws(() => parseAgentConfig({ verifier: { enabled: false } }, fail), /immer an/);
  assert.throws(() => parseAgentConfig({ writer: { threshold: 3 } }, fail), /Note von 1 bis 5/);
  assert.throws(() => parseAgentConfig({ writer: { temperature: 2 } }, fail), /0 bis 1/);
  assert.throws(() => parseAgentConfig({ writer: { instructions: 'x'.repeat(3001) } }, fail), /3000 Zeichen/);
  const config = parseStationConfig({ ...defaultStationConfig({ timezone: 'Europe/Zurich' }), agents: { music: { temperature: 0.5 } } });
  assert.deepEqual(config.agents, { music: { temperature: 0.5 } });
  assert.equal(resolveAgents(config.agents).music.temperature, 0.5);
  assert.equal(resolveAgents(config.agents).editor.enabled, true);
  assert.equal(agentOf(undefined, 'jury').threshold, 3.5);
});

test('the writer, research and fact check use the owner\'s instructions and freedom as words, never a temperature; the fact check rules stay', async () => {
  const agents = resolveAgents({ writer: { instructions: 'Schreibe wie ein Wetterfrosch.', temperature: 0.8 }, research: { instructions: 'Nur Schweizer Quellen.', temperature: 0.1 },
    verifier: { instructions: 'Jahreszahlen besonders streng prüfen.' } });
  let body: any;
  const writer = new GeminiBriefGenerator({ key: 'g' }, async (_url, init) => { body = JSON.parse(String(init?.body)); return geminiText(JSON.stringify({ title: 'T', text: 'Ein Fakt.', sourceIds: ['s1'] })); });
  await writer.generate(defaultProfile, sources, { agents });
  assert.match(body.systemInstruction.parts[0].text, /Keine neuen Fakten erfinden\. Schreibe wie ein Wetterfrosch\. Antworte ausschliesslich als JSON/);
  // Google retires temperature for Gemini: the freedom setting becomes words in the prompt.
  assert.equal(body.generationConfig.temperature, undefined);
  assert.match(body.systemInstruction.parts[0].text, /Formuliere frei, bildhaft/);

  const researcher = new GeminiResearcher({ key: 'g' }, async (_url, init) => { body = JSON.parse(String(init?.body)); return geminiText(''); });
  await researcher.research({ brief: 'x', interests: [], avoidTopics: [], now: NOW, agent: agents.research });
  assert.match(body.systemInstruction.parts[0].text, /Nutze die Google-Suche\. Nur Schweizer Quellen\. Formuliere genau, nüchtern/);
  assert.equal(body.generationConfig, undefined);

  const verifier = new GeminiEditorialVerifier({ key: 'g' }, async (_url, init) => { body = JSON.parse(String(init?.body));
    return geminiText(JSON.stringify({ approved: true, reasons: [], checks: [{ claim: 'Fakt', sourceIds: ['s1'], quote: 'Ein Fakt', supported: true }] })); });
  const script: Script = { title: 'T', text: 'Ein Fakt.', sourceIds: ['s1'] };
  assert.equal((await verifier.verify(script, sources, agents.verifier.instructions)).approved, true);
  assert.match(body.systemInstruction.parts[0].text, /Freigabe nur, wenn .* verschärfen die Prüfung, lockern sie aber nie\): Jahreszahlen besonders streng prüfen\.$/);
  assert.deepEqual(body.generationConfig, { responseMimeType: 'application/json' });
});

test('the final desk follows the switches; the jury\'s notes are always worked in; prompts carry the owner\'s text', async () => {
  const draft: Script = { title: 'Entwurf', text: 'Ein Satz mit einigen Wörtern für die Probe hier.', sourceIds: ['s1'] };
  const calls: string[] = [];
  let notes = '';
  const editor: ScriptEditor = {
    polish: async script => { calls.push('polish'); return { ...script, text: `${script.text} Neu.` }; },
    judge: async () => { calls.push('judge'); return marks(4.8, notes); },
  };
  const run = async (config: Parameters<typeof resolveAgents>[0]) => { calls.length = 0; return finishScript(editor, draft, sources, { agents: resolveAgents(config) }, context); };
  assert.equal((await run(undefined)).quality?.overall, 4.8);
  assert.deepEqual(calls, ['polish', 'judge']);
  // Notes are worked in even above the bar, at most twice.
  notes = 'mehr Tempo';
  const revised = await run(undefined);
  assert.deepEqual(calls, ['polish', 'judge', 'polish', 'judge', 'polish', 'judge']);
  assert.deepEqual(revised.quality?.rounds, [4.8, 4.8, 4.8]);
  const unedited = await run({ editor: { enabled: false }, jury: { threshold: 5 } });
  assert.deepEqual(calls, ['judge']);
  assert.equal(unedited.text, draft.text);
  const unjudged = await run({ jury: { enabled: false } });
  assert.deepEqual(calls, ['polish']);
  assert.equal(unjudged.quality, undefined);

  const asked: Array<{ system: string; temperature?: number }> = [];
  const gemini = new GeminiScriptEditor(async (system, _input, _label, temperature) => { asked.push({ system, temperature }); return {}; });
  const agents = resolveAgents({ editor: { instructions: 'Mehr Humor.', temperature: 0.7 }, jury: { instructions: 'Achte auf Humor.', temperature: 0.2 } });
  await gemini.polish(draft, sources, { agents }, context);
  await gemini.judge(draft, sources, { agents });
  assert.match(asked[0].system, /nach diesem Stilbuch: Mehr Humor\. Behalte alle Tatsachen/);
  assert.equal(asked[0].temperature, 0.7);
  assert.match(asked[1].system, /Achte auf Humor\. Antworte als JSON/);
  assert.equal(asked[1].temperature, 0.2);
});

test('a trial run uses the unsaved settings on the last spoken item and stores nothing', async () => {
  const base = defaultStationConfig({ timezone: 'Europe/Zurich' });
  const store = new StationStore(sqliteD1());
  const deps: StationDeps = {
    store, podcastAvailable: false, now: () => NOW, newId: () => 'x',
    fetchFeed: async () => [], reserveFeed: async () => {}, reserveGeneration: async () => {},
    audio: { put: async () => {}, delete: async () => {} },
    editor: { polish: async (script, _s, direction) => ({ ...script, text: `${script.text} ${direction?.agents?.editor.instructions}` }), judge: async () => marks(4.5, '') },
    pipeline: {
      draft: async (_profile, _sources, _mode, direction) => ({ title: 'Neu', text: `Frisch: ${direction?.agents?.writer.instructions}`, sourceIds: ['s1'] }),
      review: async () => ({ approved: true, reasons: [] }), voice: async () => { throw new Error('no voice'); },
    },
  };
  assert.deepEqual(await trialAgent(deps, 'o', 'editor', undefined), { ok: false, error: 'NO_ITEM' });
  await store.saveConfig('o', base, NOW);
  assert.deepEqual(await trialAgent(deps, 'o', 'editor', undefined), { ok: false, error: 'NO_ITEM' });
  const show = base.shows.find(item => item.format === 'brief')!;
  await store.insertItem('o', { id: 'a', seq: 1, showId: show.id, plannedAt: NOW.toISOString(), estimatedMinutes: 2 }, NOW);
  const stored: Script = { title: 'Gestern', text: 'Ein Satz mit einigen Wörtern für die Probe.', sourceIds: ['s1'], quality: { ...marks(3), overall: 3 } };
  await store.update('o', 'a', { state: 'ready', script_json: JSON.stringify(stored), sources_json: JSON.stringify(sources) }, NOW);

  const edited = await trialAgent(deps, 'o', 'editor', { editor: { instructions: 'Mit Pfiff.' } });
  assert.ok(edited.ok);
  assert.equal(edited.itemTitle, 'Gestern');
  assert.equal(edited.before.quality?.overall, 3);
  assert.equal(edited.after.text, `${stored.text} Mit Pfiff.`);
  assert.equal(edited.after.quality?.overall, 4.5);
  const judged = await trialAgent(deps, 'o', 'jury', { editor: { enabled: false } });
  assert.ok(judged.ok && judged.after.text === stored.text && judged.after.quality?.overall === 4.5);
  const written = await trialAgent(deps, 'o', 'writer', { writer: { instructions: 'Knapp.' } });
  assert.ok(written.ok && written.after.text === 'Frisch: Knapp.');
  assert.deepEqual(JSON.parse((await store.getItem('o', 'a'))!.script_json!), stored);
});

test('repeated 👎 reasons become notes for writer, editor and jury; one-offs do not', async () => {
  const store = new StationStore(sqliteD1());
  const dislike = async (itemId: string) => store.addFeedback('o', { itemId, interests: [], action: 'dislike', listenedRatio: 1, createdAt: NOW.toISOString() });
  for (const id of ['a', 'b', 'c']) await dislike(id);
  assert.equal(await store.setReason('o', 'x', 'boring'), false);
  assert.ok(await store.setReason('o', 'a', 'too_long'));
  assert.ok(await store.setReason('o', 'b', 'too_long'));
  assert.ok(await store.setReason('o', 'c', 'boring'));
  const counts = await store.reasonCounts('o', new Date(NOW.getTime() - 86_400_000));
  const notes = listenerNotes(counts);
  assert.equal(notes.length, 1);
  assert.match(notes[0], /zu lang/);

  let body: any;
  const writer = new GeminiBriefGenerator({ key: 'g' }, async (_url, init) => { body = JSON.parse(String(init?.body)); return geminiText(JSON.stringify({ title: 'T', text: 'Ein Fakt.', sourceIds: ['s1'] })); });
  await writer.generate(defaultProfile, sources, { listenerNotes: notes });
  assert.match(body.systemInstruction.parts[0].text, /Rückmeldungen des Hörers, die du berücksichtigen sollst: Beiträge waren dem Hörer zuletzt oft zu lang/);
  const asked: string[] = [];
  const gemini = new GeminiScriptEditor(async system => { asked.push(system); return {}; });
  const draft: Script = { title: 'T', text: 'Ein Fakt.', sourceIds: ['s1'] };
  await gemini.polish(draft, sources, { listenerNotes: notes }, context);
  await gemini.judge(draft, sources, { listenerNotes: notes });
  assert.match(asked[0], /Rückmeldungen des Hörers/);
  assert.match(asked[1], /Werte besonders streng, was der Hörer zuletzt bemängelt hat: Beiträge waren/);
  await store.clearReasons('o');
  assert.deepEqual(await store.reasonCounts('o', new Date(0)), []);
});

test('style presets set several agents at once and are recognised afterwards', () => {
  const news = AGENT_PRESETS.find(preset => preset.id === 'nachrichten')!;
  const applied = applyPreset({ music: { temperature: 0.5 } }, news);
  assert.equal(applied.music?.temperature, 0.5);
  assert.equal(activePreset(applied)?.id, 'nachrichten');
  // Every preset survives the server's validation unchanged, so it is still recognised after saving.
  for (const preset of AGENT_PRESETS) assert.deepEqual(parseAgentConfig(preset.agents, fail), preset.agents);
  assert.equal(activePreset({ ...applied, writer: { instructions: 'Anders.' } }), undefined);
});

test('the music desk and the music hour can be tried with unsaved settings', async () => {
  const base = defaultStationConfig({ timezone: 'Europe/Zurich' });
  const store = new StationStore(sqliteD1());
  await store.saveConfig('o', base, NOW);
  let seen: any;
  const deps: StationDeps = {
    store, podcastAvailable: false, now: () => NOW, newId: () => 'x',
    fetchFeed: async () => [], reserveFeed: async () => {}, reserveGeneration: async () => {},
    audio: { put: async () => {}, delete: async () => {} },
    pipeline: { draft: async () => { throw new Error('no'); }, review: async () => ({ approved: true, reasons: [] }), voice: async () => { throw new Error('no'); } },
    musicWriter: {
      pickSubject: async () => ({ subject: 'x', reason: '' }), pickTracks: async () => [], writeBlock: async () => [],
      pickSongs: async input => { seen = input; return [{ title: 'Song', artist: 'Band', announcement: `Hier: ${input.direction.agents?.music.instructions}` }]; },
      writeHour: async input => ({ title: 'Neu', intro: { text: `Hallo ${input.direction.agents?.hour.instructions}`, sourceIds: [] }, tracks: input.picks.map((_, index) => ({ index, text: `Zu Song ${index + 1}`, sourceIds: [] })), outro: { text: 'Tschüss', sourceIds: [] } }),
    },
  };
  const songs = await trialAgent(deps, 'o', 'music', { music: { instructions: 'Nur Jazz.' } });
  assert.ok(songs.ok);
  assert.equal(seen.announce, true);
  assert.equal(songs.after.text, '– Band – Song\n  «Hier: Nur Jazz.»');
  assert.equal(songs.before.text, 'Noch keine Songs gespielt.');

  assert.deepEqual(await trialAgent(deps, 'o', 'hour', undefined), { ok: false, error: 'NO_ITEM' });
  await store.insertItem('o', { id: 'h', seq: 1, showId: 'kuenstler', plannedAt: NOW.toISOString(), estimatedMinutes: 60 }, NOW);
  const pkg = { kind: 'artist_hour', artist: 'Portishead', title: 'Portishead-Stunde', text: '', sourceIds: [], parts: [
    { kind: 'speech', text: 'Willkommen.', sourceIds: [] }, { kind: 'track', uri: 'spotify:track:1', title: 'Roads', artist: 'Portishead', durationMs: 1 }, { kind: 'speech', text: 'Das war Roads.', sourceIds: [] }] };
  await store.update('o', 'h', { state: 'played', script_json: JSON.stringify(pkg), sources_json: '[]' }, NOW);
  const hour = await trialAgent(deps, 'o', 'hour', { hour: { instructions: 'Mit Witz.' } });
  assert.ok(hour.ok);
  assert.equal(hour.itemTitle, 'Portishead-Stunde');
  assert.equal(hour.before.text, 'Willkommen.\n\n♪ Portishead – Roads\n\nDas war Roads.');
  assert.equal(hour.after.text, 'Hallo Mit Witz.\n\nZu Song 1\n\n♪ Portishead – Roads\n\nTschüss');
});
