import { tenant, rows, sql } from "@agent-quality/db";
import {
  operationsConfig,
  SupabasePrivateStore,
  maintainWorkspace,
  processDeletions,
  cleanupObjects,
} from "../../../packages/operations/src/index.ts";
import type { PrivateObjectStore } from "../../../packages/operations/src/storage.ts";
import {
  billingConfig,
  DodoProvider,
  reconcileBilling,
} from "../../../packages/billing/src/index.ts";

/** One in-flight cycle per worker. Per-run database locks protect overlap across worker replicas. */
export async function startMaintenance(
  options: {
    store?: PrivateObjectStore;
    onStatus?: (status: { success: boolean; durationMs: number }) => void;
  } = {},
) {
  const store =
    options.store ??
    (process.env.SUPABASE_SERVICE_ROLE_KEY
      ? new SupabasePrivateStore()
      : undefined);
  let stopping = false,
    timer: NodeJS.Timeout | undefined,
    inFlight: Promise<void> = Promise.resolve();
  let lastBillingSuccess = 0;
  const cycle = async () => {
    const start = performance.now();
    try {
      await tenant('',null,tx=>tx.execute(sql`select operations_ensure_event_partitions()`));
      const workspaces = await tenant("", null, (tx) =>
        rows<any>(tx, sql`select operations_workspace_ids() as id`),
      );
      let failures = 0;
      for (const { id } of workspaces) {
        if (stopping) break;
        try {
          await processDeletions(id, store);
          await maintainWorkspace(id, store);
        } catch {
          failures++;
          process.stderr.write(
            "Workspace maintenance failed; durable tasks will retry.\n",
          );
        }
      }
      // Cleanup outlives a workspace. Discover only the opaque org IDs of due cleanup records.
      const orphaned = await tenant("", null, (tx) =>
        rows<any>(tx, sql`select operations_cleanup_workspace_ids() as id`),
      );
      if (store) for (const { id } of orphaned) await cleanupObjects(id, store);
      if (!stopping && Date.now() - lastBillingSuccess >= 86400000) {
        const settings = billingConfig();
        const result = await reconcileBilling(
          settings ? new DodoProvider(settings) : null,
        );
        if (result.failed === 0) lastBillingSuccess = Date.now();
        else failures++;
      }
      options.onStatus?.({
        success: failures === 0,
        durationMs: performance.now() - start,
      });
    } catch {
      options.onStatus?.({
        success: false,
        durationMs: performance.now() - start,
      });
      process.stderr.write(
        "Maintenance cycle failed; durable tasks will retry.\n",
      );
    }
  };
  const schedule = () => {
    if (!stopping)
      timer = setTimeout(() => {
        inFlight = cycle().finally(schedule);
      }, operationsConfig().OPERATIONS_INTERVAL_MS).unref();
  };
  inFlight = cycle().finally(schedule);
  return async () => {
    stopping = true;
    if (timer) clearTimeout(timer);
    await inFlight;
  };
}
