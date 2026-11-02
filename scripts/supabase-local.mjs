import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { readFile, writeFile, mkdir, chmod } from "node:fs/promises";
import { randomBytes, randomUUID } from "node:crypto";
import { generateKeyPair, exportJWK } from "jose";
import { parse } from "dotenv";
import { Pool } from "pg";
import { createClient } from "@supabase/supabase-js";

const exec = promisify(execFile);
const root = new URL("../", import.meta.url);
const cwd = root.pathname;
const cli = new URL("node_modules/.bin/supabase", root).pathname;
const envPath = new URL(".env.supabase.local", root);
const mode = process.argv[2] ?? "prepare";
const cliEnv = { ...process.env, SUPABASE_TELEMETRY_DISABLED: "1" };

async function runCli(args) {
  try {
    return await exec(
      cli,
      [...args, "--agent", "no", "--output-format", "json"],
      {
        cwd,
        env: cliEnv,
        maxBuffer: 4 * 1024 * 1024,
        timeout: 600000,
      },
    );
  } catch {
    throw new Error(
      `Supabase ${args[0]} failed. Run the CLI command directly for diagnostics.`,
    );
  }
}

async function signingKey() {
  const directory = new URL("supabase/.keys/", root);
  const target = new URL("signing-keys.json", directory);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  try {
    const keys = JSON.parse(await readFile(target, "utf8"));
    if (!keys.some((key) => key.alg === "ES256" && key.kty === "EC" && key.d))
      throw new Error(
        "The local signing-key file must contain a private ES256 key.",
      );
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
    const { privateKey } = await generateKeyPair("ES256", {
      extractable: true,
    });
    const key = {
      ...(await exportJWK(privateKey)),
      kid: randomUUID(),
      alg: "ES256",
      use: "sig",
    };
    await writeFile(target, JSON.stringify([key]), { mode: 0o600, flag: "wx" });
  }
  await chmod(target, 0o600);
}

function assertLocal(value, port) {
  const url = new URL(value);
  if (
    !["localhost", "127.0.0.1", "[::1]"].includes(url.hostname) ||
    url.port !== port
  )
    throw new Error("Local setup refuses a non-local Supabase endpoint.");
  return url;
}

async function prepare() {
  const { stdout } = await runCli(["status", "--output", "json"]);
  const status = JSON.parse(stdout);
  if (
    !status.API_URL ||
    !status.DB_URL ||
    !(status.SECRET_KEY || status.SERVICE_ROLE_KEY)
  )
    throw new Error(
      "Start the local Supabase stack before preparing the application.",
    );
  assertLocal(status.API_URL, "54321");
  const migrationUrl = assertLocal(status.DB_URL, "54322");
  let previous = {};
  try {
    previous = parse(await readFile(envPath));
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  if (previous.DATABASE_URL) assertLocal(previous.DATABASE_URL, "54322");
  const runtimeUrl = new URL(migrationUrl);
  runtimeUrl.username = "aq_app";
  runtimeUrl.password = previous.DATABASE_URL
    ? new URL(previous.DATABASE_URL).password
    : randomBytes(36).toString("base64url");
  // Only a generated/reused local credential enters DDL; never print this query.
  const password = decodeURIComponent(runtimeUrl.password).replaceAll(
    "'",
    "''",
  );
  const admin = new Pool({ connectionString: migrationUrl.toString(), max: 1 });
  try {
    const found = await admin.query(
      "select rolsuper,rolbypassrls,rolcreatedb,rolcreaterole from pg_roles where rolname='aq_app'",
    );
    if (!found.rowCount)
      await admin.query(
        `create role aq_app login password '${password}' nosuperuser nobypassrls nocreatedb nocreaterole`,
      );
    else {
      if (Object.values(found.rows[0]).some(Boolean))
        throw new Error(
          "Refusing an existing elevated application database role.",
        );
      await admin.query(`alter role aq_app login password '${password}'`);
    }
    // Hosted/local Supabase's postgres role is not a PostgreSQL superuser.
    // It needs SET ROLE membership to create the queue schema owned by aq_app.
    await admin.query("grant aq_app to postgres");
  } finally {
    await admin.end();
  }
  const settings = {
    NODE_ENV: "development",
    AUTH_MODE: "supabase",
    DATABASE_URL: runtimeUrl.toString(),
    MIGRATION_DATABASE_URL: migrationUrl.toString(),
    PORT: "4100",
    API_ORIGIN: "http://localhost:4100",
    WEB_ORIGIN: "http://localhost:3001",
    SESSION_SECRET:
      previous.SESSION_SECRET || randomBytes(48).toString("base64url"),
    SUPABASE_URL: status.API_URL,
    SUPABASE_ANON_KEY: status.PUBLISHABLE_KEY || status.ANON_KEY,
    SUPABASE_SERVICE_ROLE_KEY: status.SECRET_KEY || status.SERVICE_ROLE_KEY,
    SUPABASE_GITHUB_ENABLED: "false",
    SEMANTIC_EVALUATIONS_ENABLED: "false",
    ARCHIVE_BUCKET: "agent-quality-private",
    LOCAL_ENCRYPTION_KEY:
      previous.LOCAL_ENCRYPTION_KEY || randomBytes(32).toString("base64"),
    MAILPIT_URL: status.MAILPIT_URL || status.INBUCKET_URL,
  };
  await writeFile(
    envPath,
    Object.entries(settings)
      .map(([key, value]) => `${key}=${JSON.stringify(value)}`)
      .join("\n") + "\n",
    { mode: 0o600 },
  );
  await chmod(envPath, 0o600);
  try {
    await exec(
      process.execPath,
      ["--import", "tsx", "packages/db/src/migrate.ts"],
      {
        cwd,
        env: { ...process.env, ...settings },
        timeout: 120000,
        maxBuffer: 1024 * 1024,
      },
    );
  } catch {
    throw new Error(
      "Application migration failed. Credentials were saved to .env.supabase.local; use its migration environment to diagnose.",
    );
  }
  const checked = new Pool({
    connectionString: migrationUrl.toString(),
    max: 1,
  });
  try {
    // This dedicated local project serves the application through Fastify only.
    await checked.query(
      "revoke all on all tables in schema public from anon, authenticated, service_role",
    );
    const exposed =
      await checked.query(`select p.proname from pg_proc p join pg_namespace n on n.oid=p.pronamespace
      where n.nspname='public' and p.prosecdef and
      (has_function_privilege('anon',p.oid,'execute') or has_function_privilege('authenticated',p.oid,'execute'))`);
    if (exposed.rowCount)
      throw new Error(
        "An application security-definer function is exposed through the Data API.",
      );
    const role = (
      await checked.query(
        "select rolsuper,rolbypassrls,rolcreatedb,rolcreaterole from pg_roles where rolname='aq_app'",
      )
    ).rows[0];
    if (!role || Object.values(role).some(Boolean))
      throw new Error("Application database role has elevated privileges.");
  } finally {
    await checked.end();
  }
  const storage = createClient(
    settings.SUPABASE_URL,
    settings.SUPABASE_SERVICE_ROLE_KEY,
    {
      auth: { persistSession: false, autoRefreshToken: false },
    },
  ).storage;
  let { data: bucket, error } = await storage.getBucket(
    settings.ARCHIVE_BUCKET,
  );
  if (!bucket) {
    const created = await storage.createBucket(settings.ARCHIVE_BUCKET, {
      public: false,
      fileSizeLimit: 16 * 1024 * 1024,
      allowedMimeTypes: ["application/json"],
    });
    if (created.error)
      throw new Error("Private archive bucket could not be created.");
    ({ data: bucket, error } = await storage.getBucket(
      settings.ARCHIVE_BUCKET,
    ));
  }
  if (error || !bucket || bucket.public)
    throw new Error("Archive bucket must be private.");
  console.log(
    "Supabase application ready: migrations applied, restricted runtime role, private archive bucket.",
  );
  console.log(
    "Runtime configuration: .env.supabase.local (ignored, mode 0600).",
  );
  console.log(
    "Studio: http://127.0.0.1:54323 · Email inbox: http://127.0.0.1:54324",
  );
  console.log("Start the application with npm run dev:supabase.");
}

try {
  if (!["start", "prepare"].includes(mode))
    throw new Error("Use start or prepare.");
  await signingKey();
  if (mode === "start") {
    console.log(
      "Starting local Supabase services; first-run image downloads may take several minutes.",
    );
    await runCli(["start"]);
  }
  await prepare();
} catch (error) {
  // Subprocess failures may contain command arguments or credentials. Emit only our own messages.
  console.error(
    error instanceof Error && !("cmd" in error)
      ? error.message
      : "Supabase setup failed.",
  );
  process.exitCode = 1;
}
