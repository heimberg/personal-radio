import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classify, meteredFetch, tokensOf, usageSummary } from '../server/usage.ts';
import { sqliteD1 } from './d1-sqlite.ts';

test('provider calls and tokens are counted per day and model; other requests pass uncounted', async () => {
  const db = sqliteD1(), now = new Date('2026-09-29T08:00:00Z');
  const answers: Record<string, Response> = {};
  const counted = meteredFetch(db, { askHost: 'ask.example', now: () => now }, async input => {
    const url = String(input);
    return answers[url] ?? Response.json({ usageMetadata: { promptTokenCount: 100, candidatesTokenCount: 20, thoughtsTokenCount: 5 } });
  });
  const gemini = 'https://generativelanguage.googleapis.com/v1beta/models/gemini-test:generateContent';
  assert.equal((await (await counted(gemini, { method: 'POST' })).json() as any).usageMetadata.promptTokenCount, 100);
  await counted(gemini, { method: 'POST' });
  answers['https://ask.example/api/chat/completions'] = Response.json({ usage: { prompt_tokens: 7, completion_tokens: 3 } });
  await counted('https://ask.example/api/chat/completions', { method: 'POST', body: JSON.stringify({ model: 'ask-1' }) });
  answers['https://api.mistral.ai/v1/audio/speech'] = new Response('fail', { status: 500 });
  await counted('https://api.mistral.ai/v1/audio/speech', { method: 'POST', body: JSON.stringify({ model: 'voxtral' }) });
  await counted('https://feeds.example.test/a.xml');
  db.raw.prepare("INSERT INTO daily_requests (owner_id, utc_day, requests) VALUES ('o', '2026-09-29', 3)").run();
  db.raw.prepare("INSERT INTO daily_usage (owner_id, utc_day, characters) VALUES ('o', '2026-09-29', 1500)").run();
  const summary = await usageSummary(db, 'o', now, 14, { generations: 24, ttsCharacters: 12000 });
  assert.deepEqual(summary.days, [{ day: '2026-09-29', generations: 3, ttsCharacters: 1500, models: [
    { provider: 'ask', model: 'ask-1', calls: 1, inputTokens: 7, outputTokens: 3 },
    { provider: 'gemini', model: 'gemini-test', calls: 2, inputTokens: 200, outputTokens: 50 },
    { provider: 'mistral', model: 'voxtral', calls: 1, inputTokens: 0, outputTokens: 0 },
  ] }]);
  assert.equal(classify('https://example.org/x', undefined), undefined);
  assert.deepEqual(tokensOf(null), { input: 0, output: 0 });
});

test('speech counts under the model named in the request; quota refusals apart; voice management as «voices»', async () => {
  const db = sqliteD1(), now = new Date('2026-09-29T08:00:00Z');
  let status = 200;
  const counted = meteredFetch(db, { now: () => now }, async () => new Response('{}', { status, headers: { 'Content-Type': 'application/json' } }));
  const speak = (model: string) => counted('https://generativelanguage.googleapis.com/v1beta/interactions', { method: 'POST', body: JSON.stringify({ model }) });
  await speak('gemini-3.8-flash-tts');
  status = 429; await speak('gemini-3.8-flash-tts');
  status = 200; await speak('gemini-3.8-flash-lite-tts');
  await counted('https://generativelanguage.googleapis.com/v1beta/voices/abc');
  const speech = { model: 'gemini-3.8-flash-tts', liteModel: 'gemini-3.8-flash-lite-tts', dailyRequests: 100 };
  const summary = await usageSummary(db, 'o', now, 14, { generations: 24, ttsCharacters: 12000 }, speech);
  assert.deepEqual(summary.speech, speech);
  assert.deepEqual(summary.days[0].models.map(model => [model.model, model.calls]), [
    ['gemini-3.8-flash-lite-tts', 1], ['gemini-3.8-flash-tts', 1], ['gemini-3.8-flash-tts:abgelehnt', 1], ['voices', 1],
  ]);
  assert.equal((await usageSummary(db, 'o', now, 14, { generations: 24, ttsCharacters: 12000 })).speech, undefined);
});
