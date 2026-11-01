import pg from 'pg';
import { drizzle } from 'drizzle-orm/node-postgres';
import { desc } from 'drizzle-orm';
import { readFile, readdir } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { config } from './config.js';
import * as schema from './schema.js';
export type Sql = Pick<Store, 'q'>;
export class Store {
  pool: pg.Pool;
  orm: ReturnType<typeof drizzle<typeof schema>>;
  constructor(url = config.databaseUrl) {
    this.pool = new pg.Pool({ connectionString: url, max: 12 });
    this.orm = drizzle(this.pool, { schema });
  }
  async q<T = any>(sql: string, params: unknown[] = []): Promise<T[]> {
    return (await this.pool.query(sql, params)).rows as T[];
  }
  async tx<T>(fn: (db: Sql) => Promise<T>): Promise<T> {
    const c = await this.pool.connect();
    try {
      await c.query('BEGIN');
      const result = await fn({
        q: async <R = any>(sql: string, p: unknown[] = []) => (await c.query(sql, p)).rows as R[],
      });
      await c.query('COMMIT');
      return result;
    } catch (e) {
      await c.query('ROLLBACK');
      throw e;
    } finally {
      c.release();
    }
  }
  async listGoals() {
    return this.orm.select().from(schema.goals).orderBy(desc(schema.goals.created_at));
  }
  async migrate() {
    const dir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../migrations');
    await this.tx(async (db) => {
      await db.q("SELECT pg_advisory_xact_lock(hashtext('goalloop:migrations'))");
      await db.q(
        'CREATE TABLE IF NOT EXISTS schema_migrations(name text PRIMARY KEY, applied_at timestamptz DEFAULT now())',
      );
      for (const f of (await readdir(dir)).filter((f) => f.endsWith('.sql')).sort()) {
        if (!(await db.q('SELECT name FROM schema_migrations WHERE name=$1', [f])).length) {
          await db.q(await readFile(path.join(dir, f), 'utf8'));
          await db.q('INSERT INTO schema_migrations(name) VALUES($1)', [f]);
        }
      }
    });
  }
  async close() {
    await this.pool.end();
  }
}
export async function event(db: Sql, goalId: string, type: string, data: unknown = {}) {
  await db.q('INSERT INTO events(goal_id,type,data) VALUES($1,$2,$3)', [
    goalId,
    type,
    JSON.stringify(data),
  ]);
}
export async function enqueue(
  db: Sql,
  goalId: string,
  kind: string,
  taskId: string | null = null,
  due = new Date(),
) {
  await db.q(
    `INSERT INTO jobs(id,goal_id,task_id,kind,dedupe,due_at) VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT(dedupe) WHERE status IN ('pending','running') DO NOTHING`,
    [randomUUID(), goalId, taskId, kind, `${goalId}:${kind}:${taskId || ''}`, due],
  );
}
export async function notify(db: Sql, goalId: string, eventKey: string, payload: unknown) {
  await db.q(
    'INSERT INTO outbox(id,goal_id,event_key,payload) VALUES($1,$2,$3,$4) ON CONFLICT(event_key) DO NOTHING',
    [randomUUID(), goalId, eventKey, JSON.stringify(payload)],
  );
}
