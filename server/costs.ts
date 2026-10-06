// What the provider calls probably cost, in Swiss francs: tokens (counted in usage.ts) times a price
// list. The defaults are estimates of the public list prices in US dollars per million tokens; the
// MODEL_PRICES and USD_CHF variables override them. Calls the provider refused cost nothing.
import type { D1Database } from './station-store.ts';
import { REFUSED } from './usage.ts';

/** [input, output] in US dollars per million tokens. */
export type Price = readonly [number, number];

/** First match wins (a part of the model name); speech output is audio and costs more. */
export const DEFAULT_PRICES: ReadonlyArray<readonly [string, Price]> = [
  ['voices', [0, 0]],
  ['lite-tts', [0.25, 5]],
  ['pro-tts', [1, 20]],
  ['tts', [0.5, 10]],
  ['flash-lite', [0.1, 0.4]],
  ['flash', [0.3, 2.5]],
  ['pro', [1.25, 10]],
  ['ministral', [0.1, 0.1]],
  ['mistral-small', [0.1, 0.3]],
  ['mistral-medium', [0.4, 2]],
  ['mistral-large', [2, 6]],
  ['voxtral', [0.1, 0.3]],
];
/** Anything else: a mid-range guess rather than nothing. */
const FALLBACK: Price = [0.5, 2];
const DEFAULT_RATE = 0.8;

export interface PriceList { prices: ReadonlyArray<readonly [string, Price]>; usdToChf: number }

/** The price list from the Worker's variables: `MODEL_PRICES` as `{"flash": [0.3, 2.5]}`, `USD_CHF` as a number. */
export function priceList(env: { MODEL_PRICES?: string; USD_CHF?: string }): PriceList {
  let custom: Array<readonly [string, Price]> = [];
  try {
    const parsed = JSON.parse(env.MODEL_PRICES || '{}') as Record<string, unknown>;
    custom = Object.entries(parsed).flatMap(([pattern, value]) => Array.isArray(value) && value.length === 2 && value.every(n => Number.isFinite(n) && n >= 0)
      ? [[pattern.toLowerCase(), [Number(value[0]), Number(value[1])] as Price] as const] : []);
  } catch { /* A broken variable falls back to the defaults. */ }
  const rate = Number(env.USD_CHF);
  return { prices: [...custom, ...DEFAULT_PRICES], usdToChf: Number.isFinite(rate) && rate > 0 ? rate : DEFAULT_RATE };
}

export function priceOf(model: string, list: PriceList): Price {
  const name = model.toLowerCase();
  if (name.endsWith(REFUSED)) return [0, 0];
  return list.prices.find(([pattern]) => name.includes(pattern))?.[1] ?? FALLBACK;
}

/** Francs for these tokens. */
export function costOf(model: string, inputTokens: number, outputTokens: number, list: PriceList): number {
  const [input, output] = priceOf(model, list);
  return (inputTokens * input + outputTokens * output) / 1_000_000 * list.usdToChf;
}

/** Today and the last 30 days (UTC), in francs, rounded to the centime. */
export interface CostSpan { today: number; month: number }

const round = (value: number) => Math.round(value * 100) / 100;
const utcDay = (date: Date) => date.toISOString().slice(0, 10);

/** The whole Worker's costs (every station, from model_usage). */
export async function totalCosts(db: D1Database, now: Date, list: PriceList): Promise<CostSpan> {
  const rows = (await db.prepare('SELECT utc_day, model, input_tokens, output_tokens FROM model_usage WHERE utc_day >= ?')
    .bind(utcDay(new Date(now.getTime() - 29 * 86_400_000))).all<{ utc_day: string; model: string; input_tokens: number; output_tokens: number }>()).results;
  return span(rows, now, list);
}

/** Each station's costs (from owner_usage), keyed by owner. */
export async function costsByOwner(db: D1Database, now: Date, list: PriceList): Promise<Map<string, CostSpan>> {
  const rows = (await db.prepare('SELECT utc_day, owner_id, model, input_tokens, output_tokens FROM owner_usage WHERE utc_day >= ?')
    .bind(utcDay(new Date(now.getTime() - 29 * 86_400_000))).all<{ utc_day: string; owner_id: string; model: string; input_tokens: number; output_tokens: number }>()).results;
  const grouped = new Map<string, typeof rows>();
  for (const row of rows) grouped.set(row.owner_id, [...grouped.get(row.owner_id) ?? [], row]);
  return new Map([...grouped].map(([owner, entries]) => [owner, span(entries, now, list)]));
}

function span(rows: Array<{ utc_day: string; model: string; input_tokens: number; output_tokens: number }>, now: Date, list: PriceList): CostSpan {
  const today = utcDay(now);
  let day = 0, month = 0;
  for (const row of rows) {
    const cost = costOf(row.model, Number(row.input_tokens), Number(row.output_tokens), list);
    month += cost;
    if (row.utc_day === today) day += cost;
  }
  return { today: round(day), month: round(month) };
}
