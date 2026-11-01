import {
  createHash,
  randomBytes,
  scryptSync,
  timingSafeEqual,
} from "node:crypto";
import { SignJWT, jwtVerify, createRemoteJWKSet } from "jose";
import { createClient } from "@supabase/supabase-js";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import { tenant, rows, sql } from "@agent-quality/db";
import { config } from "../../../packages/db/src/config.ts";
import type { Role } from "@agent-quality/contracts";
import { assert, ApiError } from "./errors.ts";

export const digest = (value: string) =>
  createHash("sha256").update(value).digest("hex");
export const passwordHash = (value: string) => {
  const salt = randomBytes(16).toString("hex");
  return `${salt}:${scryptSync(value, salt, 64).toString("hex")}`;
};
function checkPassword(value: string, hash: string) {
  const [salt, key] = hash.split(":");
  if (!salt || !key) return false;
  const expected = Buffer.from(key, "hex");
  const actual = scryptSync(value, salt, 64);
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}
const signingKey = new TextEncoder().encode(config.SESSION_SECRET);
const supabaseConfigured = Boolean(
  process.env.SUPABASE_URL && process.env.SUPABASE_ANON_KEY,
);
export const cookieNames = {
  session:
    config.NODE_ENV === "production" ? "__Host-aq_session" : "aq_session",
  refresh:
    config.NODE_ENV === "production" ? "__Host-aq_refresh" : "aq_refresh",
  pkce: config.NODE_ENV === "production" ? "__Host-aq_pkce" : "aq_pkce",
};
export const authCookieOptions = (
  secure = config.NODE_ENV === "production",
) => ({ path: "/", httpOnly: true, secure, sameSite: "lax" as const });
function authClient(storage: Record<string, string> = {}) {
  if (!supabaseConfigured) return null;
  return createClient(
    process.env.SUPABASE_URL!,
    process.env.SUPABASE_ANON_KEY!,
    {
      auth: {
        storageKey: "aq-auth",
        persistSession: true,
        autoRefreshToken: false,
        detectSessionInUrl: false,
        flowType: "pkce",
        storage: {
          getItem: (key) => storage[key] ?? null,
          setItem: (key, value) => {
            storage[key] = value;
          },
          removeItem: (key) => {
            delete storage[key];
          },
        },
      },
    },
  );
}
export function safeAuthReturnPath(value: unknown): string {
  if (typeof value !== "string" || value.length > 2000) return "/app";
  try {
    const url = new URL(value, config.WEB_ORIGIN);
    if (
      url.origin !== new URL(config.WEB_ORIGIN).origin ||
      !(url.pathname === "/app" || url.pathname.startsWith("/app/"))
    )
      return "/app";
    return url.pathname + url.search;
  } catch {
    return "/app";
  }
}
async function savePkce(
  reply: FastifyReply,
  storage: Record<string, string>,
  next: unknown,
) {
  const pending = Object.fromEntries(
    Object.entries(storage).filter(([key]) => key.endsWith("-code-verifier")),
  );
  const token = await new SignJWT({
    storage: pending,
    next: safeAuthReturnPath(next),
  })
    .setProtectedHeader({ alg: "HS256" })
    .setIssuer("agent-quality-pkce")
    .setAudience("member-sign-in")
    .setIssuedAt()
    .setExpirationTime("10m")
    .sign(signingKey);
  assert(
    Buffer.byteLength(token) < 3800,
    400,
    "auth_state_too_large",
    "Start a new sign-in attempt.",
  );
  reply.setCookie(cookieNames.pkce, token, {
    path: "/",
    httpOnly: true,
    secure: config.NODE_ENV === "production",
    sameSite: "lax",
    maxAge: 600,
  });
}
const jwks = process.env.SUPABASE_URL
  ? createRemoteJWKSet(
      new URL(`${process.env.SUPABASE_URL}/auth/v1/.well-known/jwks.json`),
    )
  : null;
export type Identity = {
  userId: string | null;
  organizationId: string;
  projectId: string | null;
  role: Role;
  keyId?: string;
  scopes: string[];
};
export function setSession(
  reply: FastifyReply,
  token: string,
  refresh?: string,
) {
  const opts = {
    httpOnly: true,
    secure: config.NODE_ENV === "production",
    sameSite: "lax" as const,
    path: "/",
  };
  reply.setCookie(cookieNames.session, token, { ...opts, maxAge: 3600 });
  if (refresh)
    reply.setCookie(cookieNames.refresh, refresh, {
      ...opts,
      maxAge: 60 * 60 * 24 * 14,
    });
}
export async function userIdentity(request: FastifyRequest): Promise<string> {
  const token =
    request.cookies[cookieNames.session] ||
    request.headers.authorization?.replace(/^Bearer /, "");
  assert(token, 401, "unauthenticated", "Sign in to continue.");
  try {
    const result =
      config.AUTH_MODE === "local"
        ? await jwtVerify(token, signingKey, {
            issuer: "agent-quality-local",
            audience: "agent-quality",
          })
        : await jwtVerify(token, jwks!, {
            issuer: `${process.env.SUPABASE_URL}/auth/v1`,
            audience: "authenticated",
          });
    assert(
      result.payload.sub && z.uuid().safeParse(result.payload.sub).success,
      401,
      "unauthenticated",
      "Session identity is invalid.",
    );
    return result.payload.sub;
  } catch {
    throw new ApiError(
      401,
      "unauthenticated",
      "Your session expired. Sign in again.",
    );
  }
}
export async function authorize(
  request: FastifyRequest,
  options: {
    scope?: string;
    roles?: Role[];
    projectId?: string;
    sessionOnly?: boolean;
  } = {},
): Promise<Identity> {
  const bearer = request.headers.authorization?.replace(/^Bearer /, "");
  if (bearer?.startsWith("aq_")) {
    assert(
      !options.sessionOnly,
      403,
      "session_required",
      "This action requires a workspace member session.",
    );
    const keys = await tenant("", null, (tx) =>
      rows<any>(tx, sql`select * from authenticate_key(${digest(bearer)})`),
    );
    const key = keys[0];
    assert(key, 401, "invalid_key", "This API key is invalid or revoked.");
    assert(
      options.scope && key.scopes.includes(options.scope),
      403,
      "insufficient_scope",
      "This API key does not have the required scope.",
    );
    assert(
      !options.projectId || options.projectId === key.project_id,
      404,
      "not_found",
      "Project not found.",
    );
    return {
      organizationId: key.organization_id,
      projectId: key.project_id,
      userId: null,
      role: "member",
      scopes: key.scopes,
      keyId: key.id,
    };
  }
  const userId = await userIdentity(request);
  const orgHeader = request.headers["x-workspace-id"];
  assert(
    typeof orgHeader === "string" && z.uuid().safeParse(orgHeader).success,
    400,
    "workspace_required",
    "Select a workspace with x-workspace-id.",
  );
  const memberships = await tenant("", userId, (tx) =>
    rows<any>(
      tx,
      sql`select role from memberships where user_id=${userId} and organization_id=${orgHeader}`,
    ),
  );
  assert(
    memberships.length,
    403,
    "forbidden",
    "You no longer have access to this workspace.",
  );
  const role = memberships[0].role as Role;
  assert(
    !options.roles || options.roles.includes(role),
    403,
    "forbidden",
    "Your workspace role does not allow this action.",
  );
  if (options.projectId) {
    const projects = await tenant(orgHeader, userId, (tx) =>
      rows(tx, sql`select id from projects where id=${options.projectId}`),
    );
    assert(projects.length, 404, "not_found", "Project not found.");
  }
  return {
    userId,
    organizationId: orgHeader,
    projectId: options.projectId ?? null,
    role,
    scopes: [],
  };
}
export async function authRoutes(app: FastifyInstance) {
  app.get("/v1/auth/config", async () => ({
    mode: config.AUTH_MODE,
    emailSignup: config.AUTH_MODE === "supabase" && supabaseConfigured,
    github:
      config.AUTH_MODE === "supabase" &&
      supabaseConfigured &&
      process.env.SUPABASE_GITHUB_ENABLED === "true",
  }));
  app.get(
    "/v1/auth/github",
    { config: { rateLimit: { max: 10, timeWindow: "1 minute" } } },
    async (request, reply) => {
      assert(
        config.AUTH_MODE === "supabase" &&
          supabaseConfigured &&
          process.env.SUPABASE_GITHUB_ENABLED === "true",
        503,
        "auth_not_configured",
        "GitHub sign-in is not configured.",
      );
      const q = z
        .object({ next: z.string().max(2000).optional() })
        .parse(request.query);
      const storage: Record<string, string> = {};
      const client = authClient(storage)!;
      const { data, error } = await client.auth.signInWithOAuth({
        provider: "github",
        options: {
          redirectTo: `${config.WEB_ORIGIN}/api/v1/auth/callback`,
          skipBrowserRedirect: true,
          scopes: "read:user user:email",
        },
      });
      assert(
        !error && data.url,
        503,
        "auth_unavailable",
        "GitHub sign-in could not start.",
      );
      await savePkce(reply, storage, q.next);
      return reply.redirect(data.url);
    },
  );
  app.get("/v1/auth/callback", async (request, reply) => {
    try {
      assert(
        config.AUTH_MODE === "supabase" && supabaseConfigured,
        503,
        "auth_not_configured",
        "Authentication is unavailable.",
      );
      const { code } = z
        .object({ code: z.string().min(1).max(2000) })
        .parse(request.query);
      const pending = request.cookies[cookieNames.pkce];
      assert(pending, 401, "auth_state_missing", "Restart sign-in.");
      const { payload } = await jwtVerify(pending, signingKey, {
        issuer: "agent-quality-pkce",
        audience: "member-sign-in",
      });
      const storage = z
        .record(z.string().max(256), z.string().max(2000))
        .parse(payload.storage);
      const next = safeAuthReturnPath(payload.next);
      const client = authClient(storage)!;
      const { data, error } = await client.auth.exchangeCodeForSession(code);
      assert(
        !error && data.session && data.user?.email,
        401,
        "auth_exchange_failed",
        "Restart sign-in.",
      );
      const user = data.user!;
      await tenant("", null, (tx) =>
        tx.execute(
          sql`select provision_user(${user.id},${user.email!},${String(user.user_metadata.name ?? user.user_metadata.full_name ?? user.email!.split("@")[0]).slice(0, 100)})`,
        ),
      );
      setSession(reply, data.session.access_token, data.session.refresh_token);
      reply.clearCookie(cookieNames.pkce, authCookieOptions());
      return reply.redirect(`${config.WEB_ORIGIN}${next}`);
    } catch {
      reply.clearCookie(cookieNames.pkce, authCookieOptions());
      return reply.redirect(`${config.WEB_ORIGIN}/login?error=auth_exchange`);
    }
  });
  app.post(
    "/v1/auth/login",
    { config: { rateLimit: { max: 10, timeWindow: "1 minute" } } },
    async (request, reply) => {
      const body = z
        .object({ email: z.email(), password: z.string().min(8).max(256) })
        .parse(request.body);
      if (config.AUTH_MODE === "supabase") {
        const supabase = authClient();
        assert(
          supabase,
          503,
          "auth_not_configured",
          "Authentication is not configured.",
        );
        const { data, error } = await supabase.auth.signInWithPassword(body);
        assert(
          !error && data.session,
          401,
          "invalid_credentials",
          "Email or password is incorrect.",
        );
        await tenant("", null, (tx) =>
          tx.execute(
            sql`select provision_user(${data.user!.id},${data.user!.email!},${String(data.user!.user_metadata.name ?? body.email.split("@")[0]).slice(0, 100)})`,
          ),
        );
        setSession(
          reply,
          data.session.access_token,
          data.session.refresh_token,
        );
      } else {
        const users = await tenant("", null, (tx) =>
          rows<any>(tx, sql`select * from local_user(${body.email})`),
        );
        const user = users[0];
        assert(
          user?.password_hash &&
            checkPassword(body.password, user.password_hash),
          401,
          "invalid_credentials",
          "Email or password is incorrect.",
        );
        const token = await new SignJWT({})
          .setProtectedHeader({ alg: "HS256" })
          .setSubject(user.id)
          .setIssuer("agent-quality-local")
          .setAudience("agent-quality")
          .setIssuedAt()
          .setExpirationTime("1h")
          .sign(signingKey);
        setSession(reply, token);
      }
      return { ok: true };
    },
  );
  app.post(
    "/v1/auth/signup",
    { config: { rateLimit: { max: 3, timeWindow: "1 minute" } } },
    async (request, reply) => {
      const storage: Record<string, string> = {};
      const supabase = authClient(storage);
      assert(
        config.AUTH_MODE === "supabase" && supabase,
        503,
        "signup_unavailable",
        "Local accounts are created with npm run db:seed.",
      );
      const body = z
        .object({
          email: z.email(),
          password: z.string().min(12).max(256),
          name: z.string().min(1).max(100),
          next: z.string().max(2000).optional(),
        })
        .parse(request.body);
      const { data, error } = await supabase.auth.signUp({
        email: body.email,
        password: body.password,
        options: {
          data: { name: body.name },
          emailRedirectTo: `${config.WEB_ORIGIN}/api/v1/auth/callback`,
        },
      });
      assert(
        !error,
        400,
        "signup_failed",
        "Account creation failed. Please try again.",
      );
      if (data.session && data.user?.email) {
        await tenant("", null, (tx) =>
          tx.execute(
            sql`select provision_user(${data.user!.id},${data.user!.email!},${body.name})`,
          ),
        );
        setSession(
          reply,
          data.session.access_token,
          data.session.refresh_token,
        );
        return { sessionEstablished: true };
      }
      await savePkce(reply, storage, body.next);
      return {
        sessionEstablished: false,
        message:
          "Check your email to confirm your account. Then sign in to continue.",
      };
    },
  );
  app.post("/v1/auth/refresh", async (request, reply) => {
    const supabase = authClient();
    assert(
      config.AUTH_MODE === "supabase" &&
        supabase &&
        request.cookies[cookieNames.refresh],
      401,
      "unauthenticated",
      "Sign in again.",
    );
    const { data, error } = await supabase.auth.refreshSession({
      refresh_token: request.cookies[cookieNames.refresh]!,
    });
    assert(!error && data.session, 401, "unauthenticated", "Sign in again.");
    setSession(reply, data.session.access_token, data.session.refresh_token);
    return { ok: true };
  });
  app.post("/v1/auth/logout", async (_request, reply) => {
    reply
      .clearCookie(cookieNames.session, authCookieOptions())
      .clearCookie(cookieNames.refresh, authCookieOptions())
      .clearCookie(cookieNames.pkce, authCookieOptions());
    return { ok: true };
  });
  app.get("/v1/me", async (request) => {
    const uid = await userIdentity(request);
    return tenant("", uid, async (tx) => ({
      user: (
        await rows(tx, sql`select id,email,name from users where id=${uid}`)
      )[0],
      workspaces: await rows(
        tx,
        sql`select o.id,o.name,m.role from organizations o join memberships m on m.organization_id=o.id where m.user_id=${uid} order by o.created_at`,
      ),
      authMode: config.AUTH_MODE,
    }));
  });
}
