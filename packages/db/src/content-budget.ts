import { rows, sql, type Tx } from "./index.ts";
export const contentLimits = Object.freeze({
  runEvents: 2000,
  runBytes: 4 * 1024 * 1024,
  datasetBytes: 8 * 1024 * 1024,
  comparisonBytes: 16 * 1024 * 1024,
});
export class ContentLimitError extends Error {
  statusCode = 413;
  code = "run_content_limit";
  constructor() {
    super(
      "This run exceeds 2,000 events or 4 MiB of redacted event and evidence content. Split the workflow into linked runs or reduce captured payloads. The complete incoming batch was rolled back.",
    );
  }
}
/** Measure in PostgreSQL before loading a customer-controlled trace into worker memory. */
export async function assertRunContentBudget(
  tx: Tx,
  projectId: string,
  runId: string,
) {
  const [usage] = await rows<{ events: number; bytes: string }>(
    tx,
    sql`select (select count(*) from events where project_id=${projectId} and run_id=${runId})::int as events,((select coalesce(sum(octet_length(event::text)),0) from events where project_id=${projectId} and run_id=${runId})+(select coalesce(sum(octet_length(body::text)),0) from evidence where project_id=${projectId} and run_id=${runId}))::text as bytes`,
  );
  if (
    usage.events > contentLimits.runEvents ||
    Number(usage.bytes) > contentLimits.runBytes
  )
    throw new ContentLimitError();
}
