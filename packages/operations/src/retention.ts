import { randomUUID } from 'node:crypto';
import { tenant, rows, sql, type Tx } from '@agent-quality/db';
import { archivePath, checksum, putVerified, type PrivateObjectStore } from './storage.ts';
import { operationsConfig } from './config.ts';
import { archiveObjectBytes, lockStorageBudget, releaseArchiveObject, reserveStorageBytes, StorageBudgetError, syncRetainedStorage } from '../../storage-budget/src/index.ts';

export const archivePayloadLimitBytes = 16 * 1024 * 1024;
async function workspaceExists(tx: Tx, org: string) { return Boolean((await rows(tx, sql`select id from organizations where id=${org}`))[0]); }

export async function withRunLock(tx: Tx, org: string, project: string, run: string) {
  // Same advisory key as evaluateJob: no archive can remove a worker's frozen input mid-request.
  await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`${org}:${project}:${run}`},0))`);
  await lockStorageBudget(tx, org);
  return (await rows<any>(tx, sql`select r.*,o.retention_days from runs r join organizations o on o.id=r.organization_id where r.organization_id=${org} and r.project_id=${project} and r.id=${run} for update of r`))[0];
}
export async function runDocument(tx: Tx, project: string, run: string) {
  const [record] = await rows<any>(tx, sql`select * from runs where project_id=${project} and id=${run}`);
  if (!record) throw new Error('Run absent or expired.');
  const [size] = await rows<any>(tx, sql`select coalesce((select sum(octet_length(to_jsonb(t)::text)) from events t where project_id=${project} and run_id=${run}),0)+coalesce((select sum(octet_length(to_jsonb(t)::text)) from evidence t where project_id=${project} and run_id=${run}),0)+coalesce((select sum(octet_length(to_jsonb(t)::text)) from evaluations t where project_id=${project} and run_id=${run}),0)+coalesce((select sum(octet_length(to_jsonb(t)::text)) from reviews t where project_id=${project} and run_id=${run}),0)+coalesce((select sum(octet_length(to_jsonb(d)::text)) from review_decisions d join reviews r on r.organization_id=d.organization_id and r.project_id=d.project_id and r.id=d.review_id where r.project_id=${project} and r.run_id=${run}),0) as bytes`);
  const [tables] = await rows<{ attempts: boolean }>(tx, sql`select to_regclass('public.evaluation_attempts') is not null as attempts`);
  const [attemptSize] = tables.attempts ? await rows<{ bytes: string }>(tx, sql`select coalesce(sum(octet_length(to_jsonb(a)::text)),0)::text as bytes from evaluation_attempts a join evaluations e on e.organization_id=a.organization_id and e.project_id=a.project_id and e.id=a.evaluation_id where e.project_id=${project} and e.run_id=${run}`) : [{ bytes: '0' }];
  if (Number(size.bytes) + Number(attemptSize.bytes) > archivePayloadLimitBytes) throw new Error('Run exceeds the 16 MiB archive/export budget; database detail is retained until expiry.');
  const document = { version: 1, run: record,
    events: await rows(tx, sql`select event_id,event,ingested_at from events where project_id=${project} and run_id=${run} order by ingested_at,event_id`),
    evidence: await rows(tx, sql`select * from evidence where project_id=${project} and run_id=${run} order by created_at,id`),
    evaluations: await rows(tx, sql`select * from evaluations where project_id=${project} and run_id=${run} order by created_at,id`),
    reviews: await rows(tx, sql`select * from reviews where project_id=${project} and run_id=${run} order by created_at,id`),
    decisions: await rows(tx, sql`select d.* from review_decisions d join reviews r on r.organization_id=d.organization_id and r.project_id=d.project_id and r.id=d.review_id where r.project_id=${project} and r.run_id=${run} order by d.created_at,d.id`),
    evaluationAttempts: tables.attempts ? await rows(tx, sql`select a.* from evaluation_attempts a join evaluations e on e.organization_id=a.organization_id and e.project_id=a.project_id and e.id=a.evaluation_id where e.project_id=${project} and e.run_id=${run} order by a.evaluation_id,a.attempt_number`) : [],
  };
  if (Buffer.byteLength(JSON.stringify(document)) > archivePayloadLimitBytes) throw new Error('Run exceeds the 16 MiB archive/export budget; database detail is retained until expiry.');
  return document;
}
export async function reserveObject(org: string, path: string) {
  const id = randomUUID();
  await tenant(org, null, async tx => {
    await lockStorageBudget(tx, org);
    // Reserve before creating the outbox row, so fresh work is never an unknown legacy object.
    await reserveStorageBytes(tx, org, { category: 'archive_objects', resourceId: path, bytes: archiveObjectBytes(archivePayloadLimitBytes) });
    await tx.execute(sql`insert into operations_object_cleanup(organization_id,id,object_path,not_before) values(${org},${id},${path},now()+interval '1 hour')`);
    await syncRetainedStorage(tx, org);
  });
  return id;
}
/** Recheck after waiting for run/budget locks; cleanup may have retired an old reservation. */
export async function assertObjectReservation(tx: Tx, org: string, cleanupId: string, path: string) {
  await lockStorageBudget(tx, org);
  const [reservation] = await rows(tx, sql`select q.id from operations_object_cleanup q join storage_resources s on s.organization_id=q.organization_id and s.category='archive_objects' and s.resource_key=q.object_path where q.organization_id=${org} and q.id=${cleanupId} and q.object_path=${path} and s.bytes>=${archiveObjectBytes(archivePayloadLimitBytes)} and not s.unmeasured`);
  if (!reservation) throw Object.assign(new Error('The object reservation expired before upload. Retry the archive or export.'), { code: 'object_reservation_expired', statusCode: 409 });
}
export async function readArchive(tx: Tx, project: string, run: string, store: PrivateObjectStore) {
  const [archive] = await rows<any>(tx, sql`select * from archives where project_id=${project} and run_id=${run} and purpose='archive' and expires_at>now()`);
  if (!archive) return null;
  const bytes = await store.get(archive.object_path);
  if (bytes.byteLength > archivePayloadLimitBytes) throw new Error('Archive exceeds the 16 MiB read budget.');
  if (checksum(bytes) !== archive.checksum) throw new Error('Archive checksum verification failed.');
  const document = JSON.parse(Buffer.from(bytes).toString('utf8'));
  const [record] = await rows<any>(tx, sql`select organization_id,project_id,id,instance_id from runs where project_id=${project} and id=${run}`);
  if (!record || document?.run?.organization_id !== record.organization_id || document.run.project_id !== project || document.run.id !== run || document.run.instance_id !== record.instance_id) throw new Error('Archive run identity or instance does not match the current run.');
  return document;
}
/** Take budget before the row. A worker's session advisory lock is already held outside this transaction. */
export async function restoreRunDetail(tx: Tx, org: string, project: string, run: string, store: PrivateObjectStore) {
  await lockStorageBudget(tx, org);
  const [record] = await rows<any>(tx, sql`select content_archived_at,instance_id from runs where organization_id=${org} and project_id=${project} and id=${run} for update`);
  if (!record?.content_archived_at) return false;
  const archived = await readArchive(tx, project, run, store); if (!archived) throw new Error('Archive absent or expired; detailed content cannot be restored.');
  if (archived.run.instance_id !== record.instance_id) throw new Error('Archive run instance does not match the current run.');
  for (const event of archived.events) await tx.execute(sql`insert into events(organization_id,project_id,event_id,run_id,event,ingested_at) values(${org},${project},${event.event_id},${run},${JSON.stringify(event.event)}::jsonb,${event.ingested_at}::timestamptz) on conflict do nothing`);
  for (const evidence of archived.evidence) await tx.execute(sql`insert into evidence(organization_id,project_id,id,run_id,receipt_id,hash,body,created_at) values(${org},${project},${evidence.id},${run},${evidence.receipt_id},${evidence.hash},${JSON.stringify(evidence.body)}::jsonb,${evidence.created_at}::timestamptz) on conflict do nothing`);
  for (const evaluation of archived.evaluations) await tx.execute(sql`update evaluations set frozen_input=coalesce(frozen_input,${evaluation.frozen_input == null ? null : JSON.stringify(evaluation.frozen_input)}::jsonb),provider_response=coalesce(provider_response,${evaluation.provider_response == null ? null : JSON.stringify(evaluation.provider_response)}::jsonb) where project_id=${project} and id=${evaluation.id}`);
  await tx.execute(sql`insert into operations_object_cleanup(organization_id,object_path) select organization_id,object_path from archives where project_id=${project} and run_id=${run} and purpose='archive'`);
  await tx.execute(sql`delete from archives where project_id=${project} and run_id=${run} and purpose='archive'`);
  await tx.execute(sql`update runs set content_archived_at=null where project_id=${project} and id=${run}`);
  await syncRetainedStorage(tx, org, { projectId: project, runId: run });
  return true;
}
/** Safe only when no upload was attempted for this independently reserved path. */
export async function releaseUnwrittenObjectReservation(tx: Tx, org: string, cleanupId: string, path: string) {
  const exists = await workspaceExists(tx, org);
  if (exists) await lockStorageBudget(tx, org);
  await tx.execute(sql`delete from operations_object_cleanup where organization_id=${org} and id=${cleanupId} and object_path=${path}`);
  await releaseArchiveObject(tx, org, path);
  if (exists) await syncRetainedStorage(tx, org);
}
export async function archiveRun(org: string, project: string, run: string, store: PrivateObjectStore) {
  const path = archivePath(org, project), cleanupId = await reserveObject(org, path);
  let uploadAttempted = false;
  try { return await tenant(org, null, async tx => {
    const record = await withRunLock(tx, org, project, run);
    if (!record || record.expired_at || record.content_archived_at || !record.completed_at) { await releaseUnwrittenObjectReservation(tx, org, cleanupId, path); return false; }
    const expires = new Date(new Date(record.first_ingested_at).getTime() + record.retention_days * 86400000);
    if (expires.getTime() <= Date.now()) { await releaseUnwrittenObjectReservation(tx, org, cleanupId, path); return false; }
    const bytes = Buffer.from(JSON.stringify(await runDocument(tx, project, run)));
    if (bytes.byteLength > archivePayloadLimitBytes) throw new Error('Run exceeds the 16 MiB archive/export budget.');
    await assertObjectReservation(tx, org, cleanupId, path);
    uploadAttempted = true;
    const hash = await putVerified(store, path, bytes);
    await tx.execute(sql`insert into archives(organization_id,project_id,run_id,object_path,checksum,expires_at,bytes) values(${org},${project},${run},${path},${hash},${expires.toISOString()},${bytes.length})`);
    // Pointer and removal are one commit. Failure/termination rolls back and retains all database content.
    await tx.execute(sql`delete from events where project_id=${project} and run_id=${run}`);
    await tx.execute(sql`delete from evidence where project_id=${project} and run_id=${run}`);
    await tx.execute(sql`update evaluations set frozen_input=null,provider_response=null where project_id=${project} and run_id=${run}`);
    await tx.execute(sql`update runs set content_archived_at=now() where project_id=${project} and id=${run}`);
    await tx.execute(sql`delete from operations_object_cleanup where id=${cleanupId}`);
    await syncRetainedStorage(tx, org, { projectId: project, runId: run });
    return true;
  }); } catch (error) {
    if (!uploadAttempted) await tenant(org, null, tx => releaseUnwrittenObjectReservation(tx, org, cleanupId, path)).catch(() => undefined);
    // An attempted upload may have succeeded remotely. Its independent maximum
    // charge/outbox must survive pointer transaction rollback until removal succeeds.
    throw error;
  }
}
export async function cleanupObjects(org: string, store: PrivateObjectStore, all = false) {
  return tenant(org, null, async tx => {
    const exists = await workspaceExists(tx, org);
    if (exists) await lockStorageBudget(tx, org);
    const pending = await rows<any>(tx, sql`select * from operations_object_cleanup where organization_id=${org} and (${all} or not_before<=now()) order by created_at,id for update skip locked limit 100`);
    let removed = 0; const processed = new Set<string>();
    for (const item of pending) {
      if (processed.has(item.object_path)) continue;
      processed.add(item.object_path);
      const [active] = await rows(tx, sql`select id from archives where organization_id=${org} and object_path=${item.object_path} limit 1`);
      if (active) { await tx.execute(sql`delete from operations_object_cleanup where organization_id=${org} and object_path=${item.object_path}`); continue; }
      await store.remove([item.object_path]);
      await tx.execute(sql`delete from operations_object_cleanup where organization_id=${org} and object_path=${item.object_path}`);
      await releaseArchiveObject(tx, org, item.object_path);
      removed++;
    }
    if (exists && pending.length) await syncRetainedStorage(tx, org);
    return removed;
  });
}
export async function enqueueArchiveCleanup(tx: Tx, org: string, project?: string, run?: string) {
  await lockStorageBudget(tx, org);
  await tx.execute(sql`insert into operations_object_cleanup(organization_id,object_path) select organization_id,object_path from archives where organization_id=${org} and (${project ?? null}::uuid is null or project_id=${project ?? null}::uuid) and (${run ?? null}::text is null or run_id=${run ?? null})`);
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
    await syncRetainedStorage(tx, org, { projectId: project, runId: run });
    return true;
  });
}
export async function maintainWorkspace(org: string, store?: PrivateObjectStore) {
  const cfg = operationsConfig(); let archived = 0, expired = 0;
  // Confirm removal of due, unreferenced objects before metadata reconciliation
  // or new reservations: an over-limit workspace must be able to recover space.
  let deleted = store ? await cleanupObjects(org, store) : 0;
  const candidates = await tenant(org, null, tx => rows<any>(tx, sql`select r.project_id,r.id,r.first_ingested_at,o.retention_days from runs r join organizations o on o.id=r.organization_id where (r.first_ingested_at<now()-make_interval(days=>o.retention_days) or (r.content_archived_at is null and r.completed_at is not null and r.last_event_at<now()-interval '24 hours' and r.first_ingested_at<now()-make_interval(days=>${cfg.ARCHIVE_AFTER_DAYS}))) order by r.first_ingested_at limit ${cfg.OPERATIONS_BATCH_SIZE}`));
  for (const run of candidates) {
    if (new Date(run.first_ingested_at).getTime() <= Date.now() - run.retention_days * 86400000) expired += Number(await expireRun(org, run.project_id, run.id));
    else if (store) {
      try { archived += Number(await archiveRun(org, run.project_id, run.id, store)); }
      catch (error) { if (!(error instanceof StorageBudgetError) || !['storage_limit_exceeded', 'storage_measurement_required'].includes(error.code)) throw error; }
      // Capacity pressure must not prevent the later cleanup pass from releasing
      // failed-upload reservations, nor stop TTL expiry of other candidates.
    }
  }
  await tenant(org, null, async tx => {
    await lockStorageBudget(tx, org);
    await tx.execute(sql`insert into operations_object_cleanup(organization_id,object_path) select organization_id,object_path from archives where organization_id=${org} and expires_at<=now()`);
    const expiredPointers=await rows(tx,sql`delete from archives where organization_id=${org} and expires_at<=now() returning id`);
    if(expiredPointers.length)await syncRetainedStorage(tx, org);
  });
  if(store)deleted += await cleanupObjects(org, store);
  await tenant(org, null, async tx => {
    await tx.execute(sql`delete from operations_daily_metrics where day<current_date-90`);
    await tx.execute(sql`delete from usage_ledger u using subscriptions s where s.organization_id=u.organization_id and u.created_at<now()-interval '90 days' and u.created_at<s.period_start and u.state not in ('reserved','ambiguous')`);
    await tx.execute(sql`select operations_prune_audit(${org})`);
    await tx.execute(sql`delete from oauth_states where expires_at<now()`);
    await tx.execute(sql`insert into operations_heartbeats values(${org},now(),${archived},${expired},${deleted}) on conflict(organization_id) do update set last_success_at=excluded.last_success_at,archived=excluded.archived,expired=excluded.expired,deleted=excluded.deleted`);
  });
  return { archived, expired, deleted };
}
