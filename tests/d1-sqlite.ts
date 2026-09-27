// Test helper: a D1-compatible facade over node:sqlite that applies the real migrations.
import { readdirSync, readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import type { D1Database, D1Statement } from '../server/station-store.ts';

export function sqliteD1(): D1Database & { raw: DatabaseSync } {
  const raw = new DatabaseSync(':memory:');
  for (const file of readdirSync('migrations').filter(name => name.endsWith('.sql')).sort()) {
    raw.exec(readFileSync(`migrations/${file}`, 'utf8'));
  }
  return {
    raw,
    prepare(sql: string): D1Statement {
      let values: Array<string | number | null> = [];
      const statement: D1Statement = {
        bind: (...args: unknown[]) => { values = args as typeof values; return statement; },
        first: async <T>() => (raw.prepare(sql).get(...values) ?? null) as T | null,
        all: async <T>() => ({ results: raw.prepare(sql).all(...values) as T[] }),
        run: async () => raw.prepare(sql).run(...values),
      };
      return statement;
    },
  };
}
