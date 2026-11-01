import { defineConfig } from "vitest/config";
const suite = process.env.AQ_INTEGRATION_SUITE;
if (!suite || !["regression", "commerce", "operations"].includes(suite))
  throw new Error(
    "Use the test:regression, test:commerce or test:operations script to select an isolated database suite.",
  );
export default defineConfig({
  test: {
    include: [`tests/integration/${suite}.test.ts`],
    fileParallelism: false,
    testTimeout: 30000,
    hookTimeout: 30000,
  },
});
