// Durable steps without extra infrastructure: finished agent tasks are stored in D1, so a retried
// production resumes after the last finished task. Same shape as a Cloudflare WorkflowStep, so the
// team can move to Workflows by swapping this runner.
import type { D1Database } from '../station-store.ts';
import type { DurableStepRunner } from './runtime.ts';

export class D1StepRunner implements DurableStepRunner {
  private db: D1Database;
  private owner: string;
  private runId: string;
  constructor(db: D1Database, owner: string, runId: string) { this.db = db; this.owner = owner; this.runId = runId; }

  async do<T>(name: string, config: { retries: { limit: number } }, callback: () => Promise<T>): Promise<T> {
    const cached = await this.db.prepare('SELECT result_json FROM agent_steps WHERE run_id = ? AND step_name = ?').bind(this.runId, name).first<{ result_json: string }>();
    if (cached) return JSON.parse(cached.result_json) as T;
    let error: unknown;
    for (let attempt = 0; attempt <= config.retries.limit; attempt++) {
      try {
        const result = await callback();
        await this.db.prepare('INSERT OR REPLACE INTO agent_steps (run_id, step_name, owner_id, result_json, created_at) VALUES (?, ?, ?, ?, ?)')
          .bind(this.runId, name, this.owner, JSON.stringify(result), new Date().toISOString()).run();
        return result;
      } catch (failure) {
        error = failure;
        // Rate limits are not the task's fault: the producer defers the whole item instead of retrying now.
        if ((failure as { status?: unknown } | null)?.status === 429) throw failure;
      }
    }
    throw error;
  }

  /** The checkpoints are no longer needed once the hour's script is stored. */
  async clear(): Promise<void> {
    await this.db.prepare('DELETE FROM agent_steps WHERE run_id = ?').bind(this.runId).run();
  }
}
