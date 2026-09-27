import { test } from 'node:test';
import assert from 'node:assert/strict';
import { listMistralVoices } from '../server/mistral-voices.ts';

test('voice catalog always includes the built-in Mistral presets and adds account voices', async () => {
  const voices = await listMistralVoices('private-key', async (input, init) => {
    assert.equal(String(input), 'https://api.mistral.ai/v1/audio/voices?limit=1000&type=all');
    assert.equal(new Headers(init?.headers).get('Authorization'), 'Bearer private-key');
    return Response.json({ items: [
      { id: 'preset-1', name: 'Listed preset', type: 'preset', languages: ['en'] },
      { id: 'custom-1', name: 'My German voice', type: 'custom', languages: ['de'], user_id: 'must-not-return' },
      { id: 'bad id', name: 'Invalid', type: 'preset' },
    ] });
  });
  assert.ok(voices.some(voice => voice.id === 'en_paul_neutral'));
  assert.ok(voices.some(voice => voice.id === 'gb_oliver_neutral'));
  assert.ok(voices.some(voice => voice.id === 'fr_marie_neutral'));
  assert.deepEqual(voices.find(voice => voice.id === 'custom-1'), {
    id: 'custom-1', name: 'My German voice', type: 'custom', languages: ['de'],
  });
  assert.equal(voices.some(voice => voice.id === 'bad id'), false);
});

test('preset voices remain selectable when the account catalog is empty or unavailable', async () => {
  const empty = await listMistralVoices('key', async () => Response.json({ items: [] }));
  assert.ok(empty.length >= 4);
  const fallback = await listMistralVoices('key', async () => new Response('upstream detail', { status: 401 }));
  assert.ok(fallback.some(voice => voice.id === 'en_paul_neutral'));
  const withoutKey = await listMistralVoices('');
  assert.ok(withoutKey.some(voice => voice.id === 'gb_oliver_neutral'));
});
