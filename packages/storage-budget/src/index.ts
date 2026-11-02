import type { FastifyInstance, FastifyRequest } from "fastify";
import { rows, sql, tenant, type Tx } from "../../db/src/index.ts";
import {
  appliedStorageLimit,
  archiveObjectBytes,
  resourceOverheadBytes,
  safeBytes,
  storageCategories,
  storageLimits,
  StorageBudgetError,
  StorageLimitError,
  type StorageCategory,
  type StorageLimits,
} from "./policy.ts";
export * from "./policy.ts";

export type StorageScope = {
  projectId?: string;
  runId?: string;
  runIds?: string[];
};
export type StorageIdentity = {
  category: StorageCategory;
  resourceId: string;
  projectId?: string | null;
  runId?: string | null;
};
export type StorageResource = StorageIdentity & {
  bytes: number;
  state?: "reserved" | "retained";
  unmeasured?: boolean;
};
type Stored = {
  category: StorageCategory;
  resource_key: string;
  project_id: string | null;
  run_id: string | null;
  bytes: string | number;
  state: "reserved" | "retained";
  unmeasured: boolean;
};
type Options = { limits?: StorageLimits };
type Change = {
  category: StorageCategory;
  key: string;
  projectId: string | null;
  runId: string | null;
  bytes: number;
  state: "reserved" | "retained";
  unmeasured: boolean;
  remove?: boolean;
};
const keyFor = (identity: StorageIdentity) =>
  identity.category === "archive_objects" ||
  identity.category === "cleanup_records"
    ? identity.resourceId
    : JSON.stringify([identity.projectId ?? null, identity.resourceId]);
const identityKey = (category: string, key: string) =>
  JSON.stringify([category, key]);
const fromStored = (row: Stored): Change => ({
  category: row.category,
  key: row.resource_key,
  projectId: row.project_id,
  runId: row.run_id,
  bytes: safeBytes(row.bytes),
  state: row.state,
  unmeasured: row.unmeasured,
});
const sameScope = (row: Change, scope?: StorageScope) =>
  (!scope?.projectId || row.projectId === scope.projectId) &&
  (!scope?.runId || row.runId === scope.runId) &&
  (!scope?.runIds || (row.runId !== null && scope.runIds.includes(row.runId)));

async function assertScope(tx: Tx, organizationId: string) {
  const [context] = await rows<{ organization_id: string | null }>(
    tx,
    sql`select current_org()::text as organization_id`,
  );
  if (!organizationId || context.organization_id !== organizationId)
    throw new StorageBudgetError(
      "storage_scope_invalid",
      "Storage accounting requires the current authenticated workspace.",
      403,
    );
}
async function storedRows(
  tx: Tx,
  organizationId: string,
  scope?: StorageScope,
) {
  const selected = scope?.projectId
    ? sql`and (category in('archive_objects','cleanup_records') or (project_id=${scope.projectId}::uuid and (${scope.runId ?? null}::text is null or run_id=${scope.runId ?? null}::text) and (${sql.param(scope.runIds ?? null)}::text[] is null or run_id=any(${sql.param(scope.runIds ?? null)}::text[]))))`
    : sql``;
  return rows<Stored>(
    tx,
    sql`select category,resource_key,project_id,run_id,bytes,state,unmeasured from storage_resources where organization_id=${organizationId} ${selected}`,
  );
}
async function policy(tx: Tx, organizationId: string, options: Options) {
  const [subscription] = await rows<any>(
    tx,
    sql`select plan,status,period_end,provider_id,reconciled_at from subscriptions where organization_id=${organizationId}`,
  );
  return appliedStorageLimit(subscription, options.limits ?? storageLimits());
}
function resourceChange(resource: StorageResource): Change {
  if (
    !storageCategories.includes(resource.category) ||
    typeof resource.resourceId !== "string" ||
    !resource.resourceId ||
    resource.resourceId.length > 2048
  )
    throw new StorageBudgetError(
      "storage_identity_invalid",
      "Storage resource identity is invalid.",
      400,
    );
  if (
    !["archive_objects", "cleanup_records"].includes(resource.category) &&
    !resource.projectId
  )
    throw new StorageBudgetError(
      "storage_project_required",
      "Retained content accounting requires its project.",
      400,
    );
  const key = keyFor(resource),
    bytes = safeBytes(resource.bytes);
  if (
    key.length > 4096 ||
    (resource.category === "archive_objects" &&
      !resource.unmeasured &&
      bytes < resourceOverheadBytes)
  )
    throw new StorageBudgetError(
      "storage_identity_invalid",
      "Object charges must include resource overhead and valid identities.",
      400,
    );
  return {
    category: resource.category,
    key,
    projectId: resource.projectId ?? null,
    runId: resource.runId ?? null,
    bytes,
    state: resource.state ?? "retained",
    unmeasured: resource.unmeasured ?? false,
  };
}
async function assertProjects(
  tx: Tx,
  organizationId: string,
  resources: StorageResource[],
) {
  const projects = [
    ...new Set(
      resources.flatMap((resource) =>
        resource.projectId ? [resource.projectId] : [],
      ),
    ),
  ];
  if (!projects.length) return;
  const existing = await rows<{ id: string }>(
    tx,
    sql`select id from projects where organization_id=${organizationId} and id in (${sql.join(
      projects.map((id) => sql`${id}::uuid`),
      sql`,`,
    )})`,
  );
  if (existing.length !== projects.length)
    throw new StorageBudgetError(
      "storage_project_invalid",
      "A storage resource project does not belong to this workspace.",
      403,
    );
}

/** Canonical row measurement includes metadata and every persisted content copy. */
async function canonicalRows(
  tx: Tx,
  organizationId: string,
  scope?: StorageScope,
): Promise<Change[]> {
  const query = (
    category: StorageCategory,
    table: string,
    id: string,
    run: string,
    extra = "",
  ) =>
    sql`select ${category}::text as category,${sql.raw(id)}::text as resource_id,t.project_id,${sql.raw(run)}::text as run_id,(2*octet_length(convert_to(to_jsonb(t)::text,'UTF8'))+${resourceOverheadBytes})::bigint as bytes from ${sql.raw(table)} t ${sql.raw(extra)} where t.organization_id=${organizationId} and (${scope?.projectId ?? null}::uuid is null or t.project_id=${scope?.projectId ?? null}::uuid) and (${scope?.runId ?? null}::text is null or ${sql.raw(run)}=${scope?.runId ?? null}::text) and (${sql.param(scope?.runIds ?? null)}::text[] is null or ${sql.raw(run)}=any(${sql.param(scope?.runIds ?? null)}::text[]))`;
  const queries = [
    query("runs", "runs", "t.id", "t.id"),
    query("events", "events", "t.event_id", "t.run_id"),
    query("event_keys", "event_keys", "t.event_id", "t.run_id"),
    query("evidence", "evidence", "t.id", "t.run_id"),
    query("evaluations", "evaluations", "t.id", "t.run_id"),
    query("reviews", "reviews", "t.id", "t.run_id"),
    query(
      "review_decisions",
      "review_decisions",
      "t.id",
      "r.run_id",
      "join reviews r on r.organization_id=t.organization_id and r.project_id=t.project_id and r.id=t.review_id",
    ),
    query("datasets", "datasets", "t.id", "null::text"),
    query("experiments", "experiments", "t.id", "null::text"),
    query("calibration_reports", "calibration_reports", "t.id", "null::text"),
    query("archives", "archives", "t.id", "t.run_id"),
  ];
  const [optional] = await rows<any>(
    tx,
    sql`select to_regclass('public.operations_object_cleanup') is not null as cleanup,to_regclass('public.alert_deliveries') is not null as alerts,to_regclass('public.evaluation_attempts') is not null as attempts`,
  );
  if (optional.attempts)
    queries.push(
      query(
        "evaluation_attempts",
        "evaluation_attempts",
        "t.evaluation_id::text || ':' || t.attempt_number::text",
        "e.run_id",
        "join evaluations e on e.organization_id=t.organization_id and e.project_id=t.project_id and e.id=t.evaluation_id",
      ),
    );
  if (optional.alerts)
    queries.push(
      query(
        "alert_payloads",
        "alert_deliveries",
        "t.id",
        "e.run_id",
        "join evaluations e on e.organization_id=t.organization_id and e.project_id=t.project_id and e.id=t.evaluation_id",
      ),
    );
  const source = await rows<any>(tx, sql.join(queries, sql` union all `));
  const measuredRows = new Map<string, Change>();
  for (const row of source) {
    const measured = resourceChange({
      category: row.category,
      resourceId: row.resource_id,
      projectId: row.project_id,
      runId: row.run_id,
      bytes: safeBytes(row.bytes),
    });
    const key = identityKey(measured.category, measured.key),
      existing = measuredRows.get(key);
    if (existing && existing.runId !== measured.runId)
      throw new StorageBudgetError(
        "storage_identity_conflict",
        "Retained rows disagree about their resource identity.",
      );
    measuredRows.set(
      key,
      existing
        ? { ...existing, bytes: safeBytes(existing.bytes + measured.bytes) }
        : measured,
    );
  }
  const result = [...measuredRows.values()];
  // An object path is one physical object, even when a pointer and cleanup row overlap.
  const objects = await rows<any>(
    tx,
    sql`select object_path,max(nullif(to_jsonb(a)->>'bytes','')::bigint) as bytes,min(project_id::text) as project_id,min(run_id) as run_id from archives a where organization_id=${organizationId} group by object_path`,
  );
  const previous = await rows<Stored>(
    tx,
    sql`select category,resource_key,project_id,run_id,bytes,state,unmeasured from storage_resources where organization_id=${organizationId} and category='archive_objects'`,
  );
  const objectsByPath = new Map<string, Change>(
    previous.map((row) => [row.resource_key, fromStored(row)]),
  );
  for (const object of objects) {
    const measured = object.bytes != null && safeBytes(object.bytes) > 0;
    const existing = objectsByPath.get(object.object_path);
    objectsByPath.set(object.object_path, {
      category: "archive_objects",
      key: object.object_path,
      projectId: object.project_id,
      runId: object.run_id,
      bytes: measured
        ? archiveObjectBytes(safeBytes(object.bytes))
        : (existing?.bytes ?? 0),
      state: "retained",
      unmeasured: measured ? false : (existing?.unmeasured ?? true),
    });
  }
  if (optional.cleanup) {
    const cleanup = await rows<any>(
      tx,
      sql`select id,object_path,(2*octet_length(convert_to(to_jsonb(t)::text,'UTF8'))+${resourceOverheadBytes})::bigint as bytes from operations_object_cleanup t where organization_id=${organizationId}`,
    );
    for (const item of cleanup) {
      result.push({
        category: "cleanup_records",
        key: item.id,
        projectId: null,
        runId: null,
        bytes: safeBytes(item.bytes),
        state: "retained",
        unmeasured: false,
      });
      if (!objectsByPath.has(item.object_path))
        objectsByPath.set(item.object_path, {
          category: "archive_objects",
          key: item.object_path,
          projectId: null,
          runId: null,
          bytes: 0,
          state: "reserved",
          unmeasured: true,
        });
    }
  }
  result.push(...objectsByPath.values());
  return result;
}

async function writeChanges(
  tx: Tx,
  organizationId: string,
  changes: Change[],
  expectedUsed?: number,
) {
  const removed = changes.filter((change) => change.remove),
    retained = changes.filter((change) => !change.remove);
  // Small bounded statements avoid one round trip per resource and PostgreSQL's
  // parameter limit during a large bootstrap or project reconciliation.
  for (let i = 0; i < removed.length; i += 500) {
    const batch = removed.slice(i, i + 500);
    await tx.execute(
      sql`delete from storage_resources where organization_id=${organizationId} and (category,resource_key) in (${sql.join(
        batch.map((c) => sql`(${c.category},${c.key})`),
        sql`,`,
      )})`,
    );
  }
  for (let i = 0; i < retained.length; i += 500) {
    const batch = retained.slice(i, i + 500);
    await tx.execute(
      sql`insert into storage_resources(organization_id,category,resource_key,project_id,run_id,bytes,state,unmeasured) values ${sql.join(
        batch.map(
          (c) =>
            sql`(${organizationId},${c.category},${c.key},${c.projectId},${c.runId},${c.bytes},${c.state},${c.unmeasured})`,
        ),
        sql`,`,
      )} on conflict(organization_id,category,resource_key) do update set project_id=excluded.project_id,run_id=excluded.run_id,bytes=excluded.bytes,state=excluded.state,unmeasured=excluded.unmeasured,updated_at=now()`,
    );
  }
  const used =
    expectedUsed === undefined
      ? safeBytes(
          (
            await rows<{ bytes: string }>(
              tx,
              sql`select coalesce(sum(bytes),0)::text as bytes from storage_resources where organization_id=${organizationId}`,
            )
          )[0].bytes,
        )
      : safeBytes(expectedUsed);
  await tx.execute(
    sql`update storage_budgets set used_bytes=${used},initialized=true,updated_at=now() where organization_id=${organizationId}`,
  );
  return used;
}
function reconciledChanges(
  current: Change[],
  canonical: Change[],
  scope?: StorageScope,
) {
  const present = new Set(
    canonical.map((row) => identityKey(row.category, row.key)),
  );
  const removed = current
    .filter(
      (row) =>
        row.category !== "archive_objects" &&
        row.state !== "reserved" &&
        (row.category === "cleanup_records" || sameScope(row, scope)) &&
        !present.has(identityKey(row.category, row.key)),
    )
    .map((row) => ({ ...row, remove: true }));
  return [...removed, ...canonical];
}

/** Acquire before content row locks. Backfill can report over-limit usage; it grants no space. */
export async function lockStorageBudget(
  tx: Tx,
  organizationId: string,
  _options: Options = {},
) {
  await assertScope(tx, organizationId);
  await tx.execute(
    sql`insert into storage_budgets(organization_id) values(${organizationId}) on conflict do nothing`,
  );
  const [budget] = await rows<{ initialized: boolean; used_bytes: string }>(
    tx,
    sql`select initialized,used_bytes from storage_budgets where organization_id=${organizationId} for update`,
  );
  if (!budget.initialized) {
    const current = (await storedRows(tx, organizationId)).map(fromStored);
    return writeChanges(
      tx,
      organizationId,
      reconciledChanges(current, await canonicalRows(tx, organizationId)),
    );
  }
  return safeBytes(budget.used_bytes);
}
export const bootstrapStorageBudget = lockStorageBudget;

async function applyChanges(
  tx: Tx,
  organizationId: string,
  changes: Change[],
  options: Options = {},
) {
  const used = await lockStorageBudget(tx, organizationId, options);
  const current =
    changes.length > 500
      ? await storedRows(tx, organizationId)
      : changes.length
        ? await rows<Stored>(
            tx,
            sql`select category,resource_key,project_id,run_id,bytes,state,unmeasured from storage_resources where organization_id=${organizationId} and (category,resource_key) in (${sql.join(
              changes.map((c) => sql`(${c.category},${c.key})`),
              sql`,`,
            )})`,
          )
        : [];
  const entries = new Map(
    current.map((row) => [
      identityKey(row.category, row.resource_key),
      fromStored(row),
    ]),
  );
  const unknownRows = await rows<{ category: string; resource_key: string }>(
    tx,
    sql`select category,resource_key from storage_resources where organization_id=${organizationId} and unmeasured`,
  );
  const unknown = new Set(
    unknownRows.map((row) => identityKey(row.category, row.resource_key)),
  );
  const seen = new Set<string>(),
    writes: Change[] = [];
  let delta = 0;
  for (const change of changes) {
    const key = identityKey(change.category, change.key);
    if (seen.has(key))
      throw new StorageBudgetError(
        "storage_duplicate_change",
        "A resource may be resized only once per accounting batch.",
        400,
      );
    seen.add(key);
    const existing = entries.get(key);
    if (
      existing &&
      change.category !== "archive_objects" &&
      (existing.projectId !== change.projectId ||
        existing.runId !== change.runId)
    )
      throw new StorageBudgetError(
        "storage_identity_conflict",
        "The storage resource identity was reused for different content scope.",
      );
    delta += (change.remove ? 0 : change.bytes) - (existing?.bytes ?? 0);
    if (change.remove || !change.unmeasured) unknown.delete(key);
    else unknown.add(key);
    const identical =
      existing &&
      !change.remove &&
      existing.bytes === change.bytes &&
      existing.state === change.state &&
      existing.unmeasured === change.unmeasured &&
      existing.projectId === change.projectId &&
      existing.runId === change.runId;
    if (!identical && (!change.remove || existing)) writes.push(change);
  }
  const next = safeBytes(used + delta),
    applied = await policy(tx, organizationId, options);
  if (next > used && unknown.size)
    throw new StorageBudgetError(
      "storage_measurement_required",
      "An existing retained object needs its size verified before storage can grow.",
      409,
    );
  if (next > used && next > applied.limitBytes)
    throw new StorageLimitError(applied.limitBytes, used, next - used);
  if (writes.length) await writeChanges(tx, organizationId, writes, next);
  return { usedBytes: next, ...applied };
}
export async function setStorageResources(
  tx: Tx,
  organizationId: string,
  resources: StorageResource[],
  options: Options = {},
) {
  await assertScope(tx, organizationId);
  await assertProjects(tx, organizationId, resources);
  return applyChanges(
    tx,
    organizationId,
    resources.map(resourceChange),
    options,
  );
}
export async function setStorageBytes(
  tx: Tx,
  organizationId: string,
  resource: StorageResource,
  options: Options = {},
) {
  return setStorageResources(tx, organizationId, [resource], options);
}
/** Reservation bytes are an absolute total for this identity, never an increment. */
export async function reserveStorageBytes(
  tx: Tx,
  organizationId: string,
  resource: StorageResource,
  options: Options = {},
) {
  await lockStorageBudget(tx, organizationId, options);
  await assertProjects(tx, organizationId, [resource]);
  const change = resourceChange({ ...resource, state: "reserved" });
  const [previous] = await rows<Stored>(
    tx,
    sql`select category,resource_key,project_id,run_id,bytes,state,unmeasured from storage_resources where organization_id=${organizationId} and category=${change.category} and resource_key=${change.key}`,
  );
  if (
    previous &&
    change.category !== "archive_objects" &&
    (previous.project_id !== change.projectId ||
      previous.run_id !== change.runId)
  )
    throw new StorageBudgetError(
      "storage_identity_conflict",
      "The storage resource identity was reused for different content scope.",
    );
  if (previous && safeBytes(previous.bytes) >= change.bytes)
    return {
      usedBytes: await lockStorageBudget(tx, organizationId, options),
      ...(await policy(tx, organizationId, options)),
    };
  return applyChanges(tx, organizationId, [change], options);
}
export async function releaseStorageBytes(
  tx: Tx,
  organizationId: string,
  resource: StorageIdentity,
  options: Options = {},
) {
  if (resource.category === "archive_objects")
    throw new StorageBudgetError(
      "storage_object_confirmation_required",
      "Release retained objects only after successful object deletion.",
    );
  return applyChanges(
    tx,
    organizationId,
    [{ ...resourceChange({ ...resource, bytes: 0 }), remove: true }],
    options,
  );
}
/** Call only AFTER the private store confirmed removal, in the cleanup outbox transaction. */
export async function releaseArchiveObject(
  tx: Tx,
  organizationId: string,
  objectPath: string,
  options: Options = {},
) {
  await assertScope(tx, organizationId);
  const [workspace] = await rows(
    tx,
    sql`select id from organizations where id=${organizationId}`,
  );
  if (!workspace) return { usedBytes: 0, deletedWorkspace: true };
  if (!objectPath || objectPath.length > 2048)
    throw new StorageBudgetError(
      "storage_identity_invalid",
      "Storage object identity is invalid.",
      400,
    );
  return applyChanges(
    tx,
    organizationId,
    [
      {
        category: "archive_objects",
        key: objectPath,
        projectId: null,
        runId: null,
        bytes: 0,
        state: "retained",
        unmeasured: false,
        remove: true,
      },
    ],
    options,
  );
}
/** Call after content mutations, before commit; deletion and replacement have one net charge. */
export async function syncRetainedStorage(
  tx: Tx,
  organizationId: string,
  scope?: StorageScope,
  options: Options = {},
) {
  if ((scope?.runId || scope?.runIds) && !scope.projectId)
    throw new StorageBudgetError(
      "storage_project_required",
      "Run accounting requires its project.",
      400,
    );
  if (
    scope?.runIds &&
    (scope.runId || !scope.runIds.length || scope.runIds.length > 100)
  )
    throw new StorageBudgetError(
      "storage_scope_invalid",
      "Batch accounting requires 1–100 run IDs and no single-run scope.",
      400,
    );
  await lockStorageBudget(tx, organizationId, options);
  const current = (await storedRows(tx, organizationId, scope)).map(fromStored);
  return applyChanges(
    tx,
    organizationId,
    reconciledChanges(
      current,
      await canonicalRows(tx, organizationId, scope),
      scope,
    ),
    options,
  );
}

/** Pure read: an unbootstrapped workspace exposes no writable remaining capacity. */
export async function readStorageUsage(
  tx: Tx,
  organizationId: string,
  options: Options = {},
) {
  await assertScope(tx, organizationId);
  const applied = await policy(tx, organizationId, options);
  const [budget] = await rows<{ initialized: boolean; used_bytes: string }>(
    tx,
    sql`select initialized,used_bytes from storage_budgets where organization_id=${organizationId}`,
  );
  const resources = budget?.initialized
    ? (await storedRows(tx, organizationId)).map(fromStored)
    : await canonicalRows(tx, organizationId);
  const categories = Object.fromEntries(
    storageCategories.map((category) => [category, { bytes: 0, resources: 0 }]),
  ) as Record<StorageCategory, { bytes: number; resources: number }>;
  for (const resource of resources) {
    categories[resource.category].bytes = safeBytes(
      categories[resource.category].bytes + resource.bytes,
    );
    categories[resource.category].resources++;
  }
  const usedBytes = safeBytes(
    resources.reduce((sum, resource) => sum + resource.bytes, 0),
  );
  const unmeasuredObjects = resources.filter(
    (resource) => resource.unmeasured,
  ).length;
  const state = !budget?.initialized
    ? "backfill_required"
    : unmeasuredObjects
      ? "measurement_required"
      : "ready";
  return {
    ...applied,
    usedBytes,
    remainingBytes:
      state === "ready" ? Math.max(0, applied.limitBytes - usedBytes) : 0,
    overLimit: usedBytes > applied.limitBytes,
    unmeasuredObjects,
    state,
    categories,
    units: "bytes" as const,
  };
}
export async function storageBudgetRoutes(
  app: FastifyInstance,
  options: {
    authorize: (
      request: FastifyRequest,
    ) => Promise<{ organizationId: string; userId: string | null }>;
    limits?: StorageLimits;
  },
) {
  app.get("/v1/storage/usage", async (request) => {
    const identity = await options.authorize(request);
    return tenant(identity.organizationId, identity.userId, (tx) =>
      readStorageUsage(tx, identity.organizationId, options),
    );
  });
}
