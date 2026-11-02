# SDK and ingestion integration

The ingestion key is scoped to one workspace and project. Create it in API key settings or `POST /v1/keys`. Keep it server-side. Use separate keys for ingestion, CI and signed verifier receipts.

## TypeScript (Node 22+)

```ts
import { AgentQuality } from '@agent-quality/sdk';
const aq = new AgentQuality({
  endpoint: process.env.AQ_ENDPOINT!, apiKey: process.env.AQ_API_KEY!,
  projectId: process.env.AQ_PROJECT_ID!, agent: 'Support agent', agentVersion: 'git-sha',
});
await aq.run(async () => {
  const issue = await aq.tool('github.createIssue', { title: 'Investigate refund' }, createIssue);
  aq.expect({ id: 'ticket', name: 'Support issue created', operation: 'github.issue.create',
    required: true, source: 'github', resource: { repository: 'your-org/support', id: String(issue.number) },
    assertions: { title: 'Investigate refund', state: 'open' }, observationWindowSeconds: 300 });
  return 'Created the support issue.';
});
await aq.close(); // flush before a serverless invocation/process exits
console.log(aq.counters);
```

Use `span` for nested work. AsyncLocalStorage propagates the run and parent span identifiers. Capture outcome expectations before a risky action when the resource can be resolved from a configured tool-result field. A successful tool response is reported evidence; it does not become provider verification.

## Python (3.10+)

```python
from agent_quality import AgentQuality
aq = AgentQuality(endpoint=endpoint, api_key=key, project_id=project,
                  agent="CRM assistant", agent_version="git-sha")
@aq.tool("hubspot.updateContact")
def update_contact(contact_id):
    return update_contact_in_customer_infrastructure(contact_id)

try:
    with aq.run(run_id="customer-run-id"):
        with aq.span("Update CRM"):
            update_contact("123")
        aq.expect({"id": "contact", "name": "Lifecycle stage updated",
                   "operation": "hubspot.contact.update", "source": "hubspot", "required": True,
                   "resource": {"id": "123"}, "assertions": {"lifecyclestage": "customer"},
                   "observationWindowSeconds": 300})
        aq.message("Updated the contact.")
finally:
    aq.close()
```

Install locally with `python -m pip install ./sdk/python`. Python uses contextvars for nested and async work; the tool decorator supports synchronous and asynchronous functions.

## Delivery behavior

Both SDKs default to a 1,000-event buffer, 100-event batches and three bounded HTTP attempts with 5-second timeouts. Batches stay under 900,000 bytes. Oversized payloads are marked as truncated; oversized outcome contracts are dropped and counted. Email, phone fields and common credential fields are redacted before transport. Inspect delivery, drop, retry and truncation counters. Telemetry delivery failure never substitutes a success assessment.

The server accepts atomic batches up to 100 events and 1 MiB after gzip decompression. Identical event IDs are idempotent; different contents under an existing ID reject the whole batch with 409. `202` means events and a delayed processing job committed together. Events remain queryable while workers are unavailable. Do not interpret acknowledgement as completed evaluation.

Launch resource limits are 2,000 events and 4 MiB of redacted event/evidence content per run. A batch that exceeds either bound receives `413 run_content_limit` and rolls back completely; earlier acknowledged events remain available. Split larger workflows into linked runs and capture only relevant properties. SDK delivery isolation does not make an oversized or incomplete run a pass. Curated dataset versions are bounded to 8 MiB; a comparison may load up to 16 MiB of frozen inputs. These memory bounds are independent of workspace retained-content quotas and the standard semantic request budget.

## OTLP/HTTP JSON mapping v1

POST JSON to `/v1/traces` with `projectId` and OTLP `resourceSpans`. Protobuf is not supported by this importer. Each OTLP span produces a start and end event; 50 spans fit the 100-event limit. Trace IDs are 32-character hex and span IDs are 16-character hex. `service.name`, `service.version`, `deployment.environment.name`, `output.value` and `gen_ai.output.messages` are the pinned attributes. Root span status maps to execution status, never to quality. Expected outcomes must come from customer configuration. Unsupported OTLP representations are rejected, not silently guessed.
