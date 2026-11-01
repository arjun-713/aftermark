import { describe, expect, it } from 'vitest';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes, randomUUID } from 'node:crypto';
import { operationsConfig } from '../../packages/operations/src/config.ts';
import { checksum, putVerified, type PrivateObjectStore } from '../../packages/operations/src/storage.ts';
import { deletionHash, deletionRecordSchema, makeDeletionRecord } from '../../packages/operations/src/journal.ts';
import { encryptDump, decryptDump, backupKey, type BackupManifest } from '../../packages/operations/src/backup.ts';
import { validateRestoreTarget } from '../../scripts/restore.ts';
import { representativeRun, percentile } from '../../scripts/load.ts';
import { eventBatchSchema } from '@agent-quality/contracts';
import { validateGate } from '../../packages/operations/src/release.ts';

const commit = 'a'.repeat(40), hash = 'b'.repeat(64);
const measured = () => ({ version: 1, measuredAt: new Date().toISOString(), commit, observer: 'named-operator', environment: 'production-equivalent' });
describe('operations safety contracts', () => {
  it('requires explicit approval for capacity above $150 and alerts at or below $120', () => {
    expect(() => operationsConfig({ MONTHLY_BUDGET_USD: '151' })).toThrow();
    expect(operationsConfig({ MONTHLY_BUDGET_USD: '151', CAPACITY_OVER_150_APPROVED: 'true' }).MONTHLY_BUDGET_USD).toBe(151);
    expect(() => operationsConfig({ BUDGET_ALERT_USD: '121' })).toThrow();
  });
  it('writes only opaque keyed identifiers to deletion journals', () => {
    process.env.DELETION_JOURNAL_HMAC_KEY = 'test-only-key-at-least-32-characters-long';
    const org = randomUUID(), project = randomUUID(), record = makeDeletionRecord(org, project, 'run', 'private-customer-run');
    expect(JSON.stringify(record)).not.toContain(org); expect(JSON.stringify(record)).not.toContain('private-customer-run');
    expect(deletionRecordSchema.parse(record)).toEqual(record);
    expect(deletionHash('one', 'a'.repeat(32))).not.toBe(deletionHash('one', 'b'.repeat(32)));
    expect(() => deletionRecordSchema.parse({ ...record, trace: 'forbidden' })).toThrow();
  });
  it('refuses a corrupt upload receipt before a caller can commit a pointer', async () => {
    const store: PrivateObjectStore = { put: async () => {}, get: async () => Buffer.from('different'), remove: async () => {}, signedDownload: async () => '' };
    await expect(putVerified(store, 'path', Buffer.from('source'))).rejects.toThrow('checksum mismatch');
    store.get = async () => Buffer.from('source'); expect(await putVerified(store, 'path', Buffer.from('source'))).toBe(checksum('source'));
  });
  it('rejects production, nonempty-name, unconfirmed and same-name restore targets', () => {
    const source = 'postgres://aq_app:secret@localhost/agent_quality';
    expect(() => validateRestoreTarget(source, source, 'agent_quality')).toThrow();
    expect(() => validateRestoreTarget('postgres://postgres@localhost/aq_restore_test', source, undefined)).toThrow();
    expect(() => validateRestoreTarget('postgres://postgres@other/aq_restore_test', 'postgres://aq_app@localhost/aq_restore_test', 'aq_restore_test')).toThrow();
    expect(validateRestoreTarget('postgres://postgres@localhost/aq_restore_test', source, 'aq_restore_test')).toBe('aq_restore_test');
  });
  it('authenticates encrypted backups and rejects altered ciphertext', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'aq-crypto-test-'));
    try {
      const input = join(directory, 'source'), encrypted = join(directory, 'encrypted'), restored = join(directory, 'restored');
      await writeFile(input, Buffer.from('synthetic database backup')); const key = randomBytes(32);
      const properties = await encryptDump(input, encrypted, key);
      const manifest: BackupManifest = { version: 1, id: randomUUID(), createdAt: new Date().toISOString(), region: 'ap-southeast-1', format: 'postgres-custom-aes-256-gcm', objectKey: `backups/${randomUUID()}.dump.enc`, schemaMigrations: ['0006_operations.sql'], archives: [], ...properties };
      await decryptDump(encrypted, restored, manifest, key); expect(await readFile(restored, 'utf8')).toBe('synthetic database backup');
      await expect(decryptDump(encrypted, join(directory, 'wrong-key'), manifest, randomBytes(32))).rejects.toThrow();
      const altered = await readFile(encrypted); altered[0] ^= 1; await writeFile(encrypted, altered);
      await expect(decryptDump(encrypted, join(directory, 'corrupt'), manifest, key)).rejects.toThrow('checksum');
      expect(() => backupKey('not-a-key')).toThrow();
    } finally { await rm(directory, { recursive: true, force: true }); }
  });
  it('sends representative run batches that satisfy the public ingest contract', () => {
    const project = randomUUID(); expect(eventBatchSchema.parse({ projectId: project, events: [...representativeRun(project, 'load-one'), ...representativeRun(project, 'load-two')] }).events).toHaveLength(10);
    expect(percentile([90,10,20,30,40], 0.95)).toBe(90); expect(percentile([], 0.95)).toBeNull();
  });
});
describe('strict measured release evidence', () => {
  it('never turns a status string or synthetic fixtures into acceptance evidence', () => {
    expect(validateGate('providers', { status: 'passed' }, commit).passed).toBe(false);
    expect(validateGate('operations', { ...measured(), environment: 'ci', health: true, restart: true, queueRecovery: true, cleanup: true, gracefulShutdown: true, logRedaction: true }, commit).passed).toBe(false);
  });
  it('requires 400 labels, exact sealed25% holdout, emitted findings and95%precision', () => {
    const v = { ...measured(), humanLabelAttestation: true, totalCases: 400, holdoutCases: 100, corpusHash: hash, holdoutHash: hash, sealedBeforeTuning: true, truePositives: 95, falsePositives: 5 };
    expect(validateGate('calibration', v, commit).passed).toBe(true);
    for (const patch of [{ totalCases: 399 }, { holdoutCases: 99 }, { truePositives: 0, falsePositives: 0 }, { truePositives: 94, falsePositives: 6 }, { sealedBeforeTuning: false }]) expect(validateGate('calibration', { ...v, ...patch }, commit).passed).toBe(false);
  });
  it('requires real recovery evidence, including service recovery and erasure replay', () => {
    const v = { ...measured(), source: 'independent-singapore-backup', region: 'ap-southeast-1', independentBucket: true, encrypted: true, checksumVerified: true, authenticatedDecryption: true, deletionJournalReapplied: true, serviceRecoveryVerified: true, backupAgeMs: 21600000, restoreMs: 14400000, evidenceHash: hash };
    expect(validateGate('recovery', v, commit).passed).toBe(true);
    for (const patch of [{ source: 'disposable-local' }, { serviceRecoveryVerified: false }, { deletionJournalReapplied: false }, { backupAgeMs: 21600001 }, { restoreMs: 14400001 }]) expect(validateGate('recovery', { ...v, ...patch }, commit).passed).toBe(false);
  });
  it('requires three distinct real pilot teams for two weeks each', () => {
    const teams = [1,2,3].map(i => ({ workspaceHash: String(i).repeat(64), consecutiveDays: 14, realWorkflows: true, reviewedOutcomes: 1, evidenceHash: hash }));
    const v = { ...measured(), teams }; expect(validateGate('pilots', v, commit).passed).toBe(true);
    expect(validateGate('pilots', { ...v, teams: [teams[0],teams[0],teams[0]] }, commit).passed).toBe(false);
    expect(validateGate('pilots', { ...v, teams: teams.map(t => ({ ...t, consecutiveDays: 13 })) }, commit).passed).toBe(false);
  });
  it('binds evidence to the release commit and30-day freshness window', () => {
    const v = { ...measured(), monthlyEstimateUsd: 120, alertAtUsd: 120, independentMonitoringConfigured: true, capacityOver150Approved: false, sourceHash: hash };
    expect(validateGate('budget', v, commit).passed).toBe(true);
    expect(validateGate('budget', v, 'c'.repeat(40)).passed).toBe(false);
    expect(validateGate('budget', { ...v, measuredAt: '2020-01-01T00:00:00Z' }, commit).passed).toBe(false);
  });
});
