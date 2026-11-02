const sensitive =
  /^(authorization|password|secret|api.?key|access.?token|refresh.?token|email|phone)$/i;
function redactEmailCandidates(value: string) {
  // Scan each maximal candidate once. An unanchored greedy email prefix can
  // otherwise rescan a long non-email string at every character position.
  return value.replace(/[\w.+@-]+/g, (token) => {
    const at = token.lastIndexOf("@");
    if (at <= 0) return token;
    const domain = token.slice(at + 1).replace(/\.+$/, "");
    const dot = domain.lastIndexOf(".");
    return dot > 0 &&
      /^[\w.-]+$/.test(domain) &&
      /^[a-z]{2,63}$/i.test(domain.slice(dot + 1))
      ? "[REDACTED]" + token.slice(at + 1 + domain.length)
      : token;
  });
}
export function redact<T>(value: T): T {
  if (typeof value === "string")
    return redactEmailCandidates(value)
      .replace(/Bearer\s+[^\s"']+/gi, "Bearer [REDACTED]")
      .replace(/\b(?:sk-|aq_)[a-zA-Z0-9_-]{16,}/g, "[REDACTED]") as T;
  if (Array.isArray(value)) return value.map((x) => redact(x)) as T;
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value).map(([k, v]) => [
        k,
        sensitive.test(k) ? "[REDACTED]" : redact(v),
      ]),
    ) as T;
  return value;
}
export function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object")
    return `{${Object.entries(value)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([key, v]) => `${JSON.stringify(key)}:${canonical(v)}`)
      .join(",")}}`;
  return JSON.stringify(value);
}
