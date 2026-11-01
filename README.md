# Agent Quality

Outcome verification for SaaS workflow agents. TypeScript monorepo: Next.js UI, Fastify API, PostgreSQL/Drizzle data layer, durable workers, evaluation engine, integrations, and customer SDKs.

Requires Node 22.14+ and Docker Compose.

```sh
cp .env.example .env
npm install
docker compose up -d db
npm run db:migrate
npm run db:seed
npm run db:samples # optional, clearly labeled local examples
npm run dev:api
# in another terminal
npm run dev:web
```

Open http://localhost:3000. Seed credentials are development-only: `alex@example.test` or `sam@example.test`, password `local-password-123`. They belong to separate workspaces. Production refuses local authentication. API docs: http://localhost:4100/docs.

```sh
npm run typecheck
npm run test:integration
npm run test:e2e # builds must be current; uses local Chrome by default
```

See [implementation evidence](docs/IMPLEMENTATION.md). Provider credentials belong in ignored environment files or the hosting secret store. Do not use the development database passwords in a deployed environment.
