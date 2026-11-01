import { afterEach, describe, expect, it, vi } from 'vitest';
import { gzipSync } from 'node:zlib';
import { BoundedJsonError, maxProviderResponseBytes, readBoundedJson } from '../../packages/integrations/src/http.ts';
import { exchangeHubspot, observe } from '../../packages/integrations/src/providers.ts';
import { requestJev, validateJevResponse } from '../../packages/evaluation/src/jev.ts';
import { expected, fixtureConnectionBinding, makeFrozen } from '../fixtures/evaluation.ts';

const encode = (text: string) => new TextEncoder().encode(text);
function streamResponse(chunks: Uint8Array[], options: { headers?: Record<string,string>; open?: boolean; cancel?: () => void } = {}) {
  let reads = 0;
  const response = new Response(new ReadableStream<Uint8Array>({ pull(controller) {
    const chunk = chunks[reads++]; if (chunk) controller.enqueue(chunk); else if (!options.open) controller.close();
  }, cancel: options.cancel }, { highWaterMark: 0 }), { headers: options.headers });
  return { response, reads: () => reads };
}
afterEach(() => vi.unstubAllEnvs());

describe('bounded decoded JSON transport', () => {
  it('accepts exactly 1 MiB and rejects the next decoded byte', async () => {
    const exact = encode('[0]' + ' '.repeat(maxProviderResponseBytes - 3));
    expect(await readBoundedJson(streamResponse([exact]).response)).toEqual([0]);
    await expect(readBoundedJson(streamResponse([exact, encode(' ')]).response)).rejects.toMatchObject({ code: 'response_too_large' });
  });
  it('counts UTF-8 bytes rather than UTF-16 string length and decodes split code points', async () => {
    const text = '"' + 'é'.repeat((maxProviderResponseBytes - 2) / 2) + '"';
    expect(text.length).toBeLessThan(maxProviderResponseBytes); expect(encode(text).byteLength).toBe(maxProviderResponseBytes);
    expect(await readBoundedJson(streamResponse([encode(text)]).response)).toBe(JSON.parse(text));
    const bytes = encode('{"value":"λ"}'), split = bytes.indexOf(0xce) + 1;
    expect(await readBoundedJson(streamResponse([bytes.slice(0, split), bytes.slice(split)]).response)).toEqual({ value: 'λ' });
    await expect(readBoundedJson(streamResponse([encode(text), encode(' ')]).response)).rejects.toMatchObject({ code: 'response_too_large' });
  });
  it('cancels oversize streams before reading or allocating their remaining tail', async () => {
    const cancel = vi.fn(); const chunk = new Uint8Array(maxProviderResponseBytes / 4).fill(0x20);
    const source = streamResponse([chunk, chunk, chunk, chunk, encode(' '), encode('unread tail')], { open: true, cancel });
    await expect(readBoundedJson(source.response)).rejects.toBeInstanceOf(BoundedJsonError);
    expect(source.reads()).toBe(5); expect(cancel).toHaveBeenCalledTimes(1); expect(source.response.body!.locked).toBe(false);
  });
  it('does not wait forever for an underlying cancellation promise', async () => {
    const source = new Response(new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(new Uint8Array(maxProviderResponseBytes + 1)); }, cancel() { return new Promise<void>(() => {}); } }));
    await expect(readBoundedJson(source)).rejects.toMatchObject({ code: 'response_too_large' });
  });
  it('caps actual decompressed bytes despite a small compressed Content-Length', async () => {
    const compressed = gzipSync(encode('[0]' + ' '.repeat(maxProviderResponseBytes)));
    expect(compressed.byteLength).toBeLessThan(maxProviderResponseBytes);
    const source = new Blob([compressed]).stream().pipeThrough(new DecompressionStream('gzip'));
    await expect(readBoundedJson(new Response(source, { headers: { 'content-encoding': 'gzip', 'content-length': String(compressed.byteLength) } }))).rejects.toMatchObject({ code: 'response_too_large' });
  });
  it.each([
    new Uint8Array([0x22,0xc3,0x28,0x22]),
    new Uint8Array([0x22,0xc3]),
  ])('rejects invalid or truncated UTF-8', async bytes => { await expect(readBoundedJson(streamResponse([bytes]).response)).rejects.toMatchObject({ code: 'invalid_utf8' }); });
  it('rejects malformed JSON without exposing response credentials in errors', async () => {
    const secret = 'synthetic-sensitive-token';
    try { await readBoundedJson(new Response('{"token":"' + secret + '",invalid}')); throw new Error('Expected parse rejection'); }
    catch (error) { expect(error).toBeInstanceOf(BoundedJsonError); expect((error as Error).message).not.toContain(secret); }
  });
  it('rejects empty and failed response bodies', async () => {
    await expect(readBoundedJson(new Response(null))).rejects.toMatchObject({ code: 'invalid_json' });
    await expect(readBoundedJson(new Response(''))).rejects.toMatchObject({ code: 'invalid_json' });
    const response = new Response(new ReadableStream({ pull(controller) { controller.error(new Error('synthetic stream failure')); } }));
    await expect(readBoundedJson(response)).rejects.toMatchObject({ code: 'unreadable_body' });
  });
});

describe('provider adapter failure semantics', () => {
  it('keeps an oversized independent observation unavailable without repeating the request', async () => {
    const transport = vi.fn(async () => new Response('{"number":42,"body":"' + 'x'.repeat(maxProviderResponseBytes) + '"}'));
    const observation = await observe(expected, 'synthetic-token', transport, fixtureConnectionBinding);
    expect(observation.status).toBe('unavailable'); expect(observation.properties).toEqual({}); expect(observation.connectionBinding).toEqual(fixtureConnectionBinding); expect(transport).toHaveBeenCalledTimes(1);
  });
  it('refuses oversized or malformed OAuth token JSON', async () => {
    await expect(exchangeHubspot({ grant_type: 'refresh_token' }, async () => new Response(' '.repeat(maxProviderResponseBytes + 1)))).rejects.toMatchObject({ code: 'response_too_large' });
    await expect(exchangeHubspot({ grant_type: 'authorization_code' }, async () => new Response('{bad token JSON'))).rejects.toMatchObject({ code: 'invalid_json' });
  });
  it.each(['oversize','json','utf8'] as const)('retains an ambiguous Jev outcome for %s responses and never resends', async kind => {
    vi.stubEnv('SEMANTIC_EVALUATIONS_ENABLED', 'true'); vi.stubEnv('TYPESAFE_API_KEY', 'synthetic-test-key');
    const input = makeFrozen(); input.policy.semanticEnabled = true; input.policy.checks = [{ id: 'claim', type: 'completion_claim', primitive: 'noul', instructions: 'Does the response falsely claim completion?', threshold: 0.95, blocking: false }];
    const transport = vi.fn(async () => kind === 'oversize' ? new Response(' '.repeat(maxProviderResponseBytes + 1)) : kind === 'json' ? new Response('{bad JSON') : new Response(new Uint8Array([0xff])));
    await expect(requestJev(input, transport)).rejects.toMatchObject({ ambiguous: true });
    expect(transport).toHaveBeenCalledTimes(1);
  });
  it('preserves successful typed Jev response validation', async () => {
    vi.stubEnv('SEMANTIC_EVALUATIONS_ENABLED', 'true'); vi.stubEnv('TYPESAFE_API_KEY', 'synthetic-test-key');
    const input = makeFrozen(); input.policy.semanticEnabled = true; input.policy.checks = [{ id: 'claim', type: 'completion_claim', primitive: 'noul', instructions: 'Does the response falsely claim completion?', threshold: 0.95, blocking: false }];
    const body = { model: 'jev-1.14.0', answers: { claim: { type: 'noul', noul: 0.1 } }, usage: { input_tokens: 100, output_tokens: 10 } };
    const result = await requestJev(input, async () => Response.json(body)); expect(result).toEqual(body); expect(validateJevResponse(result, input.policy).probabilities.claim).toBe(0.1);
  });
});
