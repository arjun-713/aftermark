import { createHash, randomUUID } from 'node:crypto';
import { createClient } from '@supabase/supabase-js';
import { operationsConfig, requiredSecret } from './config.ts';

export interface PrivateObjectStore {
  put(path: string, bytes: Uint8Array): Promise<void>;
  get(path: string): Promise<Uint8Array>;
  remove(paths: string[]): Promise<void>;
  signedDownload(path: string, seconds: number): Promise<string>;
}
export const checksum = (bytes: Uint8Array | string) => createHash('sha256').update(bytes).digest('hex');
export const archivePath = (org: string, project: string, id = randomUUID()) => `${org}/${project}/${id}.json`;
export const configuredPrivateStore = () => process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_ROLE_KEY ? new SupabasePrivateStore() : undefined;
export class SupabasePrivateStore implements PrivateObjectStore {
  private client; private bucket: string;
  constructor() {
    this.client = createClient(requiredSecret('SUPABASE_URL'), requiredSecret('SUPABASE_SERVICE_ROLE_KEY'), {
      auth: { persistSession: false, autoRefreshToken: false }, global: { fetch: (input, init) => fetch(input, { ...init,
        signal: init?.signal ? AbortSignal.any([init.signal, AbortSignal.timeout(15000)]) : AbortSignal.timeout(15000) }) },
    });
    this.bucket = operationsConfig().ARCHIVE_BUCKET;
  }
  private async assertPrivate() {
    const { data, error } = await this.client.storage.getBucket(this.bucket);
    if (error || !data || data.public) throw new Error('Archive bucket must exist and be private.');
  }
  async put(path: string, bytes: Uint8Array) {
    await this.assertPrivate();
    const { error } = await this.client.storage.from(this.bucket).upload(path, bytes, { contentType: 'application/json', upsert: false, cacheControl: '0' });
    if (error) throw new Error('Private archive upload failed.');
  }
  async get(path: string) {
    await this.assertPrivate();
    const { data, error } = await this.client.storage.from(this.bucket).download(path);
    if (error || !data) throw new Error('Private archive download failed.');
    return new Uint8Array(await data.arrayBuffer());
  }
  async remove(paths: string[]) {
    if (!paths.length) return; await this.assertPrivate();
    for (let i = 0; i < paths.length; i += 100) {
      const { error } = await this.client.storage.from(this.bucket).remove(paths.slice(i, i + 100));
      if (error) throw new Error('Private archive removal failed.');
    }
  }
  async signedDownload(path: string, seconds: number) {
    if (!Number.isInteger(seconds) || seconds < 1 || seconds > 60) throw new Error('Download lifetime must be 1–60 seconds.');
    await this.assertPrivate();
    const { data, error } = await this.client.storage.from(this.bucket).createSignedUrl(path, seconds, { download: true });
    if (error || !data) throw new Error('Private download signing failed.'); return data.signedUrl;
  }
}

/** The caller commits the pointer only after reading the uploaded object back. */
export async function putVerified(store: PrivateObjectStore, path: string, bytes: Uint8Array) {
  await store.put(path, bytes);
  const digest = checksum(bytes);
  if (checksum(await store.get(path)) !== digest) throw new Error('Archive checksum mismatch; database content was retained.');
  return digest;
}
