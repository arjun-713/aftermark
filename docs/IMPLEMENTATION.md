# Implementation and release evidence

The release plan is the product contract. A local capability and a production release gate are tracked separately. No external sandbox, human calibration, load target, restore target, pilot result, or payment approval is implied by a green local test.

## Phase checkpoints

1. Foundation: Next.js/Fastify monorepo, runtime contracts, SQL migrations, Supabase authentication adapter, isolated local identities, scoped key management, RLS. Local gate passed: 4 contract tests, 5 authenticated API/database isolation tests, TypeScript check, production Next.js build, and Playwright login-to-workspace smoke. Dependency audit: zero findings after removing the vulnerable static documentation dependency. Supabase live authentication remains a deployment gate.
2. Ingestion: pending.
3. Evaluation: pending.
4. Verification: pending.
5. Review product: pending.
6. Regression: pending.
7. Commerce: pending.
8. Operations: pending.

## Design decisions

Working screens use the Framed sheet direction (seed 896759026), with IBM Plex Sans and IBM Plex Mono fixed by the brief. The product's signature is claim → expected outcome → observation, with provenance and uncertainty visible together. Metrics derive from stored runs. Development examples will be identified as samples.
