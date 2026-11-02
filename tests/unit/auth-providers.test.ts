import { expect, it, vi } from "vitest";
import { createProviderResolver } from "../../apps/api/src/auth-providers.ts";

const options = {
  enabled: true,
  url: "https://supabase.example",
  publicKey: "public-fixture",
  github: true,
  google: true,
};
it("requires provider-side configuration as well as application activation", async () => {
  const request = vi
    .fn<typeof fetch>()
    .mockResolvedValue(
      new Response(
        JSON.stringify({ external: { github: true, google: false } }),
      ),
    );
  const get = createProviderResolver(options, request);
  expect(await get()).toEqual({ github: true, google: false });
  const disabled = createProviderResolver(
    { ...options, github: false },
    request,
  );
  expect(await disabled()).toEqual({ github: false, google: false });
});
it("does not advertise malformed, missing or unavailable provider settings", async () => {
  for (const body of [
    {},
    { external: [] },
    { external: { google: "true", github: 1 } },
  ]) {
    const request = vi
      .fn<typeof fetch>()
      .mockResolvedValue(new Response(JSON.stringify(body)));
    expect(await createProviderResolver(options, request)()).toEqual({
      github: false,
      google: false,
    });
  }
  for (const response of [
    new Response("unavailable", { status: 503 }),
    new Response("{broken"),
  ]) {
    const request = vi.fn<typeof fetch>().mockResolvedValue(response);
    expect(await createProviderResolver(options, request)()).toEqual({
      github: false,
      google: false,
    });
  }
  const failure = vi
    .fn<typeof fetch>()
    .mockRejectedValue(new Error("network unavailable"));
  expect(await createProviderResolver(options, failure)()).toEqual({
    github: false,
    google: false,
  });
});
it("coalesces concurrent lookups, expires availability, and rechecks provider revocation", async () => {
  let time = 1000;
  const request = vi
    .fn<typeof fetch>()
    .mockResolvedValueOnce(
      new Response(
        JSON.stringify({ external: { github: true, google: true } }),
      ),
    )
    .mockResolvedValueOnce(
      new Response(
        JSON.stringify({ external: { github: false, google: true } }),
      ),
    );
  const get = createProviderResolver(options, request, () => time);
  expect(await Promise.all([get(), get()])).toEqual([
    { github: true, google: true },
    { github: true, google: true },
  ]);
  expect(request).toHaveBeenCalledTimes(1);
  time += 30001;
  expect(await get()).toEqual({ github: false, google: true });
  expect(request).toHaveBeenCalledTimes(2);
});
it("does not query providers for a local or unconfigured authentication backend", async () => {
  const request = vi.fn<typeof fetch>();
  expect(
    await createProviderResolver({ ...options, enabled: false }, request)(),
  ).toEqual({ github: false, google: false });
  expect(
    await createProviderResolver({ ...options, url: undefined }, request)(),
  ).toEqual({ github: false, google: false });
  expect(
    await createProviderResolver(
      { ...options, github: false, google: false },
      request,
    )(),
  ).toEqual({ github: false, google: false });
  expect(request).not.toHaveBeenCalled();
});
