// What the station spends per day: provider calls and tokens (counted where the requests leave the
// Worker), productions and speech characters (the existing daily limits). Nothing here is sent anywhere.
import type { D1Database } from './station-store.ts';

type Fetch = typeof fetch;

export interface ModelUsage { provider: string; model: string; calls: number; inputTokens: number; outputTokens: number }
export interface UsageDay { day: string; generations: number; ttsCharacters: number; models: ModelUsage[] }
export interface UsageSummary {
  days: UsageDay[];
  limits: { generations: number; ttsCharacters: number };
  /** The Gemini speech models and how many requests a day Google allows the main one (its quota, not ours). */
  speech?: { model: string; liteModel: string; dailyRequests: number };
}

/** Calls the provider refused for quota (429) are counted apart, under the model with this suffix. */
export const REFUSED = ':abgelehnt';

const utcDay = (date: Date) => date.toISOString().slice(0, 10);
const safe = (value: unknown) => typeof value === 'string' && /^[A-Za-z0-9._:-]{1,100}$/.test(value) ? value : 'unbekannt';

/** Which provider and model a request goes to; undefined for everything else (feeds, Spotify, weather). */
export function classify(url: string, body: unknown, askHost?: string): { provider: string; model: string } | undefined {
  let parsed: URL;
  try { parsed = new URL(url); } catch { return undefined; }
  const model = () => { try { return safe((JSON.parse(String(body)) as { model?: unknown }).model); } catch { return 'unbekannt'; } };
  if (parsed.hostname === 'generativelanguage.googleapis.com') {
    // Speech through the Interactions API names its model in the body; voice management has none.
    if (parsed.pathname.endsWith('/interactions')) return { provider: 'gemini', model: model() };
    if (/\/voices(\/|$)/.test(parsed.pathname)) return { provider: 'gemini', model: 'voices' };
    return { provider: 'gemini', model: safe(parsed.pathname.match(/\/models\/([^:/]+)/)?.[1]) };
  }
  if (parsed.hostname === 'api.mistral.ai') return { provider: 'mistral', model: model() };
  if (askHost && parsed.hostname === askHost) return { provider: 'ask', model: model() };
  return undefined;
}

/** Token counts as the providers report them (Gemini usageMetadata, OpenAI-style usage). */
export function tokensOf(payload: unknown): { input: number; output: number } {
  const item = (payload && typeof payload === 'object' ? payload : {}) as { usageMetadata?: Record<string, unknown>; usage?: Record<string, unknown> };
  const number = (value: unknown) => Number.isFinite(Number(value)) && Number(value) > 0 ? Math.round(Number(value)) : 0;
  if (item.usageMetadata) return { input: number(item.usageMetadata.promptTokenCount), output: number(item.usageMetadata.candidatesTokenCount) + number(item.usageMetadata.thoughtsTokenCount) };
  if (item.usage) return { input: number(item.usage.prompt_tokens), output: number(item.usage.completion_tokens) };
  return { input: 0, output: 0 };
}

/** A fetch that counts provider calls and tokens per day. Counting never fails a request. */
export function meteredFetch(db: D1Database, options: { askHost?: string; now?: () => Date } = {}, base: Fetch = fetch): Fetch {
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const response = await base(input, init);
    const target = classify(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url, init?.body, options.askHost);
    if (!target) return response;
    if (response.status === 429) target.model += REFUSED;
    try {
      let tokens = { input: 0, output: 0 };
      if (response.ok && response.headers.get('Content-Type')?.includes('json')) tokens = tokensOf(await response.clone().json());
      await db.prepare(`INSERT INTO model_usage (utc_day, provider, model, calls, input_tokens, output_tokens) VALUES (?, ?, ?, 1, ?, ?)
        ON CONFLICT(utc_day, provider, model) DO UPDATE SET calls = model_usage.calls + 1,
        input_tokens = model_usage.input_tokens + excluded.input_tokens, output_tokens = model_usage.output_tokens + excluded.output_tokens`)
        .bind(utcDay((options.now ?? (() => new Date()))()), target.provider, target.model, tokens.input, tokens.output).run();
    } catch { /* Counting is best effort. */ }
    return response;
  }) as Fetch;
}

/** The last [days] UTC days, newest first; days without any use are left out. */
export async function usageSummary(db: D1Database, owner: string, now: Date, days: number, limits: UsageSummary['limits'], speech?: UsageSummary['speech']): Promise<UsageSummary> {
  const since = utcDay(new Date(now.getTime() - (days - 1) * 86_400_000));
  const [generations, characters, models] = await Promise.all([
    db.prepare('SELECT utc_day, requests FROM daily_requests WHERE owner_id = ? AND utc_day >= ?').bind(owner, since).all<{ utc_day: string; requests: number }>(),
    db.prepare('SELECT utc_day, characters FROM daily_usage WHERE owner_id = ? AND utc_day >= ?').bind(owner, since).all<{ utc_day: string; characters: number }>(),
    db.prepare('SELECT utc_day, provider, model, calls, input_tokens, output_tokens FROM model_usage WHERE utc_day >= ? ORDER BY provider, model')
      .bind(since).all<{ utc_day: string; provider: string; model: string; calls: number; input_tokens: number; output_tokens: number }>(),
  ]);
  const byDay = new Map<string, UsageDay>();
  const day = (key: string) => { let entry = byDay.get(key); if (!entry) { entry = { day: key, generations: 0, ttsCharacters: 0, models: [] }; byDay.set(key, entry); } return entry; };
  for (const row of generations.results) day(row.utc_day).generations = Number(row.requests);
  for (const row of characters.results) day(row.utc_day).ttsCharacters = Number(row.characters);
  for (const row of models.results) day(row.utc_day).models.push({ provider: row.provider, model: row.model, calls: Number(row.calls), inputTokens: Number(row.input_tokens), outputTokens: Number(row.output_tokens) });
  return { days: [...byDay.values()].sort((a, b) => b.day.localeCompare(a.day)), limits, ...(speech ? { speech } : {}) };
}
