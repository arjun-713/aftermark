# Backup and recovery contract

Targets are RPO ≤6 hours and RTO ≤4 hours. They are release criteria requiring a measured recovery from the real independent Singapore backup store and a healthy application/worker afterward. A cron definition, encrypted file or local restore alone does not establish those targets.

The Render backup cron runs at `0 */6 * * *` UTC. `scripts/backup.ts` opens a repeatable-read transaction, exports a PostgreSQL snapshot, and dumps that exact snapshot using PostgreSQL 17. Archive pointers and their private objects are captured from the same snapshot. Each payload is read and checked against its stored SHA-256, encrypted with AES-256-GCM using a fresh IV, and uploaded to the independent bucket with SSE-KMS. Upload and HEAD checksum, length and encryption checks must pass before the manifest is published. A missing archive object or provider outage fails the backup; no incomplete manifest is advertised as successful.

The manifest includes the snapshot time, migration list, DB object checksum/size/IV/tag, and each archived object's checksum/size/IV/tag. The timestamp describes the snapshot, rather than the upload finish. All artifacts use the `backups/` prefix with a seven-day lifecycle, including noncurrent versions. `infra/backup-lifecycle.json` also aborts abandoned multipart uploads after one day. The implementation uses single-object PUT: capacity requiring files beyond S3's single-PUT limit needs an approved multipart extension and a new restore rehearsal.

The archive copy ensures that a database pointer can recover even if the primary Supabase Storage service is lost. The DB dump alone cannot do that. Curated dataset bodies live in the database and are included in the dump. Authentication users/sessions in an externally managed Supabase Auth service are outside this PostgreSQL dump; Supabase project recovery/identity continuity must be verified in the full service recovery exercise.

Keep `BACKUP_ENCRYPTION_KEY`, the HMAC journal key, KMS access, the original PostgreSQL roles/ownership, and the independent backup account recovery access outside the source database and primary hosting account. A successful backup report contains IDs, checksums and counts, not trace bodies or secrets. Configure an external alert when the newest verified snapshot is older than six hours. Seven-day retention is a recovery window, not an acceptable RPO.

## Isolated restore

Create a fresh database named `aq_restore_SUFFIX`; the restore command refuses any other name, a mismatched confirmation, the source DB name, or a target with existing user tables. It never drops a database, creates a production service or switches traffic. Provision original database roles first so pg_restore can recover ACLs, queue ownership and security-definer function owners correctly.

Supply these server-side variables to `node dist/restore.mjs` or `tsx scripts/restore.ts`:

| Variable | Value |
| --- | --- |
| `SOURCE_DATABASE_URL` | Source connection, used only to reject a same-name restore target |
| `RESTORE_DATABASE_URL` | Restore-only administrator connection to the empty target |
| `DATABASE_URL` | Non-BYPASSRLS application connection to that same target |
| `RESTORE_CONFIRM_DATABASE` | Exact `aq_restore_SUFFIX` target name |
| `RESTORE_MANIFEST_KEY` | `backups/UUID.manifest.json` in the independent bucket |
| `RESTORE_REPORT_PATH` | Private local path for measured JSON report |
| `BACKUP_BUCKET`, `BACKUP_KMS_KEY_ID`, `BACKUP_ENCRYPTION_KEY` | Independent backup access/decryption settings |
| `DELETION_JOURNAL_BUCKET`, `DELETION_JOURNAL_HMAC_KEY` | Independent journal access/replay settings |
| `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `ARCHIVE_BUCKET` | Private archive target for surviving, non-deleted objects |

Use TLS with certificate verification for remote PostgreSQL. The tools pass parsed libpq credentials in the child environment, excluding passwords from argv and shared logs. `pg_restore` requires an administrator; tenant replay uses the application role and explicitly verifies that it is not a superuser/BYPASSRLS role. Using an administrator for tenant replay could defeat its scoped queries and is refused.

The recovery order is checksum verification, authenticated decryption, restore into the empty DB, migration-manifest comparison, forced-RLS application-role check, independent journal replay, timed-detail expiry, expired pointer cleanup, and recovery of only the remaining live private objects. Existing objects are checksum-checked. Missing live archive pointers or pending cleanup fail recovery. Keep both old and restored services offline during recovery against the original storage bucket; replay intentionally removes erased objects.

The report records measured DB/object restore duration and snapshot age and fails the corresponding 4h/6h targets when exceeded. It deliberately leaves `serviceRecoveryVerified:false`: an operator must run the service checks below and persist their report before supplying production acceptance evidence.

## Promotion rehearsal

1. Start isolated API/web/worker services on the restored target with application credentials and semantic evaluation disabled. Verify health, DB readiness, login/membership, scoped run/history reads and private archived content.
2. Verify a queued deterministic evaluation is consumed, an in-flight job recovers after a controlled worker restart, and an ambiguous semantic reservation does not create another provider request. Observe DLQ/oldest-job metrics.
3. Exercise retention, failed object cleanup/retry and an explicit deletion. Confirm that a deleted trace, its curated/derived copies and its objects stay absent after recovery. Check the journal from outside the restored DB.
4. Record latest snapshot age, full elapsed recovery time, storage checksums, service health, queue/restart/cleanup outcomes and the exact commit. Keep synthetic/local evidence separate from the real independent-store exercise.
5. Promote only after release gates pass and the recovery target is approved. DNS/traffic changes and paid infrastructure creation are separate operator actions; these scripts perform neither.

## Local engineering evidence

The isolated `aq_operations_test` suite exercises failed archive verification, atomic pointer commits, transactional rehydration for late revisions, 30-day expiration, quota-accounting survival, curated retention, write-ahead journal failure, replay without a source run, object deletion, authorization and RLS. Tests refuse to run against another DB name.

A development rehearsal also encrypted a PostgreSQL 17 dump, restored it into the initially empty `aq_restore_test`, replayed a separate file-backed tombstone and verified that the source retained its synthetic trace while the restore erased it. The restored API's health/readiness returned 200 using NOSUPERUSER/NOBYPASSRLS credentials. This proves the local restore mechanics and does not satisfy the independent Singapore recovery, production Auth recovery or full application/worker recovery gates. Local fixtures are available only under ignored `.local/`; no customer/provider data or production credentials were used.
