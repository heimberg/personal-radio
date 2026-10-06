import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync } from 'node:fs';
import { sqliteD1 } from './d1-sqlite.ts';
import { meteredFetch } from '../server/usage.ts';
import { withCallContext } from '../server/trace.ts';
import { costOf, costsByOwner, priceList, priceOf, totalCosts } from '../server/costs.ts';
import { FAILURE_ALERT_COUNT, healthAlerts } from '../server/alerts.ts';
import { LATEST_MIGRATION, healthCheck } from '../server/health.ts';
import { joinRoutes } from '../server/routes/invites.ts';
import type { Environment } from '../server/http.ts';

const NOW = new Date('2026-10-06T12:00:00Z');

test('costs: speech output is dear, refusals are free, the price list can be overridden', () => {
  const list = priceList({});
  assert.deepEqual(priceOf('gemini-3.8-flash-lite-tts', list), [0.25, 5]);
  assert.deepEqual(priceOf('gemini-3.8-flash-tts', list), [0.5, 10]);
  assert.deepEqual(priceOf('gemini-2.5-flash-lite', list), [0.1, 0.4]);
  assert.deepEqual(priceOf('gemini-3.8-flash-tts:abgelehnt', list), [0, 0]);
  // A million output tokens of speech at 10 dollars, 0.80 francs each.
  assert.equal(costOf('gemini-3.8-flash-tts', 0, 1_000_000, list), 8);
  const custom = priceList({ MODEL_PRICES: '{"flash-tts": [1, 20], "bad": "x"}', USD_CHF: '0.9' });
  assert.equal(costOf('gemini-3.8-flash-tts', 0, 1_000_000, custom), 18);
  assert.deepEqual(priceList({ MODEL_PRICES: 'not json', USD_CHF: '-1' }).usdToChf, 0.8);
});

test('costs are kept per station: the owner sees the total, each listener their own', async () => {
  const db = sqliteD1();
  const counted = meteredFetch(db, { now: () => NOW }, async () => Response.json({ usageMetadata: { promptTokenCount: 0, candidatesTokenCount: 100_000 } }));
  const speak = () => counted('https://generativelanguage.googleapis.com/v1beta/interactions', { method: 'POST', body: JSON.stringify({ model: 'gemini-3.8-flash-tts' }) });
  await withCallContext({ owner: 'owner@example.test' }, speak);
  await withCallContext({ owner: 'listener:lea' }, async () => { await speak(); await speak(); });
  const list = priceList({});
  const byOwner = await costsByOwner(db, NOW, list);
  assert.deepEqual(byOwner.get('listener:lea'), { today: 1.6, month: 1.6 });
  assert.deepEqual(byOwner.get('owner@example.test'), { today: 0.8, month: 0.8 });
  // Yesterday counts for the month, not for today.
  db.raw.prepare("INSERT INTO model_usage (utc_day, provider, model, calls, input_tokens, output_tokens) VALUES ('2026-10-05', 'gemini', 'gemini-3.8-flash-tts', 1, 0, 100000)").run();
  assert.deepEqual(await totalCosts(db, NOW, list), { today: 2.4, month: 3.2 });
});

test('alerts: repeated provider failures and stuck productions, once per day and kind', async () => {
  const db = sqliteD1();
  const insert = (status: number, minutesAgo: number) => db.raw.prepare(`INSERT INTO llm_calls (at, provider, model, purpose, status, ms, request, response)
    VALUES (?, 'gemini', 'm', 'p', ?, 1, '', '')`).run(new Date(NOW.getTime() - minutesAgo * 60_000).toISOString(), status);
  for (let i = 0; i < FAILURE_ALERT_COUNT - 1; i++) insert(500, 5);
  insert(500, 90);
  assert.deepEqual(await healthAlerts(db, NOW), [], 'four recent failures are not enough, old ones do not count');
  insert(503, 1);
  assert.deepEqual((await healthAlerts(db, NOW)).map(alert => alert.id), ['provider:gemini:2026-10-06']);
  for (let i = 0; i < 6; i++) insert(429, 2);
  assert.match((await healthAlerts(db, NOW))[0].text, /Kontingent erschöpft/);
  const old = new Date(NOW.getTime() - 45 * 60_000).toISOString();
  db.raw.prepare(`INSERT INTO timeline_items (id, owner_id, seq, show_id, planned_at, state, estimated_minutes, attempts, created_at, updated_at, lease_until)
    VALUES ('a', 'o', 1, 's', ?, 'planned', 2, 0, ?, ?, ?)`).run(old, old, old, new Date(NOW.getTime() - 40 * 60_000).toISOString());
  // Waiting for the daily limit (lease until midnight) is not stuck.
  db.raw.prepare(`INSERT INTO timeline_items (id, owner_id, seq, show_id, planned_at, state, estimated_minutes, attempts, created_at, updated_at, lease_until)
    VALUES ('b', 'o', 2, 's', ?, 'planned', 2, 0, ?, ?, '2026-10-07T00:00:00.000Z')`).run(old, old, old);
  const stalled = (await healthAlerts(db, NOW)).find(alert => alert.id === 'stalled:2026-10-06');
  assert.match(stalled!.text, /1 Beiträge warten/);
});

test('/join/health answers yes or no without a token: 200 when all is well, 503 otherwise', async () => {
  const latest = readdirSync('migrations').filter(name => name.endsWith('.sql')).sort().at(-1);
  assert.equal(LATEST_MIGRATION, latest, 'LATEST_MIGRATION names the newest migration');
  const db = sqliteD1();
  const env = { DB: db, AUDIO: { get: async () => null }, GEMINI_API_KEY: 'k', ACCESS_TEAM_DOMAIN: 'team', ACCESS_AUD: 'aud' } as unknown as Environment;
  assert.deepEqual((await healthCheck(env)).checks.migrations, false, 'nothing recorded yet');
  db.raw.exec('CREATE TABLE d1_migrations (id INTEGER PRIMARY KEY, name TEXT, applied_at TEXT)');
  db.raw.prepare('INSERT INTO d1_migrations (name) VALUES (?)').run(LATEST_MIGRATION);
  const get = () => joinRoutes(new Request('https://radio.example/join/health'), env, new URL('https://radio.example/join/health'), null);
  const ok = await get();
  assert.equal(ok.status, 200);
  assert.deepEqual(await ok.json(), { ok: true, checks: { database: true, migrations: true, storage: true, speech: true, access: true } });
  (env as { AUDIO: unknown }).AUDIO = { get: async () => { throw new Error('down'); } };
  const bad = await get();
  assert.equal(bad.status, 503);
  assert.equal((await bad.json() as { checks: { storage: boolean } }).checks.storage, false);
});
