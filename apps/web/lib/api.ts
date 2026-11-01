export class RequestError extends Error {
  constructor(
    message: string,
    public status: number,
    public code: string,
  ) {
    super(message);
  }
}
let refreshing: Promise<boolean> | undefined;
export async function api<T = any>(
  path: string,
  workspaceId?: string,
  options: RequestInit = {},
): Promise<T> {
  const requestOptions: RequestInit = {
    ...options,
    headers: {
      ...(options.body ? { "Content-Type": "application/json" } : {}),
      ...(workspaceId ? { "x-workspace-id": workspaceId } : {}),
      ...options.headers,
    },
  };
  let response = await fetch(`/api/v1${path}`, requestOptions);
  if (response.status === 401 && !path.startsWith("/auth/")) {
    refreshing ??= fetch("/api/v1/auth/refresh", { method: "POST" })
      .then((r) => r.ok)
      .catch(() => false)
      .finally(() => {
        refreshing = undefined;
      });
    if (await refreshing)
      response = await fetch(`/api/v1${path}`, requestOptions);
  }
  let body: any;
  try {
    body = await response.json();
  } catch {
    throw new RequestError(
      "The service returned an unreadable response. Retry in a moment.",
      response.status,
      "invalid_response",
    );
  }
  if (!response.ok) {
    if (
      response.status === 401 &&
      typeof window !== "undefined" &&
      !path.startsWith("/auth/")
    )
      location.href = `/login?next=${encodeURIComponent(location.pathname + location.search)}`;
    throw new RequestError(
      body.error?.message ?? "The request failed.",
      response.status,
      body.error?.code ?? "request_failed",
    );
  }
  return body;
}
export const json = (value: unknown) => JSON.stringify(value);
export const pretty = (value: unknown) => JSON.stringify(value, null, 2);
export function when(value: string) {
  return new Date(value).toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}
export function ago(value: string) {
  const mins = Math.max(
    0,
    Math.round((Date.now() - Date.parse(value)) / 60000),
  );
  return mins < 1
    ? "Just now"
    : mins < 60
      ? `${mins}m ago`
      : mins < 1440
        ? `${Math.floor(mins / 60)}h ago`
        : `${Math.floor(mins / 1440)}d ago`;
}
