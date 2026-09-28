import { test } from 'node:test';
import assert from 'node:assert/strict';
import { produceWithTeam } from '../server/agentic/music-hour.ts';
import type { TeamRequest, TeamTools } from '../server/agentic/music-hour.ts';
import { D1StepRunner } from '../server/agentic/steps.ts';
import { sqliteD1 } from './d1-sqlite.ts';

const NOW = new Date('2026-09-28T08:00:00Z');
const request: TeamRequest = { focus: 'artist', subject: 'Portishead', count: 3, talkSeconds: 60, instructions: 'Frühwerk', researchPrompt: '',
  direction: { stationName: 'Radio', persona: { name: 'Mira', tone: 'warm', style: 'Radio', instructions: '' } } };
const source = (url: string, excerpt: string) => ({ id: 'x', url, title: new URL(url).hostname, excerpt, publishedAt: NOW.toISOString(), retrievedAt: NOW.toISOString() });

/** A fake team: every call is recorded; the scripts cite the sources the editor was given. */
function fakeTools(options: { failEditorOnce?: boolean; unknownSongs?: boolean } = {}) {
  const calls: string[] = [], inputs: Record<string, any> = {};
  let editorFailures = options.failEditorOnce ? 1 : 0;
  const script = (label: string, songs: number) => ({ title: 'Portishead in Bristol', intro: { text: `${label} Intro.`, sourceIds: ['w1'] },
    tracks: Array.from({ length: songs }, (_, index) => ({ index, text: `${label} Song ${index + 1}.`, sourceIds: [`s${index + 1}w1`] })), outro: { text: `${label} Outro.`, sourceIds: [] } });
  const tools: TeamTools = {
    now: () => NOW,
    researcher: { research: async input => {
      calls.push(`research: ${input.brief.slice(0, 40)}`);
      const slug = input.brief.includes('«') ? input.brief.split('«')[1].split('»')[0].replace(/\W/g, '').toLowerCase() : 'dossier';
      return { sources: [source(`https://example.org/${slug}`, `Beleg zu ${slug}.`)], queries: [`q ${slug}`] };
    } },
    catalog: { find: async pick => options.unknownSongs ? null : { uri: `spotify:track:${pick.title.replace(/\W/g, '')}`, durationMs: 200_000 } },
    model: { askJson: async (_system, input, label) => {
      calls.push(label); inputs[label] = input;
      switch (label) {
        case 'Gemini director': return { title: 'Portishead in Bristol', angle: 'Vom Studio in die Welt', specialists: [{ topic: 'Bristol Sound', question: 'Was prägte die Szene?' }],
          songs: ['Glory Box', 'Roads', 'Sour Times', 'Numb'].map(title => ({ title, artist: 'Portishead', role: 'r', question: `Wie entstand ${title}?` })) };
        case 'Gemini lyric analyst': return { themes: 'Sehnsucht', mood: 'dunkel', confidence: 'mittel' };
        case 'Gemini segment editor':
          if (editorFailures-- > 0) throw new Error('editor timeout');
          return script('Entwurf', (input as { songs: unknown[] }).songs.length);
        case 'Gemini fact checker': return { issues: [{ part: '1', sentence: 'Entwurf Song 2.', problem: 'nicht belegt' }] };
        case 'Gemini continuity editor': return script('Final', (input as { skript: { tracks: unknown[] } }).skript.tracks.length);
        default: throw new Error(`unexpected ${label}`);
      }
    } },
  };
  return { tools, calls, inputs };
}

test('the editorial team plans, researches every song, writes, checks and edits; sources are cited per song', async () => {
  const { tools, calls, inputs } = fakeTools();
  const db = sqliteD1();
  const result = await produceWithTeam({ runId: 'item-1', ownerId: 'owner@example.test', request, tools, steps: new D1StepRunner(db, 'owner@example.test', 'item-1') });
  assert.ok(result.ok);
  if (!result.ok) return;
  assert.deepEqual(result.songs.map(song => song.title), ['Glory Box', 'Roads', 'Sour Times']);
  assert.equal(result.script.intro.text, 'Final Intro.');
  assert.deepEqual(result.script.tracks.map(track => track.sourceIds), [['s1w1'], ['s2w1'], ['s3w1']]);
  assert.deepEqual(result.sources.map(item => item.id), ['w1', 's1w1', 's2w1', 's3w1', 'x1w1']);
  assert.equal(result.corrections, 1); assert.equal(result.specialists, 1);
  // Dossier, three songs and one specialist researched; three songs analysed; one draft, check and edit.
  assert.equal(calls.filter(call => call.startsWith('research')).length, 5);
  assert.equal(calls.filter(call => call === 'Gemini lyric analyst').length, 3);
  assert.deepEqual(calls.filter(call => ['Gemini director', 'Gemini segment editor', 'Gemini fact checker', 'Gemini continuity editor'].includes(call)),
    ['Gemini director', 'Gemini segment editor', 'Gemini fact checker', 'Gemini continuity editor']);
  assert.deepEqual(inputs['Gemini segment editor'].songs[0].deutung, { themes: 'Sehnsucht', mood: 'dunkel', confidence: 'mittel' });
  assert.deepEqual(inputs['Gemini continuity editor'].probleme, [{ part: '1', sentence: 'Entwurf Song 2.', problem: 'nicht belegt' }]);
  assert.ok(result.queries.includes('q glorybox') && result.queries.includes('q dossier'));
});

test('a failed run resumes after the last finished task instead of paying for it again', async () => {
  const db = sqliteD1();
  const first = fakeTools({ failEditorOnce: true });
  // The editor fails on every attempt of the first run (limit 2 retries = 3 tries), so the run stops there.
  let tries = 0;
  const failing = { ...first.tools, model: { askJson: async (system: string, input: unknown, label: string) => {
    if (label === 'Gemini segment editor') { tries++; throw new Error('editor down'); }
    return first.tools.model.askJson(system, input, label);
  } } };
  await assert.rejects(produceWithTeam({ runId: 'item-2', ownerId: 'o', request, tools: failing, steps: new D1StepRunner(db, 'o', 'item-2') }), /editor down/);
  assert.equal(tries, 3);
  const second = fakeTools();
  const result = await produceWithTeam({ runId: 'item-2', ownerId: 'o', request, tools: second.tools, steps: new D1StepRunner(db, 'o', 'item-2') });
  assert.ok(result.ok);
  // Research, director and lyric notes came from the checkpoints; only writing onwards ran again.
  assert.deepEqual(second.calls, ['Gemini segment editor', 'Gemini fact checker', 'Gemini continuity editor']);
  await new D1StepRunner(db, 'o', 'item-2').clear();
  assert.equal((db as any).raw.prepare('SELECT COUNT(*) AS n FROM agent_steps').get().n, 0);
});

test('a revision that loses a moderation is discarded; the checked draft goes on air', async () => {
  const { tools } = fakeTools();
  const broken = { ...tools, model: { askJson: async (system: string, input: unknown, label: string) => {
    const result = await tools.model.askJson(system, input, label) as { tracks?: unknown[] };
    return label === 'Gemini continuity editor' ? { ...result, tracks: result.tracks!.slice(0, 1) } : result;
  } } };
  const result = await produceWithTeam({ runId: 'item-4', ownerId: 'o', request, tools: broken, steps: new D1StepRunner(sqliteD1(), 'o', 'item-4') });
  assert.ok(result.ok);
  if (result.ok) assert.deepEqual(result.script.tracks.map(track => track.text), ['Entwurf Song 1.', 'Entwurf Song 2.', 'Entwurf Song 3.']);
});

test('too few songs on Spotify end the run with the count; nothing is written', async () => {
  const { tools, calls } = fakeTools({ unknownSongs: true });
  const result = await produceWithTeam({ runId: 'item-3', ownerId: 'o', request, tools, steps: new D1StepRunner(sqliteD1(), 'o', 'item-3') });
  assert.deepEqual(result, { ok: false, error: 'TOO_FEW_TRACKS: 0 von 4 Songs auf Spotify gefunden' });
  assert.ok(!calls.includes('Gemini segment editor'));
});
