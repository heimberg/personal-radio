import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CharacterBudget, PipelineError, SegmentPipeline } from '../server/segment-pipeline.ts';
import type { EditorialVerifier } from '../server/segment-pipeline.ts';
import type { Profile, Source, TextGenerator, SpeechSynthesizer } from '../src/domain/program.ts';

const profile: Profile = { topics: ['Wissenschaft'], interests: ['Geschichte'], interestWeights: {}, speechMinutes: 2, exploration: 10 };
const sources: Source[] = [{ id: 'src-1', url: 'https://news.example.org/item', title: 'Eine Meldung',
  publishedAt: '2026-09-25T10:00:00Z', retrievedAt: '2026-09-25T10:05:00Z', excerpt: 'Belegbarer Quellenauszug.' }];
const key = 'request-key-0001';
function fixture(options: { approved?: boolean; text?: string; sourceIds?: string[]; gate?: Promise<void>; budget?: number } = {}) {
  let textCalls = 0, verifyCalls = 0, ttsCalls = 0;
  const generator: TextGenerator = { generate: async () => {
    textCalls++; await options.gate;
    return { title: 'Einordnung', text: options.text ?? 'Ein überprüfbarer Beitrag.', sourceIds: options.sourceIds ?? ['src-1'] };
  } };
  const verifier: EditorialVerifier = { verify: async () => {
    verifyCalls++; return { approved: options.approved ?? true, reasons: [] };
  } };
  const speech: SpeechSynthesizer = { synthesize: async () => { ttsCalls++; return new Uint8Array([1, 2, 3]); } };
  const pipeline = new SegmentPipeline(generator, speech, verifier, new CharacterBudget(options.budget ?? 12_000));
  return { pipeline, counts: () => ({ textCalls, verifyCalls, ttsCalls }) };
}

test('approved script is checked before speech and returned with citations', async () => {
  const f = fixture(); const result = await f.pipeline.prepare('user-123', key, profile, sources);
  assert.equal(result.script.title, 'Einordnung'); assert.deepEqual(result.script.sourceIds, ['src-1']);
  assert.equal(result.contentType, 'audio/mpeg'); assert.equal(result.ttsCharacters, 26);
  assert.deepEqual(f.counts(), { textCalls: 1, verifyCalls: 1, ttsCalls: 1 });
});

test('podcast mode uses the Gemini two-host path while retaining ASK evidence review', async () => {
  let podcastTextCalls = 0, podcastSpeechCalls = 0;
  const wav = new Uint8Array(48); wav.set(new TextEncoder().encode('RIFF'), 0); wav.set(new TextEncoder().encode('WAVE'), 8);
  const generator: TextGenerator = { generate: async () => { podcastTextCalls++; return {
    title: 'Dialog', text: 'Hallo. Welt.', sourceIds: ['src-1'], interestTags: ['Geschichte'],
    turns: [{ speaker: 'host-a', text: 'Hallo.' }, { speaker: 'host-b', text: 'Welt.' }],
  }; } };
  const speech: SpeechSynthesizer = { synthesize: async (_text, turns) => { podcastSpeechCalls++; assert.equal(turns?.length, 2); return wav; } };
  const verifier: EditorialVerifier = { verify: async script => ({ approved: script.sourceIds.includes('src-1'), reasons: [] }) };
  const pipeline = new SegmentPipeline({ generate: async () => { throw new Error('ASK short path must not run'); } },
    { synthesize: async () => { throw new Error('Mistral path must not run'); } }, verifier, new CharacterBudget(), 4, { text: generator, speech });
  const result = await pipeline.prepare('user-123', key, profile, sources, 'podcast');
  assert.equal(result.mode, 'podcast'); assert.equal(result.contentType, 'audio/wav'); assert.equal(result.script.turns?.length, 2);
  assert.deepEqual([podcastTextCalls, podcastSpeechCalls], [1, 1]);
});

test('unapproved or malformed citation never reaches TTS', async () => {
  const rejected = fixture({ approved: false });
  await assert.rejects(rejected.pipeline.prepare('user-123', key, profile, sources), { code: 'REJECTED' });
  assert.equal(rejected.counts().ttsCalls, 0);
  const invalid = fixture({ text: 'Unbelegte Aussage.', sourceIds: ['unbekannt'] });
  await assert.rejects(invalid.pipeline.prepare('user-123', key, profile, sources), /Skript oder Quellenverweise ungültig/);
  assert.equal(invalid.counts().ttsCalls, 0);
});

test('unsafe, duplicate or oversized input is rejected before LLM call', async () => {
  const f = fixture();
  await assert.rejects(f.pipeline.prepare('user-123', key, profile, [{ ...sources[0]!, url: 'http://127.0.0.1/admin' }]),
    error => error instanceof PipelineError && error.code === 'INVALID_INPUT');
  await assert.rejects(f.pipeline.prepare('user-123', key, profile, [{ ...sources[0]!, id: 'bad id' }]),
    error => error instanceof PipelineError && error.code === 'INVALID_INPUT');
  assert.equal(f.counts().textCalls, 0);
});

test('same idempotency key coalesces concurrent work for identical input', async () => {
  let release!: () => void; const gate = new Promise<void>(resolve => { release = resolve; });
  const f = fixture({ gate });
  const a = f.pipeline.prepare('user-123', key, profile, sources);
  const b = f.pipeline.prepare('user-123', key, profile, sources);
  assert.deepEqual(f.counts(), { textCalls: 1, verifyCalls: 0, ttsCalls: 0 });
  release(); assert.strictEqual(await a, await b);
  assert.deepEqual(f.counts(), { textCalls: 1, verifyCalls: 1, ttsCalls: 1 });
});

test('same concurrent idempotency key cannot be reused for another payload', async () => {
  let release!: () => void; const gate = new Promise<void>(resolve => { release = resolve; });
  const f = fixture({ gate }); const a = f.pipeline.prepare('user-123', key, profile, sources);
  await assert.rejects(f.pipeline.prepare('user-123', key, profile, [{ ...sources[0]!, excerpt: 'Changed payload' }]),
    error => error instanceof PipelineError && error.code === 'IDEMPOTENCY_CONFLICT');
  release(); await a;
});

test('character budget is per owner, uses Unicode code points and rolls by day', async () => {
  let now = new Date('2026-09-25T23:59:00Z'); const budget = new CharacterBudget(3, () => now);
  await budget.reserve('one', 2); await budget.reserve('two', 3);
  await assert.rejects(budget.reserve('one', 2), error => error instanceof PipelineError && error.code === 'BUDGET_EXCEEDED');
  now = new Date('2026-09-26T00:01:00Z'); await budget.reserve('one', 3);
});

test('daily budget is charged before TTS and a failed call cannot bypass it', async () => {
  const speech: SpeechSynthesizer = { synthesize: async () => { throw new Error('provider timeout'); } };
  const generator: TextGenerator = { generate: async () => ({ title: 'T', text: '1234', sourceIds: ['src-1'] }) };
  const verifier: EditorialVerifier = { verify: async () => ({ approved: true, reasons: [] }) };
  const pipeline = new SegmentPipeline(generator, speech, verifier, new CharacterBudget(4));
  await assert.rejects(pipeline.prepare('user-123', key, profile, sources), /provider timeout/);
  await assert.rejects(pipeline.prepare('user-123', 'request-key-0002', profile, sources),
    error => error instanceof PipelineError && error.code === 'BUDGET_EXCEEDED');
});

test('script budget and concurrency have hard bounds', async () => {
  const long = fixture({ text: 'x'.repeat(12_001) });
  await assert.rejects(long.pipeline.prepare('user-123', key, profile, sources), /Skript oder Quellenverweise ungültig/);
  let release!: () => void; const gate = new Promise<void>(resolve => { release = resolve; });
  const f = fixture({ gate }); const work = Array.from({ length: 4 }, (_, i) => f.pipeline.prepare('user-123', `request-key-000${i}`, profile, sources));
  await assert.rejects(f.pipeline.prepare('user-123', 'request-key-9999', profile, sources),
    error => error instanceof PipelineError && error.code === 'TOO_MANY_REQUESTS');
  release(); await Promise.all(work);
});
