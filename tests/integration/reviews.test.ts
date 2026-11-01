import { beforeAll, afterAll, it, expect } from "vitest";
import { randomUUID } from "node:crypto";
import { buildServer } from "../../apps/api/src/server.ts";
import { pool, tenant, rows, sql } from "@agent-quality/db";
import { ingest } from "../../apps/api/src/ingestion.ts";
import { evaluateJob } from "../../apps/worker/src/evaluate.ts";
import { makeFrozen } from "../fixtures/evaluation.ts";
const app = await buildServer(),
  org = "10000000-0000-4000-8000-000000000001",
  project = "20000000-0000-4000-8000-000000000001";
const runId = `review-${randomUUID()}`;
let review: any, headers: Record<string, string>;
beforeAll(async () => {
  const login = await app.inject({
    method: "POST",
    url: "/v1/auth/login",
    payload: { email: "alex@example.test", password: "local-password-123" },
  });
  headers = {
    cookie: login.cookies.map((c) => `${c.name}=${c.value}`).join("; "),
    "x-workspace-id": org,
  };
  await app.ready();
  const source = makeFrozen();
  await ingest(
    {
      organizationId: org,
      projectId: project,
      userId: null,
      role: "member",
      scopes: ["ingest"],
    },
    project,
    source.events.map((e) => ({
      ...e,
      eventId: `${runId}-${e.eventId}`,
      runId,
    })),
  );
  await evaluateJob({
    organizationId: org,
    projectId: project,
    runId,
    revision: 1,
    explicit: true,
  });
  [review] = await tenant(org, null, (tx) =>
    rows(
      tx,
      sql`select * from reviews where project_id=${project} and run_id=${runId}`,
    ),
  );
  expect(review).toBeTruthy();
});
afterAll(async () => {
  await app.close();
  await pool.end();
});
it("claims work with optimistic conflict detection and records an immutable decision", async () => {
  const claim = await app.inject({
    method: "POST",
    url: `/v1/reviews/${review.id}/claim`,
    headers,
    payload: { projectId: project, expectedVersion: 1 },
  });
  expect(claim.statusCode).toBe(200);
  const conflict = await app.inject({
    method: "POST",
    url: `/v1/reviews/${review.id}/claim`,
    headers,
    payload: { projectId: project, expectedVersion: 1 },
  });
  expect(conflict.statusCode).toBe(409);
  const decision = await app.inject({
    method: "POST",
    url: `/v1/reviews/${review.id}/decisions`,
    headers,
    payload: {
      projectId: project,
      expectedVersion: 2,
      decision: "unknown",
      annotation: "Independent state is unavailable for private@example.test.",
    },
  });
  expect(decision.statusCode).toBe(200);
  expect(decision.json().annotation).not.toContain("private@example.test");
  const history = await app.inject({
    url: `/v1/reviews/${review.id}/history?projectId=${project}`,
    headers,
  });
  expect(history.json()).toHaveLength(1);
  expect(history.json()[0].version).toBe(3);
});
it("returns frozen review evidence after a newer run revision arrives", async () => {
  const e = makeFrozen().events.at(-1)!;
  await ingest(
    {
      organizationId: org,
      projectId: project,
      userId: null,
      role: "member",
      scopes: ["ingest"],
    },
    project,
    [
      {
        ...e,
        eventId: `${runId}-late`,
        runId,
        kind: "message",
        payload: { text: "Late context should not alter the original review." },
      },
    ],
  );
  const response = await app.inject({
    url: `/v1/reviews/${review.id}/context?projectId=${project}`,
    headers,
  });
  expect(response.statusCode).toBe(200);
  expect(response.json().revision).toBe(1);
  expect(JSON.stringify(response.json().events)).not.toContain("Late context");
});
