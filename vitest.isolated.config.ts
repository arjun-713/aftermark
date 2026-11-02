import { defineConfig } from "vitest/config";
const suite = process.env.AQ_INTEGRATION_SUITE;
if (
  !suite ||
  ![
    "regression",
    "commerce",
    "operations",
    "identity",
    "alerts",
    "storage",
    "storage_ops",
  ].includes(suite)
)
  throw new Error(
    "Use the test:regression, test:commerce or test:operations script to select an isolated database suite.",
  );
export default defineConfig({
  test: {
    include:
      suite === "identity"
        ? [
            "tests/integration/verification-identity.test.ts",
            "tests/integration/evaluation-retry.test.ts",
          ]
        : suite === "storage_ops"
          ? ["tests/integration/storage-operations.test.ts"]
          : suite === "storage"
            ? [
                "tests/integration/storage-budget.test.ts",
                "tests/integration/billing-retention.test.ts",
              ]
            : [
                `tests/integration/${suite === "commerce" ? "billing" : suite === "storage" ? "storage-budget" : suite}.test.ts`,
              ],
    fileParallelism: false,
    testTimeout: 30000,
    hookTimeout: 30000,
  },
});
