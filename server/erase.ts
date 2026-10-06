// Removing a listener for good: every row of their station in D1 and every object of theirs in R2.
import type { D1Database } from './station-store.ts';
import { audioKeysOf, runAll } from './station-store.ts';
import { backupFolder } from './backups.ts';
import type { AudioStore } from './http.ts';

/** Tables keyed by the station's owner ID. */
const OWNED = [
  'daily_usage', 'daily_requests', 'daily_feed_requests', 'daily_linker_requests', 'station_config', 'timeline_items', 'feedback_events',
  'covered_sources', 'station_activity', 'spotify_listening', 'agent_steps', 'quality_log', 'agent_changes', 'spotify_oauth_states', 'series',
  'family_reads', 'family_presence', 'family_avatars', 'stickers', 'radio_questions', 'followed_topics', 'bookmarks', 'research_cache',
  'error_log', 'llm_calls', 'owner_usage',
] as const;

/**
 * Deletes [owner]'s station: produced audio, backups and the profile picture in R2, then every row in D1,
 * including the family messages they sent or received. Never the owner's own station.
 */
export async function eraseStation(db: D1Database, audio: AudioStore, owner: string, avatarKey?: string): Promise<{ rows: number; objects: number }> {
  if (!owner.startsWith('listener:')) throw new Error('only a listener station can be erased');
  const keys = new Set<string>();
  for (const row of (await db.prepare('SELECT audio_key, script_json FROM timeline_items WHERE owner_id = ?').bind(owner).all<{ audio_key: string | null; script_json: string | null }>()).results) {
    for (const key of audioKeysOf(row)) keys.add(key);
  }
  if (audio.list) for (const object of (await audio.list({ prefix: await backupFolder(owner), limit: 100 })).objects) keys.add(object.key);
  if (avatarKey) keys.add(avatarKey);
  for (const key of keys) await audio.delete(key).catch(() => { /* Already gone. */ });
  const statements = [
    ...OWNED.map(table => db.prepare(`DELETE FROM ${table} WHERE owner_id = ?`).bind(owner)),
    db.prepare('DELETE FROM family_messages WHERE sender = ? OR recipient = ?').bind(owner, owner),
    db.prepare('DELETE FROM family_greetings WHERE sender = ? OR recipient = ?').bind(owner, owner),
  ];
  let rows = 0;
  if (db.batch) {
    for (const result of await db.batch(statements) as Array<{ meta?: { changes?: number } }>) rows += result?.meta?.changes ?? 0;
  } else {
    await runAll(db, statements);
  }
  return { rows, objects: keys.size };
}
