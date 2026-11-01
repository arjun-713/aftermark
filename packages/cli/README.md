# Agent Quality CLI

`aq` submits customer-generated traces and asserts candidate quality against immutable reviewed datasets. Requires Node 22.14+.

```sh
npm run build -w @agent-quality/cli
aq --help
aq compare --dataset <dataset-id> --policy <policy-id> --candidate candidate=runs.json --wait --json
aq report <experiment-id> --format junit --output comparison.xml
```

Configure `AQ_ENDPOINT`, `AQ_PROJECT_ID`, and a server-side `AQ_API_KEY`. Comparisons require the `ci` scope; exports require `read`, replay `evaluate`, and trace submission `ingest`. Use HTTPS for remote endpoints. Human dataset publishing requires explicit `AQ_SESSION_COOKIE` and `AQ_WORKSPACE_ID` from a workspace member session.

Mappings are JSON arrays of `{ "caseId": "published-case-id", "runId": "submitted-test-run-id" }`. Customer code runs in customer infrastructure; `aq` executes no customer commands. Reports preserve independent execution, quality, and verification states. Exit `0` means assertions passed, `1` a definite quality failure, and `2` infrastructure/pending/indeterminate results. Required unknown verification blocks by default.

`--json` and `--format junit` produce clean machine output. Diagnostics go to stderr. `--output` writes an artifact, `--wait --timeout 120` sets a finite polling deadline, and `--plain`/`--no-color` provide unstyled readable reports.

See the repository's `docs/REGRESSION.md` for publication contracts, acceptable failure/escalation cases, calibration gates, and the GitHub Actions example.
