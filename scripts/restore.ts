import 'dotenv/config';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Pool } from 'pg';
import { pathToFileURL } from 'node:url';
import { IndependentBackupStore, decryptDump, readBackupManifest } from '../packages/operations/src/backup.ts';
import { S3DeletionSink, deletionRecordSchema } from '../packages/operations/src/journal.ts';
import { reapplyDeletionJournal } from '../packages/operations/src/deletion.ts';
import { SupabasePrivateStore } from '../packages/operations/src/storage.ts';
import { requiredSecret } from '../packages/operations/src/config.ts';
import { readFile } from 'node:fs/promises';
import { command, libpqEnvironment } from './backup.ts';
import { expireRun } from '../packages/operations/src/retention.ts';
import { tenant, sql } from '@agent-quality/db';

export function validateRestoreTarget(target: string, application: string | undefined, confirmation: string | undefined) {
  const url = new URL(target), name = decodeURIComponent(url.pathname.slice(1));
  if (!/^aq_restore_[a-z0-9_]+$/.test(name) || confirmation !== name || !application || target === application || new URL(application).pathname === url.pathname)
    throw new Error('Restore requires a distinct empty aq_restore_* database and matching RESTORE_CONFIRM_DATABASE.');
  if (url.searchParams.get('sslmode') === 'disable' && !['localhost','127.0.0.1','[::1]'].includes(url.hostname)) throw new Error('Remote restore requires TLS.');
  return name;
}
export async function restoreBackup() {
  const started = Date.now(), target = requiredSecret('RESTORE_DATABASE_URL');
  const name = validateRestoreTarget(target, process.env.SOURCE_DATABASE_URL ?? process.env.DATABASE_URL, process.env.RESTORE_CONFIRM_DATABASE);
  // tenant() uses the non-BYPASSRLS application role, never the restore administrator.
  const applicationTarget = new URL(requiredSecret('DATABASE_URL')), adminTarget = new URL(target);
  if (applicationTarget.pathname !== adminTarget.pathname || applicationTarget.hostname !== adminTarget.hostname || applicationTarget.port !== adminTarget.port)
    throw new Error('DATABASE_URL must select the isolated restore target using the application role. Supply SOURCE_DATABASE_URL separately.');
  const directory = await mkdtemp(join(tmpdir(), 'aq-restore-')), admin = new Pool({ connectionString: target, max: 1 });
  try {
    const tables = (await admin.query("select count(*)::int as count from pg_tables where schemaname not in ('pg_catalog','information_schema')")).rows[0].count;
    if (tables !== 0) throw new Error('Restore target is not empty. No existing database will be overwritten.');
    let path: string, manifest;
    if (process.env.RESTORE_LOCAL_DUMP && process.env.RESTORE_LOCAL_MANIFEST && process.env.NODE_ENV === 'test') {
      path = process.env.RESTORE_LOCAL_DUMP; manifest = await readBackupManifest(process.env.RESTORE_LOCAL_MANIFEST);
    } else ({ path, manifest } = await new IndependentBackupStore().download(requiredSecret('RESTORE_MANIFEST_KEY'), directory));
    await decryptDump(path, join(directory, 'database.dump'), manifest);
    // Ownership and ACLs are part of recovery. Provision the original roles first; never make aq_app a table owner/superuser.
    await command('pg_restore', ['--exit-on-error','--dbname',name,join(directory,'database.dump')], libpqEnvironment(target));
    const restoredMigrations = (await admin.query('select name from public.schema_migrations order by name')).rows.map(r => r.name);
    if (JSON.stringify(restoredMigrations) !== JSON.stringify(manifest.schemaMigrations)) throw new Error('Restored migration manifest does not match.');
    const { assertApplicationRole } = await import('@agent-quality/db'); await assertApplicationRole();
    const records = process.env.RESTORE_LOCAL_JOURNAL && process.env.NODE_ENV === 'test'
      ? JSON.parse(await readFile(process.env.RESTORE_LOCAL_JOURNAL, 'utf8')).map((r: unknown) => deletionRecordSchema.parse(r))
      : await new S3DeletionSink().readAll();
    const storage = process.env.SUPABASE_SERVICE_ROLE_KEY ? new SupabasePrivateStore() : undefined;
    const deletion = await reapplyDeletionJournal(records, storage);
    // A seven-day-old backup cannot extend the thirty-day detailed retention clock.
    const expired = (await admin.query('select r.organization_id,r.project_id,r.id from runs r join organizations o on o.id=r.organization_id where r.first_ingested_at<now()-make_interval(days=>o.retention_days)')).rows;
    for (const run of expired) await expireRun(run.organization_id, run.project_id, run.id);
    for (const { organization_id: org } of (await admin.query('select distinct organization_id from archives where expires_at<=now()')).rows) await tenant(org, null, async tx => {
      await tx.execute(sql`insert into operations_object_cleanup(organization_id,object_path) select organization_id,object_path from archives where expires_at<=now()`);
      await tx.execute(sql`delete from archives where expires_at<=now()`);
    });
    const { cleanupObjects } = await import('../packages/operations/src/retention.ts');
    if (storage) for (const { organization_id: org } of (await admin.query('select distinct organization_id from operations_object_cleanup')).rows) await cleanupObjects(org, storage, true);
    const live = (await admin.query('select object_path,checksum from archives')).rows;
    if (live.length && !storage) throw new Error('Live archived content requires configured private storage recovery.');
    let archivesRestored = 0;
    if (storage) archivesRestored = await new IndependentBackupStore().recoverArchives(manifest, directory, storage, new Set(live.map(r => r.object_path)));
    for (const pointer of live) if (!manifest.archives.some(a => a.objectPath === pointer.object_path && a.checksum === pointer.checksum)) throw new Error('Database archive pointer has no matching independent backup object.');
    const orphan = (await admin.query('select count(*)::int as count from operations_object_cleanup')).rows[0].count;
    if (orphan > 0) throw new Error('Object erasure remains pending; keep restored services offline.');
    const elapsedMs = Date.now() - started;
    const backupAgeMs = Date.now() - Date.parse(manifest.createdAt);
    const report = { version: 1, measuredAt: new Date().toISOString(), target: name, backupId: manifest.id, checksumVerified: true, authenticatedDecryption: true, deletionJournalReapplied: true, ...deletion, archivesRestored, restoreMs: elapsedMs, backupAgeMs, rpoTargetMs: 21600000, rtoTargetMs: 14400000, passed: elapsedMs <= 14400000 && backupAgeMs <= 21600000, source: process.env.NODE_ENV === 'test' ? 'disposable-local' : 'independent-singapore-backup', serviceRecoveryVerified: false };
    await writeFile(requiredSecret('RESTORE_REPORT_PATH'), JSON.stringify(report, null, 2), { mode: 0o600 });
    process.stdout.write(JSON.stringify(report) + '\n'); if (!report.passed) process.exitCode = 1;
  } finally { await admin.end(); const { pool } = await import('@agent-quality/db'); await pool.end(); await rm(directory, { recursive: true, force: true }); }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) restoreBackup().catch(() => { process.stderr.write('Restore validation failed. Target stays isolated; do not enable traffic.\n'); process.exitCode = 1; });
