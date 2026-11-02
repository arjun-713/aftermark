import { afterAll, beforeAll, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { buildServer } from "../../apps/api/src/server.ts";
import { pool, tenant, rows, sql } from "@agent-quality/db";
import { evaluateJob } from "../../apps/worker/src/evaluate.ts";
import { applyDeletion } from "../../packages/operations/src/deletion.ts";
const app = await buildServer();
let org = "",
  project = "",
  policy = "",
  cookie = "";
const headers = () => ({ cookie, "x-workspace-id": org });
const fixture = (id: string) => ({
  projectId: project,
  events: ["run.started", "run.completed"].map((kind, i) => ({
    schemaVersion: "1.0",
    runId: id,
    eventId: `${id}-${i}`,
    kind,
    timestamp: new Date(Date.now() - 2000 + i * 1000).toISOString(),
    agentVersion: "v1",
    environment: "test",
    payload:
      kind === "run.started"
        ? { agent: "Product integration fixture" }
        : { text: "No independent outcome was configured." },
  })),
});
beforeAll(async () => {
  const login = await app.inject({
    method: "POST",
    url: "/v1/auth/login",
    payload: { email: "alex@example.test", password: "local-password-123" },
  });
  cookie = login.cookies.map((c) => `${c.name}=${c.value}`).join("; ");
  const workspace = await app.inject({
    method: "POST",
    url: "/v1/workspaces",
    headers: { cookie },
    payload: { name: "Content integration fixture" },
  });
  expect(workspace.statusCode).toBe(200);
  org = workspace.json().id;
  const result = await app.inject({
    method: "POST",
    url: "/v1/projects",
    headers: headers(),
    payload: { name: "Fixture" },
  });
  expect(result.statusCode).toBe(200);
  project = result.json().id;
  policy = (
    await tenant(org, null, (tx) =>
      rows<any>(
        tx,
        sql`select active_policy_id from projects where id=${project}`,
      ),
    )
  )[0].active_policy_id;
});
afterAll(async () => {
  if (org)
    await tenant(org, null, (tx) =>
      applyDeletion(org, null, "workspace", org, tx),
    );
  await app.close();
  await pool.end();
});
it("rolls back native content, deduplication and durable work when the storage cap is exceeded", async () => {
  const id = `storage-rollback-${randomUUID()}`,
    saved = process.env.STORAGE_TRIAL_BYTES;
  try {
    process.env.STORAGE_TRIAL_BYTES = "1";
    const response = await app.inject({
      method: "POST",
      url: "/v1/events",
      headers: headers(),
      payload: fixture(id),
    });
    expect(response.statusCode).toBe(413);
    expect(response.json().error.code).toBe("storage_limit_exceeded");
    const [state] = await tenant(org, null, (tx) =>
      rows<any>(
        tx,
        sql`select (select count(*) from runs where id=${id})::int as runs,(select count(*) from event_keys where run_id=${id})::int as keys,(select count(*) from pgboss.job where data->>'organizationId'=${org} and data->>'runId'=${id})::int as jobs`,
      ),
    );
    expect(state).toEqual({ runs: 0, keys: 0, jobs: 0 });
  } finally {
    if (saved === undefined) delete process.env.STORAGE_TRIAL_BYTES;
    else process.env.STORAGE_TRIAL_BYTES = saved;
  }
  const accepted = await app.inject({
    method: "POST",
    url: "/v1/events",
    headers: headers(),
    payload: fixture(id),
  });
  expect(accepted.statusCode).toBe(202);
  const key = await app.inject({
    method: "POST",
    url: "/v1/keys",
    headers: headers(),
    payload: {
      projectId: project,
      name: "Scoped read fixture",
      scopes: ["read"],
    },
  });
  expect(
    (
      await app.inject({
        url: "/v1/storage/usage",
        headers: { authorization: `Bearer ${key.json().secret}` },
      })
    ).statusCode,
  ).toBe(403);
});
it("recovers a quota-denied evaluation through the authenticated API without changing its frozen input or charging twice", async () => {
  const id = `quota-recovery-${randomUUID()}`;
  expect(
    (
      await app.inject({
        method: "POST",
        url: "/v1/events",
        headers: headers(),
        payload: fixture(id),
      })
    ).statusCode,
  ).toBe(202);
  await tenant(org, null, (tx) =>
    tx.execute(
      sql`update subscriptions set allowance=0 where organization_id=${org}`,
    ),
  );
  const job = {
    organizationId: org,
    projectId: project,
    runId: id,
    revision: 1,
    policyId: policy,
    explicit: true,
  };
  const denied = await evaluateJob(job);
  expect(denied.assessment?.processing).toBe("error");
  const [before] = await tenant(org, null, (tx) =>
    rows<any>(
      tx,
      sql`select id,frozen_input from evaluations where run_id=${id}`,
    ),
  );
  const unavailable = await app.inject({
    method: "POST",
    url: `/v1/evaluations/${before.id}/retry`,
    headers: headers(),
    payload: { projectId: project },
  });
  expect(unavailable.statusCode).toBe(402);
  await tenant(org, null, (tx) =>
    tx.execute(
      sql`update subscriptions set allowance=1000 where organization_id=${org}`,
    ),
  );
  const saved = process.env.STORAGE_TRIAL_BYTES;
  try {
    process.env.STORAGE_TRIAL_BYTES = "1";
    expect(
      (
        await app.inject({
          method: "POST",
          url: `/v1/evaluations/${before.id}/retry`,
          headers: headers(),
          payload: { projectId: project },
        })
      ).statusCode,
    ).toBe(413);
  } finally {
    if (saved === undefined) delete process.env.STORAGE_TRIAL_BYTES;
    else process.env.STORAGE_TRIAL_BYTES = saved;
  }
  const queued = await app.inject({
    method: "POST",
    url: `/v1/evaluations/${before.id}/retry`,
    headers: headers(),
    payload: { projectId: project },
  });
  expect(queued.statusCode).toBe(202);
  expect(queued.json().evaluationId).toBe(before.id);
  let collections = 0;
  await evaluateJob(job, {
    collectEvidence: async () => {
      collections++;
      return [];
    },
  });
  await evaluateJob(job);
  expect(collections).toBe(0);
  const [after] = await tenant(org, null, (tx) =>
    rows<any>(
      tx,
      sql`select frozen_input,processing,(select count(*) from usage_ledger where evaluation_id=${before.id})::int as charges from evaluations where id=${before.id}`,
    ),
  );
  expect(after).toEqual({
    frozen_input: before.frozen_input,
    processing: "partial",
    charges: 1,
  });
  const history = await app.inject({
    url: `/v1/evaluations/${before.id}/attempts?projectId=${project}`,
    headers: headers(),
  });
  expect(history.statusCode).toBe(200);
  expect(history.json()).toHaveLength(1);
  expect(history.json()[0].reason).toBe("quota_denied");
});
it("refuses a cumulative oversized run before loading it and preserves all previously acknowledged events", async () => {
  const id = `content-budget-${randomUUID()}`,
    text = "x".repeat(900000);
  const event = (i: number) => ({
    ...fixture(id).events[0],
    kind: "message",
    eventId: `${id}-${i}`,
    payload: { metadata: { fixture: text } },
  });
  for (let i = 0; i < 4; i++)
    expect(
      (
        await app.inject({
          method: "POST",
          url: "/v1/events",
          headers: headers(),
          payload: { projectId: project, events: [event(i)] },
        })
      ).statusCode,
    ).toBe(202);
  const refused = await app.inject({
    method: "POST",
    url: "/v1/events",
    headers: headers(),
    payload: { projectId: project, events: [event(4)] },
  });
  expect(refused.statusCode).toBe(413);
  expect(refused.json().error.code).toBe("run_content_limit");
  const read = await app.inject({
    url: `/v1/runs/${id}?projectId=${project}`,
    headers: headers(),
  });
  expect(read.statusCode).toBe(200);
  expect(read.json().events).toHaveLength(4);
});

it("accounts an atomic multi-run batch once while retaining unrelated content charges", async () => {
  const ids = [`batch-a-${randomUUID()}`, `batch-b-${randomUUID()}`];
  const batch = {
    projectId: project,
    events: ids.flatMap((id) => fixture(id).events),
  };
  expect(
    (
      await app.inject({
        method: "POST",
        url: "/v1/events",
        headers: headers(),
        payload: batch,
      })
    ).statusCode,
  ).toBe(202);
  const before = (
    await app.inject({ url: "/v1/storage/usage", headers: headers() })
  ).json();
  expect(
    (
      await app.inject({
        method: "POST",
        url: "/v1/events",
        headers: headers(),
        payload: batch,
      })
    ).json().duplicates,
  ).toBe(4);
  const after = (
    await app.inject({ url: "/v1/storage/usage", headers: headers() })
  ).json();
  expect(after.usedBytes).toBe(before.usedBytes);
  const [counter] = await tenant(org, null, (tx) =>
    rows<any>(
      tx,
      sql`select b.used_bytes,(select sum(bytes) from storage_resources s where s.organization_id=b.organization_id) as actual from storage_budgets b`,
    ),
  );
  expect(Number(counter.used_bytes)).toBe(Number(counter.actual));
});
