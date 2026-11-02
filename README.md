# Aftermark

Outcome verification for SaaS workflow agents. TypeScript monorepo: Next.js UI, Fastify API, PostgreSQL/Drizzle data layer, durable workers, evaluation engine, integrations, and customer SDKs.

Requires Node 22.14+ and Docker Compose.

```sh
cp .env.example .env
npm install
docker compose up -d db
npm run db:migrate
npm run db:seed
npm run db:samples # optional, clearly labeled local examples
npm run dev # web, API and evaluation worker
```

Open http://localhost:3000. Seed credentials are development-only: `alex@example.test` or `sam@example.test`, password `local-password-123`. They belong to separate workspaces. Production refuses local authentication. API docs: http://localhost:4100/docs.

For the complete local Supabase Auth, PostgreSQL, private Storage and email inbox, use `npm run supabase:start` followed by `npm run dev:supabase`. This writes a separate ignored configuration and keeps the existing Compose database intact. Run `npm run supabase:verify` to exercise real authentication, tenant isolation, private downloads and email confirmation. See [Supabase setup](docs/SUPABASE.md) for local and hosted configuration. Existing `@agent-quality/*` package names, SDK imports and API identifiers remain compatible.

```sh
npm run typecheck
npm test
npm run test:python
npm run test:integration
npm run test:regression # separate disposable local database
npm run test:commerce # signed billing protocol and membership fixtures
npm run test:identity
npm run test:alerts
npm run test:storage
npm run test:storage-operations
npm run test:operations
npm run build:services
npm run build
npm run test:e2e # uses local Chrome by default
```

See [implementation evidence](docs/IMPLEMENTATION.md), [authentication setup](docs/AUTHENTICATION.md), [billing integration](docs/BILLING.md), and [customer integration examples](examples). Provider credentials belong in ignored environment files or the hosting secret store. Do not use the development database passwords in a deployed environment. Live provider, payment, calibration and deployment gates remain required before general availability.

The Docker/Render setup and recovery procedures are in [operations](docs/OPERATIONS.md) and [recovery](docs/RECOVERY.md). [Release gates](docs/RELEASE.md) distinguish local verification from production readiness; an empty evidence manifest deliberately blocks release. Semantic evaluations default off.
