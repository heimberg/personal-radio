/** Daily limits per owner, each reserved with one atomic D1 statement. */
import { PipelineError, type CharacterBudgetStore } from './segment-pipeline.ts';
import type { D1Database } from './station-store.ts';
import type { DailyCounter } from './http.ts';

export class D1CharacterBudget implements CharacterBudgetStore {
  private db: D1Database;
  private dailyLimit: number;
  constructor(db: D1Database, dailyLimit: number) { this.db = db; this.dailyLimit = dailyLimit; }
  async reserve(ownerId: string, characters: number) {
    const day = new Date().toISOString().slice(0, 10);
    // A single conditional UPSERT is atomic across concurrent Worker instances.
    const result = await this.db.prepare(`INSERT INTO daily_usage (owner_id, utc_day, characters)
      VALUES (?, ?, ?) ON CONFLICT(owner_id, utc_day) DO UPDATE
      SET characters = daily_usage.characters + excluded.characters
      WHERE daily_usage.characters + excluded.characters <= ? RETURNING characters`)
      .bind(ownerId, day, characters, this.dailyLimit).first<{ characters: number }>();
    if (!result) throw new PipelineError('BUDGET_EXCEEDED');
  }
}

export class D1DailyCounter implements DailyCounter {
  private db: D1Database;
  constructor(db: D1Database) { this.db = db; }
  async reserve(ownerId: string, limit: number) {
    const day = new Date().toISOString().slice(0, 10);
    const result = await this.db.prepare(`INSERT INTO daily_requests (owner_id, utc_day, requests)
      VALUES (?, ?, 1) ON CONFLICT(owner_id, utc_day) DO UPDATE
      SET requests = daily_requests.requests + 1
      WHERE daily_requests.requests < ? RETURNING requests`)
      .bind(ownerId, day, limit).first<{ requests: number }>();
    if (!result) throw new PipelineError('BUDGET_EXCEEDED');
  }
}

export class D1FeedCounter implements DailyCounter {
  private db: D1Database;
  constructor(db: D1Database) { this.db = db; }
  async reserve(ownerId: string, limit: number) {
    const day = new Date().toISOString().slice(0, 10);
    const result = await this.db.prepare(`INSERT INTO daily_feed_requests (owner_id, utc_day, requests)
      VALUES (?, ?, 1) ON CONFLICT(owner_id, utc_day) DO UPDATE
      SET requests = daily_feed_requests.requests + 1
      WHERE daily_feed_requests.requests < ? RETURNING requests`)
      .bind(ownerId, day, limit).first<{ requests: number }>();
    if (!result) throw new PipelineError('BUDGET_EXCEEDED');
  }
}

export class D1LinkerCounter implements DailyCounter {
  private db: D1Database;
  constructor(db: D1Database) { this.db = db; }
  async reserve(ownerId: string, limit: number) {
    const day = new Date().toISOString().slice(0, 10);
    const result = await this.db.prepare(`INSERT INTO daily_linker_requests (owner_id, utc_day, requests)
      VALUES (?, ?, 1) ON CONFLICT(owner_id, utc_day) DO UPDATE
      SET requests = daily_linker_requests.requests + 1
      WHERE daily_linker_requests.requests < ? RETURNING requests`)
      .bind(ownerId, day, limit).first<{ requests: number }>();
    if (!result) throw new PipelineError('BUDGET_EXCEEDED');
  }
}
