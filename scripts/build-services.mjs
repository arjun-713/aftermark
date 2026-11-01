import { build } from 'esbuild';
import { cp, mkdir } from 'node:fs/promises';

// npm imports remain runtime dependencies; every @agent-quality workspace import is bundled.
const externalNpm = { name: 'external-npm', setup(builder) {
  builder.onResolve({ filter: /^[^./]|^@/ }, args => {
    if (args.path.startsWith('@agent-quality/')) return undefined;
    return { path: args.path, external: true };
  });
} };
await build({
  entryPoints: { api: 'apps/api/src/index.ts', worker: 'apps/worker/src/index.ts', 'db/migrate': 'packages/db/src/migrate.ts',
    backup: 'scripts/backup.ts', restore: 'scripts/restore.ts', load: 'scripts/load.ts', 'release-gates': 'scripts/release-gates.ts' },
  outdir: 'dist', outExtension: { '.js': '.mjs' }, bundle: true, platform: 'node', target: 'node22', format: 'esm',
  plugins: [externalNpm], sourcemap: false, metafile: true, logLevel: 'info',
});
await mkdir('dist/migrations', { recursive: true });
await cp('packages/db/migrations', 'dist/migrations', { recursive: true });
