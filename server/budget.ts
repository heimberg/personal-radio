// Monthly budgets in francs, measured against the cost estimate (costs.ts) since the first of the
// month (UTC). A used-up budget does not silence the radio: the station keeps BUDGET_FLOOR productions
// a day (the morning briefing, the news) until the month ends or the owner raises the budget.
import type { D1Database } from './station-store.ts';
import type { Environment } from './http.ts';
import { costOf, priceList, type PriceList } from './costs.ts';
import { generationLimit, type Listener } from './listeners.ts';

/** The budget for every station together. */
export const SERVER_BUDGET = '*';
/** Productions a day once a budget is used up. */
export const BUDGET_FLOOR = 4;
/** At this share of a budget the owner is warned. */
export const BUDGET_WARN = 0.8;

export interface BudgetUse { limit: number; spent: number }
export interface BudgetStatus { server?: BudgetUse; stations: Map<string, BudgetUse> }

const round = (value: number) => Math.round(value * 100) / 100;
export const monthStart = (now: Date) => `${now.toISOString().slice(0, 7)}-01`;

/** Every budget with what has been spent against it this month. */
export async function budgetStatus(db: D1Database, now: Date, list: PriceList): Promise<BudgetStatus> {
  const since = monthStart(now);
  const [budgets, total, byOwner] = await Promise.all([
    db.prepare('SELECT owner_id, monthly_chf FROM budgets').all<{ owner_id: string; monthly_chf: number }>(),
    db.prepare('SELECT model, SUM(input_tokens) AS input, SUM(output_tokens) AS output FROM model_usage WHERE utc_day >= ? GROUP BY model')
      .bind(since).all<{ model: string; input: number; output: number }>(),
    db.prepare('SELECT owner_id, model, SUM(input_tokens) AS input, SUM(output_tokens) AS output FROM owner_usage WHERE utc_day >= ? GROUP BY owner_id, model')
      .bind(since).all<{ owner_id: string; model: string; input: number; output: number }>(),
  ]);
  const spentBy = new Map<string, number>();
  for (const row of byOwner.results) spentBy.set(row.owner_id, (spentBy.get(row.owner_id) ?? 0) + costOf(row.model, Number(row.input), Number(row.output), list));
  const status: BudgetStatus = { stations: new Map() };
  for (const row of budgets.results) {
    const limit = Number(row.monthly_chf);
    if (row.owner_id === SERVER_BUDGET) {
      status.server = { limit, spent: round(total.results.reduce((sum, item) => sum + costOf(item.model, Number(item.input), Number(item.output), list), 0)) };
    } else {
      status.stations.set(row.owner_id, { limit, spent: round(spentBy.get(row.owner_id) ?? 0) });
    }
  }
  return status;
}

export const usedUp = (use?: BudgetUse) => !!use && use.spent >= use.limit;

/** Whether this station is held to BUDGET_FLOOR: its own budget or the Worker's is used up. */
export const overBudget = (status: BudgetStatus, owner: string) => usedUp(status.server) || usedUp(status.stations.get(owner));

let cached: { at: number; value: BudgetStatus } | null = null;
/** The status, read at most every 60 seconds per Worker instance (production asks for every item). */
export async function currentBudgets(env: Environment, now = new Date()): Promise<BudgetStatus> {
  if (cached && now.getTime() - cached.at < 60_000) return cached.value;
  const value = await budgetStatus(env.DB, now, priceList(env));
  cached = { at: now.getTime(), value };
  return value;
}
export const forgetBudgets = () => { cached = null; };

/** The day's production limit: the station's own, or BUDGET_FLOOR when a budget is used up. */
export async function dailyGenerationLimit(env: Environment, owner: string, listeners: Map<string, Listener>): Promise<number> {
  const limit = generationLimit(owner, listeners, Math.max(1, Number(env.DAILY_GENERATIONS) || 24));
  try { return overBudget(await currentBudgets(env), owner) ? Math.min(limit, BUDGET_FLOOR) : limit; }
  catch { return limit; }
}

/** Sets (or with null removes) a budget; the next check sees it at once. */
export async function setBudget(db: D1Database, owner: string, monthlyChf: number | null, now: Date) {
  if (monthlyChf === null) await db.prepare('DELETE FROM budgets WHERE owner_id = ?').bind(owner).run();
  else await db.prepare(`INSERT INTO budgets (owner_id, monthly_chf, updated_at) VALUES (?, ?, ?)
    ON CONFLICT(owner_id) DO UPDATE SET monthly_chf = excluded.monthly_chf, updated_at = excluded.updated_at`).bind(owner, monthlyChf, now.toISOString()).run();
  forgetBudgets();
}

/** A budget in a request: francs from 0.5 to 10 000, or null for none. Undefined when invalid. */
export function parseBudget(value: unknown): number | null | undefined {
  if (value === null) return null;
  const number = Number(value);
  return typeof value === 'number' && Number.isFinite(number) && number >= 0.5 && number <= 10_000 ? round(number) : undefined;
}

const chf = (value: number) => `CHF ${value.toFixed(2)}`;

/**
 * Warnings for the owner: a budget at 80 % and used up, each once a month (the id carries the month and
 * the step). [nameOf] names a station for the text («Lea», «deines Senders»).
 */
export function budgetAlerts(status: BudgetStatus, now: Date, nameOf: (owner: string) => string): Array<{ id: string; text: string }> {
  const month = now.toISOString().slice(0, 7), alerts: Array<{ id: string; text: string }> = [];
  const check = (key: string, whose: string, use: BudgetUse | undefined, consequence: string) => {
    if (!use || use.limit <= 0) return;
    const share = use.spent / use.limit, amounts = `${chf(use.spent)} von ${chf(use.limit)}`;
    if (share >= 1) alerts.push({ id: `budget:${key}:${month}:100`, text: `Monatsbudget ${whose} aufgebraucht (${amounts}). ${consequence}` });
    else if (share >= BUDGET_WARN) alerts.push({ id: `budget:${key}:${month}:80`, text: `Monatsbudget ${whose} zu ${Math.round(share * 100)} % verbraucht (${amounts}).` });
  };
  check('server', 'aller Sender', status.server, `Bis Monatsende produziert jeder Sender höchstens ${BUDGET_FLOOR} Beiträge am Tag; mehr Budget unter Studio › Verbrauch.`);
  for (const [owner, use] of status.stations) {
    check(owner.startsWith('listener:') ? owner.slice('listener:'.length) : 'own', nameOf(owner), use, `Bis Monatsende höchstens ${BUDGET_FLOOR} Beiträge am Tag; mehr Budget unter Studio › Einladen.`);
  }
  return alerts;
}
