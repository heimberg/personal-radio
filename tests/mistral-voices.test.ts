import { test } from 'node:test';
import assert from 'node:assert/strict';
import { listMistralVoices } from '../server/mistral-voices.ts';

test('voice catalog includes German reference voice and supported Mistral presets without network calls', async () => {
  const voices = await listMistralVoices();
  assert.deepEqual(voices.map(voice => voice.id), [
    'de_kerstin_cc0', 'en_paul_neutral', 'gb_oliver_neutral', 'gb_jane_neutral', 'fr_marie_neutral',
  ]);
  assert.deepEqual(voices.find(voice => voice.id === 'fr_marie_neutral')?.languages, ['fr-FR']);
  assert.deepEqual(voices.find(voice => voice.id === 'de_kerstin_cc0')?.languages, ['de-DE']);
  assert.ok(voices.some(voice => voice.languages.includes('en-US')));
});
