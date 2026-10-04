// Test helper: a D1-compatible facade over node:sqlite that applies the real migrations.
import { readdirSync, readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import type { D1Database, D1Statement } from '../server/station-store.ts';

/**
 * [queries] counts every statement the code sends (a batch counts each of its statements), so tests can
 * check that a production stays well inside a Worker invocation's limits.
 */
export function sqliteD1(): D1Database & { raw: DatabaseSync; queries: number } {
  const raw = new DatabaseSync(':memory:');
  for (const file of readdirSync('migrations').filter(name => name.endsWith('.sql')).sort()) {
    raw.exec(readFileSync(`migrations/${file}`, 'utf8'));
  }
  const db = {
    raw,
    queries: 0,
    prepare(sql: string): D1Statement {
      let values: Array<string | number | null> = [];
      const statement: D1Statement = {
        bind: (...args: unknown[]) => { values = args as typeof values; return statement; },
        first: async <T>() => { db.queries++; return (raw.prepare(sql).get(...values) ?? null) as T | null; },
        all: async <T>() => { db.queries++; return { results: raw.prepare(sql).all(...values) as T[] }; },
        run: async () => { db.queries++; return raw.prepare(sql).run(...values); },
      };
      return statement;
    },
    /** Like D1: all statements in one transaction. */
    async batch(statements: D1Statement[]): Promise<unknown[]> {
      raw.exec('BEGIN');
      try {
        const results = [];
        for (const statement of statements) results.push(await statement.run());
        raw.exec('COMMIT');
        return results;
      } catch (error) { raw.exec('ROLLBACK'); throw error; }
    },
  };
  return db;
}
