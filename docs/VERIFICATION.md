# Local verification and remaining release gates

This repository implements the eight product capability phases. General availability remains blocked on measured external gates. Synthetic tests, localhost performance, container startup and local recovery do not establish live provider/payment behavior or Singapore production reliability.

## Automated checks

The integrated verification covers TypeScript checking, 169 unit tests, 126 API/database integration cases across the common and isolated suites, three Python SDK tests, and nine Playwright journeys at desktop (1440), tablet (834) and phone (390) widths. The browser journeys cover onboarding, linked contradictory evidence, conflict-safe human review, immutable dataset publication, regression comparison, billing state, invitations, retention, alert endpoint rejection and processing health. Rendered screens were inspected. The production web build, standalone CLI/SDK bundles and dependency audit are checked separately.

SDK verification ran on Node 22.23.1 and Python 3.14.7; the container used Node 22.23.4. Vercel AI SDK and LangGraph examples are provided; live framework/model compatibility is not claimed by the native SDK tests.

## Container rehearsal

Image: `agent-quality:integrated-qa`. Local digest: `sha256:6d4e062b6ae9f3e26363fae2cf6ba15e9108ac344c571822b73286f4a32898a0`. Source fingerprint: `2981facdc8082b71d3a2d0159d238d35757c57b5a9a457ac8de4e8cef5d37413`.

API readiness, worker health, web rendering and the compiled web-to-API proxy all returned HTTP 200. UID 10001 could write temporary/cache files and could not modify application code. Misplaced evaluator credentials were rejected. All three service roles stopped with exit code 0. The rehearsal used a fresh disposable local database and development identities; it made no live provider calls and deployed no cloud service. QA containers were removed.

## Encrypted recovery rehearsal

PostgreSQL 17.6: 15 actual migrations through `0016_content_accounting_indexes.sql`. An actual 200,436-byte custom dump was encrypted with AES-256-GCM, checksum-verified, authenticated and restored in 3,844 ms. An independent HMAC deletion journal erased the target run while preserving its original source row. Retained runs stayed queryable, and authenticated HTTP checks verified tenant isolation. The application role had neither superuser nor BYPASSRLS. Plaintext dumps and ephemeral encryption keys were not retained.

Recovery source fingerprint: `456fffa7aef250b291f8ea9e4ef381fd54f8ba0cea765a2927a3861507512c31`. Region, independent Singapore storage, production RPO/RTO and cloud IAM remain unverified.

## Load diagnosis

The latest localhost probe submitted 100 events/second for 60 seconds in 100-event batches. It used deterministic checks, unknown customer-verifier outcomes and an explicitly enlarged synthetic trial allowance; no semantic/provider requests or real charges occurred.

| Measure | Latest probe |
| --- | ---: |
| Accepted events | 6,000 |
| HTTP errors / dropped batches | 0 / 0 |
| Completed evaluations | 1,200 |
| Consumed units / held units | 1,200 / 0 |
| Remaining queued evaluations | 0 |
| Ingestion p95 | 1515 ms |
| Run-query p95 | 91 ms |
| Sampled evaluation p95 | 83.9 s |

A preceding tuning probe measured ingestion p95 425 ms, query p95 174 ms and evaluation p95 57.4 s. Repeated measurements varied: the latest ingestion latency exceeds the 500 ms acceptance target. The production load gate remains open. Completion latency is a conservative polling observation; the probe does not establish semantic or live-verifier latency. Source fingerprint for the latest load: `516b1b727c263ceeeef95bb70ce3dd3c5ee35febb0e19d72b8ef990ef0fac1dd`.

The exercise exposed and corrected repeated tenant-wide accounting scans, per-row accounting writes, idle polling during a queue burst and a PostgreSQL expression-depth failure during large reconciliation. A separate regression and a full maintenance run cover the reconciliation fix. Storage/usage limits and atomic rollback remain enforced.

## Supabase integration verification

Supabase CLI 2.122.0 initialized a separate local Auth/PostgreSQL/Storage stack and linked the new Aftermark project `smorxhvisnmqliygbdch` in Singapore. All 16 canonical SQL files through `0017_supabase_api_boundary.sql` and the pg-boss schema are applied locally and to the hosted project. The application role has no superuser/BYPASSRLS privilege. The hosted database enforces SSL and uses certificate-verified session-pool connections. A private JSON archive bucket is configured.

Thirteen local checks passed using real Supabase services, including email confirmation and PKCE callback. Twelve checks passed against the hosted project, including actual JWKS/password login, refresh, two independent workspaces, Data API permission denials under anonymous/member/service credentials, private object access and signed downloads. The probes require a PostgreSQL permission denial rather than accepting a malformed API-key rejection. Their synthetic users/workspaces/objects are removed. No external email or production agent/provider side effects were sent.

The source review corrected Node's custom-CA trust and independent cleanup attempts. A container connection probe with the declared extra CA confirmed an authorized TLSv1.3 connection and restricted runtime role against the hosted session pooler. Hosted SMTP, GitHub sign-in, the public HTTPS origin and public application deployment remain separate configuration/verification work. The organization remains on its existing free plan; no billing upgrade was made. Details and commands are in [Supabase setup](SUPABASE.md).

## Required before general availability

The authentication-provider update passed TypeScript checking, all 173 current unit tests and all 25 common API/database integration tests. Availability requires explicit application activation and a true provider setting from Supabase; missing, malformed, revoked or unavailable settings stay disabled. Google/GitHub live activation is deferred by the owner, so these protocol checks do not claim a completed social login.

- Live Supabase email/GitHub authentication and GitHub/HubSpot sandbox verification, including reauthorization and unavailable permissions.
- Dodo merchant approval, configured products and the full sandbox/paid lifecycle.
- At least 400 genuinely human-labelled calibration cases with a sealed 25% holdout; semantic blocking remains disabled until its detector passes calibration.
- Singapore deployment, sustained representative provider-enabled load, independent encrypted backup/restore and operational monitoring within the approved budget.
- Independent security review, published operator/support/privacy details, three external pilots for at least two weeks and a paid workspace completing its billing lifecycle.

`npm run check:release -- infra/release-evidence.example.json` intentionally fails: the example contains no measured production evidence. Local results never silently satisfy these external gates.
