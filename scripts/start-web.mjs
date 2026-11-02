import { cp, access, mkdir } from "node:fs/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import { resolve } from "node:path";
const root = fileURLToPath(new URL("../", import.meta.url));
const app = resolve(root, "apps/web"),
  output = resolve(app, ".next/standalone/apps/web");
await access(resolve(output, "server.js")).catch(() => {
  throw new Error(
    "Build the web application with npm run build before starting its production preview.",
  );
});
await mkdir(resolve(output, ".next"), { recursive: true });
await cp(resolve(app, ".next/static"), resolve(output, ".next/static"), {
  recursive: true,
  force: true,
});
try {
  await cp(resolve(app, "public"), resolve(output, "public"), {
    recursive: true,
    force: true,
  });
} catch (error) {
  if (error.code !== "ENOENT") throw error;
}
process.env.PORT ??= "3000";
process.env.HOSTNAME = process.env.AQ_WEB_HOST ?? "0.0.0.0";
await import(pathToFileURL(resolve(output, "server.js")).href);
