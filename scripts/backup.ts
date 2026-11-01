import 'dotenv/config';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { Pool } from 'pg';
import { encryptDump, IndependentBackupStore } from '../packages/operations/src/backup.ts';
import { requiredSecret } from '../packages/operations/src/config.ts';
import { SupabasePrivateStore, checksum } from '../packages/operations/src/storage.ts';
import type { EncryptedArchiveObject } from '../packages/operations/src/backup.ts';
export async function command(binary: string, args: string[], env: NodeJS.ProcessEnv = process.env) {
  await new Promise<void>((resolve, reject) => {
    // Tools can emit connection strings on failure. Keep diagnostic output off application logs.
    const child = spawn(binary, args, { env, stdio: ['ignore', 'ignore', 'ignore'] });
    child.once('error', () => reject(new Error(`${binary} could not start.`)));
    child.once('exit', code => code === 0 ? resolve() : reject(new Error(`${binary} failed with exit code ${code}.`)));
  });
}
export function libpqEnvironment(connection: string): NodeJS.ProcessEnv {
  const url = new URL(connection);
  return { ...process.env, PGHOST: url.hostname, PGPORT: url.port || '5432', PGUSER: decodeURIComponent(url.username),
    PGPASSWORD: decodeURIComponent(url.password), PGDATABASE: decodeURIComponent(url.pathname.slice(1)),
    PGSSLMODE: url.searchParams.get('sslmode') ?? (['localhost','127.0.0.1'].includes(url.hostname) ? 'prefer' : 'verify-full') };
}
export async function createBackup() {
  const directory = await mkdtemp(join(tmpdir(), 'aq-backup-')), database = requiredSecret('BACKUP_DATABASE_URL');
  const pool = new Pool({ connectionString: database, max: 1 });
  try {
    await pool.query('begin isolation level repeatable read read only');
    const snapshotCreatedAt = new Date().toISOString();
    const schemaMigrations = (await pool.query('select name from public.schema_migrations order by name')).rows.map(r => r.name);
    const pointers = (await pool.query('select object_path,checksum from public.archives where expires_at>now() order by object_path')).rows;
    const snapshot = (await pool.query('select pg_export_snapshot() as snapshot')).rows[0].snapshot;
    // libpq reads the secret from PGDATABASE; it is absent from argv and logs.
    await command('pg_dump', ['--format=custom', '--snapshot', snapshot, '--file', join(directory, 'database.dump')], libpqEnvironment(database));
    const encrypted = await encryptDump(join(directory, 'database.dump'), join(directory, 'database.dump.enc'));
    const id = randomUUID(), independent = new IndependentBackupStore(), archives: EncryptedArchiveObject[] = [];
    await independent.assertRegion();
    const storage = pointers.length ? new SupabasePrivateStore() : undefined;
    for (const [index, pointer] of pointers.entries()) {
      const bytes = await storage!.get(pointer.object_path); if (checksum(bytes) !== pointer.checksum) throw new Error('Source archive checksum mismatch.');
      const source = join(directory, `archive-${index}.json`), destination = `${source}.enc`; await writeFile(source, bytes, { mode: 0o600 });
      const encryptedArchive = await encryptDump(source, destination);
      const entry = { objectPath: pointer.object_path, checksum: pointer.checksum, objectKey: `backups/${id}/${randomUUID()}.json.enc`, ...encryptedArchive };
      await independent.uploadEncryptedFile(destination, entry); archives.push(entry);
      await rm(source); await rm(destination);
    }
    const manifest = { version: 1 as const, id, createdAt: snapshotCreatedAt, region: 'ap-southeast-1' as const, format: 'postgres-custom-aes-256-gcm' as const, objectKey: `backups/${id}.dump.enc`, ...encrypted, schemaMigrations, archives };
    await independent.upload(join(directory, 'database.dump.enc'), manifest);
    await pool.query('commit');
    const report = { version: 1, measuredAt: new Date().toISOString(), backupId: id, checksumVerified: true, encrypted: true, region: manifest.region, bytes: manifest.bytes, archives: archives.length };
    if (process.env.BACKUP_REPORT_PATH) await writeFile(process.env.BACKUP_REPORT_PATH, JSON.stringify(report, null, 2), { mode: 0o600 });
    process.stdout.write(JSON.stringify(report) + '\n');
  } finally { await pool.end(); await rm(directory, { recursive: true, force: true }); }
}
if (process.argv[1]?.endsWith('/backup.ts') || process.argv[1]?.endsWith('/backup.mjs')) createBackup().catch(() => { process.stderr.write('Encrypted backup failed. Inspect infrastructure diagnostics without exposing credentials.\n'); process.exitCode = 1; });
