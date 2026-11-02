import { defineConfig } from "vitest/config";
export default defineConfig({
  test: {
    include: ["tests/integration/**/*.test.ts"],
    exclude: [
      "tests/integration/regression.test.ts",
      "tests/integration/commerce.test.ts",
      "tests/integration/billing.test.ts",
      "tests/integration/verification-identity.test.ts",
      "tests/integration/evaluation-retry.test.ts",
      "tests/integration/operations.test.ts",
      "tests/integration/alerts.test.ts",
      "tests/integration/storage-budget.test.ts",
      "tests/integration/storage-operations.test.ts",
      "tests/integration/billing-retention.test.ts",
      "tests/integration/operations.test.ts",
    ],
    fileParallelism: false,
    testTimeout: 30000,
    hookTimeout: 30000,
  },
});
