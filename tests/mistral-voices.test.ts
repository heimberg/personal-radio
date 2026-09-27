import { test } from 'node:test';
import assert from 'node:assert/strict';
import { listMistralVoices } from '../server/mistral-voices.ts';

test('voice catalog requests Mistral using server key and returns bounded voice metadata', async () => {
  const voices = await listMistralVoices('private-key', async (input, init) => {
    assert.equal(String(input), 'https://api.mistral.ai/v1/audio/voices?limit=1000&type=all');
    assert.equal(new Headers(init?.headers).get('Authorization'), 'Bearer private-key');
    return Response.json({ items: [
      { id: 'preset-1', name: 'Paul', type: 'preset', languages: ['en'], gender: 'male', user_id: 'must-not-return' },
      { id: 'custom-1', name: 'My German voice', type: 'custom', languages: ['de'] },
      { id: 'bad id', name: 'Invalid', type: 'preset' },
    ] });
  });
  assert.deepEqual(voices, [
    { id: 'preset-1', name: 'Paul', type: 'preset', languages: ['en'], gender: 'male' },
    { id: 'custom-1', name: 'My German voice', type: 'custom', languages: ['de'] },
  ]);
});

test('voice catalog hides upstream errors and rejects missing credentials', async () => {
  await assert.rejects(listMistralVoices('key', async () => new Response('private upstream detail', { status: 401 })),
    { message: 'Mistral voice catalog unavailable' });
  await assert.rejects(listMistralVoices(''), { message: 'Mistral is not configured' });
});
