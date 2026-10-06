// `/join/health`: whether this Worker can work, as plain yes/no answers (no names, no numbers), so the
// deploy can check itself without a token. It calls no provider, so it costs nothing.
import type { Environment } from './http.ts';

/** The newest migration this code needs; a test keeps it in step with migrations/. */
export const LATEST_MIGRATION = '0022_item_stage.sql';

export interface Health { ok: boolean; checks: { database: boolean; migrations: boolean; storage: boolean; speech: boolean; access: boolean } }

export async function healthCheck(env: Environment): Promise<Health> {
  const attempt = async (check: () => Promise<boolean>) => { try { return await check(); } catch { return false; } };
  const [database, migrations, storage] = await Promise.all([
    attempt(async () => (await env.DB.prepare('SELECT 1 AS one').first<{ one: number }>())?.one === 1),
    // Wrangler records applied migrations in d1_migrations.
    attempt(async () => !!await env.DB.prepare('SELECT 1 AS one FROM d1_migrations WHERE name = ?').bind(LATEST_MIGRATION).first()),
    attempt(async () => { await env.AUDIO.get('health/none'); return true; }),
  ]);
  const checks = { database, migrations, storage, speech: !!(env.GEMINI_API_KEY || env.MISTRAL_API_KEY), access: !!(env.ACCESS_TEAM_DOMAIN && env.ACCESS_AUD) };
  return { ok: Object.values(checks).every(Boolean), checks };
}
