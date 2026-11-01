import { build } from "esbuild";
import { spawnSync } from "node:child_process";
import { copyFile, mkdir, rm } from "node:fs/promises";
const cwd = new URL(".", import.meta.url);
await mkdir(new URL("dist/", cwd), { recursive: true });
await build({
  entryPoints: [new URL("src/index.ts", cwd).pathname],
  outfile: new URL("dist/index.js", cwd).pathname,
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node22",
  legalComments: "none",
});
const result = spawnSync(
  process.execPath,
  [
    new URL("../../node_modules/typescript/bin/tsc", cwd).pathname,
    "-p",
    new URL("tsconfig.build.json", cwd).pathname,
  ],
  { stdio: "inherit" },
);
if (result.status !== 0) process.exit(result.status ?? 1);
for (const name of ["index", "types"])
  await copyFile(
    new URL(`dist/types/sdk-typescript/src/${name}.d.ts`, cwd),
    new URL(`dist/${name}.d.ts`, cwd),
  );
await rm(new URL("dist/types/", cwd), { recursive: true });
