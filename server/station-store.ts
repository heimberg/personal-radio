// D1 persistence for the station: configuration, timeline, feedback and memory.
import { MUSIC_SHOW_ID, parseStationConfig } from '../src/domain/station.ts';
import type { StationConfig, TimelineState } from '../src/domain/station.ts';
import { parseFeedback } from '../src/domain/recommendation.ts';
import type { FeedbackEvent } from '../src/domain/recommendation.ts';
import { isFeedbackReason } from '../src/domain/listener-notes.ts';
import type { EpisodePlan, Series, SeriesKind, SeriesState } from '../src/domain/series.ts';
import { parseChoice } from '../src/domain/play.ts';
import type { FeedbackReason, ReasonCount } from '../src/domain/listener-notes.ts';

export interface D1Statement {
  bind(...values: unknown[]): D1Statement;
  first<T>(): Promise<T | null>;
  run(): Promise<unknown>;
  all<T>(): Promise<{ results: T[] }>;
}
/** `batch` sends several statements in one round trip (and one transaction); without it they run one by one. */
export interface D1Database { prepare(query: string): D1Statement; batch?(statements: D1Statement[]): Promise<unknown[]> }

/** Runs [statements] in one batch where the database offers it. */
export async function runAll(db: D1Database, statements: D1Statement[]): Promise<void> {
  if (!statements.length) return;
  if (db.batch) { await db.batch(statements); return; }
  for (const statement of statements) await statement.run();
}

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

  /** A cached research result no older than [maxMinutes], or null. */
  async cached(owner: string, key: string, maxMinutes: number, now: Date): Promise<string | null> {
    const row = await this.db.prepare('SELECT value_json, created_at FROM research_cache WHERE owner_id = ? AND cache_key = ?').bind(owner, key)
      .first<{ value_json: string; created_at: string }>();
    return row && now.getTime() - Date.parse(row.created_at) <= maxMinutes * 60_000 ? row.value_json : null;
  }

  /** Keeps a research result; entries older than a day go at the same time. */
  async cache(owner: string, key: string, value: string, now: Date) {
    await this.db.prepare('DELETE FROM research_cache WHERE owner_id = ? AND created_at < ?').bind(owner, new Date(now.getTime() - 86_400_000).toISOString()).run();
    await this.db.prepare(`INSERT INTO research_cache (owner_id, cache_key, created_at, value_json) VALUES (?, ?, ?, ?)
      ON CONFLICT(owner_id, cache_key) DO UPDATE SET created_at = excluded.created_at, value_json = excluded.value_json`)
      .bind(owner, key, now.toISOString(), value).run();
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
    const updates: D1Statement[] = [];
    for (const item of ordered) {
      updates.push(this.db.prepare(`UPDATE timeline_items SET seq = ?, planned_at = ?, updated_at = ? WHERE owner_id = ? AND id = ? AND state IN ('planned', 'voicing', 'ready')`)
        .bind(seq++, new Date(at).toISOString(), now.toISOString(), owner, item.id));
      at += item.estimated_minutes * 60_000;
    }
    await runAll(this.db, updates);
  }

  async insertItem(owner: string, item: NewItem, now: Date) {
    await this.insertItems(owner, [item], now);
  }

  /** The planner's new items in one batch. */
  async insertItems(owner: string, items: NewItem[], now: Date) {
    const at = now.toISOString();
    await runAll(this.db, items.map(item => this.db.prepare(`INSERT INTO timeline_items (id, owner_id, seq, show_id, planned_at, estimated_minutes, state, attempts, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, 'planned', 0, ?, ?)`)
      .bind(item.id, owner, item.seq, item.showId, item.plannedAt, item.estimatedMinutes, at, at)));
  }

  async insertSeries(owner: string, series: Series, now: Date) {
    await this.db.prepare(`INSERT INTO series (owner_id, id, title, subject, kind, episodes_json, recaps_json, scheduled, state, created_at, updated_at, interactive, choices_json)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).bind(owner, series.id, series.title, series.subject, series.kind, JSON.stringify(series.episodes),
      JSON.stringify(series.recaps), series.scheduled, series.state, series.createdAt, now.toISOString(), series.interactive ? 1 : 0, JSON.stringify(series.choices ?? [])).run();
  }

  async getSeries(owner: string, id: string): Promise<Series | null> {
    const row = await this.db.prepare('SELECT * FROM series WHERE owner_id = ? AND id = ?').bind(owner, id).first<SeriesRow>();
    return row ? seriesOf(row) : null;
  }

  /** Running series first, then the most recent finished or stopped ones. */
  async listSeries(owner: string, limit = 20): Promise<Series[]> {
    return (await this.db.prepare(`SELECT * FROM series WHERE owner_id = ? ORDER BY state = 'active' DESC, updated_at DESC LIMIT ?`)
      .bind(owner, limit).all<SeriesRow>()).results.map(seriesOf);
  }

  async updateSeries(owner: string, id: string, patch: Partial<Pick<Series, 'recaps' | 'scheduled' | 'state' | 'choices'>>, now: Date) {
    const sets: string[] = [], values: unknown[] = [];
    if (patch.choices) { sets.push('choices_json = ?'); values.push(JSON.stringify(patch.choices)); }
    if (patch.recaps) { sets.push('recaps_json = ?'); values.push(JSON.stringify(patch.recaps)); }
    if (patch.scheduled !== undefined) { sets.push('scheduled = ?'); values.push(patch.scheduled); }
    if (patch.state) { sets.push('state = ?'); values.push(patch.state); }
    if (!sets.length) return;
    await this.db.prepare(`UPDATE series SET ${sets.join(', ')}, updated_at = ? WHERE owner_id = ? AND id = ?`).bind(...values, now.toISOString(), owner, id).run();
  }

  /** Items heard to the end since [since], oldest first (the week for the Wochenrückblick). */
  async heardSince(owner: string, since: Date): Promise<TimelineRow[]> {
    return (await this.db.prepare(`SELECT * FROM timeline_items WHERE owner_id = ? AND state = 'played' AND updated_at >= ? AND script_json IS NOT NULL
      ORDER BY updated_at`).bind(owner, since.toISOString()).all<TimelineRow>()).results;
  }

  /** Items of a show created since [since], newest first. */
  async ofShowSince(owner: string, showId: string, since: Date): Promise<TimelineRow[]> {
    return (await this.db.prepare('SELECT * FROM timeline_items WHERE owner_id = ? AND show_id = ? AND created_at >= ? ORDER BY created_at DESC')
      .bind(owner, showId, since.toISOString()).all<TimelineRow>()).results;
  }

  /** The newest timeline item of a show (a series' latest episode), whatever its state. */
  async latestOfShow(owner: string, showId: string): Promise<TimelineRow | null> {
    return this.db.prepare('SELECT * FROM timeline_items WHERE owner_id = ? AND show_id = ? ORDER BY seq DESC LIMIT 1').bind(owner, showId).first<TimelineRow>();
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
    const statements = [this.db.prepare(`UPDATE timeline_items SET ${keys.map(key => `${key} = ?`).join(', ')}, updated_at = ? WHERE owner_id = ? AND id = ?`)
      .bind(...keys.map(key => patch[key] ?? null), now.toISOString(), owner, id)];
    // Every error an item records also goes to the error log, for the studio's «Diagnose».
    if (typeof patch.error === 'string' && patch.error) {
      statements.push(this.db.prepare(`INSERT INTO error_log (owner_id, item_id, show_id, stage, message, created_at)
        SELECT ?, ?, show_id, ?, ?, ? FROM timeline_items WHERE owner_id = ? AND id = ?`)
        .bind(owner, id, patch.state === 'failed' ? 'failed' : patch.state === 'expired' ? 'skipped' : 'retry', patch.error.slice(0, 400), now.toISOString(), owner, id));
    }
    await runAll(this.db, statements);
  }

  /** Today's productions and speech characters, for the warning near the daily limits. */
  async usageToday(owner: string, day: string): Promise<{ generations: number; characters: number }> {
    const row = await this.db.prepare(`SELECT (SELECT requests FROM daily_requests WHERE owner_id = ? AND utc_day = ?) AS generations,
      (SELECT characters FROM daily_usage WHERE owner_id = ? AND utc_day = ?) AS characters`).bind(owner, day, owner, day).first<{ generations: number | null; characters: number | null }>();
    return { generations: Number(row?.generations ?? 0), characters: Number(row?.characters ?? 0) };
  }

  /** How many items each show produced since [since]: where the productions (and so the costs) go. */
  async producedByShow(owner: string, since: Date): Promise<Array<{ showId: string; count: number }>> {
    const rows = (await this.db.prepare(`SELECT show_id, COUNT(*) AS count FROM timeline_items WHERE owner_id = ? AND created_at >= ?
      AND state IN ('ready', 'played', 'skipped', 'archived') GROUP BY show_id ORDER BY count DESC LIMIT 12`).bind(owner, since.toISOString()).all<{ show_id: string; count: number }>()).results;
    return rows.map(row => ({ showId: row.show_id, count: Number(row.count) }));
  }

  /** A failure outside an item (a transition, the queue). */
  async logError(owner: string, stage: string, message: string, now: Date, itemId?: string) {
    await this.db.prepare('INSERT INTO error_log (owner_id, item_id, stage, message, created_at) VALUES (?, ?, ?, ?, ?)')
      .bind(owner, itemId ?? null, stage.slice(0, 40), message.slice(0, 400), now.toISOString()).run();
  }

  /** The latest errors, newest first, with the show's id where there is one. */
  async errors(owner: string, limit = 30): Promise<Array<{ itemId: string | null; showId: string | null; stage: string; message: string; at: string }>> {
    const rows = (await this.db.prepare('SELECT item_id, show_id, stage, message, created_at FROM error_log WHERE owner_id = ? ORDER BY id DESC LIMIT ?')
      .bind(owner, limit).all<{ item_id: string | null; show_id: string | null; stage: string; message: string; created_at: string }>()).results;
    return rows.map(row => ({ itemId: row.item_id, showId: row.show_id, stage: row.stage, message: row.message, at: row.created_at }));
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

  /** What the app lists: everything still to come and the last few heard segments. */
  async visibleItems(owner: string, recentPlayed = 5): Promise<TimelineRow[]> {
    const open = await this.openItems(owner);
    const played = (await this.db.prepare(`SELECT * FROM timeline_items WHERE owner_id = ? AND state IN ('played', 'skipped')
      ORDER BY seq DESC LIMIT ?`).bind(owner, recentPlayed).all<TimelineRow>()).results.reverse();
    return [...played, ...open];
  }

  /** Failures are summarised instead of listed one by one. */
  async failureSummary(owner: string): Promise<{ count: number; latestError?: string; latestAt?: string }> {
    const [count, latest] = await Promise.all([this.db.prepare(`SELECT COUNT(*) AS n FROM timeline_items WHERE owner_id = ? AND state = 'failed'`).bind(owner).first<{ n: number }>(),
      this.db.prepare(`SELECT error, updated_at FROM timeline_items WHERE owner_id = ? AND state = 'failed' ORDER BY updated_at DESC LIMIT 1`)
      .bind(owner).first<{ error: string | null; updated_at: string }>()]);
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

  /** «Jetzt planen»: runs that found nothing new no longer pause planning. */
  async forgetEmptyRuns(owner: string): Promise<void> {
    await this.db.prepare(`UPDATE timeline_items SET error = NULL WHERE owner_id = ? AND state = 'expired' AND error = 'NO_SOURCES'`).bind(owner).run();
  }

  async recentFailures(owner: string, since: Date): Promise<number> {
    const row = await this.db.prepare(`SELECT COUNT(*) AS failures FROM timeline_items WHERE owner_id = ?
      AND (state = 'failed' OR state = 'expired' AND error = 'NO_SOURCES') AND updated_at >= ?`)
      .bind(owner, since.toISOString()).first<{ failures: number }>();
    return Number(row?.failures ?? 0);
  }

  /**
   * Items created before the cutoff leave the program: unfinished ones expire, finished but unheard ones
   * move to the archive, where they stay playable until their audio is released. The item playing right
   * now ([playing]) stays: it leaves the program when the app reports it heard.
   */
  async expire(owner: string, createdBefore: Date, now: Date, playing: string | null = null): Promise<TimelineRow[]> {
    return (await this.db.prepare(`UPDATE timeline_items SET state = CASE WHEN state = 'ready' THEN 'archived' ELSE 'expired' END,
      lease_until = NULL, updated_at = ?
      WHERE owner_id = ? AND state IN ('planned', 'voicing', 'ready') AND created_at < ? AND id != ? RETURNING *`)
      .bind(now.toISOString(), owner, createdBefore.toISOString(), playing ?? '').all<TimelineRow>()).results;
  }

  /** The item the owner's app plays now (as reported for the family), while that report holds. */
  async playingNow(owner: string, now: Date): Promise<string | null> {
    const row = await this.db.prepare('SELECT item_id FROM family_presence WHERE owner_id = ? AND until > ?')
      .bind(owner, now.toISOString()).first<{ item_id: string }>();
    return row?.item_id ?? null;
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

  /** The jury's latest notes on a show's items, newest first (what keeps it below the bar). */
  async juryNotes(owner: string, showId: string, limit = 3): Promise<string[]> {
    const rows = (await this.db.prepare('SELECT script_json FROM timeline_items WHERE owner_id = ? AND show_id = ? AND script_json IS NOT NULL ORDER BY seq DESC LIMIT 12')
      .bind(owner, showId).all<{ script_json: string }>()).results;
    const notes: string[] = [];
    for (const row of rows) {
      try { const note = (JSON.parse(row.script_json) as { quality?: { notes?: unknown } }).quality?.notes; if (typeof note === 'string' && note.trim()) notes.push(note.trim()); } catch { /* Skip corrupt rows. */ }
      if (notes.length >= limit) break;
    }
    return notes;
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
    // The station's own material has no link and is never «covered».
    await runAll(this.db, [...new Set(urls)].filter(Boolean).map(url => this.db.prepare('INSERT OR IGNORE INTO covered_sources (owner_id, url, covered_at) VALUES (?, ?, ?)')
      .bind(owner, url, now.toISOString())));
  }
}

/** A new item of the program, as the planner makes it. */
export interface NewItem { id: string; seq: number; showId: string; plannedAt: string; estimatedMinutes: number }

interface SeriesRow { id: string; title: string; subject: string; kind: SeriesKind; episodes_json: string; recaps_json: string; scheduled: number; state: SeriesState; created_at: string;
  interactive?: number; choices_json?: string }

function seriesOf(row: SeriesRow): Series {
  const list = <T>(json: string): T[] => { try { const value = JSON.parse(json); return Array.isArray(value) ? value : []; } catch { return []; } };
  return { id: row.id, title: row.title, subject: row.subject, kind: row.kind, episodes: list<EpisodePlan>(row.episodes_json),
    recaps: list<string>(row.recaps_json), scheduled: row.scheduled, state: row.state, createdAt: row.created_at,
    ...(row.interactive ? { interactive: true, choices: list<unknown>(row.choices_json ?? '[]').map(parseChoice) } : {}) };
}
