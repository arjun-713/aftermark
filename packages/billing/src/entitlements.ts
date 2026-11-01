import { plans } from '../../contracts/src/index.ts';
import { BillingError, providerSubscriptionSchema, type PaidPlan } from './provider.ts';

export type ExistingSubscription = {
  provider_id: string | null;
  customer_id: string | null;
  period_start: Date | string;
  period_end: Date | string;
};

/** Unknown provider products and invalid billing periods never grant access. */
export function deriveEntitlement(value: unknown, productIds: Record<PaidPlan, string>, existing?: ExistingSubscription) {
  const parsed = providerSubscriptionSchema.safeParse(value);
  if (!parsed.success) throw new BillingError('billing_provider_invalid');
  const subscription = parsed.data;
  const plan = (Object.keys(productIds) as PaidPlan[]).find(name => productIds[name] === subscription.product_id);
  if (!plan) throw new BillingError('unrecognized_billing_product', 422);
  if (subscription.quantity !== 1 || subscription.currency !== 'USD' || subscription.payment_frequency_interval !== 'Month' || subscription.payment_frequency_count !== 1 || subscription.recurring_pre_tax_amount > plans[plan].price * 100) throw new BillingError('unrecognized_billing_terms', 422);
  const start = new Date(subscription.previous_billing_date);
  const end = new Date(subscription.next_billing_date);
  if (start >= end || start.getTime() > Date.now() + 60_000) throw new BillingError('billing_period_invalid');
  if (existing?.provider_id && existing.provider_id !== subscription.subscription_id) throw new BillingError('billing_subscription_conflict', 409);
  if (existing?.customer_id && existing.customer_id !== subscription.customer.customer_id) throw new BillingError('billing_customer_conflict', 409);
  if (existing?.provider_id) {
    if (start < new Date(existing.period_start) || end <= new Date(existing.period_start)) throw new BillingError('stale_billing_snapshot', 409);
    // A mid-cycle plan change must not reset consumed/reserved/ambiguous units.
    if (start < new Date(existing.period_end)) start.setTime(new Date(existing.period_start).getTime());
  }
  return { subscription, plan, status: subscription.status, allowance: plans[plan].allowance, periodStart: start.toISOString(), periodEnd: end.toISOString(), cancelAtPeriodEnd: subscription.cancel_at_next_billing_date };
}
