import { Pool } from 'pg';
import { drizzle } from 'drizzle-orm/node-postgres';
import { sql } from 'drizzle-orm';
import { config } from './config.ts';
export const pool = new Pool({ connectionString: config.DATABASE_URL, max: 12, connectionTimeoutMillis: 5000, idleTimeoutMillis: 30000 });
pool.on('error', () => process.stderr.write('Database pool connection failed\n'));
export const db = drizzle(pool);
export async function assertApplicationRole() {
  const {rows}=await pool.query('select rolsuper,rolbypassrls from pg_roles where rolname=current_user');
  if(rows[0]?.rolsuper || rows[0]?.rolbypassrls) throw new Error('Application credentials must not bypass row-level security');
}
export type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];
export async function tenant<T>(organizationId: string, userId: string | null, work: (tx: Tx) => Promise<T>): Promise<T> {
  return db.transaction(async tx => {
    await tx.execute(sql`select set_config('app.org_id', ${organizationId}, true), set_config('app.user_id', ${userId ?? ''}, true)`);
    return work(tx);
  });
}
export async function rows<T = Record<string, any>>(tx: Tx, query: ReturnType<typeof sql>): Promise<T[]> { return (await tx.execute(query)).rows as T[]; }
export { sql };
