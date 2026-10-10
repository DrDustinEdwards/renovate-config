/** The parts of a D1 binding `resetDb` uses. A `D1Database` fits. */
export type D1Like = {
  prepare(sql: string): { all(): Promise<{ results: unknown[] }> };
  batch(statements: any[]): Promise<unknown>;
};

/**
 * Deletes every row of every table in `sqlite_master`, in one batch, and returns the tables it cleared. SQLite's own
 * tables, D1's `_cf_` tables and `d1_migrations` are never cleared; a virtual table is cleared through itself and its
 * shadow tables are left to it; foreign keys are checked at commit. `keep` names tables to leave as they are.
 */
export function resetDb(db: D1Like, options?: { keep?: readonly string[] }): Promise<string[]>;
