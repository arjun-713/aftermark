"use client";
import { useEffect, useState } from "react";
import Link from "next/link";
import { Github, ArrowUpRight, Check, Minus } from "lucide-react";
import { api, json } from "../../lib/api";
import { Brand, BrandMark } from "../../components/brand";
export default function Login() {
  const [error, setError] = useState(""),
    [message, setMessage] = useState(""),
    [busy, setBusy] = useState(false),
    [signup, setSignup] = useState(false),
    [next, setNext] = useState("/app"),
    [configuration, setConfiguration] = useState<{
      mode: string;
      emailSignup: boolean;
      github: boolean;
    }>();
  useEffect(() => {
    const parameters = new URLSearchParams(location.search);
    const target = parameters.get("next");
    if (target)
      try {
        const url = new URL(target, location.origin);
        if (
          url.origin === location.origin &&
          (url.pathname === "/app" || url.pathname.startsWith("/app/"))
        )
          setNext(url.pathname + url.search);
      } catch {
        /* Return to the application by default. */
      }
    if (parameters.get("error"))
      setError("Sign-in could not finish. Try signing in again.");
    if (location.search || location.hash)
      history.replaceState(null, "", "/login");
    void api("/auth/config")
      .then(setConfiguration)
      .catch(() => {});
  }, []);
  return (
    <div className="auth-page">
      <nav className="auth-header" aria-label="Account navigation">
        <Brand />
        <Link href="/help">
          Documentation <ArrowUpRight size={15} />
        </Link>
      </nav>
      <main className="auth-layout">
        <aside className="auth-story">
          <h2>
            Actions need
            <br />
            evidence.
          </h2>
          <p>
            A clear record of what your agent claimed, what your systems
            observed, and what comes next.
          </p>
          <div
            className="auth-record"
            aria-label="An outcome record keeps claims and evidence separate"
          >
            <div>
              <BrandMark />
              <span>The outcome record</span>
            </div>
            <div>
              <Check size={16} />
              <span>
                Agent execution<strong>Completed</strong>
              </span>
            </div>
            <div>
              <Minus size={16} />
              <span>
                Independent evidence<strong>Awaiting observation</strong>
              </span>
            </div>
            <p>
              Completion is a claim.
              <br />
              Verification needs evidence.
            </p>
          </div>
        </aside>
        <section className="auth">
          <h1>{signup ? "Create your account" : "Welcome to Aftermark"}</h1>
          <p>
            {signup
              ? "Give your next agent release a record to stand on."
              : "Sign in to your workspace and pick up the evidence."}
          </p>
          {configuration?.github && (
            <>
              <a
                className="btn secondary auth-social"
                href={`/api/v1/auth/github?next=${encodeURIComponent(next)}`}
              >
                <Github size={16} />
                Continue with GitHub
              </a>
              <div className="auth-divider">or continue with email</div>
            </>
          )}
          <form
            onSubmit={async (event) => {
              event.preventDefault();
              setBusy(true);
              setError("");
              setMessage("");
              const form = new FormData(event.currentTarget);
              try {
                const data = await api(
                  signup ? "/auth/signup" : "/auth/login",
                  undefined,
                  {
                    method: "POST",
                    body: json({
                      ...Object.fromEntries(form),
                      ...(signup ? { next } : {}),
                    }),
                  },
                );
                if (signup && !data.sessionEstablished)
                  setMessage(data.message);
                else location.assign(next);
              } catch (err) {
                setError((err as Error).message);
              } finally {
                setBusy(false);
              }
            }}
          >
            {signup && (
              <label>
                Name
                <input
                  name="name"
                  autoComplete="name"
                  required
                  maxLength={100}
                />
              </label>
            )}
            <label>
              Email
              <input name="email" type="email" autoComplete="email" required />
            </label>
            <label>
              Password
              <input
                name="password"
                type="password"
                autoComplete={signup ? "new-password" : "current-password"}
                required
                minLength={signup ? 12 : 8}
                maxLength={256}
                aria-describedby={signup ? "password-guidance" : undefined}
              />
              {signup && (
                <span className="field-help" id="password-guidance">
                  Use at least 12 characters.
                </span>
              )}
            </label>
            {error && (
              <p role="alert" className="form-error">
                {error}
              </p>
            )}
            {message && (
              <p role="status" className="auth-success">
                {message}
              </p>
            )}
            <button className="btn primary" disabled={busy}>
              {busy ? "Please wait…" : signup ? "Create account" : "Sign in"}
            </button>
          </form>
          {configuration?.emailSignup && (
            <button
              className="btn text-button auth-toggle"
              onClick={() => {
                setSignup(!signup);
                setError("");
                setMessage("");
              }}
            >
              {signup
                ? "Already have an account? Sign in"
                : "Create an account"}
            </button>
          )}
          {configuration?.mode === "local" && (
            <p className="auth-local">
              Development workspace · use a seeded account.
            </p>
          )}
          <p className="auth-privacy">
            Your workspace’s evidence stays under its access and retention
            controls.{" "}
            <Link href="/privacy">
              Data & privacy <ArrowUpRight size={12} />
            </Link>
          </p>
        </section>
      </main>
      <footer className="auth-footer">
        <span>Aftermark © {new Date().getFullYear()}</span>
        <span>Agent outcomes, on record.</span>
      </footer>
    </div>
  );
}
