import { createServer } from "node:http";
import { pool, assertApplicationRole } from "@agent-quality/db";
import {
  queue,
  queueName,
  stopQueue,
  type RunJob,
} from "../../../packages/db/src/queue.ts";
import { evaluateJob } from "./evaluate.ts";
import { collectEvidence } from "../../../packages/integrations/src/providers.ts";
import { startMaintenance } from "./maintenance.ts";
import { startAlertWorkers } from "./alerts.ts";
await assertApplicationRole();
const boss = await queue();
let active = 0,
  completed = 0,
  failed = 0;
const stopMaintenance = await startMaintenance();
const stopAlerts = await startAlertWorkers();
await boss.work<RunJob>(
  queueName,
  {
    localConcurrency: 2,
    groupConcurrency: 2,
    batchSize: 2,
    pollingIntervalSeconds: 0.5,
    burstWhenBatchFull: true,
    perJobResults: true,
  },
  async (jobs) => {
    return Promise.all(
      jobs.map(async (job) => {
        active++;
        try {
          if (!job.data.instanceId) {
            failed++;
            return {
              id: job.id,
              status: "deadletter" as const,
              output: {
                code: "unbound_run_instance",
                message: "Request an explicit evaluation of the current run.",
              },
            };
          }
          await evaluateJob(job.data, { collectEvidence });
          completed++;
          return { id: job.id, status: "completed" as const };
        } catch {
          failed++;
          return {
            id: job.id,
            status: "failed" as const,
            output: { code: "evaluation_interrupted" },
          };
        } finally {
          active--;
        }
      }),
    );
  },
);
const health = createServer((_req, res) => {
  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ status: "ready", active, completed, failed }));
});
health.listen(Number(process.env.WORKER_PORT ?? 4101), "0.0.0.0");
console.log("Evaluation worker ready");
for (const signal of ["SIGINT", "SIGTERM"])
  process.once(signal, async () => {
    health.close();
    await stopMaintenance();
    await stopAlerts();
    await stopQueue();
    await pool.end();
    process.exit(0);
  });
