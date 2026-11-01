# Measured release gates

Production release remains blocked until every gate below has persisted, current evidence for the exact release commit. The repository's synthetic tests, provider protocol fixtures and local database rehearsal are engineering evidence. They do not establish model precision, real provider behavior, paid lifecycle, production load capacity or RPO/RTO.

Run `npm run check:release -- PATH/manifest.json`. The tool exits nonzero for a missing manifest, missing gate, duplicate gate, invalid shape, mismatched file checksum, path outside the evidence directory, evidence for another commit, future timestamp or evidence older than 30 days. The example `infra/release-evidence.example.json` intentionally contains no acceptance artifacts and blocks all gates.

The manifest is `{version:1,releaseId,commit,artifacts:[{gate,path,sha256}]}`. `commit` is the full 40-character Git SHA. Each artifact is a JSON file inside the manifest directory, with `{version:1,measuredAt,commit,environment,observer,...measurements}`. `environment` is `ci` only for automated checks; external gates require `production-equivalent`. Hash the exact artifact bytes. Artifacts must be original measurement reports with supporting evidence hashes and a named observer; changing a status string to `passed` cannot satisfy a schema. The validator checks consistency and attestations, not whether a human claim is true. Evidence reviewers remain responsible for provenance.

| Gate | Required measured evidence |
| --- | --- |
| `automated` | Distinct unit/integration/e2e suite reports, each with test count >0, failures 0 and exit code 0 |
| `operations` | Health, controlled restart, queue recovery, cleanup, graceful shutdown and log-redaction checks |
| `calibration` | ≥400 human-labelled cases; exactly25% holdout sealed before tuning; corpus/holdout hashes; emitted high-severity findings with precision≥95% |
| `providers` | Both GitHub and HubSpot using real read-only sandboxes: existence, changed properties, expired access, stale observations, reauthorization |
| `payments` | Real Dodo sandbox checkout, forged rejection, duplicate idempotency, out-of-order safety, cancellation, reactivation, trial end and quota enforcement |
| `recovery` | Independent encrypted Singapore backup, verified checksum/decryption and erasure replay; snapshot age≤6h, restore≤4h, service recovery verified |
| `load` | ≥100 accepted events/sec for≥60s; ≥10 representative completion samples; no errors/dropped batches/pending evaluations; p95 ingestion≤500ms, reads≤1s, evaluation≤90s |
| `security` | Independent review with zero high/critical findings, plus tenant isolation, CSRF, scoped keys, callbacks, SSRF, archive access and logs |
| `pilots` | Three distinct real teams, each with≥14 consecutive days, real workflows and reviewed outcomes |
| `paidLifecycle` | Real customer payment/settled invoice, cancellation, reactivation, quota application and no duplicate charges |
| `budget` | Current complete monthly estimate, configured independent monitoring, alert≤$120; explicit approval if capacity exceeds$150 |

Exact field names and constraints live in `packages/operations/src/release.ts`. An attestation containing zero high-severity findings cannot pass calibration precision. Provider fixtures do not pass the `realSandbox` gates. A local/disposable restore cannot pass `recovery`. Three copies of one workspace cannot pass `pilots`. Semantic blocking remains review-only without the exact detector's passed calibration report, and the global semantic switch defaults off.

## Representative load run

Use an explicitly selected load project on production-equivalent infrastructure. Set a policy that preserves the intended deterministic/semantic/verifier mix and disclose that mix in supporting evidence; do not enable real provider calls through a load key accidentally. The built-in synthetic workload contains starts, expected outcomes, tool calls/results and terminal events, with twenty runs per100-event batch by default. A reported tool receipt stays reported-only; the probe does not fabricate external verification.

Configure `LOAD_API_ORIGIN`, `LOAD_PROJECT_ID`, separate `LOAD_INGEST_KEY`/`LOAD_READ_KEY`, `RELEASE_COMMIT`, `LOAD_OBSERVER`, and `LOAD_REPORT_PATH` (its directory must already exist). Set `LOAD_CONFIRM` to the exact `https://API_ORIGIN/PROJECT_UUID` string before running `tsx scripts/load.ts`. Defaults are100 events/sec for60 seconds and100 events/batch. `LOAD_BATCH_EVENTS` accepts10–100 in multiples of10; total requested events must be divisible by the batch size. Bounds are10–1000 events/sec in multiples of10 and10–3600 seconds; shorter/slower runs are diagnostic and cannot satisfy the production gate.

The harness schedules batches against a monotonic clock, caps in-flight batches, records actual accepted throughput, ingestion/read p95s and sampled end-to-end evaluation completion. Reports default to `environment:"diagnostic"`; set `LOAD_ENVIRONMENT=production-equivalent` only for a matching deployment and record that deployment's configuration. Backpressure drops, non-202/non-durable responses, read failures and incomplete samples fail the run. Evaluation completion is measured from the actual send time until observation; polling gives a conservative upper bound. A run that cannot maintain the target rate fails rather than reporting the requested rate as achieved. A zero-sample latency is null and cannot pass.

Capture resource usage, worker queue backlog, representative batch sizes and semantic/provider request counts alongside the JSON. Run the explicit worker restart and cleanup drills separately; an ordinary load report cannot prove them. The harness creates synthetic test runs only and does not clean them up automatically, so retain/report the run long enough for evidence and then delete the dedicated load project through the authorized deletion path.

## Current acceptance state

The local unit/integration suites, service bundling and disposable encrypted restore mechanics have been exercised. The default evidence manifest remains empty. Real human calibration, provider accounts, payments, independent-store recovery, production-equivalent sustained load, security review, three two-week pilots and the paid lifecycle are pending. No deployment, paid resource creation, provider connection or real payment was performed as part of these operations assets.
