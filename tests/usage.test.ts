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

test('every provider call is kept for the developer view: readable request and answer, station and item, newest 1000', async () => {
  const { llmCalls, purposeOf, requestText, responseText } = await import('../server/usage.ts');
  const { withCallContext } = await import('../server/trace.ts');
  const db = sqliteD1(), now = new Date('2026-10-06T08:00:00Z');
  const counted = meteredFetch(db, { now: () => now }, async () => Response.json({
    candidates: [{ content: { parts: [{ text: '{"songs":[]}' }, { inlineData: { data: 'A'.repeat(4096) } }] }, finishReason: 'STOP', groundingMetadata: { webSearchQueries: ['Wässermatten Lotzwil'] } }],
    usageMetadata: { promptTokenCount: 12, candidatesTokenCount: 3 },
  }));
  const body = JSON.stringify({ systemInstruction: { parts: [{ text: 'Du bist Musikredaktion eines persönlichen Radios. Schlage Songs vor.' }] },
    contents: [{ role: 'user', parts: [{ text: '{"geschmack":"Indie"}' }] }], tools: [{ google_search: {} }] });
  await withCallContext({ owner: 'o@example.test', itemId: 'item-1' }, () => counted('https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash-lite:generateContent', { method: 'POST', body }));
  const [call] = await llmCalls(db);
  assert.deepEqual({ ...call, request: undefined, response: undefined, id: undefined, ms: undefined }, {
    id: undefined, at: now.toISOString(), owner: 'o@example.test', itemId: 'item-1', provider: 'gemini', model: 'gemini-2.5-flash-lite',
    purpose: 'Du bist Musikredaktion eines persönlichen Radios.', status: 200, ms: undefined, inputTokens: 12, outputTokens: 3, request: undefined, response: undefined,
  });
  assert.match(call.request, /^SYSTEM: Du bist Musikredaktion[\s\S]*USER: \{"geschmack":"Indie"\}[\s\S]*TOOLS: google_search$/);
  assert.equal(call.response, '{"songs":[]}\n\n[Audio, 3 KB]\n\nSUCHE: Wässermatten Lotzwil');
  // Speech, OpenAI-style answers, unreadable bodies.
  assert.equal(requestText(JSON.stringify({ model: 'voxtral', input: 'Hallo' })), 'TEXT: Hallo');
  assert.equal(responseText({ choices: [{ message: { content: 'ok' }, finish_reason: 'length' }] }), 'ok\n\nENDE: length');
  assert.equal(requestText('nicht json'), '');
  assert.equal(purposeOf(''), 'Aufruf');
  // Only the newest thousand stay.
  for (let n = 0; n < 1005; n++) db.raw.prepare("INSERT INTO llm_calls (at, provider, model, purpose, status, ms, request, response) VALUES (?, 'gemini', 'm', 'p', 200, 1, '', '')").run(now.toISOString());
  await counted('https://generativelanguage.googleapis.com/v1beta/models/m:generateContent', { method: 'POST', body });
  assert.equal((db.raw.prepare('SELECT COUNT(*) AS n FROM llm_calls').get() as { n: number }).n, 1000);
  assert.equal((await llmCalls(db, { limit: 500 })).length, 100, 'one page is at most 100');
});

test('only the owner sees the calls; stations are named, never by email', async () => {
  const { devRoutes } = await import('../server/routes/dev.ts');
  const db = sqliteD1();
  db.raw.prepare("INSERT INTO llm_calls (at, owner_id, provider, model, purpose, status, ms, request, response) VALUES ('2026-10-06T08:00:00Z', 'owner@example.test', 'gemini', 'm', 'p', 200, 5, 'q', 'a')").run();
  db.raw.prepare("INSERT INTO llm_calls (at, owner_id, provider, model, purpose, status, ms, request, response) VALUES ('2026-10-06T08:01:00Z', 'listener:lea', 'gemini', 'm', 'p', 500, 5, 'q', 'kaputt')").run();
  const env = { DB: db, ALLOWED_EMAIL: 'owner@example.test', OWNER_NAME: 'Papa', LISTENERS: 'abcd.access=lea:kids' } as never;
  const get = (owner: string, query = '') => devRoutes(new Request(`https://r.example/api/dev/calls${query}`), env, owner, new URL(`https://r.example/api/dev/calls${query}`));
  assert.equal((await get('listener:lea'))!.status, 403);
  const body = await (await get('owner@example.test'))!.json() as { calls: Array<{ station: string; status: number }> };
  assert.deepEqual(body.calls.map(call => [call.station, call.status]), [['Lea', 500], ['Papa', 200]]);
  assert.doesNotMatch(JSON.stringify(body), /owner@example\.test/);
  const failed = await (await get('owner@example.test', '?failed=1'))!.json() as { calls: unknown[] };
  assert.equal(failed.calls.length, 1);
});
