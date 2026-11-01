import { defineConfig } from "vitest/config";
export default defineConfig({
  test: {
    include: ["tests/integration/**/*.test.ts"],
    exclude: [
      "tests/integration/regression.test.ts",
      "tests/integration/commerce.test.ts",
      "tests/integration/operations.test.ts",
    ],
    fileParallelism: false,
    testTimeout: 30000,
    hookTimeout: 30000,
  },
});
