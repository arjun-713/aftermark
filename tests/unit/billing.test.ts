import { afterEach, describe, expect, it, vi } from 'vitest';
import { Webhook } from 'standardwebhooks';
import { billingConfig, BillingError, DodoProvider, verifyBillingWebhook } from '../../packages/billing/src/provider.ts';
import { deriveEntitlement } from '../../packages/billing/src/entitlements.ts';

const products = { starter: 'p_starter', team: 'p_team' };
const day = 86400000;
const iso = (days: number) => new Date(Date.now() + days * day).toISOString();
const snapshot = (changes: Record<string, unknown> = {}) => ({ subscription_id: 'sub_1', product_id: products.starter, customer: { customer_id: 'cus_1' }, status: 'active', previous_billing_date: iso(-4), next_billing_date: iso(26), cancel_at_next_billing_date: false, metadata: {}, quantity: 1, currency: 'USD', recurring_pre_tax_amount: 2900, payment_frequency_interval: 'Month', payment_frequency_count: 1, ...changes });
const secret = `whsec_${Buffer.from('fixture-webhook-key-not-a-provider-secret').toString('base64')}`;
const event = { business_id: 'fixture', type: 'subscription.active', timestamp: new Date().toISOString(), data: { subscription_id: 'sub_1' } };
const signed = (raw: Buffer, date = new Date()) => ({ 'webhook-id': 'evt_fixture', 'webhook-timestamp': String(Math.floor(date.getTime() / 1000)), 'webhook-signature': new Webhook(secret).sign('evt_fixture', date, raw) });
afterEach(() => vi.unstubAllEnvs());

describe('billing trust boundary', () => {
  it('verifies the exact bytes including whitespace and Unicode before parsing', () => {
    const raw = Buffer.from(JSON.stringify({ ...event, note: 'café' }, null, 2));
    expect(verifyBillingWebhook(raw, signed(raw), secret).event.type).toBe('subscription.active');
    expect(() => verifyBillingWebhook(Buffer.from(JSON.stringify(event)), signed(raw), secret)).toThrow('invalid_webhook_signature');
  });
  it('rejects missing/array headers, invalid payloads, old timestamps and future timestamps', () => {
    const raw = Buffer.from(JSON.stringify(event));
    for (const headers of [{}, { ...signed(raw), 'webhook-id': ['evt_fixture'] }, signed(raw, new Date(Date.now() - 301000)), signed(raw, new Date(Date.now() + 301000))]) expect(() => verifyBillingWebhook(raw, headers, secret)).toThrow('invalid_webhook_signature');
    const invalid = Buffer.from('{}');
    expect(() => verifyBillingWebhook(invalid, signed(invalid), secret)).toThrow('invalid_webhook_payload');
    vi.stubEnv('DODO_PAYMENTS_BUSINESS_ID', 'different_business');
    expect(() => verifyBillingWebhook(raw, signed(raw), secret)).toThrow('invalid_webhook_business');
  });
  it('requires distinct configured product IDs and an explicit environment', () => {
    expect(billingConfig({})).toBeNull();
    const base = { DODO_PAYMENTS_API_KEY: 'fixture', DODO_PAYMENTS_WEBHOOK_KEY: secret, DODO_STARTER_PRODUCT_ID: 'a', DODO_TEAM_PRODUCT_ID: 'b' };
    expect(billingConfig(base)).toBeNull();
    expect(billingConfig({ ...base, DODO_PAYMENTS_ENVIRONMENT: 'test_mode' })?.productIds).toEqual({ starter: 'a', team: 'b' });
    expect(billingConfig({ ...base, DODO_TEAM_PRODUCT_ID: 'a', DODO_PAYMENTS_ENVIRONMENT: 'live_mode' })).toBeNull();
  });
});

describe('provider-derived entitlements', () => {
  it('maps only the configured plans to the fixed evaluation allowances', () => {
    expect(deriveEntitlement(snapshot(), products)).toMatchObject({ plan: 'starter', allowance: 10000 });
    expect(deriveEntitlement(snapshot({ product_id: products.team, recurring_pre_tax_amount: 9900 }), products)).toMatchObject({ plan: 'team', allowance: 50000 });
    expect(() => deriveEntitlement(snapshot({ product_id: 'unknown' }), products)).toThrow('unrecognized_billing_product');
  });
  it.each(['pending', 'active', 'on_hold', 'paused', 'cancelled', 'failed', 'expired', 'past_due'])('preserves the verified %s status for quota enforcement', status => {
    expect(deriveEntitlement(snapshot({ status, cancel_at_next_billing_date: true }), products)).toMatchObject({ status, cancelAtPeriodEnd: true });
  });
  it('preserves usage on overlapping plan changes, and advances to a renewed period', () => {
    const current = { provider_id: 'sub_1', customer_id: 'cus_1', period_start: iso(-10), period_end: iso(20) };
    expect(deriveEntitlement(snapshot({ previous_billing_date: iso(-2), next_billing_date: current.period_end, product_id: products.team }), products, current).periodStart).toBe(current.period_start);
    const ended = { ...current, period_start: iso(-31), period_end: iso(-1) };
    const renewed = snapshot({ previous_billing_date: iso(-0.5) });
    expect(deriveEntitlement(renewed, products, ended).periodStart).toBe(renewed.previous_billing_date);
  });
  it('rejects old periods, wrong customer/subscription, impossible periods and unknown terms', () => {
    const current = { provider_id: 'sub_1', customer_id: 'cus_1', period_start: iso(-1), period_end: iso(29) };
    expect(() => deriveEntitlement(snapshot(), products, current)).toThrow('stale_billing_snapshot');
    expect(() => deriveEntitlement(snapshot(), products, { ...current, provider_id: 'another' })).toThrow('billing_subscription_conflict');
    expect(() => deriveEntitlement(snapshot(), products, { ...current, customer_id: 'another' })).toThrow('billing_customer_conflict');
    expect(() => deriveEntitlement(snapshot({ next_billing_date: iso(-5) }), products)).toThrow('billing_period_invalid');
    expect(() => deriveEntitlement(snapshot({ previous_billing_date: iso(1) }), products)).toThrow('billing_period_invalid');
    for (const changes of [{ currency: 'EUR' }, { quantity: 2 }, { payment_frequency_interval: 'Year' }, { recurring_pre_tax_amount: 100000 }]) expect(() => deriveEntitlement(snapshot(changes), products)).toThrow('unrecognized_billing_terms');
  });
});

describe('Dodo HTTP contracts', () => {
  it('uses hosted checkout and tenant-owned customer portal without email delivery', async () => {
    const calls: { url: string; init: RequestInit }[] = [];
    const transport: typeof fetch = async (input, init) => {
      calls.push({ url: String(input), init: init! });
      return Response.json(String(input).includes('/checkouts') ? { session_id: 'cks_fixture', checkout_url: 'https://checkout.dodopayments.com/fixture' } : { link: 'https://customer.dodopayments.com/fixture' });
    };
    const client = new DodoProvider({ apiKey: 'private-fixture', environment: 'test_mode', productIds: products }, transport);
    await client.createCheckout({ productId: products.starter, binding: 'random-binding', email: 'member@example.test', name: 'Member', customerId: null, returnUrl: 'https://app.example.test/app/settings/billing' });
    expect(calls[0].url).toBe('https://test.dodopayments.com/checkouts');
    expect(JSON.parse(String(calls[0].init.body))).toMatchObject({ product_cart: [{ product_id: products.starter, quantity: 1 }], metadata: { aq_checkout_binding: 'random-binding' }, subscription_data: { trial_period_days: 0 }, feature_flags: { always_create_new_customer: true } });
    await client.createPortal('cus_owned', 'https://app.example.test/app/settings/billing');
    expect(calls[1].url).toContain('/customers/cus_owned/customer-portal/session?send_email=false&return_url=');
    expect(calls.every(call => call.init.redirect === 'error' && call.init.signal)).toBe(true);
  });
  it('rejects unsafe returned URLs and exposes only bounded error codes', async () => {
    const client = new DodoProvider({ apiKey: 'never-expose-me', environment: 'live_mode', productIds: products }, async () => Response.json({ link: 'https://attacker.example.test/portal' }));
    await expect(client.createPortal('customer', 'https://app.example.test')).rejects.toThrow('billing_provider_invalid');
    const rejected = new DodoProvider({ apiKey: 'never-expose-me', environment: 'live_mode', productIds: products }, async () => new Response('provider secret response', { status: 400 }));
    await expect(rejected.retrieveSubscription('subscription')).rejects.toEqual(new BillingError('billing_provider_rejected'));
  });
});
