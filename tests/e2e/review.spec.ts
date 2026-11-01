import { test, expect, type Page } from "@playwright/test";
import { randomUUID, createHmac } from "node:crypto";
const org = "10000000-0000-4000-8000-000000000001",
  project = "20000000-0000-4000-8000-000000000001";
async function seedRun(page: Page) {
  const runId = `browser-${randomUUID()}`;
  const headers = { "x-workspace-id": org };
  async function key(scopes: string[]) {
    const response = await page.request.post("/api/v1/keys", {
      headers,
      data: { projectId: project, name: "Browser verification", scopes },
    });
    expect(response.status()).toBe(200);
    return response.json();
  }
  const ingestion = await key(["ingest", "read", "evaluate"]);
  const verifier = await key(["verifier"]);
  const now = Date.now();
  const base = {
    schemaVersion: "1.0",
    runId,
    agentVersion: "browser-test-v1",
    environment: "test",
  };
  const outcome = {
    id: "issue",
    name: "Requested issue is open",
    operation: "custom",
    source: "customer_verifier",
    required: true,
    resource: { id: "42" },
    assertions: { state: "open" },
    observationWindowSeconds: 300,
  };
  const events = [
    {
      kind: "run.started",
      payload: { agent: "Browser workflow test", metadata: { sample: true } },
    },
    { kind: "outcome.expected", payload: { outcome } },
    {
      kind: "tool.called",
      payload: {
        tool: "createIssue",
        toolCallId: "call-1",
        arguments: { title: "Support escalation" },
      },
    },
    {
      kind: "tool.result",
      payload: {
        tool: "createIssue",
        toolCallId: "call-1",
        success: true,
        result: { id: 42, state: "open" },
      },
    },
    {
      kind: "run.completed",
      payload: { text: "Created the requested open issue." },
    },
  ].map((event, i) => ({
    ...base,
    ...event,
    eventId: `${runId}-${i}`,
    timestamp: new Date(now - 5000 + i * 1000).toISOString(),
  }));
  const accepted = await page.request.post("/api/v1/events", {
    headers: { authorization: `Bearer ${ingestion.secret}` },
    data: { projectId: project, events },
  });
  expect(accepted.status()).toBe(202);
  const body = JSON.stringify({
    receiptId: `${runId}-receipt`,
    projectId: project,
    runId,
    outcomeId: "issue",
    resourceId: "42",
    observedAt: new Date().toISOString(),
    properties: { state: "closed" },
    status: "observed",
  });
  const timestamp = String(Math.floor(Date.now() / 1000));
  const receipt = await page.request.post("/api/v1/evidence", {
    headers: {
      authorization: `Bearer ${verifier.secret}`,
      "content-type": "application/json",
      "x-receipt-timestamp": timestamp,
      "x-receipt-signature": createHmac("sha256", verifier.secret)
        .update(`${timestamp}.${body}`)
        .digest("hex"),
    },
    data: body,
  });
  expect(receipt.status()).toBe(202);
  expect(
    (
      await page.request.post(`/api/v1/runs/${runId}/evaluate`, {
        headers,
        data: { projectId: project },
      })
    ).status(),
  ).toBe(202);
  let run: any;
  await expect
    .poll(
      async () => {
        const res = await page.request.get(
          `/api/v1/runs/${runId}?projectId=${project}`,
          { headers },
        );
        run = await res.json();
        return run.evaluations?.[0]?.assessment?.decision;
      },
      { timeout: 15000 },
    )
    .toBe("fail");
  return {
    runId,
    reviewId: run.reviews[0].id,
    keys: [ingestion.id, verifier.id],
  };
}
test("onboard, inspect linked evidence, and record a review without database access", async ({
  page,
}) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto("/login");
  await page.getByLabel("Email", { exact: true }).fill("alex@example.test");
  await page.getByLabel("Password", { exact: true }).fill("local-password-123");
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "Overview", exact: true }),
  ).toBeVisible();
  const fixture = await seedRun(page);
  await page.goto("/app/onboarding");
  await expect(
    page.getByRole("heading", { name: "Instrument your agent" }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Python", exact: true }).click();
  await expect(page.locator(".code-panel pre")).toContainText("AgentQuality");
  await page.goto(`/app/runs/${fixture.runId}`);
  await expect(
    page.getByRole("heading", { name: "Agent claim", exact: true }),
  ).toBeVisible();
  await expect(page.getByText("contradicted", { exact: true })).toBeVisible();
  await expect(page.locator("blockquote")).toContainText(
    "Created the requested open issue.",
  );
  await page.getByRole("button", { name: /Timeline/ }).click();
  await expect(page.locator(".timeline-event")).toHaveCount(5);
  await page.goto(`/app/reviews?review=${fixture.reviewId}`);
  await expect(
    page.getByRole("heading", { name: "Review inbox", exact: true }),
  ).toBeVisible();
  if ((await page.viewportSize())!.width <= 700)
    await page
      .locator(".review-list-item")
      .filter({ hasText: "Browser workflow test" })
      .first()
      .click();
  await page.getByRole("button", { name: "Claim review", exact: true }).click();
  await page
    .getByLabel("Review note", { exact: true })
    .fill(
      "The signed fixture observation records a closed issue, contrary to the expected open state.",
    );
  await page
    .getByRole("button", { name: "Record decision", exact: true })
    .click();
  await expect(
    page.getByRole("status").filter({ hasText: "Review decision recorded." }),
  ).toBeVisible();
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth > innerWidth,
    ),
  ).toBe(false);
  expect(errors).toEqual([]);
  for (const id of fixture.keys)
    expect(
      (
        await page.request.delete(`/api/v1/keys/${id}`, {
          headers: { "x-workspace-id": org },
        })
      ).ok(),
    ).toBe(true);
});
