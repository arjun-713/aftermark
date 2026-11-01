import { createCipheriv, createDecipheriv, randomBytes, createHash } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { stat, readFile, writeFile } from 'node:fs/promises';
import { pipeline } from 'node:stream/promises';
import { z } from 'zod';
import { S3Client, GetBucketLocationCommand, PutObjectCommand, GetObjectCommand, HeadObjectCommand } from '@aws-sdk/client-s3';
import { requiredSecret } from './config.ts';
import { checksum, type PrivateObjectStore } from './storage.ts';

const encryptedObjectSchema = z.object({ objectPath: z.string().regex(/^[a-f0-9-]+\/[a-f0-9-]+\/[a-f0-9-]+\.json$/),
  checksum: z.string().regex(/^[a-f0-9]{64}$/), objectKey: z.string().regex(/^backups\/[a-f0-9-]+\/[a-f0-9-]+\.json\.enc$/),
  ciphertextSha256: z.string().regex(/^[a-f0-9]{64}$/), bytes: z.number().int().positive(), iv: z.string().regex(/^[a-f0-9]{24}$/), tag: z.string().regex(/^[a-f0-9]{32}$/) }).strict();
export type EncryptedArchiveObject = z.infer<typeof encryptedObjectSchema>;

export const backupManifestSchema = z.object({
  version: z.literal(1), id: z.uuid(), createdAt: z.iso.datetime(), region: z.literal('ap-southeast-1'),
  format: z.literal('postgres-custom-aes-256-gcm'), objectKey: z.string().regex(/^backups\/[a-f0-9-]+\.dump\.enc$/),
  ciphertextSha256: z.string().regex(/^[a-f0-9]{64}$/), bytes: z.number().int().positive(),
  iv: z.string().regex(/^[a-f0-9]{24}$/), tag: z.string().regex(/^[a-f0-9]{32}$/),
  schemaMigrations: z.array(z.string().regex(/^\d+_[a-z0-9_]+\.sql$/)),
  archives: z.array(encryptedObjectSchema),
}).strict();
export type BackupManifest = z.infer<typeof backupManifestSchema>;
export function backupKey(value = requiredSecret('BACKUP_ENCRYPTION_KEY')) {
  const key = Buffer.from(value, 'base64'); if (key.length !== 32 || key.toString('base64') !== value) throw new Error('BACKUP_ENCRYPTION_KEY must be canonical base64 for 32 random bytes.'); return key;
}
export async function fileHash(path: string) {
  const hash = createHash('sha256'); for await (const chunk of createReadStream(path)) hash.update(chunk); return hash.digest('hex');
}
export async function encryptDump(input: string, output: string, key = backupKey()) {
  const iv = randomBytes(12), cipher = createCipheriv('aes-256-gcm', key, iv);
  cipher.setAAD(Buffer.from('agent-quality-backup-v1'));
  await pipeline(createReadStream(input), cipher, createWriteStream(output, { mode: 0o600, flags: 'wx' }));
  return { iv: iv.toString('hex'), tag: cipher.getAuthTag().toString('hex'), ciphertextSha256: await fileHash(output), bytes: (await stat(output)).size };
}
export async function decryptDump(input: string, output: string, manifest: BackupManifest, key = backupKey()) {
  backupManifestSchema.parse(manifest);
  if ((await stat(input)).size !== manifest.bytes || await fileHash(input) !== manifest.ciphertextSha256) throw new Error('Backup checksum or size mismatch.');
  const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(manifest.iv, 'hex'));
  decipher.setAAD(Buffer.from('agent-quality-backup-v1')); decipher.setAuthTag(Buffer.from(manifest.tag, 'hex'));
  await pipeline(createReadStream(input), decipher, createWriteStream(output, { mode: 0o600, flags: 'wx' }));
}
export class IndependentBackupStore {
  private client = new S3Client({ region: 'ap-southeast-1', maxAttempts: 3, requestHandler: { requestTimeout: 15000, connectionTimeout: 5000 } });
  private bucket = requiredSecret('BACKUP_BUCKET'); private keyId = requiredSecret('BACKUP_KMS_KEY_ID');
  async assertRegion() {
    if ((await this.client.send(new GetBucketLocationCommand({ Bucket: this.bucket }))).LocationConstraint !== 'ap-southeast-1') throw new Error('Backup bucket must be in Singapore.');
  }
  async upload(path: string, manifest: BackupManifest) {
    await this.assertRegion(); backupManifestSchema.parse(manifest);
    await this.uploadEncryptedFile(path, manifest);
    const body = JSON.stringify(manifest);
    await this.client.send(new PutObjectCommand({ Bucket: this.bucket, Key: `backups/${manifest.id}.manifest.json`, Body: body, ContentType: 'application/json', ServerSideEncryption: 'aws:kms', SSEKMSKeyId: this.keyId, IfNoneMatch: '*' }));
  }
  async uploadEncryptedFile(path: string, metadata: { objectKey: string; bytes: number; ciphertextSha256: string }) {
    const response = await this.client.send(new PutObjectCommand({ Bucket: this.bucket, Key: metadata.objectKey, Body: createReadStream(path), ContentLength: metadata.bytes,
      ServerSideEncryption: 'aws:kms', SSEKMSKeyId: this.keyId, ChecksumSHA256: Buffer.from(metadata.ciphertextSha256, 'hex').toString('base64'), IfNoneMatch: '*' }));
    if (response.ChecksumSHA256 !== Buffer.from(metadata.ciphertextSha256, 'hex').toString('base64')) throw new Error('Backup upload checksum not confirmed.');
    const head = await this.client.send(new HeadObjectCommand({ Bucket: this.bucket, Key: metadata.objectKey, ChecksumMode: 'ENABLED' }));
    if (head.ContentLength !== metadata.bytes || head.ChecksumSHA256 !== response.ChecksumSHA256 || head.ServerSideEncryption !== 'aws:kms' || head.SSEKMSKeyId !== this.keyId) throw new Error('Independent backup verification failed.');
  }
  async recoverArchives(manifest: BackupManifest, directory: string, store: PrivateObjectStore, livePaths: Set<string>) {
    let restored = 0;
    for (const [index, entry] of manifest.archives.entries()) {
      // Deleted pointers were removed by journal replay; their payloads must never be rehydrated.
      if (!livePaths.has(entry.objectPath)) continue;
      let existing: Uint8Array | undefined;
      try { existing = await store.get(entry.objectPath); } catch { /* Missing source storage is a recovery scenario. */ }
      if (existing) { if (checksum(existing) !== entry.checksum) throw new Error('Existing archive checksum mismatch.'); continue; }
      const object = await this.client.send(new GetObjectCommand({ Bucket: this.bucket, Key: entry.objectKey, ChecksumMode: 'ENABLED' }));
      if (!object.Body) throw new Error('Archived backup object missing.');
      const encrypted = `${directory}/archive-${index}.enc`, plaintext = `${directory}/archive-${index}.json`;
      await pipeline(object.Body as NodeJS.ReadableStream, createWriteStream(encrypted, { mode: 0o600, flags: 'wx' }));
      await decryptDump(encrypted, plaintext, { ...manifest, ciphertextSha256: entry.ciphertextSha256, bytes: entry.bytes, iv: entry.iv, tag: entry.tag });
      const bytes = await readFile(plaintext); if (checksum(bytes) !== entry.checksum) throw new Error('Recovered archive checksum mismatch.');
      await store.put(entry.objectPath, bytes); if (checksum(await store.get(entry.objectPath)) !== entry.checksum) throw new Error('Rehydrated archive verification failed.'); restored++;
    }
    return restored;
  }
  async download(manifestKey: string, directory: string) {
    await this.assertRegion(); if (!/^backups\/[a-f0-9-]+\.manifest\.json$/.test(manifestKey)) throw new Error('Invalid manifest key.');
    const metadata = await this.client.send(new GetObjectCommand({ Bucket: this.bucket, Key: manifestKey }));
    if (!metadata.Body) throw new Error('Backup manifest missing.');
    const manifest = backupManifestSchema.parse(JSON.parse(await metadata.Body.transformToString()));
    const object = await this.client.send(new GetObjectCommand({ Bucket: this.bucket, Key: manifest.objectKey, ChecksumMode: 'ENABLED' }));
    if (!object.Body) throw new Error('Backup object missing.');
    const path = `${directory}/backup.dump.enc`;
    await pipeline(object.Body as NodeJS.ReadableStream, createWriteStream(path, { mode: 0o600, flags: 'wx' }));
    if (await fileHash(path) !== manifest.ciphertextSha256) throw new Error('Backup download checksum mismatch.');
    await writeFile(`${directory}/manifest.json`, JSON.stringify(manifest), { mode: 0o600 });
    return { path, manifest };
  }
}
export async function readBackupManifest(path: string) { return backupManifestSchema.parse(JSON.parse(await readFile(path, 'utf8'))); }
