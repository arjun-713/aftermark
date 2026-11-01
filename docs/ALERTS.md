# Configured project webhooks

Alerts are opt-in. A project has no default destination, and configuring one requires a current owner/admin member session. Up to five public HTTPS destinations can be configured per project. The default filter sends `fail`, `review`, and `unknown` evaluations; owners/admins can also select `pass`. The evaluation completion transaction records one delivery per evaluation/destination and enqueues its pg-boss job using `fromDrizzle` on that same transaction. A rollback leaves neither a completed evaluation nor an alert job. Reprocessing a completed evaluation cannot create another delivery for the same destination.

The external delivery contract is at least once. A timeout, worker termination or lost acknowledgment can cause delivery again after the receiver already accepted it. The stable event ID, unchanged body, and idempotency header support receiver deduplication; they do not establish exactly-once processing at another service.

## Payload and signature

The JSON contains only `schemaVersion`, `id`, `type`, `createdAt`, `projectId`, `evaluationId`, `revision`, `processing`, `quality`, and `verification:{verified,contradicted,unknown}`. IDs are opaque UUIDs. There is no customer run ID, event body, finding text, model context, resource properties, signed download link, provider response or credential. The stored raw UTF-8 body remains byte-for-byte identical across automatic retries and explicit replay. Queue records contain only organization/project/delivery UUIDs and a generation number.

Each attempt sends these headers:

| Header | Meaning |
| --- | --- |
| `x-aq-event-id` | Stable delivery UUID, also present as body `id` |
| `idempotency-key` | The same stable delivery UUID |
| `x-aq-timestamp` | Attempt time, integer Unix seconds |
| `x-aq-signature` | Lowercase hex HMAC-SHA256 of `timestamp + "." + raw_body` |
| `x-aq-key-version` | Destination signing-key version used for this attempt |
| `content-type` | `application/json` |

Verify the exact received bytes before parsing or reformatting JSON. Reject timestamps more than five minutes from the receiver's clock, validate a 64-character hex signature, compare in constant time, and durably deduplicate by event ID before performing side effects. Return a2xx response only after accepting the event durably. `verifyAlert` in `packages/alerts/src/contracts.ts` demonstrates signature and timestamp verification. The receiver owns its idempotency retention and processing semantics.

Signing secrets are encrypted with the existing envelope helper and tenant/project authenticated context; the encrypted value also binds the purpose and destination UUID. Production requires the configured Singapore KMS key. Local encryption is available only for development/tests. Creation and rotation return the secret once to the authorized member. List/health/delivery responses never return the plaintext secret or its envelope. Rotation increments the key version; receivers should allow an appropriate overlap for an attempt already in flight with the previous version. Signing uses a fresh timestamp and the current key on each new attempt.

## Endpoint safety and delivery bounds

Endpoints require HTTPS on port443, a qualified DNS hostname, and no URL user information, query parameters or fragments. Literal IP URLs, local/internal names and private/special-use addresses are rejected. The address policy is deliberately conservative, including special-purpose public exceptions and translated/tunneled IPv6 ranges. Ordinary public IPv4 and global unicast IPv6 are supported.

Creation resolves all addresses without sending a test webhook. Each delivery resolves all addresses again and rejects the entire answer set if any address is private, reserved, malformed or from an unexpected family. TCP lookup can return only an already validated address. The HTTPS connection retains the original hostname for the HTTP host, TLS SNI and certificate verification. Each request uses a fresh connection; redirects are never followed. A response body is not read or retained. This prevents a second DNS resolution from redirecting a validated public endpoint into an internal service.

DNS resolution is bounded to three seconds, KMS unwrap to fifteen seconds, and the HTTPS request to eight seconds. The queue job expires after60 seconds. There are at most five automatic attempts per generation, with exponential backoff starting at five seconds and capped at60 seconds. Failure codes and HTTP status integers are stored; destination response bodies, URLs, trace bodies and secrets are never logged. The worker throws a fixed failure message to pg-boss rather than forwarding transport errors. A dead-letter consumer repairs delivery state even when a worker terminated during its final attempt.

Owners/admins may replay a dead-letter or previously disabled delivery after enabling its destination. Replay requires the current generation, an explicit `confirm:"replay"`, a60-second cooldown, and fewer than three prior replays. Delivered records cannot be replayed. A replay increments the generation and creates a new durable job while keeping the original event ID and raw body. Stale jobs and stale dead-letter notifications cannot overwrite the new generation. Disabling prevents a pending attempt from starting; it cannot retract a request already in flight. Endpoint URLs are immutable: delete/create a destination to change the URL. Deleting a destination removes its queued jobs and delivery records.

Delivery rows are tenant/project scoped under forced RLS and cascade when their evaluation or destination is erased. They inherit the detailed evaluation lifecycle; source-run deletion cannot leave a delivery pointing to erased content. Destination configuration persists until explicitly removed or its project/workspace is deleted. Configuration changes and replay are audited with opaque resource IDs.

The initial capacity is bounded by five destinations/project, two concurrent alert jobs on the worker, and one concurrent delivery per workspace group. These jobs share the existing worker and PostgreSQL queue. No additional service, paid resource or default outbound destination is created. Sustained capacity and delivery latency need measurement under the release load/budget gates.

## API

All routes below require a current owner/admin session and a matching selected workspace/project; API keys cannot manage destinations or replay delivery.

| Method/path | Input/result |
| --- | --- |
| `GET /v1/alerts/destinations?projectId=UUID` | Public configuration metadata only |
| `POST /v1/alerts/destinations` | `{projectId,name,url,decisions?,signingSecret?}`; returns metadata plus the signing secret once |
| `PATCH /v1/alerts/destinations/:id` | `{projectId,enabled,decisions?}` |
| `POST /v1/alerts/destinations/:id/rotate-secret` | `{projectId}`; returns new key/version once |
| `DELETE /v1/alerts/destinations/:id?projectId=UUID` | Removes destination, delivery records and queued jobs |
| `GET /v1/alerts/health?projectId=UUID` | Scoped delivery/queue counts, oldest timestamps, safe dead-letter metadata and limits |
| `GET /v1/alerts/deliveries?projectId=UUID&state=dead_letter` | Latest50 delivery records; optional state filter |
| `POST /v1/alerts/deliveries/:id/replay` | `{projectId,expectedGeneration,confirm:"replay"}`;202 means queued, not delivered |

## Required root hooks

1. Apply `0011_alerts.sql` using the migration credential. Refresh the root lockfile for the new `packages/alerts` workspace. No new npm dependency is needed: HTTPS/DNS/crypto are Node built-ins, and pg-boss/zod/KMS helpers already exist.
2. In API `buildServer`, import `alertRoutes` from `./alerts.ts` and call `await alertRoutes(app)` alongside the other JSON routes, before registering the scoped evidence parser. Its ready hook initializes the two alert queues. The existing parent CSRF hook must continue to cover these session mutations.
3. In `evaluateInternal`'s final tenant transaction, after storing the completed assessment, call `await scheduleEvaluationAlerts(tx,{organizationId:job.organizationId,projectId:job.projectId,evaluationId:evaluation.id,revision:job.revision,assessment})`. Import the helper from `packages/alerts/src/index.ts`. Keep this inside the existing completion transaction; never enqueue after commit or send HTTP from evaluation processing. The helper selects configured decision filters and enforces the unique evaluation/destination key.
4. In worker startup, import `startAlertWorkers` from `./alerts.ts`, call `const stopAlerts=await startAlertWorkers()` after queue readiness, and await `stopAlerts()` before `stopQueue()`/pool shutdown. It registers both the delivery and dead-letter handlers on the existing pg-boss instance. Existing backend bundling includes these local modules through the entry-point imports.
5. Add `alerts` to the isolated test runner's allowed suites, using the exact disposable DB name `aq_alerts_test`, and include `tests/integration/alerts.test.ts` in its mapping. A suitable root script is `test:alerts: tsx scripts/test-isolated.ts alerts`. The test file refuses other database names. Tests inject DNS and HTTPS stubs and never contact customer endpoints.

Evidence is local: unit checks cover special-use IPv4/IPv6, mixed DNS answers, rebinding pinning, TLS options, redirect behavior, timeouts, strict metadata and signature verification. The disposable DB suite covers authorization/RLS, envelope privacy/binding, completion rollback, idempotent scheduling, stable retry signatures, native pg-boss retry/dead-letter handling, crash reconciliation and replay controls. Real destination delivery is unmeasured until a user deliberately configures an endpoint and completes a live acceptance exercise.

References: [IANA IPv4 special-purpose registry](https://www.iana.org/assignments/iana-ipv4-special-registry/), [IANA IPv6 special-purpose registry](https://www.iana.org/assignments/iana-ipv6-special-registry/), and [Node HTTPS/TLS request options](https://nodejs.org/docs/latest-v22.x/api/https.html#httpsrequesturl-options-callback).
