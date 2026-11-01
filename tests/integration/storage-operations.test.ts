import { randomUUID } from 'node:crypto';
import { Pool, type PoolClient } from 'pg';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { pool, rows, sql, tenant } from '@agent-quality/db';
import { defaultPolicy } from '@agent-quality/contracts';
import { archiveObjectBytes, lockStorageBudget, readStorageUsage, syncRetainedStorage } from '../../packages/storage-budget/src/index.ts';
import { archivePayloadLimitBytes, archiveRun, cleanupObjects, expireRun, maintainWorkspace, restoreRunDetail } from '../../packages/operations/src/retention.ts';
import { applyDeletion, processDeletions } from '../../packages/operations/src/deletion.ts';
import { checksum, type PrivateObjectStore } from '../../packages/operations/src/storage.ts';

for (const variable of ['DATABASE_URL', 'MIGRATION_DATABASE_URL']) {
  const url = new URL(process.env[variable] ?? 'postgresql://invalid/invalid');
  if (url.pathname !== '/aq_storage_ops_test' || !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)) throw new Error('Storage operations tests require local aq_storage_ops_test URLs.');
}
const admin = new Pool({ connectionString: process.env.MIGRATION_DATABASE_URL, max: 3 });
class FixtureStore implements PrivateObjectStore {
  objects = new Map<string, Uint8Array>(); puts = 0; removals = 0; ambiguousPut = false; failRemove = false;
  async put(path: string, bytes: Uint8Array) { this.puts++; this.objects.set(path, Uint8Array.from(bytes)); if (this.ambiguousPut) throw new Error('Fixture ambiguous upload'); }
  async get(path: string) { const bytes = this.objects.get(path); if (!bytes) throw new Error('Fixture missing object'); return bytes; }
  async remove(paths: string[]) { if (this.failRemove) throw new Error('Fixture removal unavailable'); this.removals += paths.length; for (const path of paths) this.objects.delete(path); }
  async signedDownload() { return 'https://private.invalid/fixture'; }
}
let org: string, project: string, user: string, policy: string, store: FixtureStore;
const usage = () => tenant(org, null, tx => readStorageUsage(tx, org));
async function ageRun(id: string, days: number) {
  const client = await admin.connect();
  try { await client.query('begin'); await client.query("set local session_replication_role='replica'"); await client.query('update runs set first_ingested_at=now()-make_interval(days=>$1) where organization_id=$2 and project_id=$3 and id=$4', [days, org, project, id]); await client.query('commit'); }
  catch (error) { await client.query('rollback'); throw error; } finally { client.release(); }
}
async function insertRun(id: string, days = 10) {
  const evaluation = randomUUID();
  await admin.query("insert into runs(organization_id,project_id,id,agent_version,environment,execution_status,started_at,completed_at,last_event_at) values($1,$2,$3,'fixture','test','completed',now(),now(),now())", [org, project, id]);
  await admin.query("insert into event_keys(organization_id,project_id,event_id,run_id,hash) values($1,$2,$3,$4,'fixture')", [org, project, `${id}:event`, id]);
  await admin.query('insert into events(organization_id,project_id,event_id,run_id,event) values($1,$2,$3,$4,$5)', [org, project, `${id}:event`, id, { payload: { text: 'Redacted fixture content' } }]);
  await admin.query("insert into evidence(organization_id,project_id,run_id,body) values($1,$2,$3,$4)", [org, project, id, { status: 'verified fixture' }]);
  await admin.query("insert into evaluations(organization_id,project_id,id,run_id,revision,policy_id,policy_hash,processing,frozen_input,provider_response,assessment,completed_at) values($1,$2,$3,$4,1,$5,'fixture','completed',$6,$7,$8,now())", [org, project, evaluation, id, policy, { id, events: [{ payload: { text: 'Frozen redacted fixture' } }] }, { typed: 'fixture' }, { decision: 'pass' }]);
  await admin.query('update runs set latest_evaluation_id=$1 where organization_id=$2 and project_id=$3 and id=$4', [evaluation, org, project, id]);
  await admin.query("insert into usage_ledger(organization_id,project_id,evaluation_id,state) values($1,$2,$3,'consumed')", [org, project, evaluation]);
  await ageRun(id, days);
  await tenant(org, null, async tx => { await lockStorageBudget(tx, org); await syncRetainedStorage(tx, org, { projectId: project, runId: id }); });
  return evaluation;
}
async function pointer(id: string) { return (await admin.query('select * from archives where organization_id=$1 and project_id=$2 and run_id=$3', [org, project, id])).rows[0]; }
async function until(check: () => Promise<boolean>) { for (let attempt = 0; attempt < 300; attempt++) { if (await check()) return; await new Promise(resolve => setTimeout(resolve, 10)); } throw new Error('Timed out waiting for fixture transaction barrier'); }
async function advisory(id: string) {
  const connection = await pool.connect(), key = `${org}:${project}:${id}`;
  await connection.query('select pg_advisory_lock(hashtextextended($1,0))', [key]);
  return async () => { await connection.query('select pg_advisory_unlock(hashtextextended($1,0))', [key]); connection.release(); };
}
async function holdBudget(): Promise<PoolClient> { const connection = await pool.connect(); await connection.query('begin'); await connection.query("select set_config('app.org_id',$1,true)", [org]); await connection.query('select organization_id from storage_budgets where organization_id=$1 for update', [org]); return connection; }
const budgetBlocked = async () => Boolean((await admin.query("select 1 from pg_stat_activity where datname='aq_storage_ops_test' and wait_event_type='Lock' and query like '%storage_budgets%' limit 1")).rowCount);
beforeEach(async () => {
  org = randomUUID(); project = randomUUID(); user = randomUUID(); policy = randomUUID(); store = new FixtureStore();
  await admin.query("insert into users(id,email,name) values($1,$2,'Storage operations fixture')", [user, `${user}@example.test`]);
  await admin.query("insert into organizations(id,name) values($1,'Storage operations fixture')", [org]);
  await admin.query('insert into subscriptions(organization_id) values($1)', [org]);
  await admin.query("insert into memberships values($1,$2,'owner')", [org, user]);
  await admin.query("insert into projects(organization_id,id,name) values($1,$2,'Storage operations fixture')", [org, project]);
  await admin.query("insert into policies(organization_id,project_id,id,version,definition,hash) values($1,$2,$3,1,$4,'fixture')", [org, project, policy, defaultPolicy]);
});
afterEach(async () => {
  vi.unstubAllEnvs();
  await admin.query('update runs set latest_evaluation_id=null where organization_id=$1', [org]);
  await admin.query('delete from evaluations where organization_id=$1', [org]);
  await admin.query('delete from experiments where organization_id=$1', [org]);
  await admin.query('delete from operations_object_cleanup where organization_id=$1', [org]);
  await admin.query('delete from organizations where id=$1', [org]);
  await admin.query('delete from users where id=$1', [user]);
});
afterAll(async () => { await pool.end(); await admin.end(); });

describe('storage accounting across operations', () => {
  it('commits a measured archive and restores hot detail while retaining object bytes until cleanup', async () => {
    await insertRun('archive-restore');
    expect(await archiveRun(org, project, 'archive-restore', store)).toBe(true);
    const archived = await pointer('archive-restore');
    expect((await usage()).categories.archive_objects.bytes).toBe(archiveObjectBytes(Number(archived.bytes)));
    expect((await admin.query('select * from operations_object_cleanup where organization_id=$1', [org])).rows).toHaveLength(0);
    const holder = await holdBudget();
    const restoring = tenant(org, null, tx => restoreRunDetail(tx, org, project, 'archive-restore', store));
    try {
      await until(budgetBlocked);
      await tenant(org, null, tx => tx.execute(sql`select id from runs where organization_id=${org} and project_id=${project} and id='archive-restore' for update nowait`));
    } finally { await holder.query('commit'); holder.release(); }
    expect(await restoring).toBe(true);
    const restored = await usage();
    expect(restored.categories.events.bytes).toBeGreaterThan(0);
    expect(restored.categories.archive_objects.bytes).toBe(archiveObjectBytes(Number(archived.bytes)));
    expect(await cleanupObjects(org, store, true)).toBe(1);
    expect((await usage()).categories.archive_objects.bytes).toBe(0);
    expect((await usage()).categories.cleanup_records.bytes).toBe(0);
  });
  it('keeps an independent maximum charge and outbox for ambiguous uploads and failed cleanup', async () => {
    await insertRun('ambiguous'); store.ambiguousPut = true;
    await expect(archiveRun(org, project, 'ambiguous', store)).rejects.toThrow('ambiguous');
    const failed = await usage();
    expect(failed.categories.archive_objects.bytes).toBe(archiveObjectBytes(archivePayloadLimitBytes));
    expect(failed.unmeasuredObjects).toBe(0);
    expect(failed.categories.events.bytes).toBeGreaterThan(0);
    expect(await pointer('ambiguous')).toBeUndefined();
    store.failRemove = true;
    await expect(cleanupObjects(org, store, true)).rejects.toThrow('removal unavailable');
    expect((await usage()).categories.archive_objects.bytes).toBe(archiveObjectBytes(archivePayloadLimitBytes));
    expect((await admin.query('select * from operations_object_cleanup where organization_id=$1', [org])).rows).toHaveLength(1);
    store.failRemove = false;
    expect(await cleanupObjects(org, store, true)).toBe(1);
    expect((await usage()).categories.archive_objects.bytes).toBe(0);
  });
  it('refuses a maximum reservation before upload when storage is exhausted', async () => {
    await insertRun('quota'); vi.stubEnv('STORAGE_TRIAL_BYTES', String(1024 * 1024));
    await expect(archiveRun(org, project, 'quota', store)).rejects.toMatchObject({ code: 'storage_limit_exceeded' });
    expect(store.puts).toBe(0);
    expect((await admin.query('select * from operations_object_cleanup where organization_id=$1', [org])).rows).toHaveLength(0);
    expect((await usage()).categories.archive_objects.bytes).toBe(0);
  });
  it('releases known-unwritten reservations for skipped and oversized archives', async () => {
    expect(await archiveRun(org, project, 'absent', store)).toBe(false);
    expect((await usage()).categories.archive_objects.bytes).toBe(0);
    const evaluation = await insertRun('oversized'), review = randomUUID();
    await admin.query("insert into reviews(organization_id,project_id,id,evaluation_id,run_id,annotation) values($1,$2,$3,$4,'oversized',$5)", [org, project, review, evaluation, 'x'.repeat(archivePayloadLimitBytes + 1)]);
    await expect(archiveRun(org, project, 'oversized', store)).rejects.toThrow('16 MiB');
    expect(store.puts).toBe(0);
    expect((await usage()).categories.archive_objects.bytes).toBe(0);
    expect((await admin.query('select * from operations_object_cleanup where organization_id=$1', [org])).rows).toHaveLength(0);
  });
  it('does not upload after cleanup retired a reservation while waiting for a session lock', async () => {
    await insertRun('waiting'); const unlock = await advisory('waiting');
    const archiving = archiveRun(org, project, 'waiting', store);
    try {
      await until(async () => Boolean((await admin.query('select 1 from operations_object_cleanup where organization_id=$1', [org])).rowCount));
      expect(await cleanupObjects(org, store, true)).toBe(1);
    } finally { await unlock(); }
    await expect(archiving).rejects.toMatchObject({ code: 'object_reservation_expired' });
    expect(store.puts).toBe(0);
    expect((await usage()).categories.archive_objects.bytes).toBe(0);
  });
  it('rejects a checksum-valid archive belonging to another run instance before restoration', async () => {
    await insertRun('instance'); await archiveRun(org, project, 'instance', store);
    const archived = await pointer('instance'), document = JSON.parse(Buffer.from(await store.get(archived.object_path)).toString());
    document.run.instance_id = randomUUID(); const changed = Buffer.from(JSON.stringify(document)); store.objects.set(archived.object_path, changed);
    await admin.query('update archives set checksum=$1,bytes=$2 where organization_id=$3 and id=$4', [checksum(changed), changed.length, org, archived.id]);
    await expect(tenant(org, null, tx => restoreRunDetail(tx, org, project, 'instance', store))).rejects.toThrow('instance');
    expect((await admin.query("select * from events where organization_id=$1 and run_id='instance'", [org])).rows).toHaveLength(0);
    expect((await admin.query("select content_archived_at from runs where organization_id=$1 and id='instance'", [org])).rows[0].content_archived_at).not.toBeNull();
  });
  it('preserves curated copies on TTL, erases them explicitly, and retains content-free quota', async () => {
    const evaluation = await insertRun('ttl'); await archiveRun(org, project, 'ttl', store); await ageRun('ttl', 31);
    const dataset = randomUUID();
    await admin.query("insert into datasets(organization_id,project_id,id,name,kind,cases,hash) values($1,$2,$3,'Curated TTL fixture','agent_regression',$4,'fixture')", [org, project, dataset, JSON.stringify([{ source: { runId: 'ttl' }, frozenInput: { id: 'ttl', text: 'Curated fixture' } }])]);
    await admin.query("insert into experiments(organization_id,project_id,name,dataset_id,policy_id,candidates) values($1,$2,'Curated experiment',$3,$4,'[]'::jsonb)", [org, project, dataset, policy]);
    await tenant(org, null, tx => syncRetainedStorage(tx, org, { projectId: project }));
    expect(await expireRun(org, project, 'ttl')).toBe(true);
    expect((await usage()).categories.datasets.bytes).toBeGreaterThan(0);
    expect((await usage()).categories.archive_objects.bytes).toBeGreaterThan(0);
    await tenant(org, null, tx => applyDeletion(org, project, 'run', 'ttl', tx));
    expect((await usage()).categories.datasets.bytes).toBe(0);
    expect((await usage()).categories.experiments.bytes).toBe(0);
    expect((await admin.query('select * from usage_ledger where organization_id=$1 and evaluation_id=$2', [org, evaluation])).rows).toHaveLength(1);
    await cleanupObjects(org, store, true);
    expect((await usage()).categories.archive_objects.bytes).toBe(0);
  });
  it('rolls project deletion back instead of waiting on an active evaluator', async () => {
    await insertRun('worker'); const unlock = await advisory('worker');
    try { await expect(tenant(org, null, tx => applyDeletion(org, project, 'project', project, tx))).rejects.toMatchObject({ code: 'deletion_busy' }); }
    finally { await unlock(); }
    expect((await admin.query('select * from projects where organization_id=$1 and id=$2', [org, project])).rows).toHaveLength(1);
    await tenant(org, null, tx => applyDeletion(org, project, 'project', project, tx));
    expect((await usage()).categories.events.bytes).toBe(0);
    expect((await admin.query('select * from usage_ledger where organization_id=$1', [org])).rows).toHaveLength(1);
  });
  it('leaves a busy queued deletion pending and completes it after the evaluator releases its lock', async () => {
    await insertRun('queued-worker'); const deletion = randomUUID(), unlock = await advisory('queued-worker');
    try {
      await admin.query("insert into operations_deletions(organization_id,id,kind,project_id,target_id,journal_checksum) values($1,$2,'project',$3,$4,'fixture')", [org, deletion, project, project]);
      expect(await processDeletions(org)).toBe(0);
    }
    finally { await unlock(); }
    expect((await admin.query('select state from operations_deletions where organization_id=$1 and id=$2', [org, deletion])).rows[0].state).toBe('pending');
    expect(await processDeletions(org)).toBe(1);
    expect((await admin.query('select state,target_id from operations_deletions where organization_id=$1 and id=$2', [org, deletion])).rows[0]).toEqual({ state: 'complete', target_id: '[deleted]' });
  });
  it('preserves the entire workspace while one of its runs has an active evaluator', async () => {
    await insertRun('workspace-worker'); const unlock = await advisory('workspace-worker');
    try { await expect(tenant(org, null, tx => applyDeletion(org, null, 'workspace', org, tx))).rejects.toMatchObject({ code: 'deletion_busy' }); }
    finally { await unlock(); }
    expect((await admin.query('select * from organizations where id=$1', [org])).rows).toHaveLength(1);
    expect((await admin.query('select * from usage_ledger where organization_id=$1', [org])).rows).toHaveLength(1);
  });
  it('rechecks runs admitted while project deletion waits for the budget', async () => {
    await insertRun('before'); const holder = await holdBudget();
    const deleting = tenant(org, null, tx => applyDeletion(org, project, 'project', project, tx));
    let unlock: (() => Promise<void>) | undefined;
    try {
      await until(budgetBlocked);
      await holder.query("insert into runs(organization_id,project_id,id,agent_version,environment,started_at,last_event_at) values($1,$2,'newly-admitted','fixture','test',now(),now())", [org, project]);
      unlock = await advisory('newly-admitted');
    } finally { await holder.query('commit'); holder.release(); }
    try { await expect(deleting).rejects.toMatchObject({ code: 'deletion_busy' }); } finally { await unlock?.(); }
    expect((await admin.query('select * from runs where organization_id=$1', [org])).rows).toHaveLength(2);
  });
  it('cleans objects after workspace erasure without recreating an organization budget', async () => {
    await insertRun('workspace'); await archiveRun(org, project, 'workspace', store);
    await tenant(org, null, tx => applyDeletion(org, null, 'workspace', org, tx));
    expect((await admin.query('select * from storage_budgets where organization_id=$1', [org])).rows).toHaveLength(0);
    expect(await cleanupObjects(org, store, true)).toBe(1);
    expect(store.objects.size).toBe(0);
    expect((await admin.query('select * from storage_budgets where organization_id=$1', [org])).rows).toHaveLength(0);
    expect((await admin.query('select * from operations_object_cleanup where organization_id=$1', [org])).rows).toHaveLength(0);
  });
  it('does not purge an object still referenced by an active pointer', async () => {
    await insertRun('active'); await archiveRun(org, project, 'active', store); const archived = await pointer('active');
    await admin.query('insert into operations_object_cleanup(organization_id,object_path) values($1,$2)', [org, archived.object_path]);
    expect(await cleanupObjects(org, store, true)).toBe(0);
    expect(store.objects.has(archived.object_path)).toBe(true);
    expect((await usage()).categories.archive_objects.bytes).toBe(archiveObjectBytes(Number(archived.bytes)));
  });
  it('reaches cleanup under storage pressure instead of getting stuck behind another maximum reservation', async () => {
    await insertRun('pressure');
    await admin.query("update runs set last_event_at=now()-interval '2 days' where organization_id=$1 and id='pressure'", [org]);
    store.ambiguousPut = true;
    await expect(archiveRun(org, project, 'pressure', store)).rejects.toThrow('ambiguous');
    store.ambiguousPut = false;
    await admin.query("update operations_object_cleanup set not_before=now()-interval '1 minute' where organization_id=$1", [org]);
    vi.stubEnv('STORAGE_TRIAL_BYTES', String(1024 * 1024));
    expect(await maintainWorkspace(org, store)).toMatchObject({ archived: 0, deleted: 1 });
    expect((await usage()).categories.archive_objects.bytes).toBe(0);
    expect((await usage()).categories.events.bytes).toBeGreaterThan(0);
  });
  it('exports immutable evaluation-attempt history while leaving the database history intact', async () => {
    const evaluation = await insertRun('attempt-history');
    await admin.query("insert into evaluation_attempts(organization_id,project_id,evaluation_id,attempt_number,reason,processing,assessment,frozen_input_hash,policy_hash,completed_at) values($1,$2,$3,1,'quota_denied','error',$4,$5,'fixture',now())", [org, project, evaluation, { decision: 'unknown', limitations: ['Quota denied fixture'] }, checksum('frozen fixture')]);
    expect(await archiveRun(org, project, 'attempt-history', store)).toBe(true);
    const archived = await pointer('attempt-history');
    const document = JSON.parse(Buffer.from(await store.get(archived.object_path)).toString());
    expect(document.evaluationAttempts).toHaveLength(1);
    expect(document.evaluationAttempts[0]).toMatchObject({ evaluation_id: evaluation, attempt_number: 1, reason: 'quota_denied' });
    expect((await admin.query('select * from evaluation_attempts where organization_id=$1 and evaluation_id=$2', [org, evaluation])).rows).toHaveLength(1);
  });
});
