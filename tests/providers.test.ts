import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AskTextGenerator, MistralSpeechSynthesizer } from '../server/providers.ts';
import { defaultProfile, parseProfile, parseScript } from '../src/domain/program.ts';
const sources = [{ id: 's1', url: 'https://example.org/news', title: 'Test', excerpt: 'Ein Test.', publishedAt: '2026-09-25', retrievedAt: '2026-09-25' }];
test('script rejects invented source IDs', () => {
  assert.throws(() => parseScript({ title: 'News', text: 'Text', sourceIds: ['invented'] }, sources));
});
test('script rejects missing sources and empty text', () => {
  assert.throws(() => parseScript({ title: 'News', text: 'Text', sourceIds: [] }, sources));
  assert.throws(() => parseScript({ title: 'News', text: ' ', sourceIds: ['s1'] }, sources));
});
test('corrupt profile is bounded and unknown topics removed', () => {
  assert.deepEqual(parseProfile({ topics: ['Wissenschaft', 'Wissenschaft', 'bad'], speechMinutes: 999, exploration: -10 }), {
    topics: ['Wissenschaft'], speechMinutes: 10, exploration: 0,
  });
  assert.equal(parseProfile({ speechMinutes: NaN }).speechMinutes, 3);
});
test('ASK keeps source text in data and uses configured endpoint', async () => {
  const ask = new AskTextGenerator({ baseUrl: 'https://ask.example/api/v1/', key: 'test-only', model: 'test-model' }, async (url, init) => {
    assert.equal(url, 'https://ask.example/api/v1/chat/completions');
    const body = JSON.parse(String(init?.body));
    assert.equal(body.response_format.type, 'json_object');
    assert.deepEqual(JSON.parse(body.messages[1].content).sources, sources);
    return Response.json({ choices: [{ message: { content: JSON.stringify({ title: 'Test', text: 'Ein Test.', sourceIds: ['s1'] }) } }] });
  });
  assert.equal((await ask.generate(defaultProfile, sources)).title, 'Test');
});
test('provider failures do not expose response body or secrets', async () => {
  const ask = new AskTextGenerator({ baseUrl: 'https://ask.example/api/v1', key: 'sensitive', model: 'test' }, async () => new Response('sensitive upstream dump', { status: 401 }));
  await assert.rejects(ask.generate(defaultProfile, sources), { message: 'ASK request failed (401)' });
});
test('ASK rejects insecure endpoint and missing sources before request', async () => {
  assert.throws(() => new AskTextGenerator({ baseUrl: 'http://ask.example', key: 'test', model: 'test' }));
  const ask = new AskTextGenerator({ baseUrl: 'https://ask.example', key: 'test', model: 'test' }, async () => { throw new Error('must not call'); });
  await assert.rejects(ask.generate(defaultProfile, []), /sources missing/);
});
test('Mistral decodes audio_data and sends voice and model', async () => {
  const tts = new MistralSpeechSynthesizer({ key: 'test', voiceId: 'voice-test' }, async (url, init) => {
    assert.equal(url, 'https://api.mistral.ai/v1/audio/speech');
    const body = JSON.parse(String(init?.body)); assert.equal(body.voice_id, 'voice-test');
    assert.equal(body.model, 'voxtral-mini-tts-2603');
    return Response.json({ audio_data: 'SUQz' });
  });
  assert.equal(Buffer.from(await tts.synthesize('Guten Tag.')).toString(), 'ID3');
});
test('TTS rejects oversized input without spending money', async () => {
  const tts = new MistralSpeechSynthesizer({ key: 'test', voiceId: 'test' }, async () => { throw new Error('must not call'); });
  await assert.rejects(tts.synthesize('Wort '.repeat(281)), /budget/);
});
