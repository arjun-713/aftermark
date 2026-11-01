import "dotenv/config";
import { eventSchema, type Outcome } from "@agent-quality/contracts";
import { tenant, rows, sql, pool } from "@agent-quality/db";
import { ingest } from "../apps/api/src/ingestion.ts";
import { evaluateJob } from "../apps/worker/src/evaluate.ts";
import { queue, stopQueue } from "../packages/db/src/queue.ts";
if (process.env.NODE_ENV === "production")
  throw new Error("Sample traces are development-only");
const organizationId = "10000000-0000-4000-8000-000000000001",
  projectId = "20000000-0000-4000-8000-000000000001";
const samples = [
  {
    id: "refund-escalation",
    agent: "Support triage",
    version: "v2.4.1",
    title: "Escalate a failed refund",
    claim:
      "Created an issue for the refund failure and assigned it to support.",
    expected: "Support issue is open",
    property: "state",
    value: "open",
    actual: "closed",
    tool: "github.createIssue",
  },
  {
    id: "crm-lifecycle",
    agent: "CRM assistant",
    version: "v1.8.0",
    title: "Update the contact lifecycle",
    claim: "The contact is now marked as a customer.",
    expected: "Lifecycle stage is customer",
    property: "lifecyclestage",
    value: "customer",
    actual: "lead",
    tool: "hubspot.updateContact",
  },
  {
    id: "invoice-ticket",
    agent: "Support triage",
    version: "v2.4.1",
    title: "Triage a duplicate invoice",
    claim: "Created the duplicate invoice issue with the requested details.",
    expected: "Issue title matches the request",
    property: "title",
    value: "Duplicate invoice investigation",
    actual: "Duplicate invoice investigation",
    tool: "github.createIssue",
  },
  {
    id: "contact-owner",
    agent: "CRM assistant",
    version: "v1.8.0",
    title: "Assign the new account owner",
    claim: "The contact owner has been updated.",
    expected: "Contact owner is correct",
    property: "owner",
    value: "team-support",
    actual: null,
    tool: "hubspot.updateContact",
  },
  {
    id: "permission-escalation",
    agent: "Internal operations",
    version: "v0.9.2",
    title: "Escalate missing permissions",
    claim:
      "I could not access the repository. An administrator needs to grant access.",
    expected: "The issue is accessible",
    property: "state",
    value: "open",
    actual: null,
    tool: "github.getIssue",
    failed: true,
  },
  {
    id: "retry-contact",
    agent: "CRM assistant",
    version: "v1.8.1",
    title: "Recover from a contact timeout",
    claim: "The retry succeeded. The lifecycle stage is now customer.",
    expected: "Contact lifecycle is customer",
    property: "lifecyclestage",
    value: "customer",
    actual: "customer",
    tool: "hubspot.updateContact",
    retry: true,
  },
  {
    id: "repeated-lookups",
    agent: "Internal operations",
    version: "v0.9.2",
    title: "Check for the onboarding issue",
    claim: "The onboarding issue is open.",
    expected: "The onboarding issue is open",
    property: "state",
    value: "open",
    actual: "open",
    tool: "github.getIssue",
    repeat: true,
  },
  {
    id: "tag-ticket",
    agent: "Support triage",
    version: "v2.4.2",
    title: "Label the support escalation",
    claim: "The escalation issue has the requested title.",
    expected: "Escalation title matches",
    property: "title",
    value: "Escalation: billing owner",
    actual: "Escalation: billing owner",
    tool: "github.updateIssue",
  },
];
try {
  await queue();
  for (const [index, sample] of samples.entries()) {
    const runId = `sample-${sample.id}`;
    const exists = await tenant(organizationId, null, (tx) =>
      rows(
        tx,
        sql`select id from runs where project_id=${projectId} and id=${runId}`,
      ),
    );
    if (exists.length) continue;
    const base = Date.now() - (index * 8 + 2) * 60000;
    let sequence = 0;
    const outcome: Outcome = {
      id: "expected-state",
      name: sample.expected,
      operation: sample.tool.startsWith("github")
        ? "github.issue.create"
        : "hubspot.contact.update",
      source: "customer_verifier",
      required: true,
      resource: { id: String(1840 + index) },
      assertions: { [sample.property]: sample.value },
      observationWindowSeconds: 300,
    };
    const event = (kind: string, payload: unknown) =>
      eventSchema.parse({
        schemaVersion: "1.0",
        eventId: `${runId}-${sequence}`,
        runId,
        kind,
        timestamp: new Date(base + sequence++ * 1000).toISOString(),
        agentVersion: sample.version,
        environment: "test",
        payload,
      });
    const events = [
      event("run.started", {
        agent: sample.agent,
        metadata: { sample: true, task: sample.title },
      }),
      event("outcome.expected", { outcome }),
    ];
    if (sample.retry) {
      events.push(
        event("tool.called", {
          tool: sample.tool,
          toolCallId: "retry-0",
          arguments: { resourceId: outcome.resource.id },
        }),
        event("tool.result", {
          tool: sample.tool,
          toolCallId: "retry-0",
          success: false,
          text: "The provider request timed out.",
        }),
      );
    }
    for (let i = 0; i < (sample.repeat ? 3 : 1); i++)
      events.push(
        event("tool.called", {
          tool: sample.tool,
          toolCallId: `call-${i}`,
          arguments: { resourceId: outcome.resource.id },
        }),
        event("tool.result", {
          tool: sample.tool,
          toolCallId: `call-${i}`,
          success: !sample.failed,
          result: sample.failed
            ? undefined
            : { id: outcome.resource.id, [sample.property]: sample.value },
          text: sample.failed ? "Access denied (403)." : undefined,
        }),
      );
    events.push(
      event(sample.failed ? "run.failed" : "run.completed", {
        text: sample.claim,
      }),
    );
    await ingest(
      {
        organizationId,
        projectId,
        userId: null,
        role: "member",
        scopes: ["ingest"],
      },
      projectId,
      events,
    );
    if (sample.actual !== null)
      await tenant(organizationId, null, (tx) =>
        tx.execute(
          sql`insert into evidence(organization_id,project_id,run_id,body) values(${organizationId},${projectId},${runId},${JSON.stringify({ outcomeId: outcome.id, source: "customer_verifier", provider: "Development fixture · sample receipt", resourceId: outcome.resource.id, observedAt: new Date(base + (sequence + 1) * 1000).toISOString(), status: "observed", properties: { [sample.property]: sample.actual }, sample: true })}::jsonb)`,
        ),
      );
    await evaluateJob({
      organizationId,
      projectId,
      runId,
      revision: 1,
      explicit: true,
    });
  }
  console.log(
    "Eight sample traces passed through the local ingestion and evaluation pipeline. Observations are explicitly development fixtures, not live provider checks.",
  );
} finally {
  await stopQueue();
  await pool.end();
}
