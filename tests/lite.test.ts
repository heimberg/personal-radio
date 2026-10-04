import { test } from 'node:test';
import assert from 'node:assert/strict';
import { GeminiMusicWriter } from '../server/music.ts';

const answer = (body: unknown, status = 200) => new Response(JSON.stringify(status === 200 ? { candidates: [{ content: { parts: [{ text: JSON.stringify(body) }] } }] } : { error: { message: 'model not found' } }), { status });

test('small tasks go to the lite model, writing stays on the main model, an unknown lite model falls back once', async () => {
  const asked: string[] = [];
  let liteKnown = true;
  const writer = new GeminiMusicWriter({ key: 'k', model: 'main-model', liteModel: 'lite-model' }, async input => {
    const model = /models\/([^:]+):/.exec(String(input))![1];
    asked.push(model);
    return model === 'lite-model' && !liteKnown ? answer(null, 404) : answer({ ok: true });
  });
  await writer.askJson('Jury', {}, 'Gemini quality jury');
  await writer.askJson('Übergang', {}, 'Gemini linker');
  await writer.askJson('Schlussredaktion', {}, 'Gemini final edit');
  assert.deepEqual(asked, ['lite-model', 'lite-model', 'main-model']);
  // The project does not offer the lite model: the main model answers, now and from then on.
  liteKnown = false; asked.length = 0;
  assert.deepEqual(await writer.askJson('Quiz', {}, 'Gemini quiz'), { ok: true });
  await writer.askJson('Quiz', {}, 'Gemini quiz');
  assert.deepEqual(asked, ['lite-model', 'main-model', 'main-model']);
  // Without a lite model everything stays on the main model.
  const plain: string[] = [];
  await new GeminiMusicWriter({ key: 'k', model: 'main-model' }, async input => { plain.push(String(input)); return answer({}); }).askJson('Jury', {}, 'Gemini quality jury');
  assert.match(plain[0], /main-model/);
});
