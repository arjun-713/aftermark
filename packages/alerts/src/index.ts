import { randomUUID } from "node:crypto";
import { fromDrizzle, type PgBoss } from "pg-boss";
import { tenant, rows, sql, pool, type Tx } from "@agent-quality/db";
import { queue } from "../../db/src/queue.ts";
import {
  encrypt,
  decrypt,
  type Envelope,
} from "../../integrations/src/encryption.ts";
import { z } from "zod";
import {
  alertPayload,
  alertPayloadSchema,
  alertJobSchema,
  alertQueueName,
  alertDeadLetterQueue,
  alertLimits,
  AlertError,
  signAlert,
  type AlertJob,
  type AlertCompletion,
} from "./contracts.ts";
import {
  resolveTarget,
  sendPinned,
  type Resolver,
  type AlertTransport,
} from "./network.ts";
export * from "./contracts.ts";
export * from "./network.ts";
import {
  lockStorageBudget,
  syncRetainedStorage,
} from "../../storage-budget/src/index.ts";
async function alertTenant<T>(job: AlertJob, work: (tx: Tx) => Promise<T>) {
  return tenant(job.organizationId, null, async (tx) => {
    await lockStorageBudget(tx, job.organizationId);
    const value = await work(tx);
    await syncRetainedStorage(tx, job.organizationId, {
      projectId: job.projectId,
    });
    return value;
  });
}

const initialized = new WeakMap<PgBoss, Promise<PgBoss>>();
export async function initializeAlertQueues() {
  const boss = await queue();
  let ready = initialized.get(boss);
  if (!ready) {
    ready = (async () => {
      await boss.createQueue(alertDeadLetterQueue, {
        retryLimit: 4,
        retryDelay: 5,
        retryBackoff: true,
        retryDelayMax: 60,
        expireInSeconds: 60,
      });
      await boss.createQueue(alertQueueName, {
        retryLimit: alertLimits.attempts - 1,
        retryDelay: 5,
        retryBackoff: true,
        retryDelayMax: 60,
        expireInSeconds: 60,
        deadLetter: alertDeadLetterQueue,
      });
      return boss;
    })().catch((error) => {
      initialized.delete(boss);
      throw error;
    });
    initialized.set(boss, ready);
  }
  return ready;
}
export async function encryptAlertSecret(
  secret: string,
  destinationId: string,
  organizationId: string,
  projectId: string,
) {
  z.string().min(32).max(256).parse(secret);
  return encrypt(
    { purpose: "project-alert-signing", destinationId, secret },
    { organizationId, projectId },
  );
}
async function signingSecret(
  envelope: Envelope,
  destinationId: string,
  organizationId: string,
  projectId: string,
) {
  let timer: NodeJS.Timeout | undefined;
  try {
    const raw = await Promise.race([
      decrypt(envelope, { organizationId, projectId }),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new AlertError("timeout")), 15000);
      }),
    ]);
    return z
      .object({
        purpose: z.literal("project-alert-signing"),
        destinationId: z.literal(destinationId),
        secret: z.string().min(32).max(256),
      })
      .strict()
      .parse(raw).secret;
  } catch (error) {
    throw error instanceof AlertError
      ? error
      : new AlertError("secret_invalid");
  } finally {
    if (timer) clearTimeout(timer);
  }
}
async function enqueueAlert(tx: Tx, boss: PgBoss, data: AlertJob) {
  const id = await boss.send(alertQueueName, data, {
    db: fromDrizzle(tx, sql),
    singletonKey: `${data.deliveryId}:${data.generation}`,
    group: { id: data.organizationId },
  });
  if (!id) throw new Error("Alert queue rejected a unique delivery.");
  return id;
}
/** Call after persisting assessment, inside the SAME tenant transaction that completes the evaluation. */
export async function scheduleEvaluationAlerts(tx: Tx, input: AlertCompletion) {
  const destinations = await rows<{ id: string }>(
    tx,
    sql`select id from alert_destinations where project_id=${input.projectId} and enabled and ${input.assessment.decision}=any(decisions)`,
  );
  if (!destinations.length) return 0;
  const boss = await initializeAlertQueues();
  let scheduled = 0;
  for (const destination of destinations) {
    const id = randomUUID(),
      rawBody = JSON.stringify(alertPayload(input, id));
    const inserted = await rows(
      tx,
      sql`insert into alert_deliveries(organization_id,project_id,id,destination_id,evaluation_id,raw_body) values(${input.organizationId},${input.projectId},${id},${destination.id},${input.evaluationId},${rawBody}) on conflict(organization_id,project_id,evaluation_id,destination_id) do nothing returning id`,
    );
    if (!inserted.length) continue;
    const jobId = await enqueueAlert(tx, boss, {
      organizationId: input.organizationId,
      projectId: input.projectId,
      deliveryId: id,
      generation: 0,
    });
    await tx.execute(
      sql`update alert_deliveries set queue_job_id=${jobId} where project_id=${input.projectId} and id=${id}`,
    );
    scheduled++;
  }
  return scheduled;
}
export type AlertAttempt = { data: AlertJob; retryCount: number };
export async function runAlertDelivery(
  attempt: AlertAttempt,
  options: {
    resolver?: Resolver;
    transport?: AlertTransport;
    now?: () => number;
  } = {},
) {
  const job = alertJobSchema.parse(attempt.data),
    connection = await pool.connect();
  const lock = `project-alert:${job.deliveryId}`;
  try {
    const held = await connection.query(
      "select pg_try_advisory_lock(hashtextextended($1,0)) as held",
      [lock],
    );
    if (!held.rows[0].held) throw new AlertError("transport_failed");
    const prepared = await alertTenant(job, async (tx) => {
      const [delivery] = await rows<any>(
        tx,
        sql`select d.*,c.enabled,c.url,c.secret_envelope,c.secret_version from alert_deliveries d join alert_destinations c on c.organization_id=d.organization_id and c.project_id=d.project_id and c.id=d.destination_id where d.project_id=${job.projectId} and d.id=${job.deliveryId} for update of d`,
      );
      if (
        !delivery ||
        delivery.generation !== job.generation ||
        ["delivered", "dead_letter", "disabled"].includes(delivery.state)
      )
        return null;
      if (!delivery.enabled) {
        await tx.execute(
          sql`update alert_deliveries set state='disabled' where project_id=${job.projectId} and id=${job.deliveryId}`,
        );
        return null;
      }
      if (delivery.generation_attempts >= alertLimits.attempts) {
        await tx.execute(
          sql`update alert_deliveries set state='dead_letter' where project_id=${job.projectId} and id=${job.deliveryId}`,
        );
        return null;
      }
      // Validate the stored whitelist before any egress. Raw bytes stay identical across attempts and replays.
      const payload = alertPayloadSchema.parse(JSON.parse(delivery.raw_body));
      if (
        payload.id !== delivery.id ||
        payload.projectId !== job.projectId ||
        payload.evaluationId !== delivery.evaluation_id
      )
        throw new AlertError("transport_failed");
      await tx.execute(
        sql`update alert_deliveries set state='delivering',attempt_count=attempt_count+1,generation_attempts=generation_attempts+1,last_attempt_at=now() where project_id=${job.projectId} and id=${job.deliveryId}`,
      );
      return delivery;
    });
    if (!prepared) return { state: "ignored" };
    let status: number | undefined;
    try {
      const target = await resolveTarget(prepared.url, options.resolver);
      const secret = await signingSecret(
        prepared.secret_envelope,
        prepared.destination_id,
        job.organizationId,
        job.projectId,
      );
      const timestamp = String(
        Math.floor((options.now?.() ?? Date.now()) / 1000),
      );
      const headers = {
        "content-type": "application/json",
        "content-length": String(Buffer.byteLength(prepared.raw_body, "utf8")),
        "x-aq-event-id": job.deliveryId,
        "idempotency-key": job.deliveryId,
        "x-aq-timestamp": timestamp,
        "x-aq-signature": signAlert(secret, timestamp, prepared.raw_body),
        "x-aq-key-version": String(prepared.secret_version),
      };
      status = await (options.transport ?? sendPinned)(
        target,
        headers,
        prepared.raw_body,
      );
      if (!Number.isInteger(status) || status < 100 || status > 599)
        throw new AlertError("transport_failed");
      if (status < 200 || status >= 300)
        throw new AlertError(
          status >= 300 && status < 400
            ? "redirect_rejected"
            : status >= 500
              ? "http_5xx"
              : "http_4xx",
          status,
        );
      await alertTenant(job, (tx) =>
        tx.execute(
          sql`update alert_deliveries set state='delivered',last_status=${status},last_error=null,delivered_at=now() where project_id=${job.projectId} and id=${job.deliveryId} and generation=${job.generation}`,
        ),
      );
      return { state: "delivered" };
    } catch (error) {
      const failure =
        error instanceof AlertError
          ? error
          : new AlertError("transport_failed");
      const exhausted =
        attempt.retryCount >= alertLimits.attempts - 1 ||
        prepared.generation_attempts + 1 >= alertLimits.attempts;
      await alertTenant(job, (tx) =>
        tx.execute(
          sql`update alert_deliveries set state=${exhausted ? "dead_letter" : "retrying"},last_status=${status ?? failure.statusCode ?? null},last_error=${failure.code} where project_id=${job.projectId} and id=${job.deliveryId} and generation=${job.generation}`,
        ),
      );
      throw failure;
    }
  } finally {
    await connection
      .query("select pg_advisory_unlock(hashtextextended($1,0))", [lock])
      .catch(() => {});
    connection.release();
  }
}
/** Also runs after a worker died during its final attempt, when no normal failure update could commit. */
export async function markAlertDeadLetter(data: AlertJob) {
  const job = alertJobSchema.parse(data);
  await alertTenant(job, (tx) =>
    tx.execute(
      sql`update alert_deliveries set state='dead_letter',last_error=coalesce(last_error,'transport_failed') where project_id=${job.projectId} and id=${job.deliveryId} and generation=${job.generation} and state not in('delivered','disabled')`,
    ),
  );
}
export async function replayAlert(
  tx: Tx,
  input: {
    organizationId: string;
    projectId: string;
    deliveryId: string;
    expectedGeneration: number;
  },
) {
  const [delivery] = await rows<any>(
    tx,
    sql`select d.*,c.enabled,exists(select 1 from pgboss.job j where j.name=${alertDeadLetterQueue} and j.data->>'organizationId'=d.organization_id::text and j.data->>'projectId'=d.project_id::text and j.data->>'deliveryId'=d.id::text and j.data->>'generation'=d.generation::text) as native_dead_letter from alert_deliveries d join alert_destinations c on c.organization_id=d.organization_id and c.project_id=d.project_id and c.id=d.destination_id where d.project_id=${input.projectId} and d.id=${input.deliveryId} for update of d`,
  );
  if (
    !delivery ||
    delivery.generation !== input.expectedGeneration ||
    !(
      ["dead_letter", "disabled"].includes(delivery.state) ||
      (delivery.native_dead_letter && delivery.state !== "delivered")
    ) ||
    !delivery.enabled ||
    delivery.replay_count >= alertLimits.replays ||
    (delivery.last_replayed_at &&
      new Date(delivery.last_replayed_at).getTime() >
        Date.now() - alertLimits.replayCooldownSeconds * 1000)
  )
    return null;
  const generation = delivery.generation + 1,
    boss = await initializeAlertQueues();
  const jobId = await enqueueAlert(tx, boss, {
    organizationId: input.organizationId,
    projectId: input.projectId,
    deliveryId: input.deliveryId,
    generation,
  });
  await tx.execute(
    sql`update alert_deliveries set state='pending',generation=${generation},generation_attempts=0,replay_count=replay_count+1,queue_job_id=${jobId},last_replayed_at=now(),last_error=null,last_status=null where project_id=${input.projectId} and id=${input.deliveryId}`,
  );
  return {
    id: input.deliveryId,
    generation,
    state: "pending",
    eventId: input.deliveryId,
  };
}
