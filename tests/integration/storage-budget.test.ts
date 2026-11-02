import { randomUUID } from "node:crypto";
import Fastify from "fastify";
import { Pool } from "pg";
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
} from "vitest";
import { pool, rows, sql, tenant } from "../../packages/db/src/index.ts";
import { defaultPolicy } from "../../packages/contracts/src/index.ts";
import {
  archiveObjectBytes,
  bootstrapStorageBudget,
  lockStorageBudget,
  readStorageUsage,
  releaseArchiveObject,
  releaseStorageBytes,
  reserveStorageBytes,
  setStorageBytes,
  setStorageResources,
  StorageBudgetError,
  StorageLimitError,
  storageBudgetRoutes,
  syncRetainedStorage,
  type StorageLimits,
} from "../../packages/storage-budget/src/index.ts";

if (
  !process.env.DATABASE_URL ||
  new URL(process.env.DATABASE_URL).pathname !== "/aq_storage_test" ||
  !process.env.MIGRATION_DATABASE_URL ||
  new URL(process.env.MIGRATION_DATABASE_URL).pathname !== "/aq_storage_test"
)
  throw new Error(
    "Storage integration tests require both URLs to use the isolated aq_storage_test database.",
  );
const admin = new Pool({
  connectionString: process.env.MIGRATION_DATABASE_URL,
});
const app = Fastify({ logger: false });
await storageBudgetRoutes(app, {
  authorize: async (request) => {
    if (request.headers.authorization !== "Bearer fixture-read")
      throw new StorageBudgetError(
        "unauthenticated",
        "Sign in to continue.",
        401,
      );
    return {
      organizationId: String(request.headers["x-workspace-id"]),
      userId: null,
    };
  },
});
let org: string,
  otherOrg: string,
  project: string,
  otherProject: string,
  policyId: string,
  userId: string;
const small: StorageLimits = { trial: 100, starter: 200, team: 300 };
const usage = () => tenant(org, null, (tx) => readStorageUsage(tx, org));
const reference = (id: string) => ({
  category: "events" as const,
  resourceId: id,
  projectId: project,
  runId: "run-fixture",
});
async function contentFixture(withArchive = false, unknownArchive = false) {
  const evaluation = randomUUID(),
    review = randomUUID(),
    dataset = randomUUID();
  await admin.query(
    "insert into runs(organization_id,project_id,id,agent_version,environment,started_at,last_event_at) values($1,$2,'run-fixture','1','test',now(),now())",
    [org, project],
  );
  await admin.query(
    "insert into event_keys(organization_id,project_id,event_id,run_id,hash) values($1,$2,'event-fixture','run-fixture','fixture')",
    [org, project],
  );
  await admin.query(
    "insert into events(organization_id,project_id,event_id,run_id,event) values($1,$2,'event-fixture','run-fixture',$3)",
    [
      org,
      project,
      { payload: { text: "Retained redacted content".repeat(5) } },
    ],
  );
  await admin.query(
    "insert into evidence(organization_id,project_id,run_id,body) values($1,$2,'run-fixture',$3)",
    [org, project, { properties: { status: "verified fixture" } }],
  );
  await admin.query(
    "insert into evaluations(organization_id,project_id,id,run_id,revision,policy_id,policy_hash,frozen_input,provider_response,assessment) values($1,$2,$3,'run-fixture',1,$4,'fixture',$5,$6,$7)",
    [
      org,
      project,
      evaluation,
      policyId,
      { events: [{ payload: { text: "Frozen copy".repeat(10) } }] },
      { answer: true },
      { decision: "review" },
    ],
  );
  await admin.query(
    "insert into reviews(organization_id,project_id,id,evaluation_id,run_id,annotation) values($1,$2,$3,$4,'run-fixture','Retained annotation')",
    [org, project, review, evaluation],
  );
  await admin.query(
    "insert into review_decisions(organization_id,project_id,review_id,reviewer_id,version,decision,annotation) values($1,$2,$3,$4,1,'pass','Curated decision')",
    [org, project, review, userId],
  );
  await admin.query(
    "insert into datasets(organization_id,project_id,id,name,kind,cases,hash) values($1,$2,$3,'Retained cases','agent_regression',$4,'fixture')",
    [
      org,
      project,
      dataset,
      JSON.stringify([
        {
          frozenInput: {
            events: [
              { payload: { text: "Curated immutable copy".repeat(10) } },
            ],
          },
        },
      ]),
    ],
  );
  await admin.query(
    "insert into experiments(organization_id,project_id,name,dataset_id,policy_id,candidates) values($1,$2,'Retained report',$3,$4,$5)",
    [
      org,
      project,
      dataset,
      policyId,
      JSON.stringify([{ assessment: { decision: "pass" } }]),
    ],
  );
  await admin.query(
    "insert into calibration_reports(organization_id,project_id,detector_hash,report,passed,approved_by) values($1,$2,'fixture',$3,false,$4)",
    [org, project, { observations: ["fixture"] }, userId],
  );
  if (withArchive) {
    await admin.query(
      "insert into archives(organization_id,project_id,run_id,object_path,checksum,bytes) values($1,$2,'run-fixture','fixture/private/object.json','fixture',$3)",
      [org, project, unknownArchive ? 0 : 1000],
    );
    await admin.query(
      "insert into operations_object_cleanup(organization_id,object_path) values($1,'fixture/private/object.json')",
      [org],
    );
  }
  return { dataset };
}
beforeAll(async () => {
  await app.ready();
});
beforeEach(async () => {
  org = randomUUID();
  otherOrg = randomUUID();
  project = randomUUID();
  otherProject = randomUUID();
  policyId = randomUUID();
  userId = randomUUID();
  await admin.query(
    "insert into users(id,email,name) values($1,$2,'Storage fixture')",
    [userId, `${userId}@example.test`],
  );
  await admin.query(
    "insert into organizations(id,name) values($1,'Storage fixture'),($2,'Storage other fixture')",
    [org, otherOrg],
  );
  await admin.query(
    "insert into subscriptions(organization_id) values($1),($2)",
    [org, otherOrg],
  );
  await admin.query(
    "insert into projects(organization_id,id,name) values($1,$2,'Storage fixture'),($3,$4,'Other project')",
    [org, project, otherOrg, otherProject],
  );
  await admin.query(
    "insert into policies(organization_id,project_id,id,version,definition,hash) values($1,$2,$3,1,$4,'fixture')",
    [org, project, policyId, defaultPolicy],
  );
});
afterEach(async () => {
  await admin.query(
    "delete from evaluations where organization_id=any($1::uuid[])",
    [[org, otherOrg]],
  );
  await admin.query(
    "delete from experiments where organization_id=any($1::uuid[])",
    [[org, otherOrg]],
  );
  await admin.query(
    "delete from operations_object_cleanup where organization_id=any($1::uuid[])",
    [[org, otherOrg]],
  );
  await admin.query("delete from organizations where id=any($1::uuid[])", [
    [org, otherOrg],
  ]);
  await admin.query("delete from users where id=$1", [userId]);
});
afterAll(async () => {
  await app.close();
  await pool.end();
  await admin.end();
});

describe("transactional retained storage budgets", () => {
  it("reserves and resizes one identity idempotently and releases it once", async () => {
    await tenant(org, null, async (tx) => {
      await reserveStorageBytes(
        tx,
        org,
        { ...reference("same"), bytes: 60 },
        { limits: small },
      );
      await reserveStorageBytes(
        tx,
        org,
        { ...reference("same"), bytes: 60 },
        { limits: small },
      );
      await reserveStorageBytes(
        tx,
        org,
        { ...reference("same"), bytes: 40 },
        { limits: small },
      );
      expect((await readStorageUsage(tx, org)).usedBytes).toBe(60);
      await setStorageBytes(
        tx,
        org,
        { ...reference("same"), bytes: 40 },
        { limits: small },
      );
      expect((await readStorageUsage(tx, org)).usedBytes).toBe(40);
      await releaseStorageBytes(tx, org, reference("same"));
      await releaseStorageBytes(tx, org, reference("same"));
    });
    expect((await usage()).usedBytes).toBe(0);
  });
  it("serializes simultaneous reservations and never exceeds the hard limit", async () => {
    const results = await Promise.allSettled(
      ["one", "two"].map((id) =>
        tenant(org, null, (tx) =>
          reserveStorageBytes(
            tx,
            org,
            { ...reference(id), bytes: 70 },
            { limits: small },
          ),
        ),
      ),
    );
    expect(
      results.filter((result) => result.status === "fulfilled"),
    ).toHaveLength(1);
    expect(
      results.find((result) => result.status === "rejected"),
    ).toMatchObject({ reason: expect.any(StorageLimitError) });
    expect((await usage()).usedBytes).toBe(70);
  });
  it("rolls back the whole rejected content batch and every accounting row", async () => {
    await expect(
      tenant(org, null, async (tx) => {
        await lockStorageBudget(tx, org);
        await tx.execute(
          sql`insert into runs(organization_id,project_id,id,agent_version,environment,started_at,last_event_at) values(${org},${project},'run-fixture','1','test',now(),now())`,
        );
        for (const id of ["first", "second"])
          await tx.execute(
            sql`insert into events(organization_id,project_id,event_id,run_id,event) values(${org},${project},${id},'run-fixture',${JSON.stringify({ text: "redacted".repeat(1000) })}::jsonb)`,
          );
        await syncRetainedStorage(
          tx,
          org,
          { projectId: project, runId: "run-fixture" },
          { limits: small },
        );
      }),
    ).rejects.toBeInstanceOf(StorageLimitError);
    for (const table of [
      "runs",
      "events",
      "storage_resources",
      "storage_budgets",
    ])
      expect(
        (
          await admin.query(
            `select count(*)::int as count from ${table} where organization_id=$1`,
            [org],
          )
        ).rows[0].count,
      ).toBe(0);
    expect((await usage()).usedBytes).toBe(0);
  });
  it("checks a batch by its final net size and permits shrinking an over-limit budget", async () => {
    await tenant(org, null, (tx) =>
      setStorageResources(
        tx,
        org,
        [
          { ...reference("one"), bytes: 100 },
          { ...reference("two"), bytes: 50 },
        ],
        { limits: { trial: 200, starter: 200, team: 200 } },
      ),
    );
    await tenant(org, null, (tx) =>
      setStorageResources(
        tx,
        org,
        [
          { ...reference("one"), bytes: 20 },
          { ...reference("two"), bytes: 80 },
        ],
        { limits: small },
      ),
    );
    expect((await usage()).usedBytes).toBe(100);
    await expect(
      tenant(org, null, (tx) =>
        setStorageBytes(
          tx,
          org,
          { ...reference("one"), bytes: 21 },
          { limits: small },
        ),
      ),
    ).rejects.toBeInstanceOf(StorageLimitError);
    expect((await usage()).usedBytes).toBe(100);
  });
  it("backfills every current content copy and keeps object pointers/outbox from double charging objects", async () => {
    await contentFixture(true);
    const before = await usage();
    expect(before).toMatchObject({
      state: "backfill_required",
      remainingBytes: 0,
    });
    expect(
      (
        await admin.query(
          "select * from storage_budgets where organization_id=$1",
          [org],
        )
      ).rows,
    ).toHaveLength(0);
    await tenant(org, null, (tx) => bootstrapStorageBudget(tx, org));
    const first = await usage();
    expect(first.state).toBe("ready");
    for (const category of [
      "events",
      "event_keys",
      "evidence",
      "evaluations",
      "reviews",
      "review_decisions",
      "datasets",
      "experiments",
      "calibration_reports",
      "archives",
    ] as const)
      expect(first.categories[category].bytes).toBeGreaterThan(512);
    expect(first.categories.archive_objects).toEqual({
      bytes: 1512,
      resources: 1,
    });
    expect(first.usedBytes).toBe(
      Object.values(first.categories).reduce(
        (sum, category) => sum + category.bytes,
        0,
      ),
    );
    await tenant(org, null, (tx) => syncRetainedStorage(tx, org));
    expect((await usage()).usedBytes).toBe(first.usedBytes);
  });
  it("keeps curated copies and archived objects after run expiry until their own deletion succeeds", async () => {
    await contentFixture(true);
    await tenant(org, null, (tx) => bootstrapStorageBudget(tx, org));
    await tenant(org, null, async (tx) => {
      await lockStorageBudget(tx, org);
      await tx.execute(
        sql`delete from runs where organization_id=${org} and project_id=${project} and id='run-fixture'`,
      );
      await syncRetainedStorage(tx, org, {
        projectId: project,
        runId: "run-fixture",
      });
    });
    const afterRun = await usage();
    expect(afterRun.categories.events.bytes).toBe(0);
    expect(afterRun.categories.evaluations.bytes).toBe(0);
    expect(afterRun.categories.datasets.bytes).toBeGreaterThan(0);
    expect(afterRun.categories.archive_objects.bytes).toBe(1512);
    await tenant(org, null, async (tx) => {
      await lockStorageBudget(tx, org);
      await tx.execute(
        sql`delete from experiments where organization_id=${org} and project_id=${project}`,
      );
      await tx.execute(
        sql`delete from datasets where organization_id=${org} and project_id=${project}`,
      );
      await syncRetainedStorage(tx, org, { projectId: project });
      // The test's fake private-store removal has succeeded before this transaction hook.
      await tx.execute(
        sql`delete from operations_object_cleanup where organization_id=${org}`,
      );
      await releaseArchiveObject(tx, org, "fixture/private/object.json");
      await syncRetainedStorage(tx, org, { projectId: project });
    });
    const final = await usage();
    expect(final.categories.datasets.bytes).toBe(0);
    expect(final.categories.experiments.bytes).toBe(0);
    expect(final.categories.archive_objects.bytes).toBe(0);
  });
  it("blocks growth for unknown legacy object sizes until a measured size is recorded", async () => {
    await contentFixture(true, true);
    await tenant(org, null, (tx) => bootstrapStorageBudget(tx, org));
    expect(await usage()).toMatchObject({
      state: "measurement_required",
      remainingBytes: 0,
      unmeasuredObjects: 1,
    });
    await expect(
      tenant(org, null, (tx) =>
        setStorageBytes(tx, org, { ...reference("new"), bytes: 1 }),
      ),
    ).rejects.toMatchObject({ code: "storage_measurement_required" });
    await tenant(org, null, (tx) =>
      setStorageBytes(tx, org, {
        category: "archive_objects",
        resourceId: "fixture/private/object.json",
        projectId: project,
        runId: "run-fixture",
        bytes: archiveObjectBytes(1000),
      }),
    );
    expect((await usage()).state).toBe("ready");
    await expect(
      tenant(org, null, (tx) =>
        releaseStorageBytes(tx, org, {
          category: "archive_objects",
          resourceId: "fixture/private/object.json",
        }),
      ),
    ).rejects.toMatchObject({ code: "storage_object_confirmation_required" });
  });
  it("applies verified paid caps, falls back on payment failure and never grants an entitlement", async () => {
    await admin.query(
      "update subscriptions set plan='starter',status='active',provider_id=$1,reconciled_at=now()-interval '1 second',period_end=now()+interval '1 day' where organization_id=$2",
      [`fixture_${randomUUID()}`, org],
    );
    await tenant(org, null, (tx) =>
      reserveStorageBytes(
        tx,
        org,
        { ...reference("paid-fixture"), bytes: 180 },
        { limits: small },
      ),
    );
    await admin.query(
      "update subscriptions set status='past_due' where organization_id=$1",
      [org],
    );
    const fallenBack = await tenant(org, null, (tx) =>
      readStorageUsage(tx, org, { limits: small }),
    );
    expect(fallenBack).toMatchObject({
      plan: "trial",
      limitBytes: 100,
      usedBytes: 180,
      remainingBytes: 0,
      overLimit: true,
    });
    await expect(
      tenant(org, null, (tx) =>
        setStorageBytes(
          tx,
          org,
          { ...reference("paid-fixture"), bytes: 181 },
          { limits: small },
        ),
      ),
    ).rejects.toBeInstanceOf(StorageLimitError);
    expect(
      (
        await admin.query(
          "select status from subscriptions where organization_id=$1",
          [org],
        )
      ).rows[0].status,
    ).toBe("past_due");
  });
  it("rejects cross-workspace scopes, project confusion and identity reuse", async () => {
    await expect(
      tenant(otherOrg, null, (tx) =>
        setStorageBytes(tx, org, { ...reference("cross"), bytes: 1 }),
      ),
    ).rejects.toMatchObject({ code: "storage_scope_invalid" });
    await expect(
      tenant(org, null, (tx) =>
        setStorageBytes(tx, org, {
          ...reference("cross"),
          projectId: otherProject,
          bytes: 1,
        }),
      ),
    ).rejects.toMatchObject({ code: "storage_project_invalid" });
    await tenant(org, null, (tx) =>
      reserveStorageBytes(tx, org, { ...reference("same"), bytes: 60 }),
    );
    await expect(
      tenant(org, null, (tx) =>
        reserveStorageBytes(tx, org, {
          ...reference("same"),
          runId: "another-run",
          bytes: 50,
        }),
      ),
    ).rejects.toMatchObject({ code: "storage_identity_conflict" });
    expect(
      (await pool.query("select * from storage_resources")).rows,
    ).toHaveLength(0);
  });
  it("resizes fifteen thousand accounting identities without exceeding PostgreSQL expression limits", async () => {
    const resources = Array.from({ length: 15000 }, (_, i) => ({
      ...reference(`large-${i}`),
      bytes: 512,
    }));
    await tenant(org, null, (tx) => setStorageResources(tx, org, resources));
    await tenant(org, null, (tx) =>
      setStorageResources(
        tx,
        org,
        resources.map((r) => ({ ...r, bytes: 600 })),
      ),
    );
    expect((await usage()).usedBytes).toBe(15000 * 600);
    const counter = (
      await admin.query(
        "select b.used_bytes,(select sum(bytes) from storage_resources s where s.organization_id=b.organization_id) as actual from storage_budgets b where organization_id=$1",
        [org],
      )
    ).rows[0];
    expect(Number(counter.used_bytes)).toBe(Number(counter.actual));
  });
  it("exposes only aggregate usage through a read-only authenticated route", async () => {
    expect((await app.inject("/v1/storage/usage")).statusCode).toBe(401);
    const response = await app.inject({
      url: "/v1/storage/usage",
      headers: { authorization: "Bearer fixture-read", "x-workspace-id": org },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      units: "bytes",
      plan: "trial",
      state: "backfill_required",
    });
    const output = JSON.stringify(response.json());
    for (const value of [
      org,
      project,
      "provider_id",
      "customer_id",
      "object_path",
      "fixture-read",
    ])
      expect(output).not.toContain(value);
    expect(
      (
        await admin.query(
          "select * from storage_budgets where organization_id=$1",
          [org],
        )
      ).rows,
    ).toHaveLength(0);
  });
});
