import type { FastifyInstance, FastifyRequest } from 'fastify';
import { rows, sql, tenant, type Tx } from '../../db/src/index.ts';
import { appliedStorageLimit, archiveObjectBytes, resourceOverheadBytes, safeBytes, storageCategories, storageLimits, StorageBudgetError, StorageLimitError, type StorageCategory, type StorageLimits } from './policy.ts';
export * from './policy.ts';

export type StorageScope = { projectId?: string; runId?: string };
export type StorageIdentity = { category: StorageCategory; resourceId: string; projectId?: string | null; runId?: string | null };
export type StorageResource = StorageIdentity & { bytes: number; state?: 'reserved' | 'retained'; unmeasured?: boolean };
type Stored = { category: StorageCategory; resource_key: string; project_id: string | null; run_id: string | null; bytes: string | number; state: 'reserved' | 'retained'; unmeasured: boolean };
type Options = { limits?: StorageLimits };
type Change = { category: StorageCategory; key: string; projectId: string | null; runId: string | null; bytes: number; state: 'reserved' | 'retained'; unmeasured: boolean; remove?: boolean };
const keyFor = (identity: StorageIdentity) => identity.category === 'archive_objects' || identity.category === 'cleanup_records' ? identity.resourceId : JSON.stringify([identity.projectId ?? null, identity.resourceId]);
const identityKey = (category: string, key: string) => JSON.stringify([category, key]);
const fromStored = (row: Stored): Change => ({ category: row.category, key: row.resource_key, projectId: row.project_id, runId: row.run_id, bytes: safeBytes(row.bytes), state: row.state, unmeasured: row.unmeasured });
const sameScope = (row: Change, scope?: StorageScope) => (!scope?.projectId || row.projectId === scope.projectId) && (!scope?.runId || row.runId === scope.runId);

async function assertScope(tx: Tx, organizationId: string) {
  const [context] = await rows<{ organization_id: string | null }>(tx, sql`select current_org()::text as organization_id`);
  if (!organizationId || context.organization_id !== organizationId) throw new StorageBudgetError('storage_scope_invalid', 'Storage accounting requires the current authenticated workspace.', 403);
}
async function storedRows(tx: Tx, organizationId: string) { return rows<Stored>(tx, sql`select category,resource_key,project_id,run_id,bytes,state,unmeasured from storage_resources where organization_id=${organizationId}`); }
async function policy(tx: Tx, organizationId: string, options: Options) {
  const [subscription] = await rows<any>(tx, sql`select plan,status,period_end,provider_id,reconciled_at from subscriptions where organization_id=${organizationId}`);
  return appliedStorageLimit(subscription, options.limits ?? storageLimits());
}
function resourceChange(resource: StorageResource): Change {
  if (!storageCategories.includes(resource.category) || typeof resource.resourceId !== 'string' || !resource.resourceId || resource.resourceId.length > 2048) throw new StorageBudgetError('storage_identity_invalid', 'Storage resource identity is invalid.', 400);
  if (!['archive_objects', 'cleanup_records'].includes(resource.category) && !resource.projectId) throw new StorageBudgetError('storage_project_required', 'Retained content accounting requires its project.', 400);
  const key = keyFor(resource), bytes = safeBytes(resource.bytes);
  if (key.length > 4096 || resource.category === 'archive_objects' && !resource.unmeasured && bytes < resourceOverheadBytes) throw new StorageBudgetError('storage_identity_invalid', 'Object charges must include resource overhead and valid identities.', 400);
  return { category: resource.category, key, projectId: resource.projectId ?? null, runId: resource.runId ?? null, bytes, state: resource.state ?? 'retained', unmeasured: resource.unmeasured ?? false };
}
async function assertProjects(tx: Tx, organizationId: string, resources: StorageResource[]) {
  const projects = [...new Set(resources.flatMap(resource => resource.projectId ? [resource.projectId] : []))];
  if (!projects.length) return;
  const existing = await rows<{ id: string }>(tx, sql`select id from projects where organization_id=${organizationId} and id in (${sql.join(projects.map(id => sql`${id}::uuid`), sql`,`)})`);
  if (existing.length !== projects.length) throw new StorageBudgetError('storage_project_invalid', 'A storage resource project does not belong to this workspace.', 403);
}

/** Canonical row measurement includes metadata and every persisted content copy. */
async function canonicalRows(tx: Tx, organizationId: string, scope?: StorageScope): Promise<Change[]> {
  const query = (category: StorageCategory, table: string, id: string, run: string, extra = '') => sql`select ${category}::text as category,${sql.raw(id)}::text as resource_id,t.project_id,${sql.raw(run)}::text as run_id,(2*octet_length(convert_to(to_jsonb(t)::text,'UTF8'))+${resourceOverheadBytes})::bigint as bytes from ${sql.raw(table)} t ${sql.raw(extra)} where t.organization_id=${organizationId} and (${scope?.projectId ?? null}::uuid is null or t.project_id=${scope?.projectId ?? null}::uuid) and (${scope?.runId ?? null}::text is null or ${sql.raw(run)}=${scope?.runId ?? null}::text)`;
  const queries = [query('runs', 'runs', 't.id', 't.id'), query('events', 'events', 't.event_id', 't.run_id'), query('event_keys', 'event_keys', 't.event_id', 't.run_id'), query('evidence', 'evidence', 't.id', 't.run_id'), query('evaluations', 'evaluations', 't.id', 't.run_id'), query('reviews', 'reviews', 't.id', 't.run_id'), query('review_decisions', 'review_decisions', 't.id', 'r.run_id', 'join reviews r on r.organization_id=t.organization_id and r.project_id=t.project_id and r.id=t.review_id'), query('datasets', 'datasets', 't.id', 'null::text'), query('experiments', 'experiments', 't.id', 'null::text'), query('calibration_reports', 'calibration_reports', 't.id', 'null::text'), query('archives', 'archives', 't.id', 't.run_id')];
  const [optional] = await rows<any>(tx, sql`select to_regclass('public.operations_object_cleanup') is not null as cleanup,to_regclass('public.alert_deliveries') is not null as alerts`);
  if (optional.alerts) queries.push(query('alert_payloads', 'alert_deliveries', 't.id', 'e.run_id', 'join evaluations e on e.organization_id=t.organization_id and e.project_id=t.project_id and e.id=t.evaluation_id'));
  const source = await rows<any>(tx, sql.join(queries, sql` union all `));
  const measuredRows = new Map<string, Change>();
  for (const row of source) {
    const measured = resourceChange({ category: row.category, resourceId: row.resource_id, projectId: row.project_id, runId: row.run_id, bytes: safeBytes(row.bytes) });
    const key = identityKey(measured.category, measured.key), existing = measuredRows.get(key);
    if (existing && existing.runId !== measured.runId) throw new StorageBudgetError('storage_identity_conflict', 'Retained rows disagree about their resource identity.');
    measuredRows.set(key, existing ? { ...existing, bytes: safeBytes(existing.bytes + measured.bytes) } : measured);
  }
  const result = [...measuredRows.values()];
  // An object path is one physical object, even when a pointer and cleanup row overlap.
  const objects = await rows<any>(tx, sql`select object_path,max(nullif(to_jsonb(a)->>'bytes','')::bigint) as bytes,min(project_id::text) as project_id,min(run_id) as run_id from archives a where organization_id=${organizationId} group by object_path`);
  const previous = (await storedRows(tx, organizationId)).filter(row => row.category === 'archive_objects');
  const objectsByPath = new Map<string, Change>(previous.map(row => [row.resource_key, fromStored(row)]));
  for (const object of objects) {
    const measured = object.bytes != null && safeBytes(object.bytes) > 0;
    const existing = objectsByPath.get(object.object_path);
    objectsByPath.set(object.object_path, { category: 'archive_objects', key: object.object_path, projectId: object.project_id, runId: object.run_id, bytes: measured ? archiveObjectBytes(safeBytes(object.bytes)) : existing?.bytes ?? 0, state: 'retained', unmeasured: measured ? false : existing?.unmeasured ?? true });
  }
  if (optional.cleanup) {
    const cleanup = await rows<any>(tx, sql`select id,object_path,(2*octet_length(convert_to(to_jsonb(t)::text,'UTF8'))+${resourceOverheadBytes})::bigint as bytes from operations_object_cleanup t where organization_id=${organizationId}`);
    for (const item of cleanup) {
      result.push({ category: 'cleanup_records', key: item.id, projectId: null, runId: null, bytes: safeBytes(item.bytes), state: 'retained', unmeasured: false });
      if (!objectsByPath.has(item.object_path)) objectsByPath.set(item.object_path, { category: 'archive_objects', key: item.object_path, projectId: null, runId: null, bytes: 0, state: 'reserved', unmeasured: true });
    }
  }
  result.push(...objectsByPath.values());
  return result;
}

async function writeChanges(tx: Tx, organizationId: string, changes: Change[]) {
  for (const change of changes) {
    if (change.remove) await tx.execute(sql`delete from storage_resources where organization_id=${organizationId} and category=${change.category} and resource_key=${change.key}`);
    else await tx.execute(sql`insert into storage_resources(organization_id,category,resource_key,project_id,run_id,bytes,state,unmeasured) values(${organizationId},${change.category},${change.key},${change.projectId},${change.runId},${change.bytes},${change.state},${change.unmeasured}) on conflict(organization_id,category,resource_key) do update set project_id=excluded.project_id,run_id=excluded.run_id,bytes=excluded.bytes,state=excluded.state,unmeasured=excluded.unmeasured,updated_at=now()`);
  }
  const [{ bytes }] = await rows<{ bytes: string }>(tx, sql`select coalesce(sum(bytes),0)::text as bytes from storage_resources where organization_id=${organizationId}`);
  const used = safeBytes(bytes);
  await tx.execute(sql`update storage_budgets set used_bytes=${used},initialized=true,updated_at=now() where organization_id=${organizationId}`);
  return used;
}
function reconciledChanges(current: Change[], canonical: Change[], scope?: StorageScope) {
  const present = new Set(canonical.map(row => identityKey(row.category, row.key)));
  const removed = current.filter(row => row.category !== 'archive_objects' && row.state !== 'reserved' && (row.category === 'cleanup_records' || sameScope(row, scope)) && !present.has(identityKey(row.category, row.key))).map(row => ({ ...row, remove: true }));
  return [...removed, ...canonical];
}

/** Acquire before content row locks. Backfill can report over-limit usage; it grants no space. */
export async function lockStorageBudget(tx: Tx, organizationId: string, _options: Options = {}) {
  await assertScope(tx, organizationId);
  await tx.execute(sql`insert into storage_budgets(organization_id) values(${organizationId}) on conflict do nothing`);
  const [budget] = await rows<{ initialized: boolean; used_bytes: string }>(tx, sql`select initialized,used_bytes from storage_budgets where organization_id=${organizationId} for update`);
  if (!budget.initialized) {
    const current = (await storedRows(tx, organizationId)).map(fromStored);
    return writeChanges(tx, organizationId, reconciledChanges(current, await canonicalRows(tx, organizationId)));
  }
  return safeBytes(budget.used_bytes);
}
export const bootstrapStorageBudget = lockStorageBudget;

async function applyChanges(tx: Tx, organizationId: string, changes: Change[], options: Options = {}) {
  const used = await lockStorageBudget(tx, organizationId, options);
  const current = (await storedRows(tx, organizationId)).map(fromStored);
  const entries = new Map(current.map(row => [identityKey(row.category, row.key), row]));
  const seen = new Set<string>();
  for (const change of changes) {
    const key = identityKey(change.category, change.key);
    if (seen.has(key)) throw new StorageBudgetError('storage_duplicate_change', 'A resource may be resized only once per accounting batch.', 400);
    seen.add(key);
    const existing = entries.get(key);
    if (existing && change.category !== 'archive_objects' && (existing.projectId !== change.projectId || existing.runId !== change.runId)) throw new StorageBudgetError('storage_identity_conflict', 'The storage resource identity was reused for different content scope.');
    if (change.remove) entries.delete(key); else entries.set(key, change);
  }
  const next = safeBytes([...entries.values()].reduce((sum, row) => sum + row.bytes, 0));
  const unknown = [...entries.values()].some(row => row.unmeasured);
  const applied = await policy(tx, organizationId, options);
  if (next > used && unknown) throw new StorageBudgetError('storage_measurement_required', 'An existing retained object needs its size verified before storage can grow.', 409);
  if (next > used && next > applied.limitBytes) throw new StorageLimitError(applied.limitBytes, used, next - used);
  await writeChanges(tx, organizationId, changes);
  return { usedBytes: next, ...applied };
}
export async function setStorageResources(tx: Tx, organizationId: string, resources: StorageResource[], options: Options = {}) {
  await assertScope(tx, organizationId); await assertProjects(tx, organizationId, resources);
  return applyChanges(tx, organizationId, resources.map(resourceChange), options);
}
export async function setStorageBytes(tx: Tx, organizationId: string, resource: StorageResource, options: Options = {}) { return setStorageResources(tx, organizationId, [resource], options); }
/** Reservation bytes are an absolute total for this identity, never an increment. */
export async function reserveStorageBytes(tx: Tx, organizationId: string, resource: StorageResource, options: Options = {}) {
  await lockStorageBudget(tx, organizationId, options);
  await assertProjects(tx, organizationId, [resource]);
  const change = resourceChange({ ...resource, state: 'reserved' });
  const previous = (await storedRows(tx, organizationId)).find(row => row.category === change.category && row.resource_key === change.key);
  if (previous && change.category !== 'archive_objects' && (previous.project_id !== change.projectId || previous.run_id !== change.runId)) throw new StorageBudgetError('storage_identity_conflict', 'The storage resource identity was reused for different content scope.');
  if (previous && safeBytes(previous.bytes) >= change.bytes) return { usedBytes: await lockStorageBudget(tx, organizationId, options), ...await policy(tx, organizationId, options) };
  return applyChanges(tx, organizationId, [change], options);
}
export async function releaseStorageBytes(tx: Tx, organizationId: string, resource: StorageIdentity, options: Options = {}) {
  if (resource.category === 'archive_objects') throw new StorageBudgetError('storage_object_confirmation_required', 'Release retained objects only after successful object deletion.');
  return applyChanges(tx, organizationId, [{ ...resourceChange({ ...resource, bytes: 0 }), remove: true }], options);
}
/** Call only AFTER the private store confirmed removal, in the cleanup outbox transaction. */
export async function releaseArchiveObject(tx: Tx, organizationId: string, objectPath: string, options: Options = {}) {
  await assertScope(tx, organizationId);
  const [workspace] = await rows(tx, sql`select id from organizations where id=${organizationId}`);
  if (!workspace) return { usedBytes: 0, deletedWorkspace: true };
  if (!objectPath || objectPath.length > 2048) throw new StorageBudgetError('storage_identity_invalid', 'Storage object identity is invalid.', 400);
  return applyChanges(tx, organizationId, [{ category: 'archive_objects', key: objectPath, projectId: null, runId: null, bytes: 0, state: 'retained', unmeasured: false, remove: true }], options);
}
/** Call after content mutations, before commit; deletion and replacement have one net charge. */
export async function syncRetainedStorage(tx: Tx, organizationId: string, scope?: StorageScope, options: Options = {}) {
  if (scope?.runId && !scope.projectId) throw new StorageBudgetError('storage_project_required', 'Run accounting requires its project.', 400);
  await lockStorageBudget(tx, organizationId, options);
  const current = (await storedRows(tx, organizationId)).map(fromStored);
  return applyChanges(tx, organizationId, reconciledChanges(current, await canonicalRows(tx, organizationId, scope), scope), options);
}

/** Pure read: an unbootstrapped workspace exposes no writable remaining capacity. */
export async function readStorageUsage(tx: Tx, organizationId: string, options: Options = {}) {
  await assertScope(tx, organizationId);
  const applied = await policy(tx, organizationId, options);
  const [budget] = await rows<{ initialized: boolean; used_bytes: string }>(tx, sql`select initialized,used_bytes from storage_budgets where organization_id=${organizationId}`);
  const resources = budget?.initialized ? (await storedRows(tx, organizationId)).map(fromStored) : await canonicalRows(tx, organizationId);
  const categories = Object.fromEntries(storageCategories.map(category => [category, { bytes: 0, resources: 0 }])) as Record<StorageCategory, { bytes: number; resources: number }>;
  for (const resource of resources) { categories[resource.category].bytes = safeBytes(categories[resource.category].bytes + resource.bytes); categories[resource.category].resources++; }
  const usedBytes = safeBytes(resources.reduce((sum, resource) => sum + resource.bytes, 0));
  const unmeasuredObjects = resources.filter(resource => resource.unmeasured).length;
  const state = !budget?.initialized ? 'backfill_required' : unmeasuredObjects ? 'measurement_required' : 'ready';
  return { ...applied, usedBytes, remainingBytes: state === 'ready' ? Math.max(0, applied.limitBytes - usedBytes) : 0, overLimit: usedBytes > applied.limitBytes, unmeasuredObjects, state, categories, units: 'bytes' as const };
}
export async function storageBudgetRoutes(app: FastifyInstance, options: { authorize: (request: FastifyRequest) => Promise<{ organizationId: string; userId: string | null }>; limits?: StorageLimits }) {
  app.get('/v1/storage/usage', async request => { const identity = await options.authorize(request); return tenant(identity.organizationId, identity.userId, tx => readStorageUsage(tx, identity.organizationId, options)); });
}
