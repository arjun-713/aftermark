# Supabase setup

Aftermark uses Supabase PostgreSQL, Auth and private Storage. Fastify remains the application API: a Supabase Auth session does not authorize direct access to the application tables. The repository pins Supabase CLI 2.122.0. The [CLI guide](https://supabase.com/docs/guides/local-development/cli/getting-started) describes installation and local services.

## Local environment

Requirements are Node 22.14+ and a running Docker engine.

```sh
npm ci
npm run supabase:start
npm run dev:supabase
```

Stop an existing application server before starting another on the same ports. The web application uses port 3001, API 4100 and worker health 4101. Supabase uses API 54321, PostgreSQL 54322, Studio 54323 and Mailpit 54324. The earlier Compose database on 55432 is independent and remains available for disposable integration suites.

`supabase:start` creates a private ES256 signing key, starts the stack, provisions a restricted `aq_app` role, applies the canonical application migrations, verifies the private archive bucket and writes `.env.supabase.local` with mode 0600. Re-running it preserves the session/encryption keys and runtime database password. `supabase:prepare` repeats application preparation against an already-running stack. Email confirmation is required; confirmation messages stay in the local inbox. GitHub sign-in is disabled until its provider is configured.

```sh
npm run supabase:verify
npm run supabase:stop
```

The verification creates disposable Auth users and workspaces, exercises real password login/JWKS, refresh, tenant isolation, connection context reset, Data API denial, private object upload/read/signed download/removal, logout, and local email confirmation with PKCE. It attempts every cleanup independently and reports incomplete cleanup. It sends no external email. The local Supabase stack is a development environment and must not be exposed as a public production service.

## Canonical migrations and database roles

SQL lives in `packages/db/migrations`, recorded in `public.schema_migrations`. Supabase's separate migration/seed runners are disabled in the local config; do not maintain a second copy of application SQL or use `supabase db reset` as an application migration command. `npm run db:migrate` applies the canonical history and initializes pg-boss.

Migration credentials and the application credential must be separate. Provision a random, private `aq_app` password before applying the foundation migration to a hosted project. The known password inside that historical migration is local-only; the migration preserves an already-provisioned role.

Supabase's `postgres` role is not a PostgreSQL superuser. It needs `GRANT aq_app TO postgres` so it can create the queue schema with `aq_app` as owner. This grants the migration role access to the application role; it does not grant the application role migration privileges. Verify `aq_app` has neither superuser, BYPASSRLS, CREATEDB nor CREATEROLE. The setup helper rejects an elevated existing role.

Migration 0017 closes explicit and default privileges for `anon`, `authenticated` and `service_role` in `public`, including security-definer entry points. Their Auth/Storage permissions remain intact. Existing application security-definer functions also revoke execution from `PUBLIC`. Tenant context is transaction-local and populated only by the authenticated application API.

Use a direct connection or the **session pooler on port 5432** for API, worker and migration roles. Transaction pooling on 6543 cannot preserve the worker's advisory locks. See [Supabase connection modes](https://supabase.com/docs/guides/database/connecting-to-postgres).

## Hosted project configured in this workspace

The CLI is linked to **Aftermark**, reference `smorxhvisnmqliygbdch`, in **ap-southeast-1 (Singapore)**. This was created in the existing organization without modifying its unrelated paused projects or upgrading its billing plan. Application migrations and the pg-boss schema are applied; the `agent-quality-private` bucket is private, accepts JSON and limits objects to 16 MiB. Database SSL enforcement is enabled.

Connection credentials are kept in `.env.supabase.hosted.local` and ignored local operator files, never in this document. The separate hosted verification is explicit:

```sh
npm run supabase:verify:hosted
```

This creates and removes synthetic confirmed users through the Auth admin API; it does not send mail or establish SMTP/GitHub OAuth readiness. Hosted Auth currently permits the exact local callback URLs at ports 3001 and 3002, has a 12-character password minimum, requires email confirmation and rotates refresh tokens. Configure the real HTTPS application origin and callback before a public deployment. Configure Resend SMTP and a verified sender before opening signup to customers; Supabase's built-in sender is not a substitute for the production mail configuration. The application user database contains no seeded customer accounts.

To link another checkout, sign in with `npx supabase login`, then run `npx supabase link --project-ref smorxhvisnmqliygbdch`. Account credentials stay in the CLI credential store. Use an ignored, separate working config for hosted changes: do not push the local stack configuration with localhost settings to production. Review `supabase config diff` before `config push`; the configured project is the only intended target.

## TLS trust

The public Supabase Root 2021 CA is bundled at `infra/supabase/prod-ca-2021.crt`, downloaded over HTTPS from [Supabase's certificate distribution](https://supabase-downloads.s3-ap-southeast-1.amazonaws.com/prod/ssl/prod-ca-2021.crt). SHA-256 fingerprint: `80:70:25:AD:50:D4:ED:21:9D:2C:9C:7D:29:9C:00:4F:82:4E:B0:0C:F7:F6:5A:FE:F6:07:D0:7B:72:E6:CA:FA`.

The local hosted connection URLs use `sslmode=verify-full` and explicitly reference this CA. The container also sets `NODE_EXTRA_CA_CERTS` for Node/pg and adds the CA to `PGSSLROOTCERT` for PostgreSQL command-line tools. Certificate verification remains enabled. See [Supabase SSL enforcement](https://supabase.com/docs/guides/platform/ssl-enforcement). Renew the bundled certificate and rerun the connection checks before its April 2031 expiry or a provider CA rotation.

Supabase setup does not replace the provider, billing, calibration, deployment and recovery release gates in [verification](VERIFICATION.md).
