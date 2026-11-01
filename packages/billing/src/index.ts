import { createHash } from 'node:crypto';
import { tenant, rows, sql, type Tx } from '../../db/src/index.ts';
import { BillingError, type BillingProvider, providerSubscriptionSchema, verifyBillingWebhook } from './provider.ts';
import { deriveEntitlement } from './entitlements.ts';
export * from './provider.ts';
export * from './entitlements.ts';

export const billingDigest = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');

async function lockSubscription(tx: Tx, organizationId: string) {
  const [subscription] = await rows<any>(tx, sql`select * from subscriptions where organization_id=${organizationId} for update`);
  if (!subscription) throw new BillingError('billing_workspace_missing', 404);
  return subscription;
}

async function syncSubscription(provider: BillingProvider, organizationId: string, subscriptionId: string, event?: { id: string; hash: string; type: string }) {
  return tenant(organizationId, null, async tx => {
    const current = await lockSubscription(tx, organizationId);
    // Serialize lookup AND application. Fetching before this lock would let a slower
    // request overwrite a renewal or cancellation with an earlier provider snapshot.
    const parsed = providerSubscriptionSchema.safeParse(await provider.retrieveSubscription(subscriptionId));
    if (!parsed.success || parsed.data.subscription_id !== subscriptionId) throw new BillingError('billing_provider_invalid');
    const snapshot = parsed.data;
    if (current.provider_id && current.provider_id !== subscriptionId) throw new BillingError('billing_subscription_conflict', 409);
    if (current.customer_id && current.customer_id !== snapshot.customer.customer_id) throw new BillingError('billing_customer_conflict', 409);
    if (!current.provider_id) {
      const binding = snapshot.metadata.aq_checkout_binding;
      if (!binding) throw new BillingError('billing_binding_missing', 409);
      const [intent] = await rows<any>(tx, sql`select id from billing_checkout_intents where binding_hash=${billingDigest(binding)} and status in('creating','ready','ambiguous') for update`);
      if (!intent) throw new BillingError('billing_binding_missing', 409);
      await tx.execute(sql`update subscriptions set provider_id=${subscriptionId},customer_id=${snapshot.customer.customer_id} where organization_id=${organizationId}`);
      await tx.execute(sql`update billing_checkout_intents set status='bound',checkout_url=null where id=${intent.id}`);
    }
    if (event) {
      const [{ state }] = await rows<{ state: string }>(tx, sql`select billing_claim_event(${event.id},${subscriptionId},${event.hash},${event.type}) as state`);
      if (state === 'conflict') throw new BillingError('billing_event_conflict', 409);
      if (state === 'processed') return { duplicate: true, organizationId };
    }
    let reason: string | null = null;
    try {
      const entitlement = deriveEntitlement(snapshot, provider.productIds, current);
      await tx.execute(sql`update subscriptions set plan=${entitlement.plan},status=${entitlement.status},allowance=${entitlement.allowance},period_start=${entitlement.periodStart},period_end=${entitlement.periodEnd},provider_product_id=${snapshot.product_id},cancel_at_period_end=${entitlement.cancelAtPeriodEnd},reconciled_at=now(),billing_sync_error=null where organization_id=${organizationId}`);
    } catch (error) {
      if (!(error instanceof BillingError)) throw error;
      if (['unrecognized_billing_product', 'unrecognized_billing_terms'].includes(error.code)) {
        reason = error.code;
        await tx.execute(sql`update subscriptions set status='billing_review',allowance=0,reconciled_at=now(),billing_sync_error=${reason} where organization_id=${organizationId}`);
      } else if (error.code === 'stale_billing_snapshot' && event) {
        reason = error.code;
      } else throw error;
    }
    if (event) await tx.execute(sql`select billing_finish_event(${event.id},${subscriptionId})`);
    await tx.execute(sql`insert into audit_events(organization_id,action,resource_id,metadata) values(${organizationId},'billing.reconciled',${subscriptionId},${JSON.stringify({ source: event ? 'webhook' : 'daily', ...(reason ? { reason } : {}) })}::jsonb)`);
    return { duplicate: false, organizationId, ...(reason ? { reason } : {}) };
  });
}

export async function processBillingWebhook(raw: Buffer, headers: Record<string, unknown>, provider: BillingProvider, secret: string) {
  const verified = verifyBillingWebhook(raw, headers, secret);
  const subscriptionId = verified.event.data.subscription_id;
  if (!subscriptionId || !/^(subscription|payment)\./.test(verified.event.type)) return { received: true, ignored: true };
  // Event fields identify a resource only. No entitlement fields are read from it.
  const parsed = providerSubscriptionSchema.safeParse(await provider.retrieveSubscription(subscriptionId));
  if (!parsed.success || parsed.data.subscription_id !== subscriptionId) throw new BillingError('billing_provider_invalid');
  const binding = parsed.data.metadata.aq_checkout_binding;
  const [{ organization_id: organizationId }] = await tenant('', null, tx => rows<{ organization_id: string | null }>(tx, sql`select billing_resolve_target(${subscriptionId},${binding ? billingDigest(binding) : null}) as organization_id`));
  if (!organizationId) return { received: true, ignored: true };
  const result = await syncSubscription(provider, organizationId, subscriptionId, { id: verified.id, hash: billingDigest(raw), type: verified.event.type });
  return { received: true, duplicate: result.duplicate, ...(result.reason ? { reason: result.reason } : {}) };
}

/** Invoke once daily from the worker/operations scheduler; no public sweep route. */
export async function reconcileBilling(provider: BillingProvider | null, options: { pageSize?: number } = {}) {
  const pageSize = Math.max(1, Math.min(1000, options.pageSize ?? 100));
  const result = { checked: 0, reconciled: 0, expiredTrials: 0, failed: 0, disconnected: !provider };
  let cursor: string | null = null;
  while (true) {
    const targets: { organization_id: string; provider_id: string | null; checkout_id: string | null }[] = await tenant('', null, tx => rows(tx, sql`select * from billing_reconciliation_targets(${cursor}::uuid,${pageSize})`));
    if (!targets.length) break;
    for (const target of targets) {
      result.checked++;
      try {
        if (!target.provider_id) {
          const expired = await tenant(target.organization_id, null, async tx => {
            const current = await lockSubscription(tx, target.organization_id);
            if (!current.provider_id && current.plan === 'trial' && current.status === 'trialing' && new Date(current.period_end) <= new Date()) {
              await tx.execute(sql`update subscriptions set status='expired',reconciled_at=now() where organization_id=${target.organization_id}`);
              return true;
            }
            return false;
          });
          if (expired) result.expiredTrials++;
        }
        if (!provider) continue;
        const subscriptionId = target.provider_id ?? (target.checkout_id ? await provider.checkoutSubscription(target.checkout_id) : null);
        if (subscriptionId) {
          await syncSubscription(provider, target.organization_id, subscriptionId);
          result.reconciled++;
        }
      } catch {
        // A failure neither fabricates a renewal nor deletes recorded usage.
        result.failed++;
      }
    }
    cursor = targets[targets.length - 1]!.organization_id;
    if (targets.length < pageSize) break;
  }
  return result;
}
