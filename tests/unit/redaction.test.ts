import { expect, it } from "vitest";
import { redact } from "../../packages/contracts/src/redaction.ts";
it("redacts candidate emails and credentials without rescanning long ordinary text", () => {
  for (const value of ["x".repeat(900000), "x".repeat(900000) + " @ invalid"])
    expect(redact(value)).toBe(value);
  const result = redact(
    "Contact alice+support@example.test. Bearer secret-token or aq_abcdefghijklmnopqrstuvwxyz",
  );
  expect(result).not.toContain("alice");
  expect(result).not.toContain("secret-token");
  expect(result).not.toContain("aq_abcdefghijkl");
  expect(
    redact({
      email: "alice@example.test",
      phone: "5551234567",
      message: "hello",
    }),
  ).toEqual({ email: "[REDACTED]", phone: "[REDACTED]", message: "hello" });
});
