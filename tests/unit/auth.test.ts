import { expect, it } from "vitest";
import Fastify from "fastify";
import cookie from "@fastify/cookie";
import {
  config,
  assertAuthenticationConfiguration,
} from "../../packages/db/src/config.ts";
import {
  safeAuthReturnPath,
  authCookieOptions,
} from "../../apps/api/src/auth.ts";
it("only returns authentication to internal application paths", () => {
  expect(safeAuthReturnPath("/app/team?invitation=fixture")).toBe(
    "/app/team?invitation=fixture",
  );
  for (const target of [
    "https://evil.test/app",
    "//evil.test/app",
    "javascript:alert(1)",
    "/app/../../evil",
    "/login",
    "\\\\evil.test/app",
  ])
    expect(safeAuthReturnPath(target)).toBe("/app");
});
it("preserves Secure on expired production Host cookies", async () => {
  const app = Fastify();
  await app.register(cookie);
  app.post("/logout", async (_request, reply) => {
    reply.clearCookie("__Host-aq_session", authCookieOptions(true));
    return { ok: true };
  });
  const response = await app.inject({ method: "POST", url: "/logout" });
  const header = String(response.headers["set-cookie"]);
  expect(header).toContain("__Host-aq_session=");
  expect(header).toContain("Secure");
  expect(header).toContain("Path=/");
  expect(header).toContain("Expires=");
  await app.close();
});
it("requires production API authentication without coupling database-only recovery tools to cookie configuration", () => {
  expect(() =>
    assertAuthenticationConfiguration(
      { ...config, NODE_ENV: "production" },
      {},
    ),
  ).toThrow("Supabase");
  const production = {
    ...config,
    NODE_ENV: "production" as const,
    AUTH_MODE: "supabase" as const,
    SESSION_SECRET: "fixture-private-secret-with-at-least-32-characters",
  };
  expect(() => assertAuthenticationConfiguration(production, {})).toThrow(
    "URL",
  );
  expect(() =>
    assertAuthenticationConfiguration(production, {
      SUPABASE_URL: "http://fixture.invalid",
      SUPABASE_ANON_KEY: "public-fixture",
    }),
  ).toThrow("HTTPS");
  expect(() =>
    assertAuthenticationConfiguration(production, {
      SUPABASE_URL: "https://fixture.invalid",
      SUPABASE_ANON_KEY: "public-fixture",
    }),
  ).not.toThrow();
});
