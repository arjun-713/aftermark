import { describe, expect, it } from 'vitest';
import { appliedStorageLimit, archiveObjectBytes, defaultStorageLimits, retainedValueBytes, safeBytes, storageLimits } from '../../packages/storage-budget/src/policy.ts';

describe('retained storage policy', () => {
  it('defines distinct binary byte caps independently of evaluation allowances', () => {
    expect(defaultStorageLimits).toEqual({ trial: 67108864, starter: 536870912, team: 2147483648 });
    expect(storageLimits({ STORAGE_TRIAL_BYTES: '1234' })).toEqual({ ...defaultStorageLimits, trial: 1234 });
    for (const value of ['0', '-1', '1.5', 'Infinity', 'NaN', '9007199254740992', '64MiB', '']) expect(() => storageLimits({ STORAGE_TEAM_BYTES: value })).toThrow('positive safe integer');
  });
  it('counts UTF-8 JSON conservatively and archives once by their actual byte size', () => {
    const value = { message: 'café 日本語', observations: [1, 2, 3] };
    expect(retainedValueBytes(value)).toBe(2 * Buffer.byteLength(JSON.stringify(value), 'utf8') + 512);
    expect(archiveObjectBytes(1234)).toBe(1746);
    expect(() => retainedValueBytes(undefined)).toThrow('JSON serializable');
    for (const value of [-1, 1.5, Number.MAX_SAFE_INTEGER + 1, Infinity, null]) expect(() => safeBytes(value)).toThrow();
  });
  it('uses the trial cap for missing, inactive, expired and unverified paid rows', () => {
    const now = Date.parse('2026-11-01T00:00:00Z');
    const paid = { plan: 'team', status: 'active', period_end: '2026-12-01T00:00:00Z', provider_id: 'fixture_subscription', reconciled_at: '2026-10-31T00:00:00Z' };
    expect(appliedStorageLimit(undefined, defaultStorageLimits, now)).toMatchObject({ plan: 'trial', limitBytes: 67108864 });
    for (const row of [{ ...paid, status: 'past_due' }, { ...paid, status: 'on_hold' }, { ...paid, status: 'cancelled' }, { ...paid, period_end: '2026-10-01T00:00:00Z' }, { ...paid, provider_id: null }, { ...paid, reconciled_at: null }, { ...paid, reconciled_at: '2027-01-01T00:00:00Z' }, { ...paid, plan: 'unknown' }]) expect(appliedStorageLimit(row, defaultStorageLimits, now).plan).toBe('trial');
  });
  it('recognizes only verified active paid rows without changing their entitlements', () => {
    const now = Date.parse('2026-11-01T00:00:00Z');
    for (const plan of ['starter', 'team'] as const) {
      const subscription = { plan, status: 'active', period_end: '2026-12-01T00:00:00Z', provider_id: 'fixture_subscription', reconciled_at: '2026-10-31T00:00:00Z' };
      expect(appliedStorageLimit(subscription, defaultStorageLimits, now)).toEqual({ plan, limitBytes: defaultStorageLimits[plan], basis: 'verified_subscription' });
      expect(subscription.status).toBe('active');
    }
  });
});
