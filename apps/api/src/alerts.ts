import {
  lockStorageBudget,
  syncRetainedStorage,
} from "../../../packages/storage-budget/src/index.ts";
import { randomBytes, randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { tenant, rows, sql } from "@agent-quality/db";
import { authorize } from "./auth.ts";
import { assert, ApiError } from "./errors.ts";
import { audit } from "./management.ts";
import {
  initializeAlertQueues,
  encryptAlertSecret,
  resolveTarget,
  replayAlert,
  alertStates,
  alertLimits,
  alertQueueName,
  alertDeadLetterQueue,
  type Resolver,
} from "../../../packages/alerts/src/index.ts";

const projectQuery = z.object({ projectId: z.uuid() });
const params = z.object({ id: z.uuid() });
const decisions = z
  .array(z.enum(["pass", "fail", "review", "unknown"]))
  .min(1)
  .max(4)
  .refine((v) => new Set(v).size === v.length, "Decisions must be unique.");
const publicColumns = sql`id,name,url,enabled,decisions,secret_version,created_at,updated_at`;
export async function alertRoutes(
  app: FastifyInstance,
  options: { resolver?: Resolver } = {},
) {
  app.addHook("onReady", async () => {
    await initializeAlertQueues();
  });
  app.get("/v1/alerts/destinations", async (request) => {
    const { projectId } = projectQuery.parse(request.query);
    const a = await authorize(request, {
      projectId,
      roles: ["owner", "admin"],
      sessionOnly: true,
    });
    return tenant(a.organizationId, a.userId, (tx) =>
      rows(
        tx,
        sql`select ${publicColumns} from alert_destinations where project_id=${projectId} order by created_at,id`,
      ),
    );
  });
  app.post("/v1/alerts/destinations", async (request, reply) => {
    const body = z
      .object({
        projectId: z.uuid(),
        name: z.string().trim().min(1).max(80),
        url: z.string().min(1).max(2048),
        decisions: decisions.default(["fail", "review", "unknown"]),
        signingSecret: z.string().min(32).max(256).optional(),
      })
      .strict()
      .parse(request.body);
    const a = await authorize(request, {
      projectId: body.projectId,
      roles: ["owner", "admin"],
      sessionOnly: true,
    });
    let target;
    try {
      target = await resolveTarget(body.url, options.resolver);
    } catch {
      throw new ApiError(
        400,
        "invalid_alert_destination",
        "Use a reachable public HTTPS hostname on port443 without URL credentials, query parameters or fragments.",
      );
    }
    const id = randomUUID(),
      secret = body.signingSecret ?? randomBytes(32).toString("base64url");
    const envelope = await encryptAlertSecret(
      secret,
      id,
      a.organizationId,
      body.projectId,
    );
    const created = await tenant(a.organizationId, a.userId, async (tx) => {
      await tx.execute(
        sql`select id from projects where id=${body.projectId} for update`,
      );
      const [{ count }] = await rows<{ count: number }>(
        tx,
        sql`select count(*)::int as count from alert_destinations where project_id=${body.projectId}`,
      );
      assert(
        count < alertLimits.destinations,
        409,
        "alert_destination_limit",
        "Delete an existing destination before configuring another. The limit is five per project.",
      );
      const [created] = await rows(
        tx,
        sql`insert into alert_destinations(organization_id,project_id,id,name,url,secret_envelope,created_by,decisions) values(${a.organizationId},${body.projectId},${id},${body.name},${target.url.href},${JSON.stringify(envelope)}::jsonb,${a.userId},ARRAY[${sql.join(
          body.decisions.map((d) => sql`${d}`),
          sql`, `,
        )}]::text[]) on conflict(organization_id,project_id,url) do nothing returning ${publicColumns}`,
      );
      assert(
        created,
        409,
        "alert_destination_exists",
        "This endpoint is already configured in the project.",
      );
      await audit(
        tx,
        a.organizationId,
        a.userId,
        "alert.destination_created",
        id,
      );
      return { ...created, signingSecret: secret, secretShownOnce: true };
    });
    return reply.code(201).send(created);
  });
  app.patch("/v1/alerts/destinations/:id", async (request) => {
    const { id } = params.parse(request.params);
    const body = z
      .object({
        projectId: z.uuid(),
        enabled: z.boolean(),
        decisions: decisions.optional(),
      })
      .strict()
      .parse(request.body);
    const a = await authorize(request, {
      projectId: body.projectId,
      roles: ["owner", "admin"],
      sessionOnly: true,
    });
    return tenant(a.organizationId, a.userId, async (tx) => {
      const updateDecisions = body.decisions
        ? sql`decisions=ARRAY[${sql.join(
            body.decisions.map((d) => sql`${d}`),
            sql`, `,
          )}]::text[],`
        : sql``;
      const [destination] = await rows(
        tx,
        sql`update alert_destinations set enabled=${body.enabled},${updateDecisions}updated_at=now() where project_id=${body.projectId} and id=${id} returning ${publicColumns}`,
      );
      assert(destination, 404, "not_found", "Alert destination not found.");
      await audit(
        tx,
        a.organizationId,
        a.userId,
        body.enabled
          ? "alert.destination_enabled"
          : "alert.destination_disabled",
        id,
      );
      return destination;
    });
  });
  app.post("/v1/alerts/destinations/:id/rotate-secret", async (request) => {
    const { id } = params.parse(request.params);
    const { projectId } = projectQuery.strict().parse(request.body);
    const a = await authorize(request, {
      projectId,
      roles: ["owner", "admin"],
      sessionOnly: true,
    });
    const secret = randomBytes(32).toString("base64url"),
      envelope = await encryptAlertSecret(
        secret,
        id,
        a.organizationId,
        projectId,
      );
    return tenant(a.organizationId, a.userId, async (tx) => {
      const [destination] = await rows(
        tx,
        sql`update alert_destinations set secret_envelope=${JSON.stringify(envelope)}::jsonb,secret_version=secret_version+1,updated_at=now() where project_id=${projectId} and id=${id} returning ${publicColumns}`,
      );
      assert(destination, 404, "not_found", "Alert destination not found.");
      await audit(tx, a.organizationId, a.userId, "alert.secret_rotated", id);
      return { ...destination, signingSecret: secret, secretShownOnce: true };
    });
  });
  app.delete("/v1/alerts/destinations/:id", async (request) => {
    const { id } = params.parse(request.params);
    const { projectId } = projectQuery.parse(request.query);
    const a = await authorize(request, {
      projectId,
      roles: ["owner", "admin"],
      sessionOnly: true,
    });
    return tenant(a.organizationId, a.userId, async (tx) => {
      await lockStorageBudget(tx, a.organizationId);
      await tx.execute(
        sql`delete from pgboss.job where name in(${alertQueueName},${alertDeadLetterQueue}) and data->>'organizationId'=${a.organizationId} and data->>'projectId'=${projectId} and data->>'deliveryId' in (select id::text from alert_deliveries where project_id=${projectId} and destination_id=${id})`,
      );
      const deleted = await rows(
        tx,
        sql`delete from alert_destinations where project_id=${projectId} and id=${id} returning id`,
      );
      assert(deleted.length, 404, "not_found", "Alert destination not found.");
      await audit(
        tx,
        a.organizationId,
        a.userId,
        "alert.destination_deleted",
        id,
      );
      await syncRetainedStorage(tx, a.organizationId, { projectId });
      return { deleted: true };
    });
  });
  app.get("/v1/alerts/health", async (request) => {
    const { projectId } = projectQuery.parse(request.query);
    const a = await authorize(request, {
      projectId,
      roles: ["owner", "admin"],
      sessionOnly: true,
    });
    return tenant(a.organizationId, a.userId, async (tx) => ({
      states: await rows(
        tx,
        sql`select state,count(*)::int as count,min(created_at) as oldest from alert_deliveries where project_id=${projectId} group by state`,
      ),
      queues: await rows(
        tx,
        sql`select name,state::text,count(*)::int as count,min(created_on) as oldest from pgboss.job where name in(${alertQueueName},${alertDeadLetterQueue}) and data->>'organizationId'=${a.organizationId} and data->>'projectId'=${projectId} group by name,state`,
      ),
      deadLetters: await rows(
        tx,
        sql`select id,destination_id,evaluation_id,generation,attempt_count,replay_count,last_error,last_status,last_attempt_at from alert_deliveries where project_id=${projectId} and state='dead_letter' order by last_attempt_at desc limit 50`,
      ),
      limits: alertLimits,
    }));
  });
  app.get("/v1/alerts/deliveries", async (request) => {
    const { projectId, state } = projectQuery
      .extend({ state: z.enum(alertStates).optional() })
      .parse(request.query);
    const a = await authorize(request, {
      projectId,
      roles: ["owner", "admin"],
      sessionOnly: true,
    });
    return tenant(a.organizationId, a.userId, (tx) =>
      rows(
        tx,
        sql`select id,destination_id,evaluation_id,state,generation,attempt_count,replay_count,last_status,last_error,created_at,last_attempt_at,delivered_at from alert_deliveries where project_id=${projectId} and (${state ?? null}::text is null or state=${state ?? null}) order by created_at desc,id limit 50`,
      ),
    );
  });
  app.post("/v1/alerts/deliveries/:id/replay", async (request, reply) => {
    const { id } = params.parse(request.params);
    const body = z
      .object({
        projectId: z.uuid(),
        expectedGeneration: z.number().int().nonnegative(),
        confirm: z.literal("replay"),
      })
      .strict()
      .parse(request.body);
    const a = await authorize(request, {
      projectId: body.projectId,
      roles: ["owner", "admin"],
      sessionOnly: true,
    });
    const queued = await tenant(a.organizationId, a.userId, async (tx) => {
      await lockStorageBudget(tx, a.organizationId);
      const replay = await replayAlert(tx, {
        organizationId: a.organizationId,
        projectId: body.projectId,
        deliveryId: id,
        expectedGeneration: body.expectedGeneration,
      });
      assert(
        replay,
        409,
        "alert_replay_conflict",
        "Replay requires a failed or disabled delivery, an enabled destination, the current generation, fewer than three replays and a60-second cooldown.",
      );
      await audit(
        tx,
        a.organizationId,
        a.userId,
        "alert.delivery_replayed",
        id,
      );
      await syncRetainedStorage(tx, a.organizationId, {
        projectId: body.projectId,
      });
      return replay;
    });
    return reply.code(202).send(queued);
  });
}
