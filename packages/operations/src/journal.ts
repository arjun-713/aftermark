import { createHmac, randomUUID } from 'node:crypto';
import { z } from 'zod';
import { S3Client, PutObjectCommand, GetObjectCommand, ListObjectsV2Command, GetBucketLocationCommand } from '@aws-sdk/client-s3';
import { checksum } from './storage.ts';
import { requiredSecret } from './config.ts';

export const deletionRecordSchema = z.object({
  version: z.literal(1), id: z.uuid(), deletedAt: z.iso.datetime(),
  kind: z.enum(['workspace', 'project', 'run', 'dataset']),
  organizationHash: z.string().regex(/^[a-f0-9]{64}$/),
  projectHash: z.string().regex(/^[a-f0-9]{64}$/).nullable(),
  targetHash: z.string().regex(/^[a-f0-9]{64}$/),
}).strict();
export type DeletionRecord = z.infer<typeof deletionRecordSchema>;
export interface DeletionSink { append(record: DeletionRecord): Promise<string>; readAll(): Promise<DeletionRecord[]> }
export function deletionHash(value: string, key = requiredSecret('DELETION_JOURNAL_HMAC_KEY')) {
  if (Buffer.byteLength(key) < 32) throw new Error('Deletion journal HMAC key must contain at least 32 bytes.');
  return createHmac('sha256', key).update(value).digest('hex');
}
export function makeDeletionRecord(org: string, project: string | null, kind: DeletionRecord['kind'], target: string): DeletionRecord {
  return { version: 1, id: randomUUID(), deletedAt: new Date().toISOString(), kind, organizationHash: deletionHash(org),
    projectHash: project ? deletionHash(`${org}:${project}`) : null, targetHash: deletionHash(`${org}:${project ?? ''}:${kind}:${target}`) };
}
/** Independent account/bucket. Runtime can append; recovery identity can list/read. Never lifecycle-expire tombstones. */
export class S3DeletionSink implements DeletionSink {
  private client = new S3Client({ region: 'ap-southeast-1', maxAttempts: 3, requestHandler: { requestTimeout: 15000, connectionTimeout: 5000 } });
  private bucket = requiredSecret('DELETION_JOURNAL_BUCKET');
  private keyId = requiredSecret('BACKUP_KMS_KEY_ID');
  private async assertRegion() {
    if ((await this.client.send(new GetBucketLocationCommand({ Bucket: this.bucket }))).LocationConstraint !== 'ap-southeast-1')
      throw new Error('Deletion journal bucket must be in Singapore.');
  }
  async append(record: DeletionRecord) {
    await this.assertRegion(); deletionRecordSchema.parse(record);
    const body = JSON.stringify(record), digest = checksum(body), key = `deletion-journal/${record.id}.json`;
    await this.client.send(new PutObjectCommand({ Bucket: this.bucket, Key: key, Body: body, ContentType: 'application/json',
      ServerSideEncryption: 'aws:kms', SSEKMSKeyId: this.keyId, ChecksumSHA256: Buffer.from(digest, 'hex').toString('base64'), IfNoneMatch: '*' }));
    return digest;
  }
  async readAll() {
    await this.assertRegion(); const records: DeletionRecord[] = []; let token: string | undefined;
    do {
      const page = await this.client.send(new ListObjectsV2Command({ Bucket: this.bucket, Prefix: 'deletion-journal/', ContinuationToken: token }));
      for (const object of page.Contents ?? []) {
        const response = await this.client.send(new GetObjectCommand({ Bucket: this.bucket, Key: object.Key, ChecksumMode: 'ENABLED' }));
        if (!response.Body) throw new Error('Deletion journal object is missing.');
        records.push(deletionRecordSchema.parse(JSON.parse(await response.Body.transformToString())));
      }
      token = page.NextContinuationToken;
    } while (token);
    return records;
  }
}
