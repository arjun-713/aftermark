# Evaluation semantics and calibration

Execution status records what the customer process reported. Processing status records whether evaluation completed. Quality is pass/fail/review/unknown. Each expected outcome separately records verified/contradicted/unknown. These dimensions must not be collapsed.

The worker waits 30 seconds after ingestion of a terminal event, freezes the current revision, and stores its policy hash, observations and typed provider response. An older queued revision is superseded. Initial evaluation plus at most three automatic amendments are permitted. Explicit evaluation requests can process later revisions. Duplicate jobs reuse the same evaluation and usage record.

Read-only observations establish state at their timestamps, within the configured window after completion. They do not establish historical causality. Missing access, missing fields, redaction, stale state and missing expectations retain uncertainty. A reported tool result never establishes provider verification. Successful retries suppress an earlier deterministic unresolved-tool finding when the tool and arguments match.

The Jev adapter pins `jev-1.14.0`, batches focused questions into one request, and validates IDs, primitive types, distributions, ranges, score legends and answer count. It enables neither images nor long context. A conservative request-size bound refuses oversized essential context instead of truncating it. The semantic kill switch defaults off. Uncalibrated semantic findings remain review-only. Model confidence is a property of a distribution, not guaranteed correctness. Source: [TypeSafe primitives](https://docs.typesafe.ai/primitives), [model limits](https://docs.typesafe.ai/models).

Quota is reserved transactionally. The worker commits an ambiguous state before making a semantic request. If it terminates during that request, recovery retains the reservation and does not automatically send the request again. Validated responses are persisted before assessment. A provider rejection known not to have processed the request releases the reservation. Operators reconcile ambiguous reservations from provider usage records; transport retries never create a second customer evaluation charge.

## Human calibration release gate

The repository's automated fixtures are synthetic engineering tests. They are not a human-labelled calibration corpus. At least 400 human-labelled cases are still required, stratified by detector and failure mode, with an immutable 25% holdout.

Input records: `id`, `stratum`, `traceHash` (SHA-256 of the frozen case), `humanLabel` (`violation` or `clear`), and `labelledBy`. Each stratum must contain a multiple of four cases.

```sh
npm run calibrate -- seal labels.json sealed.json
# calibrate using the remaining 75%; preserve the sealed manifest before scoring
npm run calibrate -- score labels.json sealed.json predictions.json report.json
```

Predictions name `model`, `detectorHash` and one `{id, highSeverityFinding}` result for every sealed holdout case. The tool checks the original corpus hash, exact holdout cardinality and a minimum of 400 labels; it reports precision and coverage together. Zero emitted findings cannot pass the precision gate. An admin attests the report via `/v1/calibration-reports`, and blocking policies require a passed report for the exact detector hash. Reports attest human process; the platform cannot infer that a label was produced by a human from its text.

Target: at least 95% precision for high-severity semantic findings. Detectors missing that target remain review-only. Live Jev accuracy and latency are unmeasured until credentials, the corpus and a completed evaluation run are available.
