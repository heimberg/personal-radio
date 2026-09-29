// Server-only: the owner's Spotify listening profile (top artists), read with the owner's permission.
// Only artist names are kept; the owner decided that they may shape the AI's music picks.
import { ProviderError } from './providers.ts';
import type { D1Database } from './station-store.ts';

type Fetch = typeof fetch;
const CACHE_HOURS = 12;
const STATE_MINUTES = 10;
/** Top artists for the music picks; playlist access so music blocks can play the owner's private playlists. */
export const LISTENING_SCOPE = 'user-top-read playlist-read-private playlist-read-collaborative';

export interface ListeningStatus { connected: boolean; artists: string[]; fetchedAt?: string }

export class SpotifyListening {
  private db: D1Database;
  private clientId: string;
  private clientSecret: string;
  private fetcher: Fetch;
  constructor(db: D1Database, config: { clientId: string; clientSecret: string }, fetcher: Fetch = fetch) {
    this.db = db; this.clientId = config.clientId; this.clientSecret = config.clientSecret;
    this.fetcher = (input, init) => fetcher(input, init);
  }

  authorizeUrl(redirectUri: string, state: string): string {
    return `https://accounts.spotify.com/authorize?${new URLSearchParams({ client_id: this.clientId, response_type: 'code', redirect_uri: redirectUri, scope: LISTENING_SCOPE, state })}`;
  }

  /** A fresh single-use state for the login; older ones of the owner are dropped. */
  async beginConnect(owner: string, now: Date): Promise<string> {
    const state = crypto.randomUUID();
    await this.db.prepare('DELETE FROM spotify_oauth_states WHERE owner_id = ?').bind(owner).run();
    await this.db.prepare('INSERT INTO spotify_oauth_states (state, owner_id, created_at) VALUES (?, ?, ?)').bind(state, owner, now.toISOString()).run();
    return state;
  }

  /** True once for a state this owner started in the last ten minutes. */
  async takeState(owner: string, state: string, now: Date): Promise<boolean> {
    const row = await this.db.prepare('DELETE FROM spotify_oauth_states WHERE state = ? AND owner_id = ? AND created_at >= ? RETURNING state')
      .bind(state, owner, new Date(now.getTime() - STATE_MINUTES * 60_000).toISOString()).first<{ state: string }>();
    return !!row;
  }

  private async token(body: Record<string, string>): Promise<{ access_token: string; refresh_token?: string }> {
    const response = await this.fetcher('https://accounts.spotify.com/api/token', {
      method: 'POST', redirect: 'manual', signal: AbortSignal.timeout(15_000),
      headers: { Authorization: `Basic ${btoa(`${this.clientId}:${this.clientSecret}`)}`, 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams(body).toString(),
    });
    if (!response.ok) throw new ProviderError('Spotify account', response.status);
    const result = await response.json() as { access_token?: string; refresh_token?: string };
    if (!result.access_token) throw new Error('Spotify returned no token');
    return { access_token: result.access_token, ...(result.refresh_token ? { refresh_token: result.refresh_token } : {}) };
  }

  async connect(owner: string, code: string, redirectUri: string, now: Date): Promise<void> {
    const result = await this.token({ grant_type: 'authorization_code', code, redirect_uri: redirectUri });
    if (!result.refresh_token) throw new Error('Spotify returned no refresh token');
    await this.db.prepare(`INSERT INTO spotify_listening (owner_id, refresh_token, artists_json, fetched_at, connected_at) VALUES (?, ?, NULL, NULL, ?)
      ON CONFLICT (owner_id) DO UPDATE SET refresh_token = excluded.refresh_token, artists_json = NULL, fetched_at = NULL, connected_at = excluded.connected_at`)
      .bind(owner, result.refresh_token, now.toISOString()).run();
  }

  async disconnect(owner: string): Promise<void> {
    await this.db.prepare('DELETE FROM spotify_listening WHERE owner_id = ?').bind(owner).run();
  }

  private row(owner: string) {
    return this.db.prepare('SELECT refresh_token, artists_json, fetched_at FROM spotify_listening WHERE owner_id = ?').bind(owner)
      .first<{ refresh_token: string; artists_json: string | null; fetched_at: string | null }>();
  }

  async status(owner: string): Promise<ListeningStatus> {
    const row = await this.row(owner);
    if (!row) return { connected: false, artists: [] };
    return { connected: true, artists: parseArtists(row.artists_json), ...(row.fetched_at ? { fetchedAt: row.fetched_at } : {}) };
  }

  /** A fresh access token of the owner's account, or null when not connected or refused. */
  async accessToken(owner: string): Promise<string | null> {
    const row = await this.row(owner);
    if (!row) return null;
    try {
      const token = await this.token({ grant_type: 'refresh_token', refresh_token: row.refresh_token });
      if (token.refresh_token && token.refresh_token !== row.refresh_token) {
        await this.db.prepare('UPDATE spotify_listening SET refresh_token = ? WHERE owner_id = ?').bind(token.refresh_token, owner).run();
      }
      return token.access_token;
    } catch { return null; }
  }

  /** Top artists, recent first, refreshed at most every 12 hours; the cached list survives Spotify outages. */
  async topArtists(owner: string, now: Date): Promise<string[]> {
    const row = await this.row(owner);
    if (!row) return [];
    const cached = parseArtists(row.artists_json);
    if (row.fetched_at && now.getTime() - Date.parse(row.fetched_at) < CACHE_HOURS * 3_600_000) return cached;
    try {
      const token = await this.token({ grant_type: 'refresh_token', refresh_token: row.refresh_token });
      const names: string[] = [];
      for (const [range, limit] of [['short_term', 20], ['medium_term', 30]] as const) {
        const response = await this.fetcher(`https://api.spotify.com/v1/me/top/artists?${new URLSearchParams({ time_range: range, limit: String(limit) })}`, {
          headers: { Authorization: `Bearer ${token.access_token}` }, redirect: 'manual', signal: AbortSignal.timeout(15_000),
        });
        if (!response.ok) throw new ProviderError('Spotify top artists', response.status);
        const body = await response.json() as { items?: Array<{ name?: unknown }> };
        for (const item of body.items ?? []) if (typeof item.name === 'string' && item.name.trim()) names.push(item.name.trim().slice(0, 100));
      }
      const artists = [...new Set(names)].slice(0, 40);
      await this.db.prepare('UPDATE spotify_listening SET artists_json = ?, fetched_at = ?, refresh_token = ? WHERE owner_id = ?')
        .bind(JSON.stringify(artists), now.toISOString(), token.refresh_token ?? row.refresh_token, owner).run();
      return artists;
    } catch { return cached; }
  }
}

function parseArtists(json: string | null): string[] {
  try { const value: unknown = JSON.parse(json ?? '[]'); return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : []; }
  catch { return []; }
}
