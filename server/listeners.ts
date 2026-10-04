// More than one listener: the owner (ALLOWED_EMAIL, the app's service token ACCESS_SERVICE_TOKEN_ID) and
// further listeners, each with their own Access service token and their own station. Everything in D1
// and R2 is already kept per owner ID; this maps a token to its listener and marks children's stations.
import type { StationConfig } from '../src/domain/station.ts';
import { AGENTS, resolveAgents } from '../src/domain/agents.ts';

/**
 * A further listener: their owner ID in the database, whether the station is for a child, and for those
 * who joined by invitation their name and whether they are a guest (an own station, but not in the family).
 */
export interface Listener { owner: string; kids: boolean; guest?: boolean; name?: string }

export type ListenerKind = 'family' | 'kids' | 'guest';

const OWNER = /^[a-z0-9][a-z0-9._-]{1,39}$/;

/**
 * `LISTENERS`: one entry per listener, separated by `;`, commas or new lines:
 * `<service token client ID>=<name>` and `:kids` for a child, e.g. `ab12cd.access=lea:kids`. The name
 * becomes the owner ID (`listener:<name>`), so it never collides with the owner's email. Malformed
 * entries are skipped.
 */
export function parseListeners(value: string | undefined): Map<string, Listener> {
  const listeners = new Map<string, Listener>();
  for (const entry of (value ?? '').split(/[;,\n]/)) {
    const [clientId, rest] = entry.split('=').map(part => part?.trim() ?? '');
    if (!clientId || !rest || !/^[A-Za-z0-9._-]{4,200}$/.test(clientId)) continue;
    const [name, flag] = rest.split(':').map(part => part.trim().toLowerCase());
    if (!OWNER.test(name) || (flag && flag !== 'kids')) continue;
    listeners.set(clientId, { owner: `listener:${name}`, kids: flag === 'kids' });
  }
  return listeners;
}

interface InvitedRow { client_id: string; owner_id: string; name: string; kind: ListenerKind }

// Per isolate for half a minute: every request needs the listeners, joining is rare.
let cached: { at: number; db: unknown; rows: InvitedRow[] } | null = null;
const CACHE_MS = 30_000;

/** Forgets the cached invited listeners (after someone joined or was removed). */
export function forgetListeners() { cached = null; }

/**
 * Every further listener: those in the `LISTENERS` secret and those who joined by invitation (D1). A
 * missing table (migration not applied yet) counts as nobody invited.
 */
export async function listenersOf(env: { LISTENERS?: string; DB: { prepare(sql: string): { all<T>(): Promise<{ results: T[] }> } } }, now = Date.now()): Promise<Map<string, Listener>> {
  const listeners = parseListeners(env.LISTENERS);
  if (!cached || cached.db !== env.DB || now - cached.at > CACHE_MS) {
    const rows = await env.DB.prepare('SELECT client_id, owner_id, name, kind FROM invited_listeners ORDER BY created_at').all<InvitedRow>()
      .then(result => result.results).catch(() => [] as InvitedRow[]);
    cached = { at: now, db: env.DB, rows };
  }
  return withInvited(listeners, cached.rows);
}

function withInvited(listeners: Map<string, Listener>, rows: InvitedRow[]): Map<string, Listener> {
  for (const row of rows) {
    if (listeners.has(row.client_id)) continue;
    listeners.set(row.client_id, { owner: row.owner_id, kids: row.kind === 'kids', guest: row.kind === 'guest', name: row.name });
  }
  return listeners;
}

/**
 * The listeners as last loaded by [listenersOf], for code that cannot wait. Every entry point (request,
 * cron, queue) loads them first, so a child's station always gets its rules.
 */
export function listenersNow(env: { LISTENERS?: string; DB: unknown }): Map<string, Listener> {
  return withInvited(parseListeners(env.LISTENERS), cached && cached.db === env.DB ? cached.rows : []);
}

/** Every station the Worker keeps: the owner first, then the listeners. */
export function allOwners(ownerEmail: string | undefined, listeners: Map<string, Listener>): string[] {
  return [...new Set([...(ownerEmail ? [ownerEmail.toLowerCase()] : []), ...[...listeners.values()].map(listener => listener.owner)])];
}

export const isKids = (owner: string, listeners: Map<string, Listener>) => [...listeners.values()].some(listener => listener.owner === owner && listener.kids);

/** The rules every text for a child's station follows; added to the host, every show and every agent. */
export const KIDS_RULES = 'Die Hörerin ist ein Kind von 11 Jahren. Sprich altersgerecht, freundlich und klar, erkläre Begriffe einfach und mit Beispielen aus dem Alltag. ' +
  'Keine Gewaltdetails, keine Kriegs-, Unfall- oder Verbrechensschilderungen, keine Sexualität, Drogen, Alkohol, Glücksspiel, Horror oder Suizid. ' +
  'Schwierige Nachrichten nur behutsam und kurz, ohne beunruhigende Einzelheiten, mit Einordnung und wenn möglich etwas Ermutigendem. ' +
  'Keine Werbung, keine Kaufaufforderungen, frag nie nach persönlichen Daten. Musik: nur kindgerechte Songs ohne explizite Texte.';

const withRules = (text: string, max: number) => (text.includes(KIDS_RULES) ? text : `${KIDS_RULES} ${text}`.trim()).slice(0, max);

/**
 * The station as production sees it for a child: the rules in front of the host's, every show's and
 * every agent's instructions. Only production uses this view; the stored settings stay as the listener
 * wrote them, so the rules can never be edited away in the studio.
 */
export function forKids(config: StationConfig): StationConfig {
  const agents = resolveAgents(config.agents);
  return {
    ...config,
    host: { ...config.host, instructions: withRules(config.host.instructions, 2600) },
    shows: config.shows.map(show => ({ ...show, instructions: withRules(show.instructions, 2600), ...(show.researchPrompt ? { researchPrompt: withRules(show.researchPrompt, 2600) } : {}) })),
    agents: Object.fromEntries(AGENTS.map(agent => [agent.id, { ...agents[agent.id], instructions: withRules(agents[agent.id].instructions, 3000) }])),
    music: { ...config.music, taste: `${config.music.taste} (nur kindgerechte Songs ohne explizite Texte)`.trim().slice(0, 600) },
  };
}
