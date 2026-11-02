import { expect, it } from "vitest";
const { validateRoleEnvironment, serviceExitCode } = await import(
  new URL("../../infra/start.mjs", import.meta.url).href
);
it("keeps the semantic provider credential on the worker and rejects database credentials on web", () => {
  expect(
    validateRoleEnvironment({
      SERVICE_ROLE: "worker",
      TYPESAFE_API_KEY: "fixture",
      SEMANTIC_EVALUATIONS_ENABLED: "true",
    }).role,
  ).toBe("worker");
  for (const role of ["api", "web", "backup", "restore", "migrate"])
    expect(() =>
      validateRoleEnvironment({
        SERVICE_ROLE: role,
        TYPESAFE_API_KEY: "fixture",
      }),
    ).toThrow("TYPESAFE_API_KEY");
  expect(() =>
    validateRoleEnvironment({ SERVICE_ROLE: "web", DATABASE_URL: "fixture" }),
  ).toThrow("DATABASE_URL");
  expect(() =>
    validateRoleEnvironment({
      SERVICE_ROLE: "worker",
      MIGRATION_DATABASE_URL: "fixture",
    }),
  ).toThrow("MIGRATION_DATABASE_URL");
});
it("checks compiled rewrites, complete backup configuration and explicit capacity changes", () => {
  expect(
    validateRoleEnvironment(
      { SERVICE_ROLE: "web", API_ORIGIN: "http://api.example.test" },
      "http://api.example.test",
    ).role,
  ).toBe("web");
  expect(() =>
    validateRoleEnvironment(
      { SERVICE_ROLE: "web", API_ORIGIN: "http://other.example.test" },
      "http://api.example.test",
    ),
  ).toThrow("differs");
  expect(() => validateRoleEnvironment({ SERVICE_ROLE: "backup" })).toThrow(
    "BACKUP_DATABASE_URL",
  );
  expect(() =>
    validateRoleEnvironment({
      SERVICE_ROLE: "worker",
      MONTHLY_BUDGET_USD: "151",
    }),
  ).toThrow("approval");
  expect(
    validateRoleEnvironment({
      SERVICE_ROLE: "worker",
      MONTHLY_BUDGET_USD: "151",
      CAPACITY_OVER_150_APPROVED: "true",
    }).role,
  ).toBe("worker");
});
it("requires production authentication at the API boundary and preserves failed operational exits", () => {
  expect(() =>
    validateRoleEnvironment({
      NODE_ENV: "production",
      SERVICE_ROLE: "api",
      DATABASE_URL: "fixture",
    }),
  ).toThrow("SESSION_SECRET");
  expect(
    validateRoleEnvironment({
      NODE_ENV: "production",
      SERVICE_ROLE: "migrate",
      DATABASE_URL: "fixture",
      MIGRATION_DATABASE_URL: "fixture",
    }).role,
  ).toBe("migrate");
  expect(serviceExitCode("web", 143, null, "SIGTERM")).toBe(0);
  expect(serviceExitCode("worker", 130, null, "SIGINT")).toBe(0);
  expect(serviceExitCode("backup", 143, null, "SIGTERM")).toBe(143);
  expect(serviceExitCode("restore", 1, null, undefined)).toBe(1);
});
