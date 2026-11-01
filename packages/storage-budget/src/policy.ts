export const storageCategories = ['runs', 'events', 'event_keys', 'evidence', 'evaluations', 'reviews', 'review_decisions', 'datasets', 'experiments', 'calibration_reports', 'archives', 'archive_objects', 'cleanup_records', 'alert_payloads'] as const;
export type StorageCategory = typeof storageCategories[number];
export type StoragePlan = 'trial' | 'starter' | 'team';
export type StorageLimits = Record<StoragePlan, number>;
export const defaultStorageLimits: Readonly<StorageLimits> = { trial: 64 * 1024 ** 2, starter: 512 * 1024 ** 2, team: 2 * 1024 ** 3 };
export const resourceOverheadBytes = 512;

export class StorageBudgetError extends Error {
  constructor(public code: string, message: string, public statusCode = 409) { super(message); }
}
export class StorageLimitError extends StorageBudgetError {
  constructor(public limitBytes: number, public usedBytes: number, public requestedBytes: number) { super('storage_limit_exceeded', 'The workspace retained-storage limit is exhausted. Delete retained content or change your plan before adding more.', 413); }
}
export function storageLimits(env: Record<string, string | undefined> = process.env): StorageLimits {
  const result = { ...defaultStorageLimits };
  for (const plan of ['trial', 'starter', 'team'] as const) {
    const value = env[`STORAGE_${plan.toUpperCase()}_BYTES`];
    if (value === undefined) continue;
    if (!/^\d+$/.test(value) || !Number.isSafeInteger(Number(value)) || Number(value) < 1) throw new StorageBudgetError('invalid_storage_config', 'Storage limits must be positive safe integer byte counts.', 503);
    result[plan] = Number(value);
  }
  return result;
}
export function safeBytes(value: unknown): number {
  const bytes = typeof value === 'string' && /^\d+$/.test(value) ? Number(value) : value;
  if (typeof bytes !== 'number' || !Number.isSafeInteger(bytes) || bytes < 0) throw new StorageBudgetError('invalid_storage_bytes', 'Storage byte counts must be non-negative safe integers.', 400);
  return bytes;
}
/** Conservative logical-content estimate; not a measurement of PostgreSQL disk allocation. */
export function retainedValueBytes(value: unknown): number {
  const encoded = JSON.stringify(value);
  if (encoded === undefined) throw new StorageBudgetError('invalid_storage_value', 'Retained content must be JSON serializable.', 400);
  return safeBytes(Buffer.byteLength(encoded, 'utf8') * 2 + resourceOverheadBytes);
}
export const archiveObjectBytes = (bytes: number) => safeBytes(safeBytes(bytes) + resourceOverheadBytes);
export function appliedStorageLimit(subscription: { plan?: string; status?: string; period_end?: string | Date; provider_id?: string | null; reconciled_at?: string | Date | null } | undefined, limits: StorageLimits = storageLimits(), now = Date.now()) {
  for (const value of Object.values(limits)) if (safeBytes(value) < 1) throw new StorageBudgetError('invalid_storage_config', 'Storage limits must be positive byte counts.', 503);
  const verified = subscription && ['starter', 'team'].includes(subscription.plan ?? '') && subscription.status === 'active' && subscription.provider_id && subscription.reconciled_at && Number.isFinite(new Date(subscription.reconciled_at).getTime()) && new Date(subscription.reconciled_at).getTime() <= now && new Date(subscription.period_end ?? '').getTime() > now;
  const plan: StoragePlan = verified ? subscription.plan as 'starter' | 'team' : 'trial';
  return { plan, limitBytes: limits[plan], basis: verified ? 'verified_subscription' as const : 'trial_cap' as const };
}
