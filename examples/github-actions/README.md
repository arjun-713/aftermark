# Customer CI regression example

`regression.yml` expects a customer-owned runner to submit terminal test/staging traces through the SDK and produce `candidate-runs.json`. Install a pinned CLI package version or a package built from this repository in your agent repository before copying the workflow. The example does not execute an agent or use production tool credentials.

Set `AQ_ENDPOINT`, `AQ_PROJECT_ID`, and the secret `AQ_CI_API_KEY` with the project `ci` scope. Invoke with an immutable reviewed regression dataset ID and policy ID. Candidate mappings must cover every dataset case exactly once. The JUnit report is retained even when assertions fail or evaluation remains indeterminate. Required unknown verification blocks the job by default. Human calibration remains a separate release gate.
