// Invitations: the owner hands out a single-use code (or a link with it). Whoever redeems it gets an Access
// service token of their own, created through the Cloudflare API, and with it a station of their own. Only a
// hash of each code is stored; the token's secret is shown once, to the joining app, and never kept.
import type { D1Database } from './station-store.ts';
import { forgetListeners, type ListenerKind } from './listeners.ts';

export const INVITE_DAYS = 7;
/** Wrong codes one address may try per hour on the public join page. */
export const JOIN_ATTEMPTS_PER_HOUR = 10;
export const KINDS: ListenerKind[] = ['family', 'kids', 'guest'];

// No 0/O, 1/I/L: a code read out loud or typed from a message stays unambiguous.
const ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';

export interface InviteRow { id: string; name: string; kind: ListenerKind; created_at: string; expires_at: string; used_at: string | null; owner_id: string | null }
export interface InvitedListenerRow { client_id: string; owner_id: string; name: string; kind: ListenerKind; token_id: string; created_at: string; daily_generations?: number | null }

/** Guests start with a smaller daily production limit; the owner can change it. */
export const GUEST_DAILY_GENERATIONS = 12;

/** Creates and deletes Access service tokens (Cloudflare API, `Access: Service Tokens Edit`). */
export interface TokenIssuer {
  create(name: string): Promise<{ id: string; clientId: string; clientSecret: string }>;
  revoke(id: string): Promise<void>;
}

/** 16 characters in four groups («K7QM-…»): about 79 bits, single use, valid for a week. */
export function newCode(random: (count: number) => Uint8Array = count => crypto.getRandomValues(new Uint8Array(count))): string {
  const bytes = random(16);
  const chars = [...bytes].map(byte => ALPHABET[byte % ALPHABET.length]).join('');
  return chars.match(/.{4}/g)!.join('-');
}

/** The code as typed: case, spaces and dashes do not matter. */
export const normalizeCode = (code: string) => code.toUpperCase().replace(/[^A-Z0-9]/g, '');

export async function hashCode(code: string): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(`invite:${normalizeCode(code)}`)));
  return [...digest].map(byte => byte.toString(16).padStart(2, '0')).join('');
}

/** A name as the listener's owner ID: lower case, umlauts spelled out, only letters, digits and dashes. */
export function ownerKey(name: string): string {
  const key = name.toLowerCase().replace(/ä/g, 'ae').replace(/ö/g, 'oe').replace(/ü/g, 'ue').replace(/ß/g, 'ss')
    .normalize('NFKD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 30);
  return key.length >= 2 ? key : `hoerer-${key || 'x'}`;
}

export class InviteStore {
  private db: D1Database;
  constructor(db: D1Database) { this.db = db; }

  async create(name: string, kind: ListenerKind, now: Date, code = newCode(), id = crypto.randomUUID()): Promise<{ id: string; code: string; expiresAt: string }> {
    const expiresAt = new Date(now.getTime() + INVITE_DAYS * 86_400_000).toISOString();
    await this.db.prepare('INSERT INTO invites (id, code_hash, name, kind, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?)')
      .bind(id, await hashCode(code), name, kind, now.toISOString(), expiresAt).run();
    return { id, code, expiresAt };
  }

  /** Open invitations first, then the used ones of the last month. */
  async list(now: Date): Promise<InviteRow[]> {
    return (await this.db.prepare(`SELECT id, name, kind, created_at, expires_at, used_at, owner_id FROM invites
      WHERE used_at IS NULL OR used_at >= ? ORDER BY used_at IS NOT NULL, created_at DESC LIMIT 50`)
      .bind(new Date(now.getTime() - 30 * 86_400_000).toISOString()).all<InviteRow>()).results;
  }

  async remove(id: string): Promise<boolean> {
    return !!(await this.db.prepare('DELETE FROM invites WHERE id = ? AND used_at IS NULL RETURNING id').bind(id).first());
  }

  /** The open invitation behind [code], if it is still valid. */
  async open(code: string, now: Date): Promise<InviteRow | null> {
    return this.db.prepare('SELECT id, name, kind, created_at, expires_at, used_at, owner_id FROM invites WHERE code_hash = ? AND used_at IS NULL AND expires_at > ?')
      .bind(await hashCode(code), now.toISOString()).first<InviteRow>();
  }

  /** Counts a wrong code from [ip]; false once the address has used up its tries this hour. */
  async attempt(ip: string, now: Date): Promise<boolean> {
    const ipHash = (await hashCode(ip)).slice(0, 32), hour = now.toISOString().slice(0, 13);
    const row = await this.db.prepare(`INSERT INTO join_attempts (ip_hash, hour, count) VALUES (?, ?, 1)
      ON CONFLICT(ip_hash, hour) DO UPDATE SET count = count + 1 RETURNING count`).bind(ipHash, hour).first<{ count: number }>();
    return (row?.count ?? 1) <= JOIN_ATTEMPTS_PER_HOUR;
  }

  async blocked(ip: string, now: Date): Promise<boolean> {
    const row = await this.db.prepare('SELECT count FROM join_attempts WHERE ip_hash = ? AND hour = ?')
      .bind((await hashCode(ip)).slice(0, 32), now.toISOString().slice(0, 13)).first<{ count: number }>();
    return (row?.count ?? 0) >= JOIN_ATTEMPTS_PER_HOUR;
  }

  async listeners(): Promise<InvitedListenerRow[]> {
    return (await this.db.prepare('SELECT client_id, owner_id, name, kind, token_id, created_at, daily_generations FROM invited_listeners ORDER BY created_at').all<InvitedListenerRow>()).results;
  }

  /**
   * Redeems [code]: claims the invitation first (so it works once even when two phones try at the same
   * moment), then has a service token made and records the new listener under a free owner ID.
   */
  async redeem(code: string, issuer: TokenIssuer, taken: Set<string>, now: Date): Promise<{ clientId: string; clientSecret: string; name: string } | null> {
    const invite = await this.open(code, now);
    if (!invite) return null;
    let key = ownerKey(invite.name);
    for (let n = 2; taken.has(`listener:${key}`); n++) key = `${ownerKey(invite.name).slice(0, 27)}-${n}`;
    const owner = `listener:${key}`;
    const claimed = await this.db.prepare('UPDATE invites SET used_at = ?, owner_id = ? WHERE id = ? AND used_at IS NULL RETURNING id')
      .bind(now.toISOString(), owner, invite.id).first();
    if (!claimed) return null;
    let token: Awaited<ReturnType<TokenIssuer['create']>>;
    try { token = await issuer.create(`Radio · ${invite.name}`); }
    catch (error) {
      // Without a token nobody joined: the invitation stays usable.
      await this.db.prepare('UPDATE invites SET used_at = NULL, owner_id = NULL WHERE id = ?').bind(invite.id).run();
      throw error;
    }
    await this.db.prepare('INSERT INTO invited_listeners (client_id, owner_id, name, kind, token_id, created_at, daily_generations) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .bind(token.clientId, owner, invite.name, invite.kind, token.id, now.toISOString(), invite.kind === 'guest' ? GUEST_DAILY_GENERATIONS : null).run();
    forgetListeners();
    return { clientId: token.clientId, clientSecret: token.clientSecret, name: invite.name };
  }

  /** A listener's own daily production limit; null returns to the Worker's. */
  async setLimit(owner: string, dailyGenerations: number | null): Promise<boolean> {
    const row = await this.db.prepare('UPDATE invited_listeners SET daily_generations = ? WHERE owner_id = ? RETURNING owner_id').bind(dailyGenerations, owner).first();
    forgetListeners();
    return !!row;
  }

  /** Takes a listener's access away: the token is revoked, the station's data stays until it is cleaned up. */
  async removeListener(owner: string, issuer: TokenIssuer): Promise<boolean> {
    const row = await this.db.prepare('SELECT token_id FROM invited_listeners WHERE owner_id = ?').bind(owner).first<{ token_id: string }>();
    if (!row) return false;
    await issuer.revoke(row.token_id);
    await this.db.prepare('DELETE FROM invited_listeners WHERE owner_id = ?').bind(owner).run();
    forgetListeners();
    return true;
  }
}

/** Access service tokens through the Cloudflare API; null without `CF_ACCOUNT_ID` and `CF_ACCESS_API_TOKEN`. */
export function cloudflareIssuer(env: { CF_ACCOUNT_ID?: string; CF_ACCESS_API_TOKEN?: string }, fetcher: typeof fetch = fetch): TokenIssuer | null {
  const account = env.CF_ACCOUNT_ID?.trim(), apiToken = env.CF_ACCESS_API_TOKEN?.trim();
  if (!account || !apiToken || !/^[a-f0-9]{32}$/.test(account)) return null;
  const base = `https://api.cloudflare.com/client/v4/accounts/${account}/access/service_tokens`;
  const headers = { Authorization: `Bearer ${apiToken}`, 'Content-Type': 'application/json' };
  return {
    async create(name) {
      // A year; the owner can remove a listener at any time, which revokes the token at once.
      const response = await fetcher(base, { method: 'POST', headers, body: JSON.stringify({ name: name.slice(0, 60), duration: '8760h' }) });
      const body = await response.json().catch(() => null) as { success?: boolean; result?: { id?: string; client_id?: string; client_secret?: string } } | null;
      const result = body?.result;
      if (!response.ok || !body?.success || !result?.id || !result.client_id || !result.client_secret) throw new Error(`Cloudflare API: Service-Token nicht erstellt (HTTP ${response.status})`);
      return { id: result.id, clientId: result.client_id, clientSecret: result.client_secret };
    },
    async revoke(id) {
      const response = await fetcher(`${base}/${encodeURIComponent(id)}`, { method: 'DELETE', headers });
      // Already gone counts as revoked.
      if (!response.ok && response.status !== 404) throw new Error(`Cloudflare API: Service-Token nicht widerrufen (HTTP ${response.status})`);
    },
  };
}
