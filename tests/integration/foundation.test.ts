import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildServer } from "../../apps/api/src/server.ts";
import { pool, tenant, rows, sql } from "@agent-quality/db";
const app = await buildServer();
const northstar = "10000000-0000-4000-8000-000000000001";
const orbit = "10000000-0000-4000-8000-000000000002";
let cookie = "";
beforeAll(async () => {
  const res = await app.inject({
    method: "POST",
    url: "/v1/auth/login",
    payload: { email: "alex@example.test", password: "local-password-123" },
  });
  expect(res.statusCode).toBe(200);
  cookie = res.cookies.map((x) => `${x.name}=${x.value}`).join("; ");
});
afterAll(async () => {
  await app.close();
  await pool.end();
});
describe("authenticated tenant foundation", () => {
  it("keeps signup and social authentication unavailable on a local authentication backend", async () => {
    const settings = await app.inject("/v1/auth/config");
    expect(settings.json()).toEqual({
      mode: "local",
      emailSignup: false,
      github: false,
      google: false,
    });
    for (const provider of ["google", "github"]) {
      const response = await app.inject(`/v1/auth/${provider}?next=%2Fapp`);
      expect(response.statusCode).toBe(503);
      expect(response.json().error.code).toBe("auth_not_configured");
      expect(response.headers.location).toBeUndefined();
    }
  });
  it("denies unauthenticated requests", async () => {
    expect((await app.inject("/v1/projects")).statusCode).toBe(401);
  });
  it("only lists projects from the authorized workspace", async () => {
    const res = await app.inject({
      url: "/v1/projects",
      headers: { cookie, "x-workspace-id": northstar },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().every((p: any) => p.name !== "CRM assistant")).toBe(true);
    expect(res.json().length).toBeGreaterThan(0);
  });
  it("rejects a different workspace even with a valid session", async () => {
    expect(
      (
        await app.inject({
          url: "/v1/projects",
          headers: { cookie, "x-workspace-id": orbit },
        })
      ).statusCode,
    ).toBe(403);
  });
  it("authenticates the second workspace independently", async () => {
    const login = await app.inject({
      method: "POST",
      url: "/v1/auth/login",
      payload: { email: "sam@example.test", password: "local-password-123" },
    });
    expect(login.statusCode).toBe(200);
    const sam = login.cookies.map((c) => `${c.name}=${c.value}`).join("; ");
    const own = await app.inject({
      url: "/v1/projects",
      headers: { cookie: sam, "x-workspace-id": orbit },
    });
    expect(own.json()[0].name).toBe("CRM assistant");
    expect(
      (
        await app.inject({
          url: "/v1/projects",
          headers: { cookie: sam, "x-workspace-id": northstar },
        })
      ).statusCode,
    ).toBe(403);
  });
  it("uses an application role that cannot bypass RLS and clears pooled tenant context", async () => {
    const role = await pool.query(
      "select rolbypassrls,rolsuper from pg_roles where rolname=current_user",
    );
    expect(role.rows[0]).toEqual({ rolbypassrls: false, rolsuper: false });
    const first = await tenant(northstar, null, (tx) =>
      rows(tx, sql`select id from projects`),
    );
    expect(first.length).toBeGreaterThan(0);
    expect((await pool.query("select * from projects")).rows).toHaveLength(0);
    await expect(pool.query("select * from events_default")).rejects.toThrow(
      "permission denied",
    );
    const second = await tenant(orbit, null, (tx) =>
      rows<any>(tx, sql`select name from projects`),
    );
    expect(second[0].name).toBe("CRM assistant");
  });
});
