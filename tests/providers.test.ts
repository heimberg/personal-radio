import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AskEditorialVerifier, AskTextGenerator, GeminiPodcastGenerator, GeminiPodcastSpeechSynthesizer, MistralSpeechSynthesizer } from '../server/providers.ts';
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
    topics: ['Wissenschaft'], interests: [], interestWeights: {}, speechMinutes: 10, exploration: 0,
  });
  assert.equal(parseProfile({ speechMinutes: NaN }).speechMinutes, 3);
});
test('Gemini creates a validated, source-cited two-host script from the official generation endpoint', async () => {
  const generator = new GeminiPodcastGenerator({ key: 'test-key' }, async (url, init) => {
    assert.equal(url, 'https://generativelanguage.googleapis.com/v1beta/models/gemini-3.8-flash:generateContent');
    assert.equal(new Headers(init?.headers).get('x-goog-api-key'), 'test-key');
    const body = JSON.parse(String(init?.body));
    assert.equal(body.generationConfig.responseMimeType, 'application/json');
    return Response.json({ candidates: [{ content: { parts: [{ text: JSON.stringify({ title: 'Zwei Hosts', turns: [
      { speaker: 'host-a', text: 'Erste Aussage.' }, { speaker: 'host-b', text: 'Zweite Aussage.' },
    ], sourceIds: ['s1'], interestTags: ['Geschichte'] }) }] } }] });
  });
  const result = await generator.generate({ ...defaultProfile, interests: ['Geschichte'] }, sources);
  assert.equal(result.text, 'Erste Aussage. Zweite Aussage.');
  assert.equal(result.turns?.[1]?.speaker, 'host-b');
});
test('Gemini TTS sends two configured voices and accepts only WAV audio', async () => {
  const wav = Buffer.alloc(48); wav.write('RIFF', 0); wav.write('WAVE', 8);
  const synth = new GeminiPodcastSpeechSynthesizer({ key: 'test-key', voiceA: 'Kore', voiceB: 'Puck' }, async (url, init) => {
    assert.equal(url, 'https://generativelanguage.googleapis.com/v1beta/interactions');
    const body = JSON.parse(String(init?.body));
    assert.equal(body.generation_config.speech_config.mode, 'conversational');
    assert.deepEqual(body.generation_config.speech_config.speakers.map((speaker: any) => speaker.voice), ['Kore', 'Puck']);
    assert.deepEqual(body.input[0].content.map((turn: any) => turn.annotations[0].speaker), ['host-a', 'host-b']);
    return Response.json({ steps: [{ type: 'model_output', content: [{ type: 'audio', data: wav.toString('base64') }] }] });
  });
  const result = await synth.synthesize('A B', [{ speaker: 'host-a', text: 'A' }, { speaker: 'host-b', text: 'B' }]);
  assert.equal(Buffer.from(result).toString('ascii', 0, 4), 'RIFF');
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
test('ASK verifier approves only direct quotes from cited source excerpts', async () => {
  const verifier = new AskEditorialVerifier({ baseUrl: 'https://ask.example/api/v1', key: 'test', model: 'test' }, async (_url, init) => {
    const body = JSON.parse(String(init?.body));
    assert.equal(body.temperature, 0);
    return Response.json({ choices: [{ message: { content: JSON.stringify({ approved: true,
      checks: [{ claim: 'Ein Test', sourceIds: ['s1'], quote: 'Ein Test.', supported: true }], reasons: [] }) } }] });
  });
  assert.equal((await verifier.verify({ title: 'News', text: 'Ein Test.', sourceIds: ['s1'] }, sources)).approved, true);
  const forged = new AskEditorialVerifier({ baseUrl: 'https://ask.example/api/v1', key: 'test', model: 'test' }, async () =>
    Response.json({ choices: [{ message: { content: JSON.stringify({ approved: true,
      checks: [{ claim: 'Behauptung', sourceIds: ['s1'], quote: 'Das steht hier nicht.', supported: true }], reasons: [] }) } }] }));
  assert.equal((await forged.verify({ title: 'News', text: 'Behauptung.', sourceIds: ['s1'] }, sources)).approved, false);
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
