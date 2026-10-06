// Warnings for the owner's phone: a provider keeps failing, or productions are stuck. Computed from
// the call log and the timeline on every timeline request of the owner; the app reports each id once.
import type { D1Database } from './station-store.ts';

export interface HealthAlert { id: string; text: string }

/** This many failed calls to one provider within the window make a warning. */
export const FAILURE_ALERT_COUNT = 5;
export const FAILURE_WINDOW_MINUTES = 30;
/** A waiting item nobody picked up for this long means the queue or the cron is stuck. */
export const STALL_MINUTES = 30;

const PROVIDERS: Record<string, string> = { gemini: 'Gemini', mistral: 'Mistral', ask: 'Der Frage-Dienst' };

export async function healthAlerts(db: D1Database, now: Date): Promise<HealthAlert[]> {
  const day = now.toISOString().slice(0, 10), alerts: HealthAlert[] = [];
  const since = new Date(now.getTime() - FAILURE_WINDOW_MINUTES * 60_000).toISOString();
  const failures = (await db.prepare(`SELECT provider, COUNT(*) AS count, SUM(status = 429) AS refused, MAX(status) AS status FROM llm_calls
    WHERE at >= ? AND status >= 400 GROUP BY provider`).bind(since).all<{ provider: string; count: number; refused: number; status: number }>()).results;
  for (const row of failures) {
    if (Number(row.count) < FAILURE_ALERT_COUNT) continue;
    const name = PROVIDERS[row.provider] ?? row.provider, quota = Number(row.refused) * 2 >= Number(row.count);
    alerts.push(quota
      ? { id: `quota:${row.provider}:${day}`, text: `${name}: Kontingent erschöpft – ${row.count} abgelehnte Aufrufe in ${FAILURE_WINDOW_MINUTES} Minuten. Produktionen warten, bis es wieder geht.` }
      : { id: `provider:${row.provider}:${day}`, text: `${name} antwortet mit Fehlern – ${row.count} in ${FAILURE_WINDOW_MINUTES} Minuten (zuletzt HTTP ${row.status}). Details unter Studio › Entwickler.` });
  }
  // Waiting items whose lease ran out long ago (or was never taken): nothing is producing them.
  const stale = new Date(now.getTime() - STALL_MINUTES * 60_000).toISOString();
  const stuck = await db.prepare(`SELECT COUNT(*) AS count FROM timeline_items WHERE state IN ('planned', 'voicing')
    AND (lease_until IS NULL OR lease_until < ?) AND updated_at < ?`).bind(stale, stale).first<{ count: number }>();
  if (Number(stuck?.count ?? 0) > 0) {
    alerts.push({ id: `stalled:${day}`, text: `Die Produktion stockt: ${stuck!.count} Beiträge warten seit über ${STALL_MINUTES} Minuten, ohne dass jemand sie bearbeitet. Die Warteschlange oder der Zeitplan des Workers prüfen.` });
  }
  return alerts;
}
