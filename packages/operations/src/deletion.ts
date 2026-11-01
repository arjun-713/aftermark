import { tenant, rows, sql, type Tx } from '@agent-quality/db';
import { checksum, type PrivateObjectStore } from './storage.ts';
import { enqueueArchiveCleanup, cleanupObjects } from './retention.ts';
import { deletionHash, makeDeletionRecord, type DeletionRecord, type DeletionSink } from './journal.ts';
import { lockStorageBudget, syncRetainedStorage } from '../../storage-budget/src/index.ts';

/** Admission hook for ingestion/evaluation. Prevents a deleted run ID from being reused after erasure. */
export async function assertRunWritable(tx: Tx, org: string, project: string, run: string) {
  if (!process.env.DELETION_JOURNAL_HMAC_KEY && process.env.NODE_ENV !== 'production') return;
  const [state] = await rows<any>(tx, sql`select operations_target_deleted(${deletionHash(org)},${deletionHash(`${org}:${project}`)},${deletionHash(`${org}:${project}:run:${run}`)}) as deleted`);
  if (state.deleted) throw Object.assign(new Error('This run or its parent was deleted. Use a new run ID.'), { status: 410, statusCode: 410, code: 'data_deleted' });
}

async function removeRunCopies(tx: Tx, org: string, project: string, run: string) {
  // Explicit erasure also removes curated/derived copies; timed retention deliberately does not.
  await tx.execute(sql`delete from experiments where organization_id=${org} and project_id=${project} and jsonb_path_exists(candidates,'$.**.runId ? (@ == $run)'::jsonpath,jsonb_build_object('run',${run}::text))`);
  const copied = sql`jsonb_path_exists(cases,'$.**.runId ? (@ == $run)'::jsonpath,jsonb_build_object('run',${run}::text)) or jsonb_path_exists(cases,'$[*].frozenInput.id ? (@ == $run)'::jsonpath,jsonb_build_object('run',${run}::text))`;
  await tx.execute(sql`delete from experiments where organization_id=${org} and project_id=${project} and dataset_id in (select id from datasets where organization_id=${org} and project_id=${project} and (${copied}))`);
  await tx.execute(sql`delete from datasets where organization_id=${org} and project_id=${project} and (${copied})`);
}
function busyDeletion() { return Object.assign(new Error('A run is being evaluated. The deletion remains pending and will retry.'), { code: 'deletion_busy', statusCode: 409 }); }
async function prepareDeletion(tx: Tx, org: string, project: string | null, kind: DeletionRecord['kind'], target: string) {
  const [context] = await rows<{ id: string | null }>(tx, sql`select current_org()::text as id`);
  if (context.id !== org) throw Object.assign(new Error('Deletion requires the current workspace.'), { code: 'deletion_scope_invalid', statusCode: 403 });
  if (!(await rows(tx, sql`select id from organizations where id=${org}`)).length) return false;
  if (kind === 'run' && !project) throw new Error('Run deletion requires a project.');
  const affected = async () => {
    const filter = kind === 'project' ? target : kind === 'run' ? project : null;
    const runs = await rows<{ project_id: string; id: string }>(tx, sql`select project_id,id from runs where organization_id=${org} and (${filter}::uuid is null or project_id=${filter}::uuid) and (${kind === 'run' ? target : null}::text is null or id=${kind === 'run' ? target : null}::text) order by project_id,id`);
    if (kind === 'run' && !runs.length) runs.push({ project_id: project!, id: target });
    return runs.sort((a, b) => `${a.project_id}:${a.id}`.localeCompare(`${b.project_id}:${b.id}`));
  };
  const tryLocks = async () => {
    for (const run of await affected()) {
      const [{ acquired }] = await rows<{ acquired: boolean }>(tx, sql`select pg_try_advisory_xact_lock(hashtextextended(${`${org}:${run.project_id}:${run.id}`},0)) as acquired`);
      if (!acquired) throw busyDeletion();
    }
  };
  if (kind !== 'dataset') await tryLocks();
  await lockStorageBudget(tx, org);
  // An ingestion may have committed a new run while we waited for the budget.
  // Recheck with TRY locks only: waiting here would deadlock a session-locked worker.
  if (kind !== 'dataset') await tryLocks();
  return true;
}
export async function applyDeletion(org: string, project: string | null, kind: DeletionRecord['kind'], target: string, tx: Tx) {
  if (!await prepareDeletion(tx, org, project, kind, target)) return;
  if (kind === 'run') {
    if (!project) throw new Error('Run deletion requires a project.');
    await enqueueArchiveCleanup(tx, org, project, target); await removeRunCopies(tx, org, project, target);
    await tx.execute(sql`delete from pgboss.job where data->>'organizationId'=${org} and data->>'projectId'=${project} and data->>'runId'=${target}`);
    await tx.execute(sql`delete from runs where organization_id=${org} and project_id=${project} and id=${target}`);
    await syncRetainedStorage(tx, org, { projectId: project });
  } else if (kind === 'dataset') {
    if (!project) throw new Error('Dataset deletion requires a project.');
    await tx.execute(sql`delete from experiments where organization_id=${org} and project_id=${project} and dataset_id=${target}::uuid`);
    await tx.execute(sql`delete from datasets where organization_id=${org} and project_id=${project} and id=${target}::uuid`);
    await syncRetainedStorage(tx, org, { projectId: project });
  } else {
    await enqueueArchiveCleanup(tx, org, kind === 'project' ? target : undefined);
    // Existing foundation cycles use deferred FKs, and project deletion cascades all scoped rows.
    if (kind === 'project') {
      await tx.execute(sql`delete from pgboss.job where data->>'organizationId'=${org} and data->>'projectId'=${target}`);
      await tx.execute(sql`delete from experiments where organization_id=${org} and project_id=${target}::uuid`);
      await tx.execute(sql`delete from runs where organization_id=${org} and project_id=${target}::uuid`);
      await tx.execute(sql`delete from projects where organization_id=${org} and id=${target}::uuid`);
      await syncRetainedStorage(tx, org, { projectId: target });
    } else {
      await tx.execute(sql`delete from pgboss.job where data->>'organizationId'=${org}`);
      await tx.execute(sql`delete from experiments where organization_id=${org}`);
      await tx.execute(sql`delete from runs where organization_id=${org}`);
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
    try { await tenant(org, null, async tx => {
      const [candidate] = await rows<any>(tx, sql`select * from operations_deletions where organization_id=${org} and id=${request.id} and state='pending'`); if (!candidate) return;
      if (!await prepareDeletion(tx, org, candidate.project_id, candidate.kind, candidate.target_id)) return;
      // Claim after budget acquisition: a workspace cascade must not wait on a
      // second request row whose transaction is itself waiting for this budget.
      const [item] = await rows<any>(tx, sql`select * from operations_deletions where organization_id=${org} and id=${request.id} and state='pending' for update`); if (!item) return;
      await applyDeletion(org, item.project_id, item.kind, item.target_id, tx);
      await tx.execute(sql`update operations_deletions set state='complete',completed_at=now(),target_id='[deleted]' where id=${item.id}`); deleted++;
    }); } catch (error) { if (!(error instanceof Error) || (error as any).code !== 'deletion_busy') throw error; }
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
