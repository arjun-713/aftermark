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
    [configurationError, setConfigurationError] = useState(false),
    [next, setNext] = useState("/app"),
    [configuration, setConfiguration] = useState<{
      mode: string;
      emailSignup: boolean;
      github: boolean;
      google?: boolean;
    }>();
  useEffect(() => {
    const parameters = new URLSearchParams(location.search);
    const target = parameters.get("next");
    if (parameters.get("mode") === "signup") setSignup(true);
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
      history.replaceState(
        null,
        "",
        parameters.get("mode") === "signup" ? "/login?mode=signup" : "/login",
      );
    void api("/auth/config")
      .then(setConfiguration)
      .catch(() => setConfigurationError(true));
  }, []);
  const chooseMode = (create: boolean) => {
    setSignup(create);
    setError("");
    setMessage("");
    history.replaceState(null, "", create ? "/login?mode=signup" : "/login");
  };
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
          <div
            className="auth-mode-tabs"
            role="tablist"
            aria-label="Account access"
          >
            <button
              id="sign-in-tab"
              role="tab"
              aria-selected={!signup}
              aria-controls="auth-panel"
              tabIndex={signup ? -1 : 0}
              onClick={() => chooseMode(false)}
              onKeyDown={(event) => {
                if (event.key === "ArrowRight") {
                  chooseMode(true);
                  document.getElementById("create-account-tab")?.focus();
                }
              }}
            >
              Sign in
            </button>
            <button
              id="create-account-tab"
              role="tab"
              aria-selected={signup}
              aria-controls="auth-panel"
              tabIndex={signup ? 0 : -1}
              onClick={() => chooseMode(true)}
              onKeyDown={(event) => {
                if (event.key === "ArrowLeft") {
                  chooseMode(false);
                  document.getElementById("sign-in-tab")?.focus();
                }
              }}
            >
              Create account
            </button>
          </div>
          <div
            id="auth-panel"
            role="tabpanel"
            aria-labelledby={signup ? "create-account-tab" : "sign-in-tab"}
          >
            <h1>{signup ? "Create your account" : "Welcome to Aftermark"}</h1>
            <p>
              {signup
                ? "Give your next agent release a record to stand on."
                : "Sign in to your workspace and pick up the evidence."}
            </p>
            {(configuration?.google || configuration?.github) && (
              <>
                <div className="auth-providers" aria-label="Provider sign-in">
                  {configuration.google && (
                    <a
                      className="btn secondary auth-social"
                      href={`/api/v1/auth/google?next=${encodeURIComponent(next)}`}
                    >
                      <GoogleMark />
                      Continue with Google
                    </a>
                  )}
                  {configuration.github && (
                    <a
                      className="btn secondary auth-social"
                      href={`/api/v1/auth/github?next=${encodeURIComponent(next)}`}
                    >
                      <Github size={16} />
                      Continue with GitHub
                    </a>
                  )}
                </div>
                <div className="auth-divider">
                  {signup
                    ? "or create an account with email"
                    : "or sign in with email"}
                </div>
              </>
            )}
            {configurationError && (
              <p className="auth-config-error" role="alert">
                Sign-in options could not load. Reload this page to try again.
              </p>
            )}
            {signup && configuration && !configuration.emailSignup ? (
              <div className="signup-unavailable" role="status">
                <strong>Account creation is unavailable here.</strong>
                <p>
                  This development workspace uses existing accounts. Switch to
                  Sign in to continue.
                </p>
                <button
                  className="btn secondary"
                  onClick={() => chooseMode(false)}
                >
                  Return to sign in
                </button>
              </div>
            ) : (
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
                  <input
                    name="email"
                    type="email"
                    autoComplete="email"
                    required
                  />
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
                <button
                  className="btn primary"
                  disabled={busy || (signup && !configuration?.emailSignup)}
                >
                  {busy
                    ? "Please wait…"
                    : signup
                      ? "Create account"
                      : "Sign in"}
                </button>
              </form>
            )}
            {configuration?.emailSignup && (
              <button
                className="btn text-button auth-toggle"
                onClick={() => chooseMode(!signup)}
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
          </div>
        </section>
      </main>
      <footer className="auth-footer">
        <span>Aftermark © {new Date().getFullYear()}</span>
        <span>Agent outcomes, on record.</span>
      </footer>
    </div>
  );
}

function GoogleMark() {
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 24 24"
      aria-hidden="true"
      fill="currentColor"
    >
      <path d="M21.8 12.2c0-.7-.1-1.4-.2-2.1H12v4h5.5a4.7 4.7 0 0 1-2 3.1v2.6h3.3c1.9-1.8 3-4.4 3-7.6ZM12 22c2.7 0 5-.9 6.7-2.4l-3.3-2.6c-.9.6-2.1 1-3.4 1-2.6 0-4.8-1.8-5.6-4.2H3v2.7A10 10 0 0 0 12 22ZM6.4 13.8a6 6 0 0 1 0-3.6V7.5H3a10 10 0 0 0 0 9l3.4-2.7ZM12 6c1.5 0 2.8.5 3.8 1.5l2.9-2.8A9.6 9.6 0 0 0 12 2a10 10 0 0 0-9 5.5l3.4 2.7C7.2 7.8 9.4 6 12 6Z" />
    </svg>
  );
}
