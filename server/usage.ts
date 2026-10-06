// What the station spends per day: provider calls and tokens (counted where the requests leave the
// Worker), productions and speech characters (the existing daily limits). Nothing here is sent anywhere.
import type { D1Database } from './station-store.ts';
import { runAll } from './station-store.ts';
import { currentCallContext } from './trace.ts';

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

const MAX_TEXT = 4000;
const cut = (text: string, max = MAX_TEXT) => text.length > max ? `${text.slice(0, max)} … [+${text.length - max} Zeichen]` : text;

/** What a provider request asks, readable: the system prompt and the messages, never audio or images. */
export function requestText(body: unknown): string {
  let value: any;
  try { value = JSON.parse(String(body)); } catch { return ''; }
  const parts = (list: unknown) => Array.isArray(list) ? list.map((part: any) => typeof part?.text === 'string' ? part.text : part?.inlineData ? '[Daten]' : '').filter(Boolean).join('\n') : '';
  const lines: string[] = [];
  if (value?.systemInstruction) lines.push(`SYSTEM: ${parts(value.systemInstruction.parts)}`);
  for (const content of Array.isArray(value?.contents) ? value.contents : []) lines.push(`${String(content?.role ?? 'user').toUpperCase()}: ${parts(content?.parts)}`);
  for (const message of Array.isArray(value?.messages) ? value.messages : []) {
    lines.push(`${String(message?.role ?? 'user').toUpperCase()}: ${typeof message?.content === 'string' ? message.content : JSON.stringify(message?.content ?? '')}`);
  }
  // Speech: the text to be spoken.
  if (typeof value?.input === 'string') lines.push(`TEXT: ${value.input}`);
  else if (value?.input) lines.push(`TEXT: ${JSON.stringify(value.input).slice(0, MAX_TEXT)}`);
  if (Array.isArray(value?.tools) && value.tools.length) lines.push(`TOOLS: ${value.tools.map((tool: object) => Object.keys(tool).join(',')).join(', ')}`);
  return cut(lines.join('\n\n'));
}

/** What came back, readable: text answers and search queries; audio only as its size. */
export function responseText(payload: any): string {
  const lines: string[] = [];
  for (const candidate of Array.isArray(payload?.candidates) ? payload.candidates : []) {
    for (const part of Array.isArray(candidate?.content?.parts) ? candidate.content.parts : []) {
      if (typeof part?.text === 'string') lines.push(part.text);
      else if (typeof part?.inlineData?.data === 'string') lines.push(`[Audio, ${Math.round(part.inlineData.data.length * 0.75 / 1024)} KB]`);
    }
    const queries = candidate?.groundingMetadata?.webSearchQueries;
    if (Array.isArray(queries) && queries.length) lines.push(`SUCHE: ${queries.join(' · ')}`);
    if (candidate?.finishReason && candidate.finishReason !== 'STOP') lines.push(`ENDE: ${candidate.finishReason}`);
  }
  for (const choice of Array.isArray(payload?.choices) ? payload.choices : []) {
    const content = choice?.message?.content;
    if (typeof content === 'string') lines.push(content);
    if (choice?.finish_reason && choice.finish_reason !== 'stop') lines.push(`ENDE: ${choice.finish_reason}`);
  }
  if (!lines.length && payload && typeof payload === 'object') lines.push(JSON.stringify(payload, (key, value) => key === 'data' && typeof value === 'string' && value.length > 200 ? `[${value.length} Zeichen]` : value).slice(0, MAX_TEXT));
  return cut(lines.join('\n\n'));
}

/** The first words of the system prompt: what the call was for («Du bist die Qualitätsjury …»). */
export function purposeOf(request: string): string {
  const system = request.match(/^SYSTEM: (.+)/)?.[1] ?? request.match(/^\w+: (.+)/)?.[1] ?? '';
  const sentence = system.split(/(?<=[.!?])\s/)[0] ?? '';
  return (sentence.length > 90 ? `${sentence.slice(0, 90)}…` : sentence) || 'Aufruf';
}

/**
 * A fetch that counts provider calls and tokens per day and keeps each call for the developer view.
 * Neither counting nor keeping ever fails a request.
 */
export function meteredFetch(db: D1Database, options: { askHost?: string; now?: () => Date } = {}, base: Fetch = fetch): Fetch {
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const started = Date.now();
    const response = await base(input, init);
    const target = classify(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url, init?.body, options.askHost);
    if (!target) return response;
    const model = target.model;
    if (response.status === 429) target.model += REFUSED;
    try {
      const now = (options.now ?? (() => new Date()))();
      let tokens = { input: 0, output: 0 }, answer = '';
      if (response.headers.get('Content-Type')?.includes('json')) {
        const payload = await response.clone().json().catch(() => null);
        if (response.ok) tokens = tokensOf(payload);
        answer = responseText(payload);
      } else if (!response.ok) {
        answer = cut(await response.clone().text().catch(() => ''), 1000);
      } else {
        answer = `[${response.headers.get('Content-Type') ?? 'Daten'}]`;
      }
      const request = requestText(init?.body), { owner, itemId } = currentCallContext();
      await runAll(db, [
        db.prepare(`INSERT INTO model_usage (utc_day, provider, model, calls, input_tokens, output_tokens) VALUES (?, ?, ?, 1, ?, ?)
          ON CONFLICT(utc_day, provider, model) DO UPDATE SET calls = model_usage.calls + 1,
          input_tokens = model_usage.input_tokens + excluded.input_tokens, output_tokens = model_usage.output_tokens + excluded.output_tokens`)
          .bind(utcDay(now), target.provider, target.model, tokens.input, tokens.output),
        // The same per station, for the costs per listener.
        db.prepare(`INSERT INTO owner_usage (utc_day, owner_id, provider, model, calls, input_tokens, output_tokens) VALUES (?, ?, ?, ?, 1, ?, ?)
          ON CONFLICT(utc_day, owner_id, provider, model) DO UPDATE SET calls = owner_usage.calls + 1,
          input_tokens = owner_usage.input_tokens + excluded.input_tokens, output_tokens = owner_usage.output_tokens + excluded.output_tokens`)
          .bind(utcDay(now), owner ?? '', target.provider, target.model, tokens.input, tokens.output),
        db.prepare(`INSERT INTO llm_calls (at, owner_id, item_id, provider, model, purpose, status, ms, input_tokens, output_tokens, request, response)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
          .bind(now.toISOString(), owner ?? null, itemId ?? null, target.provider, model, purposeOf(request), response.status, Date.now() - started, tokens.input, tokens.output, request, answer),
        db.prepare('DELETE FROM llm_calls WHERE id <= (SELECT MAX(id) - 1000 FROM llm_calls)'),
      ]);
    } catch { /* Counting is best effort. */ }
    return response;
  }) as Fetch;
}

export interface LlmCall {
  id: number; at: string; owner: string | null; itemId: string | null; provider: string; model: string; purpose: string;
  status: number; ms: number; inputTokens: number; outputTokens: number; request: string; response: string;
}

/** The newest calls (before [before], for paging), optionally only failed ones. */
export async function llmCalls(db: D1Database, options: { before?: number; limit?: number; failed?: boolean } = {}): Promise<LlmCall[]> {
  const limit = Math.min(100, Math.max(1, options.limit ?? 50));
  const rows = (await db.prepare(`SELECT * FROM llm_calls WHERE id < ? ${options.failed ? 'AND status >= 400' : ''} ORDER BY id DESC LIMIT ?`)
    .bind(options.before ?? Number.MAX_SAFE_INTEGER, limit).all<Record<string, unknown>>()).results;
  return rows.map(row => ({
    id: Number(row.id), at: String(row.at), owner: (row.owner_id as string | null) ?? null, itemId: (row.item_id as string | null) ?? null,
    provider: String(row.provider), model: String(row.model), purpose: String(row.purpose), status: Number(row.status), ms: Number(row.ms),
    inputTokens: Number(row.input_tokens), outputTokens: Number(row.output_tokens), request: String(row.request), response: String(row.response),
  }));
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
