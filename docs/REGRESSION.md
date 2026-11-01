# Reviewed cases and regression CI

Customer agents execute in customer infrastructure. Agent Quality accepts their traces, evaluates completed runs, and compares frozen evaluations. Neither the API nor `aq` executes arbitrary customer commands, replays write tools, or reruns production workflows.

## Publish an immutable dataset version

Resolve a review with a pass/fail decision and annotation. Publishing requires the current `reviewVersion` and a workspace member session; CI keys cannot manufacture human labels. Reviewed production, staging, and test cases are supported. The manifest retains the source environment and explicit `sample`, `fixture`, and `provenance` event metadata. A synthetic case remains synthetic after review.

`POST /v1/datasets` publishes a complete version. The next publication with the same project, name, and kind receives the next version and a new ID and hash. Existing versions cannot be updated by the application role.

```json
{
  "projectId": "20000000-0000-4000-8000-000000000001",
  "name": "Support regressions",
  "kind": "agent_regression",
  "cases": [{
    "reviewId": "30000000-0000-4000-8000-000000000001",
    "reviewVersion": 2,
    "caseId": "support-issue",
    "expectedBehavior": {
      "kind": "completion",
      "description": "Create the requested issue with verified properties.",
      "executionStatuses": ["completed"],
      "messageIncludes": [],
      "outcomes": [{"id": "issue", "verification": "verified"}]
    }
  }]
}
```

Each case stores the immutable human decision, its reviewer/version/annotation, the source evaluation/revision/policy, frozen trace and evidence, stored semantic response, expected outcomes, and a trace hash. The dataset hash covers its name, kind, version, and complete case manifest. Later run events or reviews do not replace that snapshot. Curated datasets survive routine trace retention; explicit deletion removes affected curated datasets and derived experiment reports.

`GET /v1/datasets?projectId=…&kind=agent_regression` lists versions. `GET /v1/datasets/:id?projectId=…` exports a complete version. `POST /v1/datasets/:id/replay` with `{ "projectId": "…" }` assesses only frozen data and stored typed semantic answers. It creates no evaluations, usage entries, external requests, or customer actions. Source calibration and policy activation gates are captured when the case is published.

Evaluator calibration is a separate dataset kind. Publish `kind: "evaluator_calibration"` with case fields `reviewId`, `reviewVersion`, optional `caseId`, `humanLabel` (`violation` or `clear`), and `stratum`; these cases have no `expectedBehavior`. They cannot be used in agent regression experiments. This publishing path does not claim that the 400-case human corpus, sealed holdout, detector precision gate, or live Jev acceptance has been completed. See [evaluation and calibration](EVALUATION.md).

## Express acceptable failures and escalation

`expectedBehavior.kind` is `completion`, `honest_failure`, or `escalation`. Completion requires completed execution and the published required outcomes to be verified. An explicit `outcomes` array can also assert particular verified outcomes. Required operation, source, assertion properties, observation window, repository, tool result mapping, and required flags must remain equal to the published contract. Resource IDs may change for isolated test resources.

Failure or escalation expectations require at least one `messageIncludes` phrase. Matching is literal and case-insensitive over recorded messages and terminal responses; it checks wording and does not establish the truth of an external handoff. For example:

```json
{
  "kind": "honest_failure",
  "description": "Acknowledge the issue creation failure without claiming completion.",
  "executionStatuses": ["failed"],
  "messageIncludes": ["could not create the issue"],
  "outcomes": [{"id": "issue", "verification": "contradicted"}]
}
```

An explicitly expected contradicted outcome can pass this behavioral assertion while the report continues to show execution `failed`, quality `fail`, and verification `contradicted`. Every case need not complete successfully. A false completion message fails the required acknowledgement check. Use a provider or signed customer verifier when an assertion must establish an external state change.

Required unknown verification remains `unknown` and blocks CI by default, including failure/escalation cases. An experiment may explicitly set `allowRequiredUnknown: true` (CLI `--allow-required-unknown`); the report retains the count and the exception. Explicit `verified`/`contradicted` assertions still require evidence and cannot be bypassed by that switch. Missing/truncated traces, processing errors, and unmatched pinned identities remain indeterminate.

Semantic findings block only when the selected immutable policy was activated at experiment creation, its exact detector hash has an approved calibration report, the frozen evaluation records calibration approval, and the policy/check enables blocking. Otherwise findings remain for review and are counted separately. Missing uncalibrated semantic answers cannot become a quality failure. No semantic request is repeated by comparison or replay.

## Submit candidate runs and compare

Run the agent in customer CI against test resources. Submit its events through the existing SDK/ingestion endpoint or `aq submit events.json`. Candidate runs must use `environment: "test"` or `"staging"` and contain a terminal execution event. Ingestion acknowledgement is durable acceptance, not a completed evaluation.

Prepare a JSON mapping file with exactly one distinct run per dataset case:

```json
[
  {"caseId": "support-issue", "runId": "ci-support-2026-11-02"}
]
```

`POST /v1/experiments` accepts:

```json
{
  "projectId": "20000000-0000-4000-8000-000000000001",
  "name": "Candidate against main",
  "datasetId": "50000000-0000-4000-8000-000000000001",
  "policyId": "40000000-0000-4000-8000-000000000001",
  "candidates": [{"name": "candidate", "runs": [{"caseId": "support-issue", "runId": "ci-support-2026-11-02"}]}],
  "allowRequiredUnknown": false,
  "evaluateMissing": true
}
```

Optional `datasetHash` and `policyHash` must exactly match their selected immutable versions. Duplicate/missing/extra cases and reused run IDs within a candidate are rejected. Each mapping may specify an `evaluationId`; it must belong to the selected run and policy. A completed older evaluation can be explicitly selected. Otherwise the experiment pins the current run revision and any matching evaluation.

By default, missing candidate evaluations are queued under the selected policy; provider verification is read-only. Set `evaluateMissing: false` or CLI `--no-evaluate` to use existing evaluations only. Late events cannot advance a saved mapping to a different revision. If the pinned revision was superseded before evaluation, publish a new candidate mapping to the completed revision. Re-running an experiment request creates a separate experiment; read its saved ID to poll the same one.

The creation response and `GET /v1/experiments/:id?projectId=…` return a versioned comparison report with dataset/policy hashes, frozen calibration/activation gates, per-candidate case decisions/assertions, independent execution/quality/verification fields, pending state, and counts of failures, unknowns, and semantic review findings. `ready` describes whether pinned evaluations completed; `status` describes assertion results. `GET /v1/experiments?projectId=…` lists saved experiments.

## CLI and automation contract

```sh
npm run build -w @agent-quality/cli
# The workspace installs the aq package entrypoint; source invocation is also available.
npm run aq -- --help

export AQ_ENDPOINT=https://your-agent-quality.example
export AQ_PROJECT_ID=your-project-uuid
# Supply AQ_API_KEY through your secret store, never committed files.
aq compare --dataset "$DATASET_ID" --policy "$POLICY_ID" \
  --candidate baseline=baseline-runs.json --candidate candidate=candidate-runs.json \
  --wait --timeout 120 --poll 2 --json --output comparison.json
aq report "$EXPERIMENT_ID" --format junit --output comparison.xml
aq report "$EXPERIMENT_ID" --plain
```

Use a project-scoped CI key with `ci` to create/read comparisons. Dataset exports need `read`; dataset replay needs `evaluate`; trace submission needs `ingest`. Use separate ingestion and CI keys where possible. Human publication requires a member session. `aq datasets publish manifest.json` uses explicit `AQ_SESSION_COOKIE` and `AQ_WORKSPACE_ID` environment variables; do not put session credentials in scripts or CI. `aq datasets validate manifest.json` performs local validation without credentials.

The CLI supports readable, JSON, and JUnit comparison reports; `--output` writes the selected format to a file. JSON stdout contains one JSON value, JUnit stdout one XML document. Diagnostics/progress go to stderr. Readable output respects `NO_COLOR`, `--no-color`, redirected streams, and narrow terminals. Commands have no prompts; Ctrl-C cancels the current request/wait. Network calls have a 15-second request bound; `--wait --timeout` additionally bounds evaluation polling, with a two-minute default. A deadline preserves the saved pending report and prints the resume command to stderr.

Exit codes are stable:

| Exit | Meaning |
| --- | --- |
| `0` | Every requested assertion passed, including explicitly recorded acceptable failure/escalation behavior or allowed uncertainty. |
| `1` | A completed report has a definite quality assertion failure. |
| `2` | Infrastructure/input/authentication failure, pending evaluation, or indeterminate quality. |

JSON report keys under `schemaVersion: "1.0"` and the exit codes are automation contracts. JUnit emits definite quality failures as `<failure>` and indeterminate/pending cases as `<error>`. The standalone package bundles its runtime code into a Node 22+ entrypoint. Build artifacts are generated from source and are not committed.

[GitHub Actions example](../examples/github-actions/regression.yml) consumes candidate mappings produced by customer CI. It supplies no agent runner, fabricated labels, provider observations, or production replay.
