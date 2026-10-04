import { runAll } from './station-store.ts';
import type { D1Database } from './station-store.ts';

/**
 * How long each kind of record is kept, in days. The program itself cleans up after itself (failed and
 * expired items after a day, audio after a week); these tables otherwise only grow.
 */
export const RETENTION_DAYS = {
  /** Articles already used: long enough that a feed does not bring them back. */
  covered_sources: 90,
  /** Daily counters and the usage overview (which shows the last weeks). */
  daily: 400,
  quality_log: 180,
  feedback_events: 365,
  agent_changes: 365,
  error_log: 30,
  /** Greetings and questions once aired, OAuth states that were never used. */
  aired: 30,
} as const;

const before = (now: Date, days: number) => new Date(now.getTime() - days * 86_400_000).toISOString();
const dayBefore = (now: Date, days: number) => before(now, days).slice(0, 10);

/** Deletes what is older than its retention, for every owner, in one batch. */
export async function pruneDatabase(db: D1Database, now: Date): Promise<void> {
  const statements = [
    db.prepare('DELETE FROM covered_sources WHERE covered_at < ?').bind(before(now, RETENTION_DAYS.covered_sources)),
    ...['daily_requests', 'daily_usage', 'daily_feed_requests', 'daily_linker_requests', 'model_usage']
      .map(table => db.prepare(`DELETE FROM ${table} WHERE utc_day < ?`).bind(dayBefore(now, RETENTION_DAYS.daily))),
    db.prepare('DELETE FROM quality_log WHERE created_at < ?').bind(before(now, RETENTION_DAYS.quality_log)),
    db.prepare('DELETE FROM feedback_events WHERE created_at < ?').bind(before(now, RETENTION_DAYS.feedback_events)),
    db.prepare('DELETE FROM agent_changes WHERE changed_at < ?').bind(before(now, RETENTION_DAYS.agent_changes)),
    db.prepare('DELETE FROM error_log WHERE created_at < ?').bind(before(now, RETENTION_DAYS.error_log)),
    db.prepare('DELETE FROM family_greetings WHERE aired_at IS NOT NULL AND aired_at < ?').bind(before(now, RETENTION_DAYS.aired)),
    db.prepare('DELETE FROM radio_questions WHERE aired_at IS NOT NULL AND aired_at < ?').bind(before(now, RETENTION_DAYS.aired)),
    db.prepare('DELETE FROM spotify_oauth_states WHERE created_at < ?').bind(before(now, 1)),
    db.prepare('DELETE FROM research_cache WHERE created_at < ?').bind(before(now, 2)),
    // Join attempts count per hour; invitations nobody used are gone a month after they expired.
    db.prepare('DELETE FROM join_attempts WHERE hour < ?').bind(before(now, 1).slice(0, 13)),
    db.prepare('DELETE FROM invites WHERE used_at IS NULL AND expires_at < ?').bind(before(now, 30)),
  ];
  await runAll(db, statements);
}
