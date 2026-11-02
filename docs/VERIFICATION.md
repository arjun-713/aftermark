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

The authentication-provider update passed TypeScript checking, all 173 current unit tests and all 25 common API/database integration tests. Availability requires explicit application activation and a true provider setting from Supabase; missing, malformed, revoked or unavailable settings stay disabled. Google/GitHub live activation is deferred by the owner, so these protocol checks do not claim a completed social login.

## Aftermark interface and local production containers

The brand, logo, palette, components, working screens and public pages were redesigned with Impeccable and design-taste-frontend. Documentation now has persistent desktop contents, a mobile contents overlay, active-section feedback and deep-link focus. The final hero puts purpose, claim, expected state and independent observation in one section. Sign in/Create account modes remain visible, and primary acquisition links open signup directly. Unavailable social providers are hidden; their activation is deferred by the owner. GSAP motion respects reduced-motion preferences and leaves content visible.

The nine baseline browser workflows passed across desktop, tablet and phone. Three additional public/auth checks passed against the hosted Auth configuration after the user-directed hero/signup correction. The final frontend inspector reported zero failures; remaining warnings and their dispositions are recorded in `.impeccable/verification.md`. An independent reviewer approved the application/documentation surfaces and then all 15 current public/auth captures at 1440×900, 834×1000 and 390×844. These are interface approvals, not live payment or provider-authorization certification.

The running image is `aftermark:release`, built from application commit `50daba3692a270cdf86cd3c626255afaf2376eb4`, with manifest digest `sha256:d95390e6ecf63f400ac2d20892a55eeba491eb34b60fbf86ab66158456ee2447`. Web, API and worker run as UID/GID 10001 with `unless-stopped` restart policy. Only the API/worker receive backend credentials; migration credentials are excluded. The loopback bindings are web 3001, API 4100 and worker health 4101. All services reported healthy.

An actual browser run through the final production web-to-API proxy signed in with a disposable confirmed Supabase identity, established its browser session, created a workspace/project, and rendered the authenticated overview with no horizontal overflow or browser errors. Its synthetic records were removed; no external confirmation email was sent. HTTP checks returned 200 for the public routes and API readiness, and the authentication config returned `emailSignup:true` with both social providers false. Local email-confirmation/PKCE and hosted Auth/Storage checks are recorded above; external SMTP delivery remains unverified.

This workspace's role-separated runtime files are ignored under `.local/aftermark`. Inspect the running services with `docker compose -f .local/aftermark/compose.yml ps`; restart them with the same command and `up -d`. Temporary worktree/candidate services were stopped. The requested background containers remain running. No Render application deployment or paid-plan upgrade was performed.

## Required before general availability

- Live Supabase email/GitHub authentication and GitHub/HubSpot sandbox verification, including reauthorization and unavailable permissions.
- Dodo merchant approval, configured products and the full sandbox/paid lifecycle.
- At least 400 genuinely human-labelled calibration cases with a sealed 25% holdout; semantic blocking remains disabled until its detector passes calibration.
- Singapore deployment, sustained representative provider-enabled load, independent encrypted backup/restore and operational monitoring within the approved budget.
- Independent security review, published operator/support/privacy details, three external pilots for at least two weeks and a paid workspace completing its billing lifecycle.

`npm run check:release -- infra/release-evidence.example.json` intentionally fails: the example contains no measured production evidence. Local results never silently satisfy these external gates.
