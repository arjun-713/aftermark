import { test, expect } from "@playwright/test";
import { randomUUID } from "node:crypto";

test("public preview explains evidence and proposed plans", async ({
  page,
}, info) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto("/");
  await expect(
    page.getByRole("heading", { name: "Did the agent finish?" }),
  ).toBeVisible();
  const observation = page.getByLabel("Independent sample observation");
  await expect(page.locator(".demo-result")).toContainText(
    "Completion remains unknown",
  );
  await observation.selectOption("open");
  await expect(page.locator(".demo-result")).toContainText(
    "Expected state observed",
  );
  await expect(page.locator(".landing-report pre")).toContainText("exit  0");
  await observation.selectOption("closed");
  await expect(page.locator(".demo-result")).toContainText(
    "Observed state contradicts",
  );
  await expect(page.locator(".landing-report pre")).toContainText("exit  1");
  await page.screenshot({
    path: info.outputPath("landing.png"),
    fullPage: true,
  });
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth > innerWidth,
    ),
  ).toBe(false);
  await page.goto("/pricing");
  await page.getByRole("button", { name: /Team/ }).click();
  await expect(page.locator(".plan-price")).toContainText("$99");
  await expect(page.locator(".plan-detail")).toContainText("50,000");
  await page.screenshot({
    path: info.outputPath("pricing.png"),
    fullPage: true,
  });
  await page.goto("/help#ci");
  await expect(
    page.getByRole("heading", { name: "Turn the review into a regression" }),
  ).toBeVisible();
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth > innerWidth,
    ),
  ).toBe(false);
  await page.goto("/privacy");
  await expect(
    page.getByRole("heading", { name: "Data handling, plainly." }),
  ).toBeVisible();
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth > innerWidth,
    ),
  ).toBe(false);
  expect(errors).toEqual([]);
});

test("workspace owner manages an invitation and retention with real API state", async ({
  page,
}, info) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto("/login");
  await page.getByLabel("Email", { exact: true }).fill("alex@example.test");
  await page.getByLabel("Password", { exact: true }).fill("local-password-123");
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "Overview", exact: true }),
  ).toBeVisible();
  await page.goto(
    "/app/settings/billing?status=succeeded&subscription_id=unverified-fixture",
  );
  await expect(
    page.getByRole("heading", { name: "Usage & billing", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByText("Billing disconnected", { exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("meter", { name: "Evaluation allowance used or held" }),
  ).toBeVisible();
  await expect(
    page.getByRole("meter", { name: "Retained-content storage used" }),
  ).toBeVisible();
  await expect(page).not.toHaveURL(/subscription_id/);
  await page.screenshot({
    path: info.outputPath("billing.png"),
    fullPage: true,
  });
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth > innerWidth,
    ),
  ).toBe(false);
  await page.goto("/app/settings/team");
  await page
    .getByRole("button", { name: "Invite member", exact: true })
    .click();
  const email = `browser-${randomUUID()}@example.test`;
  const invite = page.getByRole("dialog", { name: "Invite a teammate" });
  await invite.getByLabel("Email address", { exact: true }).fill(email);
  await invite
    .getByLabel("Workspace role", { exact: true })
    .selectOption("viewer");
  await invite
    .getByRole("button", { name: "Create invitation", exact: true })
    .click();
  const ready = page.getByRole("dialog", { name: "Invitation ready" });
  await expect(
    ready.getByText("Invitation link", { exact: true }),
  ).toBeVisible();
  await expect(ready.locator(".secret-display code")).toContainText(
    "/app/team?invitation=",
  );
  await ready.getByRole("button", { name: "Done", exact: true }).click();
  const row = page.getByRole("row").filter({ hasText: email });
  await expect(row).toBeVisible();
  await row.getByRole("button", { name: "Revoke", exact: true }).click();
  await page
    .getByRole("dialog", { name: "Revoke this invitation?" })
    .getByRole("button", { name: "Revoke invitation", exact: true })
    .click();
  await expect(row).toHaveCount(0);
  await page.goto("/app/settings/retention");
  const days = page.getByLabel("Keep content for", { exact: true });
  await expect(days).toHaveValue("30");
  await days.fill("29");
  await page
    .getByRole("button", { name: "Save retention", exact: true })
    .click();
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "Save shorter retention", exact: true })
    .click();
  await expect(
    page.getByText("Current policy: 29 days.", { exact: false }),
  ).toBeVisible();
  await days.fill("30");
  await page
    .getByRole("button", { name: "Save retention", exact: true })
    .click();
  await expect(
    page.getByText("Current policy: 30 days.", { exact: false }),
  ).toBeVisible();
  await page.screenshot({
    path: info.outputPath("retention.png"),
    fullPage: true,
  });
  await page.goto("/app/settings/alerts");
  await expect(
    page.getByRole("heading", { name: "Alerts", exact: true }),
  ).toBeVisible();
  await page
    .getByRole("button", { name: "Add destination", exact: true })
    .click();
  const destination = page.getByRole("dialog", {
    name: "Add an alert destination",
  });
  await destination
    .getByLabel("Name", { exact: true })
    .fill("Private address rejection fixture");
  await destination
    .getByLabel("Public HTTPS endpoint", { exact: true })
    .fill("https://127.0.0.1/receipt");
  await destination
    .getByRole("button", { name: "Enable destination", exact: true })
    .click();
  await expect(destination.getByRole("alert")).toContainText(
    "public HTTPS hostname",
  );
  await destination
    .getByRole("button", { name: "Cancel", exact: true })
    .click();
  await page.goto("/app/settings/operations");
  await expect(
    page.getByRole("heading", { name: "Processing health", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("heading", { name: "Queue state", exact: true }),
  ).toBeVisible();
  await page.screenshot({
    path: info.outputPath("processing-health.png"),
    fullPage: true,
  });
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth > innerWidth,
    ),
  ).toBe(false);
  expect(errors).toEqual([]);
});
