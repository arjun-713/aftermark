# Agent Quality SDK

Node 22.14+ telemetry with redaction, bounded batching, nested context, expected outcomes and tool wrappers. Delivery failures never replace your agent result. See the repository integration guide for the full event and evidence contracts.

```ts
import { AgentQuality } from "@agent-quality/sdk";
const aq = new AgentQuality({
  endpoint: process.env.AQ_ENDPOINT!,
  apiKey: process.env.AQ_API_KEY!,
  projectId: process.env.AQ_PROJECT_ID!,
  agent: "Support agent",
  agentVersion: "git-sha",
});
try {
  await aq.run(async () => {
    // Define aq.expect(...) and wrap side effects with aq.tool(...).
    return await yourAgent();
  });
} finally {
  await aq.close();
}
```

Inspect `aq.counters` for delivered, dropped, retries, truncated and deliveryFailures. Keep the credential backend-only. A successful tool result remains reported evidence. `submitEvidence` requires a separate verifier credential and signs the exact UTF-8 receipt bytes.

Build the local workspace with `npm run build -w @agent-quality/sdk`. The package bundles its runtime and ships TypeScript declarations. Publishing is a separate release action.
