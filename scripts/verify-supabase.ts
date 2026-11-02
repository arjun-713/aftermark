import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { readdir } from "node:fs/promises";
import { Pool } from "pg";
import { createClient } from "@supabase/supabase-js";

// Deliberately uses real Auth, JWKS, PostgreSQL and Storage. It creates only
// uniquely named disposable users/workspaces and removes those identities below.
if (
  process.env.AUTH_MODE !== "supabase" ||
  !process.env.SUPABASE_URL ||
  !process.env.SUPABASE_ANON_KEY ||
  !process.env.SUPABASE_SERVICE_ROLE_KEY ||
  !process.env.MIGRATION_DATABASE_URL
)
  throw new Error(
    "Load a Supabase application environment before running this check.",
  );
Object.assign(process.env, { NODE_ENV: "test" });
const { buildServer } = await import("../apps/api/src/server.ts");
const { pool } = await import("../packages/db/src/index.ts");
const { SupabasePrivateStore } =
  await import("../packages/operations/src/storage.ts");
const application = await buildServer();
const admin = new Pool({
  connectionString: process.env.MIGRATION_DATABASE_URL,
  max: 1,
  connectionTimeoutMillis: 15000,
});
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY,
  {
    auth: { autoRefreshToken: false, persistSession: false },
    global: {
      fetch: (url, init) =>
        fetch(url, { ...init, signal: AbortSignal.timeout(15000) }),
    },
  },
);
const suffix = randomUUID();
const users: string[] = [];
const organizations: string[] = [];
const mailIds: string[] = [];
const objectPath = `verification/${suffix}/receipt.json`;
const store = new SupabasePrivateStore();
let objectCreated = false;
let checks = 0;
const checked = (name: string) => {
  checks++;
  console.log(`  OK ${name}`);
};
const cookie = (response: { cookies: { name: string; value: string }[] }) =>
  response.cookies.map((value) => `${value.name}=${value.value}`).join("; ");

try {
  assert.equal(
    (await application.inject({ method: "GET", url: "/ready" })).statusCode,
    200,
  );
  const role = (
    await pool.query(
      "select rolsuper,rolbypassrls from pg_roles where rolname=current_user",
    )
  ).rows[0];
  assert.equal(role.rolsuper, false);
  assert.equal(role.rolbypassrls, false);
  checked("restricted runtime role and database readiness");
  const applied = new Set(
    (await admin.query("select name from public.schema_migrations")).rows.map(
      (row) => row.name,
    ),
  );
  const required = (
    await readdir(new URL("../packages/db/migrations/", import.meta.url))
  ).filter((name) => name.endsWith(".sql"));
  assert.ok(
    required.every((name) => applied.has(name)),
    "A canonical application migration is missing.",
  );
  checked("application migrations applied");
  const identities: {
    cookie: string;
    token: string;
    org: string;
    project: string;
  }[] = [];
  for (const index of [1, 2]) {
    const email = `supabase-check-${index}-${suffix}@aftermark.invalid`;
    const password = randomBytes(32).toString("base64url");
    const { data, error } = await supabase.auth.admin.createUser({
      email,
      password,
      email_confirm: true,
    });
    assert.ok(
      !error && data.user,
      "Disposable Auth identity could not be created.",
    );
    users.push(data.user.id);
    const login = await application.inject({
      method: "POST",
      url: "/v1/auth/login",
      payload: { email, password },
    });
    assert.equal(
      login.statusCode,
      200,
      `Supabase login failed (${login.statusCode}).`,
    );
    const jar = cookie(login);
    const token = login.cookies.find(
      (value) => value.name === "aq_session",
    )?.value;
    assert.ok(token);
    assert.ok(login.cookies.find((value) => value.name === "aq_refresh"));
    const me = await application.inject({
      method: "GET",
      url: "/v1/me",
      headers: { cookie: jar },
    });
    assert.equal(me.statusCode, 200);
    checked(`Auth password exchange, JWKS and session for workspace ${index}`);
    const workspace = await application.inject({
      method: "POST",
      url: "/v1/workspaces",
      headers: { cookie: jar },
      payload: { name: `Supabase verification ${suffix}-${index}` },
    });
    assert.equal(workspace.statusCode, 200);
    const org = workspace.json().id as string;
    organizations.push(org);
    const project = await application.inject({
      method: "POST",
      url: "/v1/projects",
      headers: { cookie: jar, "x-workspace-id": org },
      payload: { name: "Verification agent" },
    });
    assert.equal(project.statusCode, 200);
    identities.push({ cookie: jar, token, org, project: project.json().id });
    checked(`authenticated workspace/project creation ${index}`);
  }
  for (const [current, other] of [
    [identities[0], identities[1]],
    [identities[1], identities[0]],
  ]) {
    const own = await application.inject({
      method: "GET",
      url: "/v1/projects",
      headers: { cookie: current.cookie, "x-workspace-id": current.org },
    });
    assert.equal(own.statusCode, 200);
    assert.equal(own.json().length, 1);
    assert.equal(own.json()[0].id, current.project);
    const cross = await application.inject({
      method: "GET",
      url: "/v1/projects",
      headers: { cookie: current.cookie, "x-workspace-id": other.org },
    });
    assert.ok([403, 404].includes(cross.statusCode));
  }
  assert.equal(
    (await pool.query("select count(*)::int as count from organizations"))
      .rows[0].count,
    0,
  );
  checked("two-way tenant isolation and connection context reset");
  const apiHeaders = (key: string, token?: string) => {
    const headers: Record<string, string> = { apikey: key };
    if (token || !key.startsWith("sb_"))
      headers.Authorization = `Bearer ${token || key}`;
    return headers;
  };
  for (const headers of [
    apiHeaders(process.env.SUPABASE_ANON_KEY),
    apiHeaders(process.env.SUPABASE_ANON_KEY, identities[0].token),
    apiHeaders(process.env.SUPABASE_SERVICE_ROLE_KEY),
  ]) {
    const response = await fetch(
      `${process.env.SUPABASE_URL}/rest/v1/users?select=id&limit=1`,
      {
        headers,
        signal: AbortSignal.timeout(15000),
      },
    );
    assert.ok(
      [401, 403].includes(response.status),
      "Application tables must not be exposed through the Data API.",
    );
    const denial = (await response.json()) as { code?: string };
    assert.equal(
      denial.code,
      "42501",
      "Expected a database permission denial, not an invalid API key or JWT.",
    );
  }
  const exposed =
    await admin.query(`select p.proname from pg_proc p join pg_namespace n on n.oid=p.pronamespace
    where n.nspname='public' and p.prosecdef and
    (has_function_privilege('anon',p.oid,'execute') or has_function_privilege('authenticated',p.oid,'execute'))`);
  assert.equal(exposed.rowCount, 0);
  checked(
    "Data API denies anonymous, member and service-role access to application tables/functions",
  );
  const refreshed = await application.inject({
    method: "POST",
    url: "/v1/auth/refresh",
    headers: { cookie: identities[0].cookie },
  });
  assert.equal(refreshed.statusCode, 200);
  const refreshedMe = await application.inject({
    method: "GET",
    url: "/v1/me",
    headers: { cookie: cookie(refreshed) },
  });
  assert.equal(refreshedMe.statusCode, 200);
  checked("real Supabase refresh session");
  const bytes = new TextEncoder().encode(
    JSON.stringify({
      verification: suffix,
      evidence: "independent storage observation",
    }),
  );
  await store.put(objectPath, bytes);
  objectCreated = true;
  assert.deepEqual(await store.get(objectPath), bytes);
  const publicDownload = await fetch(
    `${process.env.SUPABASE_URL}/storage/v1/object/public/${process.env.ARCHIVE_BUCKET || "agent-quality-private"}/${objectPath}`,
    { signal: AbortSignal.timeout(15000) },
  );
  assert.notEqual(publicDownload.status, 200);
  await publicDownload.arrayBuffer();
  const signedUrl = await store.signedDownload(objectPath, 60);
  const download = await fetch(signedUrl, {
    signal: AbortSignal.timeout(15000),
  });
  assert.equal(download.status, 200);
  assert.deepEqual(new Uint8Array(await download.arrayBuffer()), bytes);
  checked("private upload/read, denied public access and signed download");
  await store.remove([objectPath]);
  objectCreated = false;
  await assert.rejects(store.get(objectPath));
  checked("confirmed private object deletion");
  const logout = await application.inject({
    method: "POST",
    url: "/v1/auth/logout",
    headers: { cookie: cookie(refreshed) },
  });
  assert.equal(logout.statusCode, 200);
  assert.ok(
    logout.cookies
      .filter((value) => ["aq_session", "aq_refresh"].includes(value.name))
      .every((value) => value.value === ""),
  );
  assert.equal(
    (await application.inject({ method: "GET", url: "/v1/me" })).statusCode,
    401,
  );
  checked("logout clears browser sessions");
  if (process.env.MAILPIT_URL) {
    const inbox = new URL(process.env.MAILPIT_URL);
    assert.ok(
      ["localhost", "127.0.0.1", "[::1]"].includes(inbox.hostname),
      "Confirmation checks require a local email inbox.",
    );
    const email = `supabase-confirm-${suffix}@aftermark.invalid`;
    const signup = await application.inject({
      method: "POST",
      url: "/v1/auth/signup",
      payload: {
        email,
        password: randomBytes(32).toString("base64url"),
        name: "Confirmation verification",
        next: "/app/onboarding",
      },
    });
    const created = (
      await admin.query("select id from auth.users where email=$1", [email])
    ).rows[0];
    if (created) users.push(created.id);
    assert.equal(signup.statusCode, 200);
    assert.equal(signup.json().sessionEstablished, false);
    let messageId: string | undefined;
    for (let attempt = 0; attempt < 20 && !messageId; attempt++) {
      const response = await fetch(
        new URL(
          `/api/v1/search?query=${encodeURIComponent(`to:${email}`)}`,
          inbox,
        ),
        { signal: AbortSignal.timeout(5000) },
      );
      const found = (await response.json()) as { messages?: { ID: string }[] };
      messageId = found.messages?.[0]?.ID;
      if (!messageId) await new Promise((resolve) => setTimeout(resolve, 250));
    }
    assert.ok(messageId, "Confirmation email did not reach the local inbox.");
    mailIds.push(messageId);
    const mail = (await (
      await fetch(new URL(`/api/v1/message/${messageId}`, inbox), {
        signal: AbortSignal.timeout(5000),
      })
    ).json()) as { HTML: string };
    const link = [...mail.HTML.matchAll(/href=["']([^"']+)["']/g)]
      .map((match) => match[1].replaceAll("&amp;", "&"))
      .find((value) => value.includes("/auth/v1/verify"));
    assert.ok(
      link,
      "Confirmation message did not contain an Auth verification link.",
    );
    assert.equal(
      new URL(link).origin,
      new URL(process.env.SUPABASE_URL).origin,
    );
    const confirmation = await fetch(link, {
      redirect: "manual",
      signal: AbortSignal.timeout(15000),
    });
    assert.ok(
      [302, 303].includes(confirmation.status),
      "Auth verification did not redirect to the PKCE callback.",
    );
    const callback = new URL(confirmation.headers.get("location")!);
    assert.equal(callback.origin, process.env.WEB_ORIGIN);
    assert.equal(callback.pathname, "/api/v1/auth/callback");
    assert.ok(callback.searchParams.get("code"));
    const exchange = await application.inject({
      method: "GET",
      url: `/v1/auth/callback${callback.search}`,
      headers: { cookie: cookie(signup) },
    });
    assert.equal(exchange.statusCode, 302);
    assert.equal(
      exchange.headers.location,
      `${process.env.WEB_ORIGIN}/app/onboarding`,
    );
    const confirmedMe = await application.inject({
      method: "GET",
      url: "/v1/me",
      headers: { cookie: cookie(exchange) },
    });
    assert.equal(confirmedMe.statusCode, 200);
    checked("confirmation email, PKCE callback and established session");
  }
  console.log(
    `Supabase verification passed: ${checks} checks; disposable records are being removed.`,
  );
} finally {
  const failures: unknown[] = [];
  const attempt = async (work: () => Promise<unknown>) => {
    try {
      await work();
    } catch (error) {
      failures.push(error);
    }
  };
  try {
    if (objectCreated) await attempt(() => store.remove([objectPath]));
    if (organizations.length)
      await attempt(() =>
        admin.query("delete from organizations where id=any($1::uuid[])", [
          organizations,
        ]),
      );
    if (users.length)
      await attempt(() =>
        admin.query("delete from users where id=any($1::uuid[])", [users]),
      );
    for (const id of users) {
      await attempt(async () => {
        const result = await supabase.auth.admin.deleteUser(id);
        if (result.error)
          throw new Error("Disposable Supabase identity cleanup failed.");
      });
    }
    if (mailIds.length && process.env.MAILPIT_URL)
      await attempt(async () => {
        const removed = await fetch(
          new URL("/api/v1/messages", process.env.MAILPIT_URL),
          {
            method: "DELETE",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ IDs: mailIds }),
            signal: AbortSignal.timeout(5000),
          },
        );
        assert.ok(removed.ok, "Local confirmation message cleanup failed.");
      });
  } finally {
    await Promise.allSettled([application.close(), pool.end(), admin.end()]);
  }
  if (failures.length)
    throw new Error(
      `Disposable Supabase cleanup failed for ${failures.length} operations.`,
    );
}
