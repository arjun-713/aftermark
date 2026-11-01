import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { tenant, rows, sql } from '@agent-quality/db';
import { authorize } from './auth.ts';
import { assert, ApiError } from './errors.ts';
import { SupabasePrivateStore, S3DeletionSink, requestDeletion, runDocument, readArchive, reserveObject, withRunLock, archivePath, putVerified, operationsConfig } from '../../../packages/operations/src/index.ts';
import type { PrivateObjectStore, DeletionSink } from '../../../packages/operations/src/index.ts';

export async function loadRunContent(tx: Parameters<typeof runDocument>[0], project: string, run: string, store?: PrivateObjectStore) {
  const current = await runDocument(tx, project, run);
  if (!current.run.content_archived_at) return current;
  if (!store) throw new ApiError(503, 'archive_unavailable', 'Archived content is temporarily unavailable.');
  const archived = await readArchive(tx, project, run, store);
  assert(archived, 410, 'data_expired', 'Detailed run content has expired.');
  return { ...archived, run: current.run, reviews: current.reviews, decisions: current.decisions,
    evaluations: current.evaluations.map((e: any) => {
      const original = archived.evaluations.find((v: any) => v.id === e.id);
      return { ...e, frozen_input: original?.frozen_input ?? e.frozen_input, provider_response: original?.provider_response ?? e.provider_response };
    }) };
}
export async function operationsRoutes(app: FastifyInstance, options: { store?: PrivateObjectStore; deletionSink?: DeletionSink } = {}) {
  const storage = () => options.store ?? new SupabasePrivateStore();
  const journal = () => options.deletionSink ?? new S3DeletionSink();
  app.get('/v1/operations/health', async request => {
    const { projectId } = z.object({ projectId: z.uuid() }).parse(request.query);
    const a = await authorize(request, { projectId, sessionOnly: true, roles: ['owner', 'admin'] });
    return tenant(a.organizationId, a.userId, async tx => {
      const processing = await rows(tx, sql`select processing,count(*)::int as count from evaluations where project_id=${projectId} group by processing`);
      const queue = await rows(tx, sql`select name,state::text,count(*)::int as count,min(created_on) as oldest from pgboss.job where name in ('evaluate-run','evaluation-dead-letter') and data->>'organizationId'=${a.organizationId} and data->>'projectId'=${projectId} group by name,state`);
      const deadLetter = await rows(tx, sql`select id,created_on,retry_count from pgboss.job where name='evaluation-dead-letter' and data->>'organizationId'=${a.organizationId} and data->>'projectId'=${projectId} order by created_on desc limit 50`);
      const ambiguous = await rows(tx, sql`select evaluation_id,state,units,tokens,created_at from usage_ledger where project_id=${projectId} and state='ambiguous' order by created_at limit 100`);
      const [maintenance] = await rows(tx, sql`select last_success_at,archived,expired,deleted from operations_heartbeats`);
      const [deletions] = await rows(tx, sql`select count(*)::int as pending from operations_deletions where state='pending' and (project_id=${projectId} or project_id is null)`);
      return { processing, queue, deadLetter, ambiguous, maintenance: maintenance ?? null, deletions,
        semanticEnabled: process.env.SEMANTIC_EVALUATIONS_ENABLED === 'true', budgetAlertUsd: operationsConfig().BUDGET_ALERT_USD };
    });
  });
  app.post('/v1/operations/reservations/:id/reconcile', async request => {
    const { id } = z.object({ id: z.uuid() }).parse(request.params);
    const b = z.object({ projectId: z.uuid(), state: z.enum(['consumed', 'released']), tokens: z.number().int().min(0).max(10000000), providerEvidenceSha256: z.string().regex(/^[a-f0-9]{64}$/), confirmedProcessed: z.boolean() }).strict().parse(request.body);
    assert((b.state === 'consumed') === b.confirmedProcessed, 400, 'invalid_reconciliation', 'The provider evidence must confirm whether the request was processed.');
    const a = await authorize(request, { projectId: b.projectId, sessionOnly: true, roles: ['owner', 'admin'] });
    return tenant(a.organizationId, a.userId, async tx => {
      const [entry] = await rows<any>(tx, sql`select * from usage_ledger where project_id=${b.projectId} and evaluation_id=${id} and state='ambiguous' and created_at<now()-interval '15 minutes' for update`);
      assert(entry, 409, 'reservation_not_reconcilable', 'An ambiguous reservation older than 15 minutes is required.');
      await tx.execute(sql`update usage_ledger set state=${b.state},tokens=${b.tokens} where project_id=${b.projectId} and evaluation_id=${id}`);
      await tx.execute(sql`insert into audit_events(organization_id,user_id,action,resource_id,metadata) values(${a.organizationId},${a.userId},'reservation.reconciled',${id},${JSON.stringify({ state: b.state, providerEvidenceSha256: b.providerEvidenceSha256 })}::jsonb)`);
      return { evaluationId: id, state: b.state, automaticRetry: false };
    });
  });
  app.post('/v1/runs/:id/export', async request => {
    const { id } = z.object({ id: z.string().min(1).max(128) }).parse(request.params);
    const { projectId } = z.object({ projectId: z.uuid() }).parse(request.body);
    const a = await authorize(request, { projectId, scope: 'read', roles: ['owner', 'admin', 'member'] });
    const store = storage(), path = archivePath(a.organizationId, projectId), cleanup = await reserveObject(a.organizationId, path);
    return tenant(a.organizationId, a.userId, async tx => {
      const run = await withRunLock(tx, a.organizationId, projectId, id); assert(run, 404, 'not_found', 'Run is absent or expired.');
      const bytes = Buffer.from(JSON.stringify(await loadRunContent(tx, projectId, id, store)));
      const hash = await putVerified(store, path, bytes);
      const expires = new Date(Math.min(Date.now() + 3600000, new Date(run.first_ingested_at).getTime() + run.retention_days * 86400000));
      assert(expires.getTime() > Date.now(), 410, 'data_expired', 'Detailed run content has expired.');
      const [archive] = await rows<any>(tx, sql`insert into archives(organization_id,project_id,run_id,object_path,checksum,purpose,expires_at,bytes) values(${a.organizationId},${projectId},${id},${path},${hash},'export',${expires.toISOString()},${bytes.length}) returning id,checksum,expires_at`);
      await tx.execute(sql`delete from operations_object_cleanup where id=${cleanup}`);
      await tx.execute(sql`insert into audit_events(organization_id,user_id,action,resource_id) values(${a.organizationId},${a.userId},'run.export_created',${archive.id})`);
      return { ...archive, downloadPath: `/v1/archives/${archive.id}/download?projectId=${projectId}` };
    });
  });
  app.get('/v1/archives/:id/download', async request => {
    const { id } = z.object({ id: z.uuid() }).parse(request.params); const { projectId } = z.object({ projectId: z.uuid() }).parse(request.query);
    const a = await authorize(request, { projectId, scope: 'read' });
    return tenant(a.organizationId, a.userId, async tx => {
      const [archive] = await rows<any>(tx, sql`select object_path,checksum,expires_at from archives where project_id=${projectId} and id=${id} and expires_at>now() for update`);
      assert(archive, 404, 'not_found', 'Archive is absent or expired.');
      const seconds = Math.min(60, Math.floor((new Date(archive.expires_at).getTime() - Date.now()) / 1000));
      assert(seconds > 0, 410, 'data_expired', 'Archive has expired.');
      return { url: await storage().signedDownload(archive.object_path, seconds), checksum: archive.checksum, expiresIn: seconds };
    });
  });
  app.post('/v1/operations/deletions', async (request, reply) => {
    const body = z.object({ kind: z.enum(['workspace', 'project', 'run', 'dataset']), projectId: z.uuid().optional(), targetId: z.string().min(1).max(128), confirm: z.literal('delete') }).strict().parse(request.body);
    if (body.kind !== 'run') z.uuid().parse(body.targetId);
    if (['run','dataset','project'].includes(body.kind)) assert(body.projectId, 400, 'project_required', 'Select a project for this deletion.');
    const a = await authorize(request, { projectId: body.projectId, sessionOnly: true, roles: body.kind === 'workspace' ? ['owner'] : ['owner','admin'] });
    assert(body.kind !== 'workspace' || body.targetId === a.organizationId, 404, 'not_found', 'Workspace not found.');
    assert(body.kind !== 'project' || body.targetId === body.projectId, 404, 'not_found', 'Project not found.');
    const id = await requestDeletion({ organizationId: a.organizationId, userId: a.userId!, projectId: body.projectId ?? null, kind: body.kind, target: body.targetId }, journal());
    return reply.code(202).send({ id, state: 'pending', detail: 'Erasure is complete after database and object cleanup finish.' });
  });
  app.get('/v1/operations/deletions/:id', async request => {
    const { id } = z.object({ id: z.uuid() }).parse(request.params);
    const a = await authorize(request, { sessionOnly: true, roles: ['owner','admin'] });
    return tenant(a.organizationId, a.userId, async tx => {
      const [item] = await rows(tx, sql`select id,kind,state,created_at,completed_at from operations_deletions where id=${id}`);
      assert(item, 404, 'not_found', 'Deletion request not found.');
      const [cleanup] = await rows<any>(tx, sql`select count(*)::int as pending from operations_object_cleanup`);
      return { ...item, objectsPending: cleanup.pending, complete: item.state === 'complete' && cleanup.pending === 0 };
    });
  });
}
