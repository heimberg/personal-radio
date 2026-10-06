import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sqliteD1 } from './d1-sqlite.ts';
import { BUDGET_FLOOR, budgetAlerts, budgetStatus, dailyGenerationLimit, forgetBudgets, overBudget, parseBudget, setBudget } from '../server/budget.ts';
import { priceList } from '../server/costs.ts';
import { forgetListeners } from '../server/listeners.ts';
import { InviteStore } from '../server/invites.ts';
import { inviteRoutes } from '../server/routes/invites.ts';
import type { Environment } from '../server/http.ts';

const OWNER = 'owner@example.test';

/** Speech worth [francs] (flash TTS: 10 dollars per million output tokens at 0.80). */
function spend(db: ReturnType<typeof sqliteD1>, owner: string, francs: number, day = new Date().toISOString().slice(0, 10)) {
  const tokens = Math.round(francs / 8 * 1_000_000);
  db.raw.prepare(`INSERT INTO model_usage (utc_day, provider, model, calls, input_tokens, output_tokens) VALUES (?, 'gemini', 'gemini-3.8-flash-tts', 1, 0, ?)
    ON CONFLICT(utc_day, provider, model) DO UPDATE SET output_tokens = model_usage.output_tokens + excluded.output_tokens`).run(day, tokens);
  db.raw.prepare(`INSERT INTO owner_usage (utc_day, owner_id, provider, model, calls, input_tokens, output_tokens) VALUES (?, ?, 'gemini', 'gemini-3.8-flash-tts', 1, 0, ?)
    ON CONFLICT(utc_day, owner_id, provider, model) DO UPDATE SET output_tokens = owner_usage.output_tokens + excluded.output_tokens`).run(day, owner, tokens);
}

test('budgets count from the first of the month; a used-up one holds the station to a few productions a day', async () => {
  const db = sqliteD1(), now = new Date();
  forgetListeners(); forgetBudgets();
  const env = { DB: db, ALLOWED_EMAIL: OWNER, DAILY_GENERATIONS: '24' } as unknown as Environment;
  spend(db, 'listener:lea', 3);
  spend(db, OWNER, 1);
  // Last month does not count.
  const lastMonth = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 0)).toISOString().slice(0, 10);
  spend(db, 'listener:lea', 50, lastMonth);
  await setBudget(db, 'listener:lea', 5, now);
  let status = await budgetStatus(db, now, priceList({}));
  assert.deepEqual(status.stations.get('listener:lea'), { limit: 5, spent: 3 });
  assert.equal(overBudget(status, 'listener:lea'), false);
  assert.equal(await dailyGenerationLimit(env, 'listener:lea', new Map()), 24);
  spend(db, 'listener:lea', 2.5);
  forgetBudgets();
  assert.equal(await dailyGenerationLimit(env, 'listener:lea', new Map()), BUDGET_FLOOR);
  assert.equal(await dailyGenerationLimit(env, OWNER, new Map()), 24, 'other stations go on');
  // The whole Worker's budget holds everyone.
  await setBudget(db, '*', 6, now);
  status = await budgetStatus(db, now, priceList({}));
  assert.deepEqual(status.server, { limit: 6, spent: 6.5 });
  assert.equal(await dailyGenerationLimit(env, OWNER, new Map()), BUDGET_FLOOR);
  await setBudget(db, '*', null, now);
  assert.equal(await dailyGenerationLimit(env, OWNER, new Map()), 24, 'removing a budget takes effect at once');
});

test('the owner is warned at 80 % and when a budget is used up, once a month each', () => {
  const now = new Date('2026-10-20T10:00:00Z');
  const alerts = budgetAlerts({ server: { limit: 20, spent: 17 }, stations: new Map([['listener:lea', { limit: 5, spent: 5.2 }], ['listener:tom', { limit: 5, spent: 1 }]]) },
    now, owner => owner === 'listener:lea' ? 'von Lea' : 'deines Senders');
  assert.deepEqual(alerts.map(alert => alert.id), ['budget:server:2026-10:80', 'budget:lea:2026-10:100']);
  assert.match(alerts[0].text, /aller Sender zu 85 % verbraucht \(CHF 17\.00 von CHF 20\.00\)/);
  assert.match(alerts[1].text, /Monatsbudget von Lea aufgebraucht/);
});

test('only the owner sets budgets: for all, for their own station or for a listener', async () => {
  const db = sqliteD1();
  forgetListeners(); forgetBudgets();
  const env = { DB: db, ALLOWED_EMAIL: OWNER, AUDIO: { get: async () => null } } as unknown as Environment;
  const issuer = { create: async () => ({ id: 't', clientId: 'c.access', clientSecret: 's' }), revoke: async () => {} };
  const store = new InviteStore(db);
  await store.redeem((await store.create('Lea', 'guest', new Date())).code, issuer, new Set(), new Date());
  forgetListeners();
  const patch = (body: unknown, owner = OWNER) => inviteRoutes(new Request('https://radio.example/api/budgets', { method: 'PATCH', body: JSON.stringify(body),
    headers: { Origin: 'https://radio.example', 'Content-Type': 'application/json' } }), env, owner, new URL('https://radio.example/api/budgets'), undefined, issuer);
  assert.equal((await patch({ station: 'server', monthlyChf: 20 }, 'listener:lea'))!.status, 403);
  assert.equal((await patch({ station: 'server', monthlyChf: 0 }))!.status, 400);
  assert.equal((await patch({ station: 'nobody', monthlyChf: 5 }))!.status, 404);
  assert.equal((await patch({ station: 'server', monthlyChf: 20 }))!.status, 200);
  assert.equal((await patch({ station: 'own', monthlyChf: 12.345 }))!.status, 200);
  assert.equal((await patch({ station: 'lea', monthlyChf: 5 }))!.status, 200);
  const listed = await (await inviteRoutes(new Request('https://radio.example/api/invites'), env, OWNER, new URL('https://radio.example/api/invites'), undefined, issuer))!.json() as any;
  assert.deepEqual(listed.serverBudget, { limit: 20, spent: 0 });
  assert.deepEqual(listed.own.usage.budget, { limit: 12.35, spent: 0 });
  assert.deepEqual(listed.listeners[0].usage.budget, { limit: 5, spent: 0 });
  assert.equal((await patch({ station: 'lea', monthlyChf: null }))!.status, 200);
  assert.equal((await budgetStatus(db, new Date(), priceList({}))).stations.has('listener:lea'), false);
  assert.equal(parseBudget('5'), undefined);
});
