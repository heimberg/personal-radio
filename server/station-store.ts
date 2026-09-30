// D1 persistence for the station: configuration, timeline, feedback and memory.
import { MUSIC_SHOW_ID, parseStationConfig } from '../src/domain/station.ts';
import type { StationConfig, TimelineState } from '../src/domain/station.ts';
import { parseFeedback } from '../src/domain/recommendation.ts';
import type { FeedbackEvent } from '../src/domain/recommendation.ts';
import { isFeedbackReason } from '../src/domain/listener-notes.ts';
import type { FeedbackReason, ReasonCount } from '../src/domain/listener-notes.ts';

export interface D1Statement {
  bind(...values: unknown[]): D1Statement;
  first<T>(): Promise<T | null>;
  run(): Promise<unknown>;
  all<T>(): Promise<{ results: T[] }>;
}
export interface D1Database { prepare(query: string): D1Statement }

export interface TimelineRow {
  id: string;
  owner_id: string;
  seq: number;
  show_id: string;
  planned_at: string;
  estimated_minutes: number;
  state: TimelineState;
  attempts: number;
  lease_until: string | null;
  script_json: string | null;
  sources_json: string | null;
  verification: string | null;
  audio_key: string | null;
  content_type: string | null;
  research_json: string | null;
  error: string | null;
  created_at: string;
  updated_at: string;
}
export type TimelinePatch = Partial<Pick<TimelineRow, 'state' | 'attempts' | 'lease_until' | 'script_json' | 'sources_json' | 'verification' | 'audio_key' | 'content_type' | 'research_json' | 'error' | 'estimated_minutes'>>;
const PATCHABLE = ['state', 'attempts', 'lease_until', 'script_json', 'sources_json', 'verification', 'audio_key', 'content_type', 'research_json', 'error', 'estimated_minutes'] as const;

/** An artist hour keeps one audio file per spoken part; everything else has at most one. */
export function audioKeysOf(row: Pick<TimelineRow, 'audio_key' | 'script_json'>): string[] {
  const keys = new Set<string>(row.audio_key ? [row.audio_key] : []);
  try {
    const parts = (JSON.parse(row.script_json ?? '{}') as { parts?: Array<{ audioKey?: unknown }> }).parts ?? [];
    for (const part of parts) if (typeof part.audioKey === 'string') keys.add(part.audioKey);
  } catch { /* No parts. */ }
  return [...keys];
}

export class StationStore {
  private db: D1Database;
  /** How production sees the settings (a child's station adds its rules); the stored document stays as written. */
  private view: (config: StationConfig) => StationConfig;
  constructor(db: D1Database, view: (config: StationConfig) => StationConfig = config => config) { this.db = db; this.view = view; }

  async getConfig(owner: string): Promise<StationConfig | null> {
    const row = await this.db.prepare('SELECT config_json FROM station_config WHERE owner_id = ?').bind(owner).first<{ config_json: string }>();
    if (!row) return null;
    // A stored document that no longer validates is treated as missing rather than crashing production.
    let config: StationConfig;
    try { config = parseStationConfig(JSON.parse(row.config_json)); } catch { return null; }
    return this.view(config);
  }

  async saveConfig(owner: string, config: StationConfig, now: Date) {
    await this.db.prepare(`INSERT INTO station_config (owner_id, config_json, updated_at) VALUES (?, ?, ?)
      ON CONFLICT(owner_id) DO UPDATE SET config_json = excluded.config_json, updated_at = excluded.updated_at`)
      .bind(owner, JSON.stringify(config), now.toISOString()).run();
  }

  async touch(owner: string, now: Date) {
    await this.db.prepare(`INSERT INTO station_activity (owner_id, last_seen_at) VALUES (?, ?)
      ON CONFLICT(owner_id) DO UPDATE SET last_seen_at = excluded.last_seen_at`).bind(owner, now.toISOString()).run();
  }

  async lastSeen(owner: string): Promise<Date | null> {
    const row = await this.db.prepare('SELECT last_seen_at FROM station_activity WHERE owner_id = ?').bind(owner).first<{ last_seen_at: string }>();
    return row ? new Date(row.last_seen_at) : null;
  }

  async openItems(owner: string): Promise<TimelineRow[]> {
    return (await this.db.prepare(`SELECT * FROM timeline_items WHERE owner_id = ? AND state IN ('planned', 'voicing', 'ready') ORDER BY seq`)
      .bind(owner).all<TimelineRow>()).results;
  }

  async recentItems(owner: string, limit: number): Promise<TimelineRow[]> {
    return (await this.db.prepare('SELECT * FROM timeline_items WHERE owner_id = ? ORDER BY seq DESC LIMIT ?')
      .bind(owner, limit).all<TimelineRow>()).results.reverse();
  }

  async lastItem(owner: string): Promise<TimelineRow | null> {
    return this.db.prepare('SELECT * FROM timeline_items WHERE owner_id = ? ORDER BY seq DESC LIMIT 1').bind(owner).first<TimelineRow>();
  }

  /** The item right before [seq] in the program that is still or already on air (not failed or dropped). */
  async previousItem(owner: string, seq: number): Promise<TimelineRow | null> {
    return this.db.prepare(`SELECT * FROM timeline_items WHERE owner_id = ? AND seq < ? AND state NOT IN ('failed', 'expired')
      ORDER BY seq DESC LIMIT 1`).bind(owner, seq).first<TimelineRow>();
  }

  async getItem(owner: string, id: string): Promise<TimelineRow | null> {
    return this.db.prepare('SELECT * FROM timeline_items WHERE owner_id = ? AND id = ?').bind(owner, id).first<TimelineRow>();
  }

  /**
   * Puts open items into the given order: fresh sequence numbers after every existing one (so no
   * uniqueness clash) and planned times one after another from [start].
   */
  async arrange(owner: string, ordered: Array<Pick<TimelineRow, 'id' | 'estimated_minutes'>>, start: Date, now: Date) {
    const max = await this.db.prepare('SELECT MAX(seq) AS seq FROM timeline_items WHERE owner_id = ?').bind(owner).first<{ seq: number | null }>();
    let seq = (max?.seq ?? 0) + 1, at = start.getTime();
    for (const item of ordered) {
      await this.db.prepare(`UPDATE timeline_items SET seq = ?, planned_at = ?, updated_at = ? WHERE owner_id = ? AND id = ? AND state IN ('planned', 'voicing', 'ready')`)
        .bind(seq++, new Date(at).toISOString(), now.toISOString(), owner, item.id).run();
      at += item.estimated_minutes * 60_000;
    }
  }

  async insertItem(owner: string, item: { id: string; seq: number; showId: string; plannedAt: string; estimatedMinutes: number }, now: Date) {
    const at = now.toISOString();
    await this.db.prepare(`INSERT INTO timeline_items (id, owner_id, seq, show_id, planned_at, estimated_minutes, state, attempts, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, 'planned', 0, ?, ?)`)
      .bind(item.id, owner, item.seq, item.showId, item.plannedAt, item.estimatedMinutes, at, at).run();
  }

  /** Claims an item for production. A single conditional UPDATE is atomic across Worker instances. */
  async lease(owner: string, id: string, now: Date, until: Date): Promise<TimelineRow | null> {
    return this.db.prepare(`UPDATE timeline_items SET lease_until = ?, updated_at = ?
      WHERE owner_id = ? AND id = ? AND state IN ('planned', 'voicing') AND (lease_until IS NULL OR lease_until < ?) RETURNING *`)
      .bind(until.toISOString(), now.toISOString(), owner, id, now.toISOString()).first<TimelineRow>();
  }

  async update(owner: string, id: string, patch: TimelinePatch, now: Date) {
    const keys = PATCHABLE.filter(key => key in patch);
    if (!keys.length) return;
    await this.db.prepare(`UPDATE timeline_items SET ${keys.map(key => `${key} = ?`).join(', ')}, updated_at = ? WHERE owner_id = ? AND id = ?`)
      .bind(...keys.map(key => patch[key] ?? null), now.toISOString(), owner, id).run();
  }

  /** Items waiting for production whose lease is free. */
  async dueItems(owner: string, now: Date): Promise<TimelineRow[]> {
    return (await this.db.prepare(`SELECT * FROM timeline_items WHERE owner_id = ? AND state IN ('planned', 'voicing')
      AND (lease_until IS NULL OR lease_until < ?) ORDER BY seq`).bind(owner, now.toISOString()).all<TimelineRow>()).results;
  }

  /**
   * «Erneut versuchen»: items that failed within the last day are produced again from scratch (research,
   * script, check; a chosen subject is kept), older failures are retired; waiting items become due now with
   * fresh attempts, keeping approved scripts. Either way they no longer count towards the failure pause.
   */
  async retryNow(owner: string, now: Date): Promise<{ retried: number; retired: number; restarted: number }> {
    const at = now.toISOString(), since = new Date(now.getTime() - 86_400_000).toISOString();
    const retried = (await this.db.prepare(`UPDATE timeline_items SET state = 'planned', attempts = 0, lease_until = NULL, error = NULL,
      script_json = NULL, sources_json = NULL, verification = NULL, audio_key = NULL, content_type = NULL, updated_at = ?
      WHERE owner_id = ? AND state = 'failed' AND updated_at >= ? RETURNING id`).bind(at, owner, since).all<{ id: string }>()).results.length;
    const retired = (await this.db.prepare(`UPDATE timeline_items SET state = 'expired', lease_until = NULL, updated_at = ?
      WHERE owner_id = ? AND state = 'failed' RETURNING id`).bind(at, owner).all<{ id: string }>()).results.length;
    const restarted = (await this.db.prepare(`UPDATE timeline_items SET lease_until = NULL, attempts = 0, updated_at = ?
      WHERE owner_id = ? AND state IN ('planned', 'voicing') AND lease_until IS NOT NULL AND error IS NOT NULL RETURNING id`)
      .bind(at, owner).all<{ id: string }>()).results.length;
    return { retried, retired, restarted };
  }

  /** What the cockpit lists: everything still to come and the last few heard segments. */
  async visibleItems(owner: string, recentPlayed = 5): Promise<TimelineRow[]> {
    const open = await this.openItems(owner);
    const played = (await this.db.prepare(`SELECT * FROM timeline_items WHERE owner_id = ? AND state IN ('played', 'skipped')
      ORDER BY seq DESC LIMIT ?`).bind(owner, recentPlayed).all<TimelineRow>()).results.reverse();
    return [...played, ...open];
  }

  /** Failures are summarised instead of listed one by one. */
  async failureSummary(owner: string): Promise<{ count: number; latestError?: string; latestAt?: string }> {
    const count = await this.db.prepare(`SELECT COUNT(*) AS n FROM timeline_items WHERE owner_id = ? AND state = 'failed'`).bind(owner).first<{ n: number }>();
    const latest = await this.db.prepare(`SELECT error, updated_at FROM timeline_items WHERE owner_id = ? AND state = 'failed' ORDER BY updated_at DESC LIMIT 1`)
      .bind(owner).first<{ error: string | null; updated_at: string }>();
    return { count: Number(count?.n ?? 0), ...(latest ? { latestError: latest.error ?? undefined, latestAt: latest.updated_at } : {}) };
  }

  /** Deletes failed and expired items (all, or only those last changed before the cutoff) and returns their audio keys. */
  async purge(owner: string, updatedBefore?: Date): Promise<{ removed: number; audioKeys: string[] }> {
    const rows = (await this.db.prepare(`DELETE FROM timeline_items WHERE owner_id = ? AND state IN ('failed', 'expired')
      AND updated_at < ? RETURNING audio_key, script_json`).bind(owner, updatedBefore?.toISOString() ?? '9999-12-31T23:59:59.999Z')
      .all<{ audio_key: string | null; script_json: string | null }>()).results;
    // Checkpoints of editorial-team runs that never finished (the item expired or was removed).
    await this.db.prepare(`DELETE FROM agent_steps WHERE owner_id = ? AND created_at < ?`).bind(owner, updatedBefore?.toISOString() ?? '9999-12-31T23:59:59.999Z').run();
    return { removed: rows.length, audioKeys: rows.flatMap(row => audioKeysOf(row)) };
  }

  async recentFailures(owner: string, since: Date): Promise<number> {
    const row = await this.db.prepare(`SELECT COUNT(*) AS failures FROM timeline_items WHERE owner_id = ? AND state = 'failed' AND updated_at >= ?`)
      .bind(owner, since.toISOString()).first<{ failures: number }>();
    return Number(row?.failures ?? 0);
  }

  /**
   * Items created before the cutoff leave the program: unfinished ones expire, finished but unheard ones
   * move to the archive, where they stay playable until their audio is released.
   */
  async expire(owner: string, createdBefore: Date, now: Date): Promise<TimelineRow[]> {
    return (await this.db.prepare(`UPDATE timeline_items SET state = CASE WHEN state = 'ready' THEN 'archived' ELSE 'expired' END,
      lease_until = NULL, updated_at = ?
      WHERE owner_id = ? AND state IN ('planned', 'voicing', 'ready') AND created_at < ? RETURNING *`)
      .bind(now.toISOString(), owner, createdBefore.toISOString()).all<TimelineRow>()).results;
  }

  /** Audio of items that left the program before the retention cutoff. */
  async audioToRelease(owner: string, updatedBefore: Date): Promise<TimelineRow[]> {
    return (await this.db.prepare(`SELECT * FROM timeline_items WHERE owner_id = ? AND audio_key IS NOT NULL
      AND state IN ('played', 'skipped', 'archived', 'expired', 'failed') AND updated_at < ?`).bind(owner, updatedBefore.toISOString()).all<TimelineRow>()).results;
  }

  /** Deletes a production that already left the program (heard, skipped or archived) and returns its audio keys. */
  async deleteHeard(owner: string, id: string): Promise<string[] | null> {
    const row = await this.db.prepare(`DELETE FROM timeline_items WHERE owner_id = ? AND id = ? AND state IN ('played', 'skipped', 'archived')
      RETURNING audio_key, script_json`).bind(owner, id).first<{ audio_key: string | null; script_json: string | null }>();
    return row ? audioKeysOf(row) : null;
  }

  /** Everything that can still be heard, newest first: ready, heard and archived productions with audio. Single songs are left out. */
  async library(owner: string, limit = 60): Promise<TimelineRow[]> {
    return (await this.db.prepare(`SELECT * FROM timeline_items WHERE owner_id = ? AND audio_key IS NOT NULL AND show_id != ?
      AND state IN ('ready', 'played', 'skipped', 'archived') ORDER BY created_at DESC, seq DESC LIMIT ?`)
      .bind(owner, MUSIC_SHOW_ID, limit).all<TimelineRow>()).results;
  }

  async addFeedback(owner: string, event: FeedbackEvent) {
    await this.db.prepare(`INSERT INTO feedback_events (owner_id, item_id, interests_json, action, listened_ratio, created_at) VALUES (?, ?, ?, ?, ?, ?)`)
      .bind(owner, event.itemId, JSON.stringify(event.interests), event.action, event.listenedRatio, event.createdAt).run();
  }

  async feedback(owner: string): Promise<FeedbackEvent[]> {
    const rows = (await this.db.prepare(`SELECT item_id, interests_json, action, listened_ratio, created_at FROM feedback_events
      WHERE owner_id = ? ORDER BY id DESC LIMIT 200`).bind(owner).all<{ item_id: string; interests_json: string; action: string; listened_ratio: number; created_at: string }>()).results;
    return parseFeedback(rows.reverse().map(row => {
      let interests: unknown = [];
      try { interests = JSON.parse(row.interests_json); } catch { /* Ignore a corrupt row. */ }
      return { itemId: row.item_id, interests, action: row.action, listenedRatio: row.listened_ratio, createdAt: row.created_at };
    }));
  }

  /** Adds the reason to the owner's latest down-rating of the item; false when there is none. */
  async setReason(owner: string, itemId: string, reason: FeedbackReason): Promise<boolean> {
    const result = await this.db.prepare(`UPDATE feedback_events SET reason = ? WHERE id = (SELECT MAX(id) FROM feedback_events WHERE owner_id = ? AND item_id = ? AND action = 'dislike') RETURNING id`)
      .bind(reason, owner, itemId).first<{ id: number }>();
    return !!result;
  }

  async reasonCounts(owner: string, since: Date): Promise<ReasonCount[]> {
    const rows = (await this.db.prepare(`SELECT reason, COUNT(*) AS count FROM feedback_events WHERE owner_id = ? AND reason IS NOT NULL AND created_at >= ? GROUP BY reason`)
      .bind(owner, since.toISOString()).all<{ reason: string; count: number }>()).results;
    return rows.filter(row => isFeedbackReason(row.reason)).map(row => ({ reason: row.reason as FeedbackReason, count: Number(row.count) }));
  }

  /** The owner starts over: collected reasons no longer steer the prompts. */
  async clearReasons(owner: string) {
    await this.db.prepare('UPDATE feedback_events SET reason = NULL WHERE owner_id = ? AND reason IS NOT NULL').bind(owner).run();
  }

  async logQuality(owner: string, entry: { itemId: string; showId: string; overall: number; at: Date }) {
    await this.db.prepare('INSERT OR REPLACE INTO quality_log (owner_id, item_id, show_id, overall, created_at) VALUES (?, ?, ?, ?, ?)')
      .bind(owner, entry.itemId, entry.showId, entry.overall, entry.at.toISOString()).run();
  }

  async qualityLog(owner: string, since: Date): Promise<Array<{ showId: string; overall: number; createdAt: string }>> {
    return (await this.db.prepare('SELECT show_id, overall, created_at FROM quality_log WHERE owner_id = ? AND created_at >= ? ORDER BY created_at')
      .bind(owner, since.toISOString()).all<{ show_id: string; overall: number; created_at: string }>()).results
      .map(row => ({ showId: row.show_id, overall: Number(row.overall), createdAt: row.created_at }));
  }

  async logAgentChange(owner: string, at: Date, agents: string[]) {
    await this.db.prepare('INSERT INTO agent_changes (owner_id, changed_at, agents) VALUES (?, ?, ?)').bind(owner, at.toISOString(), JSON.stringify(agents)).run();
  }

  async agentChanges(owner: string, since: Date): Promise<Array<{ at: string; agents: string[] }>> {
    return (await this.db.prepare('SELECT changed_at, agents FROM agent_changes WHERE owner_id = ? AND changed_at >= ? ORDER BY changed_at')
      .bind(owner, since.toISOString()).all<{ changed_at: string; agents: string }>()).results.map(row => {
        let agents: string[] = [];
        try { agents = JSON.parse(row.agents); } catch { /* Corrupt row: the mark stays, without names. */ }
        return { at: row.changed_at, agents };
      });
  }

  async coveredUrls(owner: string, urls: string[]): Promise<Set<string>> {
    const covered = new Set<string>();
    // Small batches keep each statement well below D1's bound-parameter limit.
    for (let start = 0; start < urls.length; start += 50) {
      const batch = urls.slice(start, start + 50);
      if (!batch.length) continue;
      const rows = (await this.db.prepare(`SELECT url FROM covered_sources WHERE owner_id = ? AND url IN (${batch.map(() => '?').join(', ')})`)
        .bind(owner, ...batch).all<{ url: string }>()).results;
      rows.forEach(row => covered.add(row.url));
    }
    return covered;
  }

  async markCovered(owner: string, urls: string[], now: Date) {
    for (const url of new Set(urls)) {
      await this.db.prepare('INSERT OR IGNORE INTO covered_sources (owner_id, url, covered_at) VALUES (?, ?, ?)')
        .bind(owner, url, now.toISOString()).run();
    }
  }
}
