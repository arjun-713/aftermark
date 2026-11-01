import { defineConfig, devices } from "@playwright/test";
export default defineConfig({
  testDir: "./tests/e2e",
  fullyParallel: false,
  workers: 1,
  timeout: 45000,
  expect: { timeout: 10000 },
  reporter: [["list"]],
  use: {
    baseURL: process.env.AQ_WEB_URL ?? "http://localhost:3000",
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    launchOptions: {
      executablePath: process.env.CHROME_PATH ?? "/usr/bin/google-chrome",
      args: ["--no-sandbox"],
    },
  },
  projects: [
    { name: "desktop", use: { viewport: { width: 1440, height: 900 } } },
    { name: "tablet", use: { viewport: { width: 834, height: 1000 } } },
    {
      name: "phone",
      use: {
        viewport: { width: 390, height: 844 },
        isMobile: true,
        hasTouch: true,
      },
    },
  ],
  webServer: process.env.AQ_WEB_URL
    ? undefined
    : [
        {
          command: "npm run dev:api",
          url: "http://localhost:4100/ready",
          reuseExistingServer: !process.env.CI,
          timeout: 60000,
        },
        {
          command: "npm run dev:worker",
          url: "http://localhost:4101",
          reuseExistingServer: !process.env.CI,
          timeout: 60000,
        },
        {
          command: "npm run start -w @agent-quality/web",
          url: "http://localhost:3000/login",
          reuseExistingServer: !process.env.CI,
          timeout: 60000,
        },
      ],
});
