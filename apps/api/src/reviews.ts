import {
  lockStorageBudget,
  syncRetainedStorage,
} from "../../../packages/storage-budget/src/index.ts";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { tenant, rows, sql } from "@agent-quality/db";
import { authorize } from "./auth.ts";
import { assert } from "./errors.ts";
import { audit } from "./management.ts";
import { redact } from "../../../packages/contracts/src/redaction.ts";
import { loadRunContent } from "./operations.ts";
export async function reviewRoutes(app: FastifyInstance) {
  app.get("/v1/overview", async (request) => {
    const { projectId } = z
      .object({ projectId: z.uuid() })
      .parse(request.query);
    const a = await authorize(request, { scope: "read", projectId });
    return tenant(a.organizationId, a.userId, async (tx) => {
      const [metrics] = await rows<any>(
        tx,
        sql`select count(*)::int as total,count(*) filter(where execution_status<>'running')::int as terminal,count(*) filter(where e.revision=r.revision and execution_status<>'running' and e.processing in('completed','partial'))::int as evaluated,count(*) filter(where e.revision=r.revision and e.assessment->>'decision'='pass')::int as passed,count(*) filter(where e.revision=r.revision and (e.assessment->>'verifiedCompletion')::boolean)::int as verified,count(*) filter(where e.revision=r.revision and e.assessment->>'decision'='fail')::int as failed,count(*) filter(where e.revision=r.revision and e.assessment->>'decision'='unknown')::int as unknown,count(*) filter(where e.revision=r.revision and e.assessment->>'decision'='review')::int as needs_review from runs r left join evaluations e on e.organization_id=r.organization_id and e.project_id=r.project_id and e.id=r.latest_evaluation_id where r.project_id=${projectId}`,
      );
      const [{ open_reviews }] = await rows<any>(
        tx,
        sql`select count(*)::int as open_reviews from reviews where project_id=${projectId} and status<>'resolved'`,
      );
      const attention = await rows(
        tx,
        sql`select r.id,r.agent,r.agent_version,r.environment,r.started_at,e.id as evaluation_id,e.assessment,rev.id as review_id,rev.status as review_status,(select ev.event->'payload'->>'text' from events ev where ev.organization_id=r.organization_id and ev.project_id=r.project_id and ev.run_id=r.id and ev.event->>'kind' in('run.completed','run.failed','message') and ev.event->'payload'->>'text' is not null order by ev.event->>'timestamp' desc limit 1) as claim,(select jsonb_agg(jsonb_build_object('id',ob.id)||ob.body) from evidence ob where ob.organization_id=r.organization_id and ob.project_id=r.project_id and ob.run_id=r.id) as observations from runs r join evaluations e on e.organization_id=r.organization_id and e.project_id=r.project_id and e.id=r.latest_evaluation_id left join reviews rev on rev.organization_id=e.organization_id and rev.project_id=e.project_id and rev.evaluation_id=e.id where r.project_id=${projectId} and e.assessment->>'decision'<>'pass' and coalesce(rev.status,'open')<>'resolved' order by case when e.assessment->>'decision'='fail' then 0 else 1 end,r.started_at desc limit 4`,
      );
      const daily = await rows(
        tx,
        sql`select date_trunc('day',r.started_at) as day,count(*)::int as runs,count(*) filter(where e.assessment->>'decision'='pass')::int as passed,count(*) filter(where e.assessment->>'decision'='fail')::int as failed from runs r left join evaluations e on e.organization_id=r.organization_id and e.project_id=r.project_id and e.id=r.latest_evaluation_id where r.project_id=${projectId} and r.started_at>now()-interval '7 days' group by 1 order by 1`,
      );
      return {
        metrics: {
          ...metrics,
          open_reviews,
          coverage: metrics.terminal
            ? metrics.evaluated / metrics.terminal
            : null,
        },
        attention,
        daily,
        updatedAt: new Date().toISOString(),
      };
    });
  });
  app.get("/v1/reviews", async (request) => {
    const q = z
      .object({
        projectId: z.uuid(),
        status: z.enum(["open", "resolved", "disputed", "all"]).default("open"),
        assigned: z.enum(["all", "mine", "unassigned"]).default("all"),
      })
      .parse(request.query);
    const a = await authorize(request, {
      scope: "read",
      projectId: q.projectId,
    });
    return tenant(a.organizationId, a.userId, (tx) =>
      rows(
        tx,
        sql`select rev.*,r.agent,r.agent_version,r.environment,e.assessment,e.revision as evaluated_revision,r.revision as current_revision from reviews rev join runs r on r.organization_id=rev.organization_id and r.project_id=rev.project_id and r.id=rev.run_id join evaluations e on e.organization_id=rev.organization_id and e.project_id=rev.project_id and e.id=rev.evaluation_id where rev.project_id=${q.projectId} and (${q.status}='all' or rev.status=${q.status}) and (${q.assigned}='all' or ${q.assigned}='mine' and rev.assigned_to=${a.userId}::uuid or ${q.assigned}='unassigned' and rev.assigned_to is null) order by case when e.assessment->>'decision'='fail' then 0 when e.assessment->>'decision'='unknown' then 1 else 2 end,rev.created_at desc limit 100`,
      ),
    );
  });
  app.post("/v1/reviews/:id/claim", async (request) => {
    const { id } = z.object({ id: z.uuid() }).parse(request.params);
    const body = z
      .object({
        projectId: z.uuid(),
        expectedVersion: z.number().int().positive(),
        release: z.boolean().default(false),
      })
      .parse(request.body);
    const a = await authorize(request, {
      sessionOnly: true,
      roles: ["owner", "admin", "member"],
      projectId: body.projectId,
    });
    return tenant(a.organizationId, a.userId, async (tx) => {
      await lockStorageBudget(tx, a.organizationId);
      const changed = await rows(
        tx,
        sql`update reviews set assigned_to=${body.release ? null : a.userId},version=version+1 where project_id=${body.projectId} and id=${id} and version=${body.expectedVersion} and (assigned_to is null or assigned_to=${a.userId}) returning *`,
      );
      assert(
        changed.length,
        409,
        "review_conflict",
        "This review changed or was claimed by another reviewer. Refresh to continue.",
      );
      await audit(
        tx,
        a.organizationId,
        a.userId,
        body.release ? "review.released" : "review.claimed",
        id,
      );
      await syncRetainedStorage(tx, a.organizationId, {
        projectId: body.projectId,
        runId: changed[0].run_id,
      });
      return changed[0];
    });
  });
  app.post("/v1/reviews/:id/decisions", async (request) => {
    const { id } = z.object({ id: z.uuid() }).parse(request.params);
    const body = z
      .object({
        projectId: z.uuid(),
        expectedVersion: z.number().int().positive(),
        decision: z.enum(["pass", "fail", "unknown"]),
        annotation: z.string().min(3).max(5000),
        disagree: z.boolean().default(false),
      })
      .parse(request.body);
    const a = await authorize(request, {
      sessionOnly: true,
      roles: ["owner", "admin", "member"],
      projectId: body.projectId,
    });
    return tenant(a.organizationId, a.userId, async (tx) => {
      await lockStorageBudget(tx, a.organizationId);
      body.annotation = redact(body.annotation);
      const status = body.disagree
        ? "disputed"
        : body.decision === "unknown"
          ? "open"
          : "resolved";
      const changed = await rows<any>(
        tx,
        sql`update reviews set decision=${body.decision},annotation=${body.annotation},status=${status},version=version+1 where project_id=${body.projectId} and id=${id} and version=${body.expectedVersion} and assigned_to=${a.userId} returning *`,
      );
      assert(
        changed.length,
        409,
        "review_conflict",
        "Claim this review and refresh its current version before submitting.",
      );
      await tx.execute(
        sql`insert into review_decisions(organization_id,project_id,review_id,reviewer_id,version,decision,annotation) values(${a.organizationId},${body.projectId},${id},${a.userId},${changed[0].version},${body.decision},${body.annotation})`,
      );
      await audit(tx, a.organizationId, a.userId, "review.decided", id);
      await syncRetainedStorage(tx, a.organizationId, {
        projectId: body.projectId,
        runId: changed[0].run_id,
      });
      return changed[0];
    });
  });
  app.get("/v1/reviews/:id/history", async (request) => {
    const { id } = z.object({ id: z.uuid() }).parse(request.params);
    const { projectId } = z
      .object({ projectId: z.uuid() })
      .parse(request.query);
    const a = await authorize(request, { scope: "read", projectId });
    return tenant(a.organizationId, a.userId, (tx) =>
      rows(
        tx,
        sql`select d.*,u.name as reviewer from review_decisions d left join users u on u.id=d.reviewer_id where d.project_id=${projectId} and d.review_id=${id} order by d.version desc`,
      ),
    );
  });
  app.get("/v1/reviews/:id/context", async (request) => {
    const { id } = z.object({ id: z.uuid() }).parse(request.params);
    const { projectId } = z
      .object({ projectId: z.uuid() })
      .parse(request.query);
    const a = await authorize(request, { scope: "read", projectId });
    return tenant(a.organizationId, a.userId, async (tx) => {
      let [record] = await rows<any>(
        tx,
        sql`select e.* from reviews r join evaluations e on e.organization_id=r.organization_id and e.project_id=r.project_id and e.id=r.evaluation_id where r.project_id=${projectId} and r.id=${id}`,
      );
      if (record && !record.frozen_input)
        record = (
          await loadRunContent(tx, projectId, record.run_id)
        ).evaluations.find((e: any) => e.id === record.id);
      assert(
        record?.frozen_input,
        410,
        "data_expired",
        "The frozen review evidence is unavailable or expired.",
      );
      const input = record.frozen_input;
      return {
        id: input.id,
        revision: input.revision,
        events: input.events,
        evidence: input.evidence.map((body: any) => ({ id: body.id, body })),
        evaluations: [
          {
            id: record.id,
            revision: record.revision,
            assessment: record.assessment,
            policy_hash: record.policy_hash,
            processing: record.processing,
          },
        ],
        execution_status: input.executionStatus,
      };
    });
  });
}
