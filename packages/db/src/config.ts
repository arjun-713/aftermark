import "dotenv/config";
import { z } from "zod";
export const config = z
  .object({
    NODE_ENV: z
      .enum(["development", "test", "production"])
      .default("development"),
    AUTH_MODE: z.enum(["local", "supabase"]).default("local"),
    DATABASE_URL: z
      .string()
      .default(
        "postgresql://aq_app:local_app_password@localhost:55432/agent_quality",
      ),
    PORT: z.coerce.number().default(4100),
    WEB_ORIGIN: z.url().default("http://localhost:3000"),
    SESSION_SECRET: z
      .string()
      .min(32)
      .default("local-only-change-this-secret-at-least-32-characters"),
  })
  .parse(process.env);
// Database tools and restore jobs do not serve authentication. Validate the
// authentication boundary when constructing an API server, not when importing DB tools.
export function assertAuthenticationConfiguration(
  settings = config,
  env: Record<string, string | undefined> = process.env,
) {
  if (
    settings.NODE_ENV === "production" &&
    (settings.AUTH_MODE !== "supabase" ||
      settings.SESSION_SECRET.startsWith("local-only"))
  )
    throw new Error(
      "Production requires Supabase authentication and a private session secret",
    );
  if (
    settings.AUTH_MODE === "supabase" &&
    (!env.SUPABASE_URL || !env.SUPABASE_ANON_KEY)
  )
    throw new Error(
      "Supabase authentication requires its URL and public anon key",
    );
  if (
    settings.NODE_ENV === "production" &&
    env.SUPABASE_URL &&
    !env.SUPABASE_URL.startsWith("https://")
  )
    throw new Error("Production authentication requires HTTPS");
}
