import 'dotenv/config';
import { Pool } from 'pg';
import { readdir, readFile } from 'node:fs/promises';
import { PgBoss } from 'pg-boss';
import { config } from './config.ts';
const migrationUrl = process.env.MIGRATION_DATABASE_URL;
if(!migrationUrl) throw new Error('Set MIGRATION_DATABASE_URL to a migration-only credential');
const admin = new Pool({ connectionString: migrationUrl, max:1 });
const connection = await admin.connect();
try {
  await connection.query('select pg_advisory_lock(103242100)');
  await connection.query('create table if not exists public.schema_migrations (name text primary key, applied_at timestamptz not null default now())');
  for (const name of (await readdir(new URL('../migrations/', import.meta.url))).filter(n=>n.endsWith('.sql')).sort()) {
    if ((await connection.query('select 1 from public.schema_migrations where name=$1', [name])).rowCount) continue;
    await connection.query('begin');
    try {
      await connection.query(await readFile(new URL(`../migrations/${name}`,import.meta.url),'utf8'));
      await connection.query('insert into public.schema_migrations(name) values ($1)', [name]);
      await connection.query('commit');
      console.log(`Applied ${name}`);
    } catch(error) { await connection.query('rollback'); throw error; }
  }
} finally { await connection.query('select pg_advisory_unlock(103242100)'); connection.release(); await admin.end(); }
const boss=new PgBoss({connectionString:config.DATABASE_URL,schema:'pgboss',createSchema:false});
boss.on('error',()=>process.stderr.write('Queue migration error\n'));
try{await boss.start();console.log('Durable queue schema ready');}finally{await boss.stop();}
