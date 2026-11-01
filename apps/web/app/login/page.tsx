"use client";
import { useEffect, useState } from "react";
import Link from "next/link";
import { ScanEye, Github } from "lucide-react";
import { api, json } from "../../lib/api";
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
    <main className="auth">
      <Link className="wordmark" href="/">
        <ScanEye size={25} strokeWidth={1.5} />
        Agent Quality
      </Link>
      <h1>{signup ? "Create your account" : "Sign in to Agent Quality"}</h1>
      <p>Review agent outcomes with the evidence behind them.</p>
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
            if (signup && !data.sessionEstablished) setMessage(data.message);
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
            <input name="name" autoComplete="name" required maxLength={100} />
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
          />
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
          {signup ? "Already have an account? Sign in" : "Create an account"}
        </button>
      )}
      {configuration?.mode === "local" && (
        <p className="auth-local">
          Local preview · use a seeded development account.
        </p>
      )}
      <Link className="back-link" href="/help">
        Integration and privacy guide
      </Link>
    </main>
  );
}
