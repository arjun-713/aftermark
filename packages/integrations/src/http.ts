/** Fetch exposes decoded response bytes. Never trust compressed Content-Length as the limit. */
export const maxProviderResponseBytes = 1024 * 1024;
export class BoundedJsonError extends Error {
  constructor(public code: 'response_too_large' | 'invalid_utf8' | 'invalid_json' | 'unreadable_body', message: string) { super(message); }
}

/** Read at most 1 MiB after HTTP decompression, then parse strict UTF-8 JSON.
 * Body text is never included in errors; token responses can contain credentials.
 */
export async function readBoundedJson(response: Response): Promise<unknown> {
  if (!response.body) throw new BoundedJsonError('invalid_json', 'Provider response contains no JSON body.');
  const reader = response.body.getReader();
  // A fixed buffer also bounds overhead for providers that stream one byte per chunk.
  const buffer = new Uint8Array(maxProviderResponseBytes); let bytes = 0;
  try {
    while (true) {
      let chunk: ReadableStreamReadResult<Uint8Array>;
      try { chunk = await reader.read(); }
      catch { throw new BoundedJsonError('unreadable_body', 'Provider response body could not be read.'); }
      if (chunk.done) break;
      if (chunk.value.byteLength > maxProviderResponseBytes - bytes) throw new BoundedJsonError('response_too_large', 'Provider JSON response exceeds the 1 MiB budget.');
      buffer.set(chunk.value, bytes); bytes += chunk.value.byteLength;
    }
    let text: string;
    try { text = new TextDecoder('utf-8', { fatal: true }).decode(buffer.subarray(0, bytes)); }
    catch { throw new BoundedJsonError('invalid_utf8', 'Provider response is not valid UTF-8.'); }
    try { return JSON.parse(text); }
    catch { throw new BoundedJsonError('invalid_json', 'Provider response is not valid JSON.'); }
  } catch (error) {
    // Cancel immediately without awaiting an uncooperative underlying cancellation promise.
    try { void reader.cancel().catch(() => {}); } catch { /* Preserve the bounded parse failure. */ }
    throw error;
  } finally { reader.releaseLock(); }
}
