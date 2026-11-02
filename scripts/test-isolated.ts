import "dotenv/config";
import { Pool } from "pg";
import { spawn } from "node:child_process";
const suite = process.argv[2];
if (
  ![
    "regression",
    "commerce",
    "operations",
    "identity",
    "alerts",
    "storage",
    "storage_ops",
  ].includes(suite)
)
  throw new Error(
    "Select regression, commerce, operations, identity, alerts or storage.",
  );
if (process.env.NODE_ENV === "production")
  throw new Error(
    "Disposable integration databases are disabled in production.",
  );
const adminUrl = new URL(
  process.env.MIGRATION_DATABASE_URL ??
    "postgresql://postgres:local_postgres_password@localhost:55432/agent_quality",
);
const appUrl = new URL(
  process.env.DATABASE_URL ??
    "postgresql://aq_app:local_app_password@localhost:55432/agent_quality",
);
if (
  !["localhost", "127.0.0.1", "[::1]"].includes(adminUrl.hostname) ||
  adminUrl.host !== appUrl.host
)
  throw new Error(
    "Isolated test setup is restricted to the same local PostgreSQL server.",
  );
const database = `aq_${suite}_test`;
const admin = new Pool({ connectionString: adminUrl.toString(), max: 1 });
try {
  const result = await admin.query(
    "select 1 from pg_database where datname=$1",
    [database],
  );
  if (!result.rowCount) await admin.query(`create database "${database}"`);
} finally {
  await admin.end();
}
adminUrl.pathname = `/${database}`;
appUrl.pathname = `/${database}`;
const env: NodeJS.ProcessEnv = {
  ...process.env,
  NODE_ENV: "test",
  DATABASE_URL: appUrl.toString(),
  MIGRATION_DATABASE_URL: adminUrl.toString(),
  AQ_REGRESSION_TEST_DATABASE: suite === "regression" ? database : undefined,
  AQ_INTEGRATION_SUITE: suite,
};
async function run(command: string, args: string[]) {
  const child = spawn(command, args, { stdio: "inherit", env });
  const code = await new Promise<number>((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code) => resolve(code ?? 1));
  });
  if (code !== 0) process.exit(code);
}
await run("npm", ["run", "db:migrate"]);
await run("npm", ["run", "db:seed"]);
await run(process.execPath, [
  "node_modules/vitest/vitest.mjs",
  "run",
  "--config",
  "vitest.isolated.config.ts",
]);
