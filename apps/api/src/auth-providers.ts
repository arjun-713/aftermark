import { readBoundedJson } from "../../../packages/integrations/src/http.ts";

type ProviderState = { github: boolean; google: boolean };
type ProviderOptions = {
  enabled: boolean;
  url?: string;
  publicKey?: string;
  github: boolean;
  google: boolean;
};

/** Supabase's configured providers are authoritative; a feature flag alone is insufficient. */
export function createProviderResolver(
  options: ProviderOptions,
  request: typeof fetch = fetch,
  now = Date.now,
) {
  const unavailable: ProviderState = { github: false, google: false };
  let cached = unavailable;
  let expires = 0;
  let pending: Promise<ProviderState> | undefined;
  return async (): Promise<ProviderState> => {
    if (
      !options.enabled ||
      !options.url ||
      !options.publicKey ||
      (!options.github && !options.google)
    )
      return unavailable;
    if (now() < expires) return cached;
    if (pending) return pending;
    pending = (async () => {
      try {
        const response = await request(`${options.url}/auth/v1/settings`, {
          headers: { apikey: options.publicKey! },
          signal: AbortSignal.timeout(5000),
        });
        if (!response.ok) throw new Error("Provider settings unavailable.");
        const body = await readBoundedJson(response);
        const external =
          body && typeof body === "object" && "external" in body
            ? body.external
            : undefined;
        cached =
          external && typeof external === "object" && !Array.isArray(external)
            ? {
                github:
                  options.github &&
                  "github" in external &&
                  external.github === true,
                google:
                  options.google &&
                  "google" in external &&
                  external.google === true,
              }
            : unavailable;
        expires = now() + 30000;
      } catch {
        cached = unavailable;
        expires = now() + 5000;
      }
      return cached;
    })();
    try {
      return await pending;
    } finally {
      pending = undefined;
    }
  };
}
