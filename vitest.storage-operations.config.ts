import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';
export default defineConfig({
  resolve: { alias: {
    '@agent-quality/db': fileURLToPath(new URL('./packages/db/src/index.ts', import.meta.url)),
    '@agent-quality/contracts': fileURLToPath(new URL('./packages/contracts/src/index.ts', import.meta.url)),
  } },
  test: { include: ['tests/integration/storage-operations.test.ts'], fileParallelism: false, testTimeout: 30000, hookTimeout: 30000 },
});
