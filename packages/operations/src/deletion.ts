import { tenant, rows, sql, type Tx } from '@agent-quality/db';
import { checksum, type PrivateObjectStore } from './storage.ts';
import { enqueueArchiveCleanup, cleanupObjects, withRunLock } from './retention.ts';
import { deletionHash, makeDeletionRecord, type DeletionRecord, type DeletionSink } from './journal.ts';

/** Admission hook for ingestion/evaluation. Prevents a deleted run ID from being reused after erasure. */
export async function assertRunWritable(tx: Tx, org: string, project: string, run: string) {
  if (!process.env.DELETION_JOURNAL_HMAC_KEY && process.env.NODE_ENV !== 'production') return;
  const [state] = await rows<any>(tx, sql`select operations_target_deleted(${deletionHash(org)},${deletionHash(`${org}:${project}`)},${deletionHash(`${org}:${project}:run:${run}`)}) as deleted`);
  if (state.deleted) throw Object.assign(new Error('This run or its parent was deleted. Use a new run ID.'), { status: 410, statusCode: 410, code: 'data_deleted' });
}

async function removeRunCopies(tx: Tx, project: string, run: string) {
  // Explicit erasure also removes curated/derived copies; timed retention deliberately does not.
  await tx.execute(sql`delete from experiments where project_id=${project} and jsonb_path_exists(candidates,'$.**.runId ? (@ == $run)'::jsonpath,jsonb_build_object('run',${run}::text))`);
  const copied = sql`jsonb_path_exists(cases,'$.**.runId ? (@ == $run)'::jsonpath,jsonb_build_object('run',${run}::text)) or jsonb_path_exists(cases,'$[*].frozenInput.id ? (@ == $run)'::jsonpath,jsonb_build_object('run',${run}::text))`;
  await tx.execute(sql`delete from experiments where project_id=${project} and dataset_id in (select id from datasets where project_id=${project} and (${copied}))`);
  await tx.execute(sql`delete from datasets where project_id=${project} and (${copied})`);
}
export async function applyDeletion(org: string, project: string | null, kind: DeletionRecord['kind'], target: string, tx: Tx) {
  if (kind === 'run') {
    if (!project) throw new Error('Run deletion requires a project.');
    await withRunLock(tx, org, project, target);
    await enqueueArchiveCleanup(tx, org, project, target); await removeRunCopies(tx, project, target);
    await tx.execute(sql`delete from pgboss.job where data->>'organizationId'=${org} and data->>'projectId'=${project} and data->>'runId'=${target}`);
    await tx.execute(sql`delete from runs where project_id=${project} and id=${target}`);
  } else if (kind === 'dataset') {
    if (!project) throw new Error('Dataset deletion requires a project.');
    await tx.execute(sql`delete from experiments where project_id=${project} and dataset_id=${target}::uuid`);
    await tx.execute(sql`delete from datasets where project_id=${project} and id=${target}::uuid`);
  } else {
    await enqueueArchiveCleanup(tx, org, kind === 'project' ? target : undefined);
    // Existing foundation cycles use deferred FKs, and project deletion cascades all scoped rows.
    if (kind === 'project') {
      await tx.execute(sql`delete from pgboss.job where data->>'organizationId'=${org} and data->>'projectId'=${target}`);
      await tx.execute(sql`delete from experiments where project_id=${target}::uuid`);
      await tx.execute(sql`delete from runs where project_id=${target}::uuid`);
      await tx.execute(sql`delete from projects where id=${target}::uuid`);
    } else {
      await tx.execute(sql`delete from pgboss.job where data->>'organizationId'=${org}`);
      await tx.execute(sql`delete from experiments`);
      await tx.execute(sql`delete from runs`);
      await tx.execute(sql`delete from organizations where id=${org}`);
    }
  }
}
export async function requestDeletion(input: { organizationId: string; userId: string; projectId: string | null; kind: DeletionRecord['kind']; target: string }, sink: DeletionSink) {
  const { organizationId: org, userId, projectId: project, kind, target } = input;
  const record = makeDeletionRecord(org, project, kind, target);
  // Write-ahead tombstone lives outside every database backup. Do not erase if this write fails.
  const journalChecksum = await sink.append(record);
  if (journalChecksum !== checksum(JSON.stringify(record))) throw new Error('Independent deletion journal receipt is invalid.');
  await tenant(org, userId, async tx => {
    await tx.execute(sql`select operations_record_deletion(${record.id},${org},${record.organizationHash},${kind},${record.projectHash},${record.targetHash})`);
    await tx.execute(sql`insert into operations_deletions(organization_id,id,kind,project_id,target_id,journal_checksum) values(${org},${record.id},${kind},${project},${target},${journalChecksum})`);
    await tx.execute(sql`insert into audit_events(organization_id,user_id,action,resource_id) values(${org},${userId},'data.deletion_requested',${record.id})`);
  });
  return record.id;
}
export async function processDeletions(org: string, store?: PrivateObjectStore) {
  const requests = await tenant(org, null, tx => rows<any>(tx, sql`select id from operations_deletions where state='pending' order by created_at limit 10`));
  let deleted = 0;
  for (const request of requests) {
    await tenant(org, null, async tx => {
      const [item] = await rows<any>(tx, sql`select * from operations_deletions where id=${request.id} and state='pending' for update`); if (!item) return;
      await applyDeletion(org, item.project_id, item.kind, item.target_id, tx);
      await tx.execute(sql`update operations_deletions set state='complete',completed_at=now(),target_id='[deleted]' where id=${item.id}`); deleted++;
    });
  }
  if (store) await cleanupObjects(org, store);
  return deleted;
}
/** Recovery only, before accepting any traffic. Replays all retained independent tombstones. */
export async function reapplyDeletionJournal(records: DeletionRecord[], store?: PrivateObjectStore) {
  const workspaces = await tenant('', null, tx => rows<any>(tx, sql`select operations_workspace_ids() as id`)); let applied = 0;
  for (const { id: org } of workspaces) {
    const relevant = records.filter(r => r.organizationHash === deletionHash(org));
    for (const record of relevant) {
      const matches = await tenant(org, null, async tx => {
        if (record.kind === 'workspace') return [{ project: null, target: org }];
        const projects = await rows<any>(tx, sql`select id from projects`); const result: {project: string; target: string}[] = [];
        for (const { id: project } of projects) {
          if (record.projectHash !== deletionHash(`${org}:${project}`)) continue;
          if (record.kind === 'project') result.push({ project, target: project });
          else {
            const targets = record.kind === 'run'
              ? await rows<any>(tx, sql`select id from runs where project_id=${project}`)
              : await rows<any>(tx, sql`select id from datasets where project_id=${project}`);
            for (const { id } of targets) if (record.targetHash === deletionHash(`${org}:${project}:${record.kind}:${id}`)) result.push({ project, target: id });
            // Retention may already have deleted the original run while curated copies survived.
            if (record.kind === 'run') {
              const copies = await rows<any>(tx, sql`select distinct value#>>'{}' as id from datasets cross join lateral jsonb_path_query(cases,'$.**.runId') value where project_id=${project} union select distinct c->'frozenInput'->>'id' as id from datasets cross join lateral jsonb_array_elements(cases) c where project_id=${project} union select distinct value#>>'{}' as id from experiments cross join lateral jsonb_path_query(candidates,'$.**.runId') value where project_id=${project}`);
              for (const { id } of copies) if (id && record.targetHash === deletionHash(`${org}:${project}:run:${id}`) && !result.some(m => m.project === project && m.target === id)) result.push({ project, target: id });
            }
          }
        } return result;
      });
      for (const match of matches) { await tenant(org, null, tx => applyDeletion(org, match.project, record.kind, match.target, tx)); applied++; }
    }
    if (store) await cleanupObjects(org, store, true);
  }
  return { applied, records: records.length };
}
