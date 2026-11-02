import Link from "next/link";
import { MarketingNav, MarketingFooter } from "../../components/landing";
import { DocsContents } from "../../components/docs-contents";
export default function Help() {
  return (
    <div className="marketing docs-site" id="top">
      <MarketingNav />
      <main className="documentation">
        <DocsContents />
        <article>
          <div className="docs-intro">
            <h1>
              Build a record.
              <br />
              Ship with evidence.
            </h1>
            <p>
              Instrument a workflow, define the result, and keep independent
              evidence with every agent run.
            </p>
            <div className="docs-intro-links">
              <a href="#start">Get started ↓</a>
              <a href="#ci">Connect your CI →</a>
            </div>
          </div>
          <section id="start" tabIndex={-1}>
            <h2>Instrument a workflow</h2>
            <p>
              Create a workspace and project, then create an ingestion key. Keep
              the key in your agent backend. The TypeScript and Python SDKs
              redact before transmission, batch in the background, isolate
              delivery failures and provide an explicit flush.
            </p>
            <pre>{`import { AgentQuality } from '@agent-quality/sdk';\n\nconst aq = new AgentQuality({\n  endpoint: process.env.AQ_ENDPOINT!,\n  apiKey: process.env.AQ_API_KEY!,\n  projectId: process.env.AQ_PROJECT_ID!,\n  agent: 'Support agent', agentVersion: 'git-sha',\n});\n\ntry {\n  await aq.run(async () => {\n    // Define expected outcomes and wrap tools.\n    return await yourAgent();\n  });\n} finally { await aq.close(); }`}</pre>
            <p>
              Native event batches contain up to 100 events and 1 MiB after
              decompression. Identical event IDs are idempotent; conflicting
              content rejects the complete batch. A <code>202</code> response
              means events and their processing job are durable, while
              evaluation may still be pending.
            </p>
            <p>
              The OTLP/HTTP JSON importer uses a pinned mapping and does not
              infer expected outcomes. See the repository integration guide for
              supported attributes and framework examples.
            </p>
          </section>
          <section id="outcomes" tabIndex={-1}>
            <h2>Define the result you need</h2>
            <p>
              An expected outcome names the operation, resource, required
              properties, verification source and acceptable observation window.
              Tool mappings can derive a resource ID from a recorded tool
              result.
            </p>
            <pre>{`aq.expect({\n  id: 'issue', name: 'Support issue is open',\n  operation: 'github.issue.create', required: true,\n  source: 'github',\n  resource: { repository: 'your-org/support', id: '42' },\n  assertions: { state: 'open' },\n  observationWindowSeconds: 300,\n});`}</pre>
            <p>
              Define expectations before a risky action when you already know
              the resource, or configure a policy tool mapping for returned IDs.
              Runs without explicit expectations cannot establish overall
              verified completion.
            </p>
          </section>
          <section id="verifiers" tabIndex={-1}>
            <h2>Connect independent evidence</h2>
            <p>
              GitHub uses a read-only App for Issues and repository metadata.
              HubSpot uses contact-read OAuth and retrieves only configured
              properties. Connection health is visible in the workspace. A 404,
              missing permission or unavailable property retains uncertainty.
            </p>
            <p>
              A customer-operated verifier uses a separate <code>verifier</code>{" "}
              key. Receipts contain a receipt ID, run and outcome IDs, resource
              ID, observed properties and timestamp. Sign the exact UTF-8 JSON
              body with HMAC-SHA256 using <code>timestamp + "." + body</code>;
              send the hexadecimal signature and a timestamp within five
              minutes. Both SDKs include helpers.
            </p>
            <p>
              Provider observations and customer receipts keep distinct
              provenance. Ordinary ingestion credentials cannot manufacture a
              provider-verified record. Recorded state does not establish
              historical causality.
            </p>
          </section>
          <section id="reviews" tabIndex={-1}>
            <h2>Make a human decision</h2>
            <p>
              Open the review inbox, claim a finding, inspect its frozen claim
              and evidence, and record a quality decision with a note. J/K
              navigates the inbox. Concurrent edits use version checks, and
              disagreement remains visible without rewriting the original
              assessment.
            </p>
            <p>
              Policies save immutable versions. Testing reuses frozen
              observations; activation applies to later evaluation requests.
              Semantic detectors need calibration against human labels before
              they can block a release.
            </p>
          </section>
          <section id="ci" tabIndex={-1}>
            <h2>Turn the review into a regression</h2>
            <p>
              Publish a resolved case as an immutable agent regression dataset.
              Choose expected completion, honest failure or escalation.
              Evaluator calibration datasets keep human detector labels
              separately.
            </p>
            <pre>{`# Customer CI runs the agent and submits test traces first.\naq compare --dataset "$DATASET_ID" --policy "$POLICY_ID" \\n  --candidate candidate=candidate-runs.json --wait --json\naq report "$EXPERIMENT_ID" --format junit --output comparison.xml`}</pre>
            <p>
              Candidate mappings cover every dataset case and pin a run revision
              and policy version. Comparison repeats no customer actions. Exit{" "}
              <code>0</code> means declared assertions passed; <code>1</code>{" "}
              means quality assertions failed; <code>2</code> means
              infrastructure, pending or indeterminate checks. Required unknown
              outcomes block by default.
            </p>
          </section>
          <section id="privacy" tabIndex={-1}>
            <h2>Know the evidence limits</h2>
            <p>
              Detailed trace and evidence retention defaults to 30 days. Curated
              regression datasets remain until deletion, within storage quota.
              Administrative audit metadata and recovery backups have separate
              retention. Exports and payload downloads require workspace
              authorization.
            </p>
            <p>
              Primary deployment targets Singapore. Redacted semantic context
              may leave Singapore for Jev processing. No Singapore-only
              processing or upstream zero-retention guarantee is implied.
            </p>
            <Link href="/privacy">Read the data handling disclosure →</Link>
          </section>
          <section id="alerts" tabIndex={-1}>
            <h2>Receive signed alerts</h2>
            <p>
              Owners and admins can add a public HTTPS destination in Settings →
              Alerts. New fail, review and unknown assessments create durable,
              bounded deliveries. The notification contains opaque
              project/evaluation/event IDs, enum statuses and verification
              counts; it contains no trace text or model context.
            </p>
            <p>
              Verify <code>x-aq-signature</code> as HMAC-SHA256 over{" "}
              <code>x-aq-timestamp + "." + raw_body</code> with your destination
              secret. Reject timestamps more than five minutes old, compare
              signatures in constant time, and durably deduplicate{" "}
              <code>x-aq-event-id</code> before processing. Retries preserve the
              event ID and body. A destination can receive the same event more
              than once.
            </p>
            <p>
              Endpoints use public DNS and port 443 without URL credentials,
              query parameters or redirects. Five automatic attempts precede a
              visible dead letter. Investigate delivery health before requesting
              one of the three allowed replays.
            </p>
          </section>
          <section id="billing" tabIndex={-1}>
            <h2>Manage allowance and access</h2>
            <p>
              Owners manage billing, cancellation and workspace deletion. Admins
              manage provider connections and active policies; members review
              and curate experiments; viewers have read access. Keys carry
              project-specific ingestion, CI, read or verifier scopes.
            </p>
            <p>
              Dodo-hosted checkout and the customer portal handle payments.
              Entitlements come from verified provider state, never from a
              checkout return URL. Evaluation quota is reserved before semantic
              requests; ambiguous requests retain their reservation until
              reconciled. Hard limits keep remaining allowance explicit.
            </p>
            <Link href="/pricing">Compare plans →</Link>
          </section>
        </article>
      </main>
      <MarketingFooter />
    </div>
  );
}
