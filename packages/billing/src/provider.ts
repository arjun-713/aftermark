import { z } from 'zod';
import { Webhook } from 'standardwebhooks';

export const paidPlans = ['starter', 'team'] as const;
export type PaidPlan = typeof paidPlans[number];
export type BillingConfig = {
  apiKey: string;
  environment: 'test_mode' | 'live_mode';
  productIds: Record<PaidPlan, string>;
};

export class BillingError extends Error {
  constructor(public code: string, public status = 503) { super(code); }
}

/** Read only public configuration state; never return these values through an API. */
export function billingConfig(env: Record<string, string | undefined> = process.env): BillingConfig | null {
  if (!env.DODO_PAYMENTS_API_KEY || !env.DODO_PAYMENTS_WEBHOOK_KEY || !env.DODO_PAYMENTS_ENVIRONMENT || !env.DODO_STARTER_PRODUCT_ID || !env.DODO_TEAM_PRODUCT_ID) return null;
  const environment = z.enum(['test_mode', 'live_mode']).safeParse(env.DODO_PAYMENTS_ENVIRONMENT);
  if (!environment.success || env.DODO_STARTER_PRODUCT_ID === env.DODO_TEAM_PRODUCT_ID) return null;
  return { apiKey: env.DODO_PAYMENTS_API_KEY, environment: environment.data, productIds: { starter: env.DODO_STARTER_PRODUCT_ID, team: env.DODO_TEAM_PRODUCT_ID } };
}

export const providerSubscriptionSchema = z.object({
  subscription_id: z.string().min(1).max(200),
  product_id: z.string().min(1).max(200),
  customer: z.object({ customer_id: z.string().min(1).max(200) }),
  status: z.enum(['pending', 'active', 'on_hold', 'paused', 'cancelled', 'failed', 'expired', 'past_due']),
  previous_billing_date: z.iso.datetime({ offset: true }),
  next_billing_date: z.iso.datetime({ offset: true }),
  cancel_at_next_billing_date: z.boolean(),
  metadata: z.record(z.string(), z.string()),
  quantity: z.number().int().positive(),
  currency: z.string(),
  recurring_pre_tax_amount: z.number().int().nonnegative(),
  payment_frequency_interval: z.string(),
  payment_frequency_count: z.number().int().positive(),
});
export type ProviderSubscription = z.infer<typeof providerSubscriptionSchema>;
export type CheckoutInput = {
  productId: string;
  binding: string;
  email: string;
  name: string;
  customerId: string | null;
  returnUrl: string;
};
export interface BillingProvider {
  readonly productIds: Record<PaidPlan, string>;
  readonly environment: 'test_mode' | 'live_mode';
  retrieveSubscription(id: string): Promise<unknown>;
  createCheckout(input: CheckoutInput): Promise<{ sessionId: string; url: string }>;
  createPortal(customerId: string, returnUrl: string): Promise<{ url: string }>;
  checkoutSubscription(checkoutId: string): Promise<string | null>;
}

const hostedUrl = z.url().refine(value => {
  const url = new URL(value);
  return url.protocol === 'https:' && !url.username && !url.password && (url.hostname === 'dodopayments.com' || url.hostname.endsWith('.dodopayments.com'));
});

/** Fixed provider hosts, bounded requests, no automatic retries for writes. */
export class DodoProvider implements BillingProvider {
  readonly productIds: Record<PaidPlan, string>;
  readonly environment: 'test_mode' | 'live_mode';
  private readonly baseUrl: string;
  constructor(private readonly config: BillingConfig, private readonly transport: typeof fetch = fetch) {
    this.productIds = config.productIds;
    this.environment = config.environment;
    this.baseUrl = config.environment === 'live_mode' ? 'https://live.dodopayments.com' : 'https://test.dodopayments.com';
  }
  private async request(path: string, method = 'GET', body?: unknown): Promise<unknown> {
    let response: Response;
    try {
      response = await this.transport(`${this.baseUrl}${path}`, {
        method, redirect: 'error', signal: AbortSignal.timeout(8000),
        headers: { authorization: `Bearer ${this.config.apiKey}`, accept: 'application/json', ...(body ? { 'content-type': 'application/json' } : {}) },
        ...(body ? { body: JSON.stringify(body) } : {}),
      });
    } catch { throw new BillingError('billing_provider_unavailable'); }
    if (!response.ok) throw new BillingError(response.status >= 400 && response.status < 500 && ![408, 409, 429].includes(response.status) ? 'billing_provider_rejected' : 'billing_provider_unavailable');
    const text = await response.text();
    if (text.length > 1_048_576) throw new BillingError('billing_provider_invalid');
    try { return JSON.parse(text); } catch { throw new BillingError('billing_provider_invalid'); }
  }
  retrieveSubscription(id: string) { return this.request(`/subscriptions/${encodeURIComponent(id)}`); }
  async createCheckout(input: CheckoutInput) {
    const result = z.object({ session_id: z.string().min(1).max(200), checkout_url: hostedUrl }).safeParse(await this.request('/checkouts', 'POST', {
      product_cart: [{ product_id: input.productId, quantity: 1 }],
      customer: input.customerId ? { customer_id: input.customerId } : { email: input.email, name: input.name },
      feature_flags: { always_create_new_customer: !input.customerId, allow_customer_editing_email: false, allow_currency_selection: false },
      subscription_data: { trial_period_days: 0 },
      metadata: { aq_checkout_binding: input.binding }, return_url: input.returnUrl, cancel_url: input.returnUrl,
    }));
    if (!result.success) throw new BillingError('billing_provider_invalid');
    return { sessionId: result.data.session_id, url: result.data.checkout_url };
  }
  async createPortal(customerId: string, returnUrl: string) {
    const query = new URLSearchParams({ send_email: 'false', return_url: returnUrl });
    const result = z.object({ link: hostedUrl }).safeParse(await this.request(`/customers/${encodeURIComponent(customerId)}/customer-portal/session?${query}`, 'POST'));
    if (!result.success) throw new BillingError('billing_provider_invalid');
    return { url: result.data.link };
  }
  async checkoutSubscription(checkoutId: string) {
    const checkout = z.object({ payment_id: z.string().max(200).nullable().optional() }).safeParse(await this.request(`/checkouts/${encodeURIComponent(checkoutId)}`));
    if (!checkout.success) throw new BillingError('billing_provider_invalid');
    if (!checkout.data.payment_id) return null;
    const payment = z.object({ subscription_id: z.string().max(200).nullable().optional() }).safeParse(await this.request(`/payments/${encodeURIComponent(checkout.data.payment_id)}`));
    if (!payment.success) throw new BillingError('billing_provider_invalid');
    return payment.data.subscription_id ?? null;
  }
}

export const webhookEventSchema = z.object({
  business_id: z.string().min(1).max(200), type: z.string().min(1).max(100), timestamp: z.iso.datetime({ offset: true }),
  data: z.object({ subscription_id: z.string().min(1).max(200).nullable().optional() }).passthrough(),
});

/** Verification consumes the exact bytes preserved by the route's buffer parser. */
export function verifyBillingWebhook(raw: Buffer, headers: Record<string, unknown>, secret: string) {
  const required: Record<string, string> = {};
  for (const name of ['webhook-id', 'webhook-timestamp', 'webhook-signature']) {
    if (typeof headers[name] !== 'string' || !headers[name] || String(headers[name]).length > 2048) throw new BillingError('invalid_webhook_signature', 401);
    required[name] = String(headers[name]);
  }
  if (required['webhook-id']!.length > 200) throw new BillingError('invalid_webhook_payload', 400);
  try {
    const event = new Webhook(secret).verify(raw, required);
    const parsed = webhookEventSchema.safeParse(event);
    if (!parsed.success) throw new BillingError('invalid_webhook_payload', 400);
    if (process.env.DODO_PAYMENTS_BUSINESS_ID && parsed.data.business_id !== process.env.DODO_PAYMENTS_BUSINESS_ID) throw new BillingError('invalid_webhook_business', 401);
    return { id: required['webhook-id']!, event: parsed.data };
  } catch (error) {
    if (error instanceof BillingError) throw error;
    throw new BillingError('invalid_webhook_signature', 401);
  }
}
