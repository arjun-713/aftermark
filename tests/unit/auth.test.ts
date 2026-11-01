import { expect, it } from "vitest";
import Fastify from "fastify";
import cookie from "@fastify/cookie";
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
