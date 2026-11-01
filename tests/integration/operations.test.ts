import { beforeAll, afterAll, describe, it, expect } from 'vitest';
import Fastify from 'fastify';
import cookie from '@fastify/cookie';
import { SignJWT } from 'jose';
import { randomUUID } from 'node:crypto';
import { tenant, rows, sql, pool, assertApplicationRole } from '@agent-quality/db';
import { config } from '../../packages/db/src/config.ts';
import { defaultPolicy } from '@agent-quality/contracts';
import { operationsRoutes, loadRunContent } from '../../apps/api/src/operations.ts';
import { archiveRun, expireRun, cleanupObjects, restoreRunDetail } from '../../packages/operations/src/retention.ts';
import { requestDeletion, processDeletions, reapplyDeletionJournal, applyDeletion, assertRunWritable } from '../../packages/operations/src/deletion.ts';
import { checksum, type PrivateObjectStore } from '../../packages/operations/src/storage.ts';
import { makeDeletionRecord, type DeletionRecord, type DeletionSink } from '../../packages/operations/src/journal.ts';
import { ApiError } from '../../apps/api/src/errors.ts';
import { Pool } from 'pg';

const database = new URL(process.env.DATABASE_URL ?? '').pathname.slice(1);
if (database !== 'aq_operations_test') throw new Error('Operations integration tests require the isolated aq_operations_test database.');
const adminUrl = new URL(process.env.MIGRATION_DATABASE_URL ?? 'postgresql://postgres:local_postgres_password@localhost:55432/aq_operations_test');
if (adminUrl.pathname !== '/aq_operations_test' || !['localhost','127.0.0.1','[::1]'].includes(adminUrl.hostname)) throw new Error('Retention fixtures require a local aq_operations_test administrator.');
const fixtureAdmin = new Pool({ connectionString: adminUrl.toString(), max: 1 });
process.env.DELETION_JOURNAL_HMAC_KEY = 'operations-test-key-only-at-least-32-characters';
const user = randomUUID(), project = randomUUID(), otherUser = randomUUID(); let org: string, otherOrg: string, token: string, policy: string;
const objects = new Map<string, Uint8Array>(); let corrupt = false;
const store: PrivateObjectStore = {
  put: async (path, bytes) => { objects.set(path, Uint8Array.from(bytes)); },
  get: async path => { if (corrupt) return Buffer.from('corrupt'); const b = objects.get(path); if (!b) throw new Error('Missing object'); return b; },
  remove: async paths => { for (const p of paths) objects.delete(p); },
  signedDownload: async (path, seconds) => `https://private.invalid/${path}?ttl=${seconds}`,
};
const records: DeletionRecord[] = [], sink: DeletionSink = { append: async record => { records.push(record); return checksum(JSON.stringify(record)); }, readAll: async () => records };
const app = Fastify(); app.setErrorHandler((error, _request, reply) => reply.code(error instanceof ApiError ? error.status : 500).send({ error: 'request_failed' }));
await app.register(cookie); await operationsRoutes(app, { store, deletionSink: sink });
async function insertRun(id: string, days = 10) {
  const evaluationId = await tenant(org, user, async tx => {
    await tx.execute(sql`insert into runs(organization_id,project_id,id,agent_version,environment,execution_status,started_at,completed_at,last_event_at) values(${org},${project},${id},'v1','test','completed',now()-make_interval(days=>${days}),now()-make_interval(days=>${days}),now())`);
    await tx.execute(sql`insert into events(organization_id,project_id,event_id,run_id,event) values(${org},${project},${`${id}-event`},${id},'{}'::jsonb)`);
    const [e] = await rows<any>(tx, sql`insert into evaluations(organization_id,project_id,run_id,revision,policy_id,policy_hash,processing,frozen_input,assessment,provider_response,completed_at) values(${org},${project},${id},1,${policy},${checksum('policy')},'completed','{"secret":"synthetic-frozen-input"}'::jsonb,'{"decision":"pass"}'::jsonb,'{"result":"synthetic-provider"}'::jsonb,now()) returning id`);
    await tx.execute(sql`update runs set latest_evaluation_id=${e.id} where project_id=${project} and id=${id}`);
    await tx.execute(sql`insert into usage_ledger(organization_id,project_id,evaluation_id,state) values(${org},${project},${e.id},'consumed')`);
    return e.id;
  });
  // Only a disposable-test administrator can age the immutable server clock.
  if (days > 0) {
    const client = await fixtureAdmin.connect();
    try {
      await client.query('begin'); await client.query("set local session_replication_role='replica'");
      await client.query('update runs set first_ingested_at=now()-make_interval(days=>$1) where organization_id=$2 and project_id=$3 and id=$4', [days,org,project,id]);
      await client.query('commit');
    } catch (error) { await client.query('rollback'); throw error; } finally { client.release(); }
  }
  return evaluationId;
}
beforeAll(async () => {
  await assertApplicationRole();
  for (const u of [user, otherUser]) await tenant('', u, tx => tx.execute(sql`select provision_user(${u},${`${u}@example.test`},'Operations fixture')`));
  org = (await tenant('', user, tx => rows<any>(tx, sql`select create_workspace(${user},'Operations fixture') as id`)))[0].id;
  otherOrg = (await tenant('', otherUser, tx => rows<any>(tx, sql`select create_workspace(${otherUser},'Isolated fixture') as id`)))[0].id;
  await tenant(org, user, async tx => {
    await tx.execute(sql`insert into projects(organization_id,id,name) values(${org},${project},'Operations fixture')`);
    const [p] = await rows<any>(tx, sql`insert into policies(organization_id,project_id,version,definition,hash) values(${org},${project},1,${JSON.stringify(defaultPolicy)}::jsonb,${checksum('policy')}) returning id`); policy = p.id;
  });
  token = await new SignJWT({}).setProtectedHeader({ alg: 'HS256' }).setSubject(user).setIssuer('agent-quality-local').setAudience('agent-quality').setExpirationTime('1h').sign(new TextEncoder().encode(config.SESSION_SECRET));
});
afterAll(async () => {
  for (const id of [org, otherOrg]) if (id) await tenant(id, null, tx => applyDeletion(id, null, 'workspace', id, tx));
  await app.close(); await pool.end(); await fixtureAdmin.end();
});
describe('isolated operations transactions', () => {
  it('retains all database detail when object verification fails', async () => {
    await insertRun('archive-failure'); corrupt = true;
    await expect(archiveRun(org, project, 'archive-failure', store)).rejects.toThrow('checksum'); corrupt = false;
    const record = await tenant(org, null, tx => rows<any>(tx, sql`select content_archived_at,(select count(*) from events where run_id='archive-failure')::int as events from runs where id='archive-failure'`));
    expect(record[0]).toEqual({ content_archived_at: null, events: 1 });
  });
  it('commits a verified pointer and clears payloads atomically, then reads the archive', async () => {
    await insertRun('archive-success'); expect(await archiveRun(org, project, 'archive-success', store)).toBe(true);
    const document = await tenant(org, null, tx => loadRunContent(tx, project, 'archive-success', store));
    expect(document.events).toHaveLength(1); expect(document.evaluations[0].frozen_input.secret).toBe('synthetic-frozen-input');
    const [state] = await tenant(org, null, tx => rows<any>(tx, sql`select (select count(*) from events where run_id='archive-success')::int as events,(select count(*) from archives where run_id='archive-success')::int as archives,(select frozen_input from evaluations where run_id='archive-success') as frozen`));
    expect(state).toEqual({ events: 0, archives: 1, frozen: null });
  });
  it('expires detailed content after30days and preserves accounting and curated cases', async () => {
    const evaluation = await insertRun('expire-content', 31), dataset = randomUUID();
    await tenant(org, user, tx => tx.execute(sql`insert into datasets(organization_id,project_id,id,name,kind,cases,hash) values(${org},${project},${dataset},'Curated case','agent_regression','[{"source":{"runId":"expire-content"},"frozenInput":{"secret":"curated"}}]'::jsonb,${checksum('curated')})`));
    expect(await expireRun(org, project, 'expire-content')).toBe(true);
    const [state] = await tenant(org, null, tx => rows<any>(tx, sql`select (select count(*) from runs where id='expire-content')::int as runs,(select count(*) from usage_ledger where evaluation_id=${evaluation})::int as ledger,(select count(*) from datasets where id=${dataset})::int as curated,(select sum(count)::int from operations_daily_metrics) as aggregate`));
    expect(state).toEqual({ runs: 0, ledger: 1, curated: 1, aggregate: 1 });
  });
  it('uses the immutable server clock when a client supplies year9999 or an ancient timestamp', async () => {
    await insertRun('future-client-clock',31);
    await tenant(org, user, tx => tx.execute(sql`update runs set started_at='9999-01-01T00:00:00Z',completed_at='9999-01-01T00:00:00Z',last_event_at=now() where id='future-client-clock'`));
    expect(await expireRun(org,project,'future-client-clock')).toBe(true);
    await insertRun('ancient-client-clock',0);
    await tenant(org,user,tx=>tx.execute(sql`update runs set started_at='2000-01-01T00:00:00Z' where id='ancient-client-clock'`));
    expect(await expireRun(org,project,'ancient-client-clock')).toBe(false);
  });
  it('overrides insert clock values and rejects application changes to the retention deadline', async () => {
    const [record] = await tenant(org,user,tx=>rows<any>(tx,sql`insert into runs(organization_id,project_id,id,agent_version,environment,started_at,last_event_at,first_ingested_at) values(${org},${project},'untrusted-retention-clock','v1','test','9999-01-01',now(),'9999-01-01') returning first_ingested_at`));
    expect(Math.abs(new Date(record.first_ingested_at).getTime()-Date.now())).toBeLessThan(5000);
    await expect(tenant(org,user,tx=>tx.execute(sql`update runs set first_ingested_at='9999-01-01' where id='untrusted-retention-clock'`))).rejects.toThrow();
  });
  it('rehydrates archived detail transactionally for late revisions and explicit evaluation', async () => {
    await insertRun('late-revision'); await archiveRun(org, project, 'late-revision', store);
    expect(await tenant(org, null, tx => restoreRunDetail(tx, org, project, 'late-revision', store))).toBe(true);
    const [state] = await tenant(org, null, tx => rows<any>(tx, sql`select (select count(*) from events where run_id='late-revision')::int as events,(select frozen_input from evaluations where run_id='late-revision') as frozen,(select content_archived_at from runs where id='late-revision') as archived`));
    expect(state.events).toBe(1); expect(state.frozen.secret).toBe('synthetic-frozen-input'); expect(state.archived).toBeNull();
  });
  it('does not erase anything when the independent write-ahead journal is unavailable', async () => {
    await insertRun('journal-unavailable');
    await expect(requestDeletion({ organizationId: org, userId: user, projectId: project, kind: 'run', target: 'journal-unavailable' }, { append: async () => { throw new Error('offline'); }, readAll: async () => [] })).rejects.toThrow('offline');
    expect((await tenant(org, null, tx => rows(tx, sql`select id from runs where id='journal-unavailable'`))).length).toBe(1);
  });
  it('reapplies a deletion after restore even if timed retention already removed its source run', async () => {
    const record = makeDeletionRecord(org, project, 'run', 'expire-content');
    expect((await reapplyDeletionJournal([record], store)).applied).toBe(1);
    expect(await tenant(org, null, tx => rows(tx, sql`select id from datasets where cases::text like '%expire-content%'`))).toHaveLength(0);
  });
  it('erases archives, source content and derived copies through a durable deletion request', async () => {
    const [archive] = await tenant(org, null, tx => rows<any>(tx, sql`select object_path from archives where run_id='archive-success'`));
    const id = await requestDeletion({ organizationId: org, userId: user, projectId: project, kind: 'run', target: 'archive-success' }, sink);
    expect(await processDeletions(org, store)).toBe(1);
    const [item] = await tenant(org, null, tx => rows<any>(tx, sql`select state,target_id from operations_deletions where id=${id}`)); expect(item).toEqual({ state: 'complete', target_id: '[deleted]' });
    expect(await tenant(org, null, tx => rows(tx, sql`select id from runs where id='archive-success'`))).toHaveLength(0);
    expect(objects.has(archive.object_path)).toBe(false);
    await expect(tenant(org, null, tx => assertRunWritable(tx, org, project, 'archive-success'))).rejects.toThrow('deleted');
  });
  it('authorizes downloads at request time and denies cross-workspace administration', async () => {
    const headers = { cookie: `aq_session=${token}`, 'x-workspace-id': org };
    expect((await app.inject({ url: `/v1/operations/health?projectId=${project}`, headers })).statusCode).toBe(200);
    expect((await app.inject({ url: `/v1/operations/health?projectId=${project}`, headers: { ...headers, 'x-workspace-id': otherOrg } })).statusCode).toBe(403);
    const exported = await app.inject({ method: 'POST', url: '/v1/runs/archive-failure/export', headers, payload: { projectId: project } });
    expect(exported.statusCode).toBe(200); const download = await app.inject({ url: exported.json().downloadPath, headers });
    expect(download.statusCode).toBe(200); expect(download.json().expiresIn).toBeLessThanOrEqual(60);
    expect((await app.inject({ url: exported.json().downloadPath })).statusCode).toBe(401);
  });
  it('cleans abandoned objects and preserves forced tenant isolation on operations tables', async () => {
    await cleanupObjects(org, store, true);
    expect((await pool.query('select * from operations_deletions')).rows).toHaveLength(0);
    expect(await tenant(otherOrg, otherUser, tx => rows(tx, sql`select * from operations_daily_metrics`))).toHaveLength(0);
  });
  it('deletes a project with frozen evaluations without FK cascade ordering failures', async () => {
    await tenant(org, user, tx => applyDeletion(org, project, 'project', project, tx));
    expect(await tenant(org, null, tx => rows(tx, sql`select id from projects where id=${project}`))).toHaveLength(0);
  });
});
