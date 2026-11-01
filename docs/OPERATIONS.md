# Operations and deployment

The production shape is one Next.js web instance, two Fastify API instances, and one durable evaluation worker in Render Singapore. Supabase Auth, PostgreSQL and private Storage belong in Singapore as well. `render.yaml` is a reviewable resource template; applying it creates billable services. No resource has been deployed by this implementation.

The initial operating envelope is $50–150/month. Alert at $120. Provider API usage, Supabase, Render, independent backup storage, KMS and egress all count toward the budget. `MONTHLY_BUDGET_USD>150` requires `CAPACITY_OVER_150_APPROVED=true`; record the approval and measured capacity need in release evidence. `infra/monitoring.json` defines alerts, but an external monitor and billing alert still need to be configured. It is not a running monitoring service.

## Build and rollout

`node scripts/build-services.mjs` bundles local workspace TypeScript into `dist/*.mjs` while keeping npm dependencies external. Runtime does not require `tsx` or other development dependencies. The migration bundle is `dist/db/migrate.mjs`; SQL files are copied to `dist/migrations` to preserve its relative file lookup. The Docker image contains the standalone Next server, API, worker, migration/backup/recovery tools and PostgreSQL 17 clients. It runs as UID/GID 10001 and forwards termination signals.

The Next configuration must set `output:'standalone'`. `API_ORIGIN` must be correct at web build time because the Next rewrite is compiled during build. Pass the intended API URL as the Docker build argument. It must also be available in the web service environment. Keep browser API traffic on `/api` so authentication cookies have the application origin. Render documents environment variables as Docker build arguments; verify the effective build value during staging.

```sh
npm ci
node scripts/build-services.mjs
npm run build -w @agent-quality/web
docker build --build-arg API_ORIGIN=https://YOUR_API_ORIGIN -t agent-quality:RELEASE .
```

In a managed cloud builder, pass its proxy CA as a BuildKit secret and use it for npm's TLS trust; keep TLS verification enabled. The repository Dockerfile uses the normal public CA store by default. Do not copy workstation `.env`, credentials, node_modules, backups or `.git` into an image; `.dockerignore` excludes them.

Run migrations as a separately credentialed release job before promoting API/worker instances. `SERVICE_ROLE=migrate` runs the bundled migrator. Provide `MIGRATION_DATABASE_URL` only to that job, along with the non-BYPASSRLS `DATABASE_URL` used to initialize pg-boss. The existing production config also requires Supabase auth mode and a private session secret for the migration process. Runtime roles reject a migration credential in their environment. Do not place the migration credential in the shared Render application environment group or an API pre-deploy environment.

Migration0006 adds nullable columns, new tables, narrowly scoped functions and indexes; existing API/worker code can run during its application. It detaches quota accounting from detailed evaluations and adds a project-scoped FK so retained units survive run expiration. Migration0007 adds the immutable server `first_ingested_at` clock, backfilled from the earliest stored server event ingestion (bounded to now) or now when unavailable. This clock drives archive/expiry/export deadlines and aggregate dates. Customer timestamps never drive retention. Existing migration files must never be edited after production application. Roll forward after a failed application; do not roll an applied schema back while newer services are running. Promote a verified image to the API instances, web and worker, then check health, queue recovery and maintenance. A code rollback can use the previous image against this expanded schema.

## Required integration hooks

The operations modules are deliberately registered through the existing entry points:

* In API `buildServer`, import `operationsRoutes` from `./operations.ts` and `await operationsRoutes(app)` before returning the server.
* In worker startup, import `startMaintenance` from `./maintenance.ts`; after queue startup call `const stopMaintenance=await startMaintenance()`. During shutdown, await `stopMaintenance()` before ending the DB pool. It catches and reports a failed cycle with a content-free log line and retries the durable work next cycle.
* Inside ingestion's tenant transaction, before creating/mutating each run, call `assertRunWritable(tx,org,project,run)` from `packages/operations/src/deletion.ts`. After locking an existing archived run, call `restoreRunDetail(tx,org,project,run,store)` before reading its event history. The run lock serializes archive pointer changes.
* In worker evaluation preparation, after `SELECT ... FROM runs ... FOR UPDATE` and before reading events/existing frozen input, call `restoreRunDetail` when `content_archived_at` is set. Do not acquire another session advisory lock on a second connection: the evaluator already holds its advisory lock. The helper uses the current transaction's row lock and rehydrates the exact frozen provider responses, so retries keep their existing provenance and reservation behavior.
* Use `loadRunContent(tx,project,run,store)` from API `operations.ts` for archived run detail, replay, policy preview, review context and publishing reviewed cases to datasets. The result has `run`, `events:[{event_id,event,ingested_at}]`, `evidence`, full `evaluations` with `frozen_input`/`provider_response`, `reviews`, and `decisions`. Select the requested evaluation by ID. Display events with `events.map(x=>x.event)`. Reading/replaying a frozen assessment must not call an external provider again.
* Late verifier evidence also needs the deletion admission hook and `restoreRunDetail` before insertion. An archived run remains writable within its original detailed retention period. Archiving does not reset the retention clock or authorize extra automatic evaluation amendments.

`SupabasePrivateStore` is a server-only dependency. Instantiate it when storage is configured; never expose the service role credential to a browser. The store checks that the bucket is private before each operation and bounds network requests. Private archive/download access follows the current workspace membership and key project scope.

Suggested root package scripts are `build:services: node scripts/build-services.mjs`, `backup: tsx scripts/backup.ts`, `restore: tsx scripts/restore.ts`, `test:load: tsx scripts/load.ts`, and the existing `check:release: tsx scripts/release-gates.ts`. Required additions are `esbuild` in development dependencies and `@aws-sdk/client-s3` in runtime dependencies. Keep them pinned in the lockfile.

## Configuration and credentials

| Variable | Purpose |
| --- | --- |
| `SERVICE_ROLE` | `web`, `api`, `worker`, `migrate`, `backup`, `restore`, `load`, or `release` |
| `ARCHIVE_BUCKET` | Existing private Supabase bucket; default `agent-quality-private` |
| `ARCHIVE_AFTER_DAYS` | 1–29, default 7; runs active in the last 24h are skipped |
| `OPERATIONS_BATCH_SIZE` | 1–100, default 10 runs per workspace per cycle |
| `OPERATIONS_INTERVAL_MS` | At least 1000, default 60000 |
| `DELETION_JOURNAL_HMAC_KEY` | At least 32 bytes, server/recovery only; retain independently of DB backups |
| `DELETION_JOURNAL_BUCKET` | Independent-account Singapore bucket, no expiry for its journal prefix |
| `BACKUP_BUCKET` | Independent-account Singapore bucket with seven-day lifecycle |
| `BACKUP_KMS_KEY_ID` | Exact KMS key ARN in Singapore for both independent stores |
| `BACKUP_DATABASE_URL` | Backup-only credential able to read the complete DB, including forced-RLS tables |
| `BACKUP_ENCRYPTION_KEY` | Canonical base64 of 32 random bytes; retain a recovery copy independently |
| `MONTHLY_BUDGET_USD` / `BUDGET_ALERT_USD` | Capacity ceiling/alert; default 150/120 |
| `CAPACITY_OVER_150_APPROVED` | Defaults false; explicit approval required above 150 |
| `SEMANTIC_EVALUATIONS_ENABLED` | Defaults false; disabling it stops new semantic requests, not stored replay |

The application role must be NOSUPERUSER/NOBYPASSRLS. The entry points already check this. The backup/restore administrator is separate and must never be used for the API or tenant maintenance. Backup credentials need to read every row; an ordinary application credential can silently produce an incomplete dump under RLS and is unsuitable. Restrict the backup identity to read/backup duties, and the restore administrator to isolated recovery work. Recreate the original PostgreSQL roles before restoring; ownership, ACLs and security-definer function owners are part of the backup contract.

Use workload identity or a narrowly scoped hosting secret for AWS, configured explicitly by the operator. This implementation does not select or reuse connected application credentials. The application needs KMS wrapping rights for the configured integration key, append-only journal writes and bucket location lookup. It does not need to read the journal. The backup identity needs encrypted writes and checksum/HEAD verification under `backups/`. The recovery identity needs list/read of backups and journals. Deny public bucket access, enforce TLS and SSE-KMS, and keep the backup bucket in a separate account/control boundary. Apply `infra/backup-lifecycle.json` only to the `backups/` prefix; never to `deletion-journal/`.

## Health and operator actions

`/health` is process liveness; API `/ready` checks PostgreSQL. Worker health uses its configured `PORT`/`WORKER_PORT`. Production monitoring must check the worker and the maintenance heartbeat as well as API readiness. Readiness alone does not prove that evaluation jobs are being consumed.

Workspace owners/admins with a current member session can call `GET /v1/operations/health?projectId=UUID`. The response includes scoped processing counts, queue counts/oldest timestamp, dead-letter IDs/retry counts, ambiguous reservation IDs and maintenance heartbeat. It excludes job payloads, traces, provider credentials and provider error bodies. No cross-workspace queue listing is exposed. A dead-letter entry needs investigation; this API deliberately provides no blind redrive that might repeat an ambiguous provider request.

`POST /v1/operations/reservations/:evaluationId/reconcile` accepts `projectId`, `state` (`consumed`/`released`), `tokens`, `providerEvidenceSha256`, and `confirmedProcessed`. It requires an ambiguous reservation older than 15 minutes and an owner/admin session. Confirm provider usage independently first; consumed requires confirmed processing, and released requires confirmed non-processing. The action records the evidence hash in audit history and never sends a provider request. It does not invent typed semantic answers or revise an already frozen assessment.

Logs are content-free: service, request ID, status/error code, duration and counts. Do not log request bodies, authentication headers, cookies, OAuth codes, URLs containing signed tokens, database URLs, provider response bodies or trace text. Backup/restore subprocess output is suppressed because client tools can emit connection details on failure. A failed backup is an alert, not an excuse to enable verbose credentials in shared logs.

Reference: [Render Blueprint spec](https://render.com/docs/blueprint-spec), [Docker deployments](https://render.com/docs/docker), [pre-deploy behavior](https://render.com/docs/deploys), and [private Supabase buckets](https://supabase.com/docs/guides/storage/buckets/fundamentals).
