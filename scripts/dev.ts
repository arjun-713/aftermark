import { spawn } from "node:child_process";
const webPort =
  new URL(process.env.WEB_ORIGIN ?? "http://localhost:3000").port || "3000";
const webEnv: NodeJS.ProcessEnv = { ...process.env, PORT: webPort };
// The frontend needs the API origin, not server credentials loaded by local setup.
for (const key of Object.keys(webEnv)) {
  if (
    /^(DATABASE_URL|MIGRATION_DATABASE_URL|BACKUP_DATABASE_URL|SESSION_SECRET|SUPABASE_|TYPESAFE_|DODO_|RESEND_|GITHUB_APP_|GITHUB_CLIENT_|HUBSPOT_|AWS_|KMS_|BACKUP_|DELETION_JOURNAL_|LOCAL_ENCRYPTION_KEY)/.test(
      key,
    )
  )
    delete webEnv[key];
}
const commands = [
  {
    args: ["run", "dev:api"],
    env: { ...process.env, PORT: process.env.PORT ?? "4100" },
  },
  { args: ["run", "dev:web"], env: webEnv },
  {
    args: ["run", "dev:worker"],
    env: { ...process.env, PORT: process.env.WORKER_PORT ?? "4101" },
  },
];
const children = commands.map(({ args, env }) =>
  spawn("npm", args, { stdio: "inherit", env }),
);
let closing = false;
const close = (code: number) => {
  if (closing) return;
  closing = true;
  for (const child of children) child.kill("SIGTERM");
  setTimeout(() => process.exit(code), 500).unref();
};
for (const child of children) {
  child.on("error", () => close(1));
  child.on("exit", (code) => {
    if (!closing) close(code ?? 1);
  });
}
process.once("SIGINT", () => close(0));
process.once("SIGTERM", () => close(0));
