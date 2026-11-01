import { randomUUID } from 'node:crypto';
import { tenant, rows, sql, type Tx } from '@agent-quality/db';
import { archivePath, checksum, putVerified, type PrivateObjectStore } from './storage.ts';
import { operationsConfig } from './config.ts';

export async function withRunLock(tx: Tx, org: string, project: string, run: string) {
  // Same advisory key as evaluateJob: no archive can remove a worker's frozen input mid-request.
  await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`${org}:${project}:${run}`},0))`);
  return (await rows<any>(tx, sql`select r.*,o.retention_days from runs r join organizations o on o.id=r.organization_id where r.project_id=${project} and r.id=${run} for update of r`))[0];
}
export async function runDocument(tx: Tx, project: string, run: string) {
  const [record] = await rows<any>(tx, sql`select * from runs where project_id=${project} and id=${run}`);
  if (!record) throw new Error('Run absent or expired.');
  const [size] = await rows<any>(tx, sql`select coalesce((select sum(octet_length(event::text)) from events where project_id=${project} and run_id=${run}),0)+coalesce((select sum(octet_length(body::text)) from evidence where project_id=${project} and run_id=${run}),0)+coalesce((select sum(coalesce(octet_length(frozen_input::text),0)+coalesce(octet_length(provider_response::text),0)+coalesce(octet_length(assessment::text),0)) from evaluations where project_id=${project} and run_id=${run}),0) as bytes`);
  if (Number(size.bytes) > 16 * 1024 * 1024) throw new Error('Run exceeds the 16 MiB archive/export budget; database detail is retained until expiry.');
  return { version: 1, run: record,
    events: await rows(tx, sql`select event_id,event,ingested_at from events where project_id=${project} and run_id=${run} order by ingested_at,event_id`),
    evidence: await rows(tx, sql`select * from evidence where project_id=${project} and run_id=${run} order by created_at,id`),
    evaluations: await rows(tx, sql`select * from evaluations where project_id=${project} and run_id=${run} order by created_at,id`),
    reviews: await rows(tx, sql`select * from reviews where project_id=${project} and run_id=${run} order by created_at,id`),
    decisions: await rows(tx, sql`select d.* from review_decisions d join reviews r on r.organization_id=d.organization_id and r.project_id=d.project_id and r.id=d.review_id where r.project_id=${project} and r.run_id=${run} order by d.created_at,d.id`),
  };
}
export async function reserveObject(org: string, path: string) {
  const id = randomUUID();
  await tenant(org, null, tx => tx.execute(sql`insert into operations_object_cleanup(organization_id,id,object_path,not_before) values(${org},${id},${path},now()+interval '1 hour')`));
  return id;
}
export async function readArchive(tx: Tx, project: string, run: string, store: PrivateObjectStore) {
  const [archive] = await rows<any>(tx, sql`select * from archives where project_id=${project} and run_id=${run} and purpose='archive' and expires_at>now()`);
  if (!archive) return null;
  const bytes = await store.get(archive.object_path);
  if (checksum(bytes) !== archive.checksum) throw new Error('Archive checksum verification failed.');
  return JSON.parse(Buffer.from(bytes).toString('utf8'));
}
/** Caller holds the run row lock. Worker already holds its session advisory lock; do not acquire it on a second connection. */
export async function restoreRunDetail(tx: Tx, org: string, project: string, run: string, store: PrivateObjectStore) {
  const [record] = await rows<any>(tx, sql`select content_archived_at from runs where project_id=${project} and id=${run} for update`);
  if (!record?.content_archived_at) return false;
  const archived = await readArchive(tx, project, run, store); if (!archived) throw new Error('Archive absent or expired; detailed content cannot be restored.');
  for (const event of archived.events) await tx.execute(sql`insert into events(organization_id,project_id,event_id,run_id,event,ingested_at) values(${org},${project},${event.event_id},${run},${JSON.stringify(event.event)}::jsonb,${event.ingested_at}::timestamptz) on conflict do nothing`);
  for (const evidence of archived.evidence) await tx.execute(sql`insert into evidence(organization_id,project_id,id,run_id,receipt_id,hash,body,created_at) values(${org},${project},${evidence.id},${run},${evidence.receipt_id},${evidence.hash},${JSON.stringify(evidence.body)}::jsonb,${evidence.created_at}::timestamptz) on conflict do nothing`);
  for (const evaluation of archived.evaluations) await tx.execute(sql`update evaluations set frozen_input=coalesce(frozen_input,${evaluation.frozen_input == null ? null : JSON.stringify(evaluation.frozen_input)}::jsonb),provider_response=coalesce(provider_response,${evaluation.provider_response == null ? null : JSON.stringify(evaluation.provider_response)}::jsonb) where project_id=${project} and id=${evaluation.id}`);
  await tx.execute(sql`insert into operations_object_cleanup(organization_id,object_path) select organization_id,object_path from archives where project_id=${project} and run_id=${run} and purpose='archive'`);
  await tx.execute(sql`delete from archives where project_id=${project} and run_id=${run} and purpose='archive'`);
  await tx.execute(sql`update runs set content_archived_at=null where project_id=${project} and id=${run}`);
  return true;
}
export async function archiveRun(org: string, project: string, run: string, store: PrivateObjectStore) {
  const path = archivePath(org, project), cleanupId = await reserveObject(org, path);
  return tenant(org, null, async tx => {
    const record = await withRunLock(tx, org, project, run);
    if (!record || record.expired_at || record.content_archived_at || !record.completed_at) { await tx.execute(sql`delete from operations_object_cleanup where id=${cleanupId}`); return false; }
    const expires = new Date(new Date(record.first_ingested_at).getTime() + record.retention_days * 86400000);
    if (expires.getTime() <= Date.now()) { await tx.execute(sql`delete from operations_object_cleanup where id=${cleanupId}`); return false; }
    const bytes = Buffer.from(JSON.stringify(await runDocument(tx, project, run)));
    const hash = await putVerified(store, path, bytes);
    await tx.execute(sql`insert into archives(organization_id,project_id,run_id,object_path,checksum,expires_at,bytes) values(${org},${project},${run},${path},${hash},${expires.toISOString()},${bytes.length})`);
    // Pointer and removal are one commit. Failure/termination rolls back and retains all database content.
    await tx.execute(sql`delete from events where project_id=${project} and run_id=${run}`);
    await tx.execute(sql`delete from evidence where project_id=${project} and run_id=${run}`);
    await tx.execute(sql`update evaluations set frozen_input=null,provider_response=null where project_id=${project} and run_id=${run}`);
    await tx.execute(sql`update runs set content_archived_at=now() where project_id=${project} and id=${run}`);
    await tx.execute(sql`delete from operations_object_cleanup where id=${cleanupId}`);
    return true;
  });
}
export async function cleanupObjects(org: string, store: PrivateObjectStore, all = false) {
  return tenant(org, null, async tx => {
    const pending = await rows<any>(tx, sql`select * from operations_object_cleanup where (${all} or not_before<=now()) order by created_at for update skip locked limit 100`);
    for (const item of pending) {
      await store.remove([item.object_path]);
      await tx.execute(sql`delete from operations_object_cleanup where id=${item.id}`);
    }
    return pending.length;
  });
}
export async function enqueueArchiveCleanup(tx: Tx, org: string, project?: string, run?: string) {
  await tx.execute(sql`insert into operations_object_cleanup(organization_id,object_path) select organization_id,object_path from archives where (${project ?? null}::uuid is null or project_id=${project ?? null}::uuid) and (${run ?? null}::text is null or run_id=${run ?? null})`);
}
export async function expireRun(org: string, project: string, run: string) {
  return tenant(org, null, async tx => {
    const record = await withRunLock(tx, org, project, run); if (!record) return false;
    if (new Date(record.first_ingested_at).getTime() > Date.now() - record.retention_days * 86400000) return false;
    const [evaluation] = await rows<any>(tx, sql`select processing,assessment->>'decision' as decision from evaluations where project_id=${project} and id=${record.latest_evaluation_id}`);
    const decision = ['pass','fail','review','unknown','pending'].includes(evaluation?.decision) ? evaluation.decision : 'pending';
    const processing = ['pending','processing','completed','error','partial'].includes(evaluation?.processing) ? evaluation.processing : 'unknown';
    const execution = ['running','completed','failed','cancelled'].includes(record.execution_status) ? record.execution_status : 'unknown';
    await tx.execute(sql`insert into operations_daily_metrics(organization_id,project_id,day,decision,processing,execution,count) values(${org},${project},${record.first_ingested_at}::timestamptz::date,${decision},${processing},${execution},1) on conflict(organization_id,project_id,day,decision,processing,execution) do update set count=operations_daily_metrics.count+1`);
    await enqueueArchiveCleanup(tx, org, project, run);
    await tx.execute(sql`delete from pgboss.job where data->>'organizationId'=${org} and data->>'projectId'=${project} and data->>'runId'=${run}`);
    // Curated dataset copies are intentionally retained until explicit deletion.
    await tx.execute(sql`delete from runs where project_id=${project} and id=${run}`);
    return true;
  });
}
export async function maintainWorkspace(org: string, store?: PrivateObjectStore) {
  const cfg = operationsConfig(); let archived = 0, expired = 0;
  const candidates = await tenant(org, null, tx => rows<any>(tx, sql`select r.project_id,r.id,r.first_ingested_at,o.retention_days from runs r join organizations o on o.id=r.organization_id where (r.first_ingested_at<now()-make_interval(days=>o.retention_days) or (r.content_archived_at is null and r.completed_at is not null and r.last_event_at<now()-interval '24 hours' and r.first_ingested_at<now()-make_interval(days=>${cfg.ARCHIVE_AFTER_DAYS}))) order by r.first_ingested_at limit ${cfg.OPERATIONS_BATCH_SIZE}`));
  for (const run of candidates) {
    if (new Date(run.first_ingested_at).getTime() <= Date.now() - run.retention_days * 86400000) expired += Number(await expireRun(org, run.project_id, run.id));
    else if (store) archived += Number(await archiveRun(org, run.project_id, run.id, store));
  }
  await tenant(org, null, async tx => {
    await tx.execute(sql`insert into operations_object_cleanup(organization_id,object_path) select organization_id,object_path from archives where expires_at<=now()`);
    await tx.execute(sql`delete from archives where expires_at<=now()`);
  });
  const deleted = store ? await cleanupObjects(org, store) : 0;
  await tenant(org, null, async tx => {
    await tx.execute(sql`delete from operations_daily_metrics where day<current_date-90`);
    await tx.execute(sql`delete from usage_ledger u using subscriptions s where s.organization_id=u.organization_id and u.created_at<now()-interval '90 days' and u.created_at<s.period_start and u.state not in ('reserved','ambiguous')`);
    await tx.execute(sql`select operations_prune_audit(${org})`);
    await tx.execute(sql`delete from oauth_states where expires_at<now()`);
    await tx.execute(sql`insert into operations_heartbeats values(${org},now(),${archived},${expired},${deleted}) on conflict(organization_id) do update set last_success_at=excluded.last_success_at,archived=excluded.archived,expired=excluded.expired,deleted=excluded.deleted`);
  });
  return { archived, expired, deleted };
}
