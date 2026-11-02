"use client";
import { useQuery } from "@tanstack/react-query";
import { api } from "../lib/api";
import { useScope } from "./app-shell";
import { ErrorState, Loading } from "./ui";
const mib = (bytes: number) =>
  `${(bytes / 1048576).toLocaleString(undefined, { maximumFractionDigits: 1 })} MiB`;
export function StorageUsage() {
  const s = useScope();
  const query = useQuery<any>({
    queryKey: ["storage-usage", s.workspaceId],
    queryFn: () => api("/storage/usage", s.workspaceId),
    enabled: !!s.workspaceId,
    refetchInterval: 15000,
  });
  return (
    <section className="settings-row">
      <div>
        <h2>Retained content</h2>
        <p>
          Trace content, frozen evaluations, curated copies and private objects
          have a separate storage limit. Evaluation units and payment status are
          tracked independently.
        </p>
        <p>
          Content stays counted until deletion succeeds. Lowering retention does
          not immediately restore space.
        </p>
      </div>
      <div className="settings-panel">
        {query.isPending ? (
          <Loading rows={3} />
        ) : query.error ? (
          <ErrorState error={query.error} retry={() => query.refetch()} />
        ) : query.data ? (
          <>
            <h3>
              {mib(query.data.usedBytes)} of {mib(query.data.limitBytes)}
            </h3>
            <div
              className="quota-track"
              role="meter"
              aria-label="Retained-content storage used"
              aria-valuemin={0}
              aria-valuemax={query.data.limitBytes}
              aria-valuenow={Math.min(
                query.data.usedBytes,
                query.data.limitBytes,
              )}
              aria-valuetext={`${mib(query.data.usedBytes)} retained, ${mib(query.data.remainingBytes)} writable capacity`}
            >
              <span
                style={{
                  display: "block",
                  height: "100%",
                  width: `${Math.min(100, (query.data.usedBytes / query.data.limitBytes) * 100)}%`,
                  background: "var(--accent,#087d77)",
                }}
              />
            </div>
            <p className="muted small">
              {query.data.state === "measurement_required"
                ? "An existing private object needs its size verified. New content is paused until it is measured or deleted."
                : query.data.state === "backfill_required"
                  ? "Storage accounting is awaiting maintenance initialization. Existing content is included in this estimate."
                  : query.data.overLimit
                    ? "Storage is above the current plan limit. Delete retained content before adding more."
                    : `${mib(query.data.remainingBytes)} remaining under the ${query.data.plan} storage cap.`}
            </p>
            <p className="muted small">
              Logical retained-content quota; database files, indexes, recovery
              backups and audit metadata have separate operational limits.
            </p>
          </>
        ) : null}
      </div>
    </section>
  );
}
