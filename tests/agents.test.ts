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

const NOW = new Date('2026-09-28T05:30:00Z');
const sources: Source[] = [{ id: 's1', url: 'https://example.org/a', title: 'Quelle', excerpt: 'Ein Fakt.', publishedAt: NOW.toISOString(), retrievedAt: NOW.toISOString() }];
const geminiText = (text: string) => Response.json({ candidates: [{ content: { parts: [{ text }] } }] });
const fail = (path: string, expected: string): never => { throw new ConfigError(`${path}: ${expected}`); };
const context: StationContext = { stationName: 'Radio', when: 'Montag, 07:30', afterMusic: false };
const marks = (overall: number) => ({ hook: overall, clarity: overall, facts: overall, novelty: overall, length: overall, notes: 'mehr Tempo' });

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

test('the writer, research and fact check use the owner\'s instructions and temperature; the fact check rules stay', async () => {
  const agents = resolveAgents({ writer: { instructions: 'Schreibe wie ein Wetterfrosch.', temperature: 0.8 }, research: { instructions: 'Nur Schweizer Quellen.', temperature: 0.1 },
    verifier: { instructions: 'Jahreszahlen besonders streng prüfen.' } });
  let body: any;
  const writer = new GeminiBriefGenerator({ key: 'g' }, async (_url, init) => { body = JSON.parse(String(init?.body)); return geminiText(JSON.stringify({ title: 'T', text: 'Ein Fakt.', sourceIds: ['s1'] })); });
  await writer.generate(defaultProfile, sources, { agents });
  assert.match(body.systemInstruction.parts[0].text, /Keine neuen Fakten erfinden\. Schreibe wie ein Wetterfrosch\. Antworte ausschliesslich als JSON/);
  assert.equal(body.generationConfig.temperature, 0.8);

  const researcher = new GeminiResearcher({ key: 'g' }, async (_url, init) => { body = JSON.parse(String(init?.body)); return geminiText(''); });
  await researcher.research({ brief: 'x', interests: [], avoidTopics: [], now: NOW, agent: agents.research });
  assert.match(body.systemInstruction.parts[0].text, /Nutze die Google-Suche\. Nur Schweizer Quellen\.$/);
  assert.equal(body.generationConfig.temperature, 0.1);

  const verifier = new GeminiEditorialVerifier({ key: 'g' }, async (_url, init) => { body = JSON.parse(String(init?.body));
    return geminiText(JSON.stringify({ approved: true, reasons: [], checks: [{ claim: 'Fakt', sourceIds: ['s1'], quote: 'Ein Fakt', supported: true }] })); });
  const script: Script = { title: 'T', text: 'Ein Fakt.', sourceIds: ['s1'] };
  assert.equal((await verifier.verify(script, sources, agents.verifier.instructions)).approved, true);
  assert.match(body.systemInstruction.parts[0].text, /Freigabe nur, wenn .* verschärfen die Prüfung, lockern sie aber nie\): Jahreszahlen besonders streng prüfen\.$/);
  assert.equal(body.generationConfig.temperature, 0);
});

test('the final desk follows the switches and the jury\'s bar; editor and jury prompts carry the owner\'s text', async () => {
  const draft: Script = { title: 'Entwurf', text: 'Ein Satz mit einigen Wörtern für die Probe hier.', sourceIds: ['s1'] };
  const calls: string[] = [];
  const editor: ScriptEditor = {
    polish: async script => { calls.push('polish'); return { ...script, text: `${script.text} Neu.` }; },
    judge: async () => { calls.push('judge'); return marks(3.8); },
  };
  const run = async (config: Parameters<typeof resolveAgents>[0]) => { calls.length = 0; return finishScript(editor, draft, sources, { agents: resolveAgents(config) }, context); };
  assert.equal((await run(undefined)).quality?.overall, 3.8);
  assert.deepEqual(calls, ['polish', 'judge']);
  await run({ jury: { threshold: 4.5 } });
  assert.deepEqual(calls, ['polish', 'judge', 'polish', 'judge']);
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
    editor: { polish: async (script, _s, direction) => ({ ...script, text: `${script.text} ${direction?.agents?.editor.instructions}` }), judge: async () => marks(4.5) },
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
