import { build } from 'esbuild';
import { chmod } from 'node:fs/promises';
await build({ entryPoints: [new URL('./src/index.ts', import.meta.url).pathname], outfile: new URL('./dist/index.js', import.meta.url).pathname,
  bundle: true, platform: 'node', format: 'esm', target: 'node22', legalComments: 'none',
  banner: { js: "import { createRequire as aqCreateRequire } from 'node:module'; const require = aqCreateRequire(import.meta.url);" } });
await chmod(new URL('./dist/index.js', import.meta.url), 0o755);
