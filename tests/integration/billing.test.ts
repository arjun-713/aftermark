import { randomUUID } from 'node:crypto';
import Fastify from 'fastify';
import cookie from '@fastify/cookie';
import { Pool } from 'pg';
import { SignJWT } from 'jose';
import { Webhook } from 'standardwebhooks';
import { ZodError } from 'zod';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { commerceRoutes } from '../../apps/api/src/commerce.ts';
import { ApiError } from '../../apps/api/src/errors.ts';
import { pool, tenant, rows, sql } from '../../packages/db/src/index.ts';
import { config } from '../../packages/db/src/config.ts';
import { defaultPolicy } from '../../packages/contracts/src/index.ts';
import { billingDigest, BillingError, reconcileBilling, type BillingProvider, type CheckoutInput } from '../../packages/billing/src/index.ts';

// Never run commerce fixtures against the application's shared development DB.
if (!process.env.DATABASE_URL || new URL(process.env.DATABASE_URL).pathname !== '/aq_commerce_test' || !process.env.MIGRATION_DATABASE_URL || new URL(process.env.MIGRATION_DATABASE_URL).pathname !== '/aq_commerce_test') throw new Error('Billing integration tests require the isolated aq_commerce_test database for both URLs.');
const admin = new Pool({ connectionString: process.env.MIGRATION_DATABASE_URL });
const secret = `whsec_${Buffer.from('commerce-integration-fixture-key-only').toString('base64')}`;
const iso = (days: number) => new Date(Date.now() + days * 86400000).toISOString();
const products = { starter: 'fixture_starter', team: 'fixture_team' };
const fixtureSubscription = (changes: Record<string, unknown> = {}) => ({ subscription_id: 'sub_fixture', product_id: products.team, customer: { customer_id: 'cus_fixture' }, status: 'active', previous_billing_date: iso(-5), next_billing_date: iso(25), cancel_at_next_billing_date: false, metadata: {}, quantity: 1, currency: 'USD', recurring_pre_tax_amount: 9900, payment_frequency_interval: 'Month', payment_frequency_count: 1, ...changes });
class FixtureProvider implements BillingProvider {
  productIds = products;
  environment = 'test_mode' as const;
  snapshots = new Map<string, ReturnType<typeof fixtureSubscription>>();
  checkouts: CheckoutInput[] = [];
  portalCustomers: string[] = [];
  fail = false;
  checkoutTarget: string | null = null;
  calls = 0;
  async retrieveSubscription(id: string) { this.calls++; if (this.fail) throw new BillingError('billing_provider_unavailable'); return structuredClone(this.snapshots.get(id)); }
  async createCheckout(input: CheckoutInput) { this.checkouts.push(input); if (this.fail) throw new BillingError('billing_provider_unavailable'); return { sessionId: 'cks_fixture', url: 'https://checkout.dodopayments.com/fixture' }; }
  async createPortal(customerId: string) { this.portalCustomers.push(customerId); return { url: 'https://customer.dodopayments.com/fixture' }; }
  async checkoutSubscription() { return this.checkoutTarget; }
}
const provider = new FixtureProvider();
const app = Fastify({ logger: false });
await app.register(cookie);
app.setErrorHandler((error, _request, reply) => reply.code(error instanceof ApiError ? error.status : error instanceof ZodError ? 400 : 500).send({ error: { code: error instanceof ApiError ? error.code : error instanceof ZodError ? 'invalid_request' : 'internal' } }));
await commerceRoutes(app, { provider, webhookKey: secret, sendInvitation: async () => 'not_configured' });
let org: string, otherOrg: string, project: string, policy: string, ledgerRevision: number;
let users: Record<'owner' | 'admin' | 'member' | 'viewer' | 'invitee' | 'outsider', { id: string; email: string; cookie: string }>;
async function session(id: string) {
  const token = await new SignJWT({}).setProtectedHeader({ alg: 'HS256' }).setSubject(id).setIssuer('agent-quality-local').setAudience('agent-quality').setIssuedAt().setExpirationTime('1h').sign(new TextEncoder().encode(config.SESSION_SECRET));
  return `aq_session=${token}`;
}
const request = (method: 'GET' | 'POST' | 'PATCH' | 'DELETE', url: string, payload?: unknown, user: keyof typeof users = 'owner', workspace?: string) => app.inject({ method, url, ...(payload === undefined ? {} : { payload: payload as any }), headers: { cookie: users[user].cookie, 'x-workspace-id': workspace ?? org } });
const signedEvent = (changes: Record<string, unknown> = {}, id = randomUUID()) => {
  const raw = Buffer.from(JSON.stringify({ business_id: 'fixture_business', type: 'subscription.active', timestamp: new Date().toISOString(), data: { subscription_id: 'sub_fixture', status: 'active' }, ...changes }, null, 2));
  const date = new Date();
  return { id, raw, headers: { 'content-type': 'application/json', 'webhook-id': id, 'webhook-timestamp': String(Math.floor(date.getTime() / 1000)), 'webhook-signature': new Webhook(secret).sign(id, date, raw) } };
};
const deliver = (event: ReturnType<typeof signedEvent>) => app.inject({ method: 'POST', url: '/v1/billing/webhook', payload: event.raw, headers: event.headers });
async function bindKnown(changes: Record<string, unknown> = {}) {
  const snapshot = fixtureSubscription(changes);
  provider.snapshots.set(snapshot.subscription_id, snapshot);
  await admin.query('update subscriptions set provider_id=$1,customer_id=$2,period_start=$3,period_end=$4 where organization_id=$5', [snapshot.subscription_id, snapshot.customer.customer_id, snapshot.previous_billing_date, snapshot.next_billing_date, org]);
  return snapshot;
}
async function ledger(state: 'reserved' | 'consumed' | 'ambiguous', units: number, createdAt = iso(-2)) {
  const id = randomUUID();
  await admin.query("insert into evaluations(organization_id,project_id,id,run_id,revision,policy_id,policy_hash) values($1,$2,$3,'billing-fixture',$4,$5,'fixture')", [org, project, id, ++ledgerRevision, policy]);
  await admin.query('insert into usage_ledger(organization_id,project_id,evaluation_id,state,units,created_at) values($1,$2,$3,$4,$5,$6)', [org, project, id, state, units, createdAt]);
}
beforeAll(async () => { await app.ready(); });
beforeEach(async () => {
  org = randomUUID(); otherOrg = randomUUID(); project = randomUUID(); policy = randomUUID(); ledgerRevision = 0;
  users = {} as typeof users;
  for (const role of ['owner', 'admin', 'member', 'viewer', 'invitee', 'outsider'] as const) {
    const id = randomUUID(), email = `${role}-${id}@example.test`;
    users[role] = { id, email, cookie: await session(id) };
    await admin.query('insert into users(id,email,name) values($1,$2,$3)', [id, email, `Fixture ${role}`]);
  }
  await admin.query("insert into organizations(id,name) values($1,'Commerce fixture'),($2,'Other fixture')", [org, otherOrg]);
  await admin.query("insert into subscriptions(organization_id,plan,status,allowance) values($1,'team','active',50000),($2,'trial','trialing',1000)", [org, otherOrg]);
  for (const role of ['owner', 'admin', 'member', 'viewer'] as const) await admin.query('insert into memberships values($1,$2,$3)', [org, users[role].id, role]);
  await admin.query("insert into memberships values($1,$2,'owner')", [otherOrg, users.outsider.id]);
  await admin.query("insert into projects(organization_id,id,name) values($1,$2,'Billing fixture')", [org, project]);
  await admin.query("insert into policies(organization_id,project_id,id,version,definition,hash) values($1,$2,$3,1,$4,'fixture')", [org, project, policy, defaultPolicy]);
  await admin.query("insert into runs(organization_id,project_id,id,agent_version,environment,started_at,last_event_at) values($1,$2,'billing-fixture','1','test',now(),now())", [org, project]);
  provider.snapshots.clear(); provider.checkouts = []; provider.portalCustomers = []; provider.fail = false; provider.checkoutTarget = null; provider.calls = 0;
});
afterEach(async () => {
  await admin.query('delete from evaluations where organization_id=any($1::uuid[])', [[org, otherOrg]]);
  await admin.query('delete from organizations where id=any($1::uuid[])', [[org, otherOrg]]);
  await admin.query('delete from users where id=any($1::uuid[])', [Object.values(users).map(user => user.id)]);
});
afterAll(async () => { await app.close(); await pool.end(); await admin.end(); });

describe('billing and workspace isolation', () => {
  it('keeps global billing events private and the profile helper scoped to current members', async () => {
    await expect(pool.query('select * from billing_events')).rejects.toThrow('permission denied');
    const leaked = await tenant(org, users.owner.id, tx => rows(tx, sql`select * from workspace_member_profiles(${otherOrg})`));
    expect(leaked).toEqual([]);
    expect((await request('GET', '/v1/team', undefined, 'outsider')).statusCode).toBe(403);
    const team = (await request('GET', '/v1/team')).json();
    expect(team.members).toHaveLength(4);
    expect(team.members.map((member: any) => member.email)).not.toContain(users.outsider.email);
    expect(JSON.stringify(team)).not.toContain('password_hash');
  });
  it('creates and reuses one hosted checkout while leaving entitlement unchanged until verification', async () => {
    await admin.query("update subscriptions set plan='trial',status='trialing',allowance=1000 where organization_id=$1", [org]);
    const first = await request('POST', '/v1/billing/checkout', { plan: 'starter' });
    expect(first.statusCode).toBe(200);
    expect((await request('POST', '/v1/billing/checkout', { plan: 'starter' })).json()).toMatchObject({ reused: true, url: first.json().url });
    expect((await request('POST', '/v1/billing/checkout', { plan: 'team' })).statusCode).toBe(409);
    expect(provider.checkouts).toHaveLength(1);
    expect((await request('GET', '/v1/billing')).json().subscription).toMatchObject({ plan: 'trial', allowance: 1000 });
    const snapshot = fixtureSubscription({ product_id: products.starter, recurring_pre_tax_amount: 2900, metadata: { aq_checkout_binding: provider.checkouts[0].binding } });
    provider.snapshots.set('sub_fixture', snapshot);
    expect((await deliver(signedEvent())).statusCode).toBe(200);
    expect((await request('GET', '/v1/billing')).json().subscription).toMatchObject({ plan: 'starter', status: 'active', allowance: 10000 });
  });
  it('holds an ambiguous checkout instead of issuing a second provider write', async () => {
    provider.fail = true;
    expect((await request('POST', '/v1/billing/checkout', { plan: 'starter' })).statusCode).toBe(503);
    provider.fail = false;
    expect((await request('POST', '/v1/billing/checkout', { plan: 'starter' })).statusCode).toBe(409);
    expect(provider.checkouts).toHaveLength(1);
  });
  it('binds the portal to this workspace customer and requires the current owner', async () => {
    await bindKnown();
    expect((await request('POST', '/v1/billing/portal', { customerId: 'someone_else' })).statusCode).toBe(200);
    expect(provider.portalCustomers).toEqual(['cus_fixture']);
    expect((await request('POST', '/v1/billing/portal', {}, 'admin')).statusCode).toBe(403);
    expect((await request('POST', '/v1/billing/checkout', { plan: 'starter' })).json().error.code).toBe('billing_use_portal');
  });
  it('rejects byte changes before provider reads and does not bind a forged workspace field', async () => {
    const event = signedEvent();
    const invalid = await app.inject({ method: 'POST', url: '/v1/billing/webhook', headers: event.headers, payload: Buffer.from(event.raw.toString().replace('active', 'expired')) });
    expect(invalid.statusCode).toBe(401);
    expect(provider.calls).toBe(0);
    provider.snapshots.set('sub_fixture', fixtureSubscription({ metadata: { organization_id: org, aq_checkout_binding: 'invented' } }));
    expect((await deliver(signedEvent())).json()).toMatchObject({ received: true, ignored: true });
    expect((await admin.query('select provider_id from subscriptions where organization_id=$1', [org])).rows[0].provider_id).toBeNull();
  });
  it('deduplicates repeated IDs and rejects the same ID with different signed content', async () => {
    await bindKnown();
    const event = signedEvent();
    expect((await deliver(event)).json().duplicate).toBe(false);
    expect((await deliver(event)).json().duplicate).toBe(true);
    expect((await admin.query('select count(*)::int as count from billing_events where organization_id=$1', [org])).rows[0].count).toBe(1);
    expect((await deliver(signedEvent({ type: 'subscription.cancelled' }, event.id))).statusCode).toBe(409);
    expect((await admin.query("select count(*)::int as count from audit_events where organization_id=$1 and action='billing.reconciled'", [org])).rows[0].count).toBe(1);
  });
  it('uses current provider state for reordered events, cancellation and renewal failure', async () => {
    const snapshot = await bindKnown();
    expect((await deliver(signedEvent({ type: 'subscription.cancelled', timestamp: iso(-2), data: { subscription_id: 'sub_fixture', status: 'cancelled' } }))).statusCode).toBe(200);
    expect((await request('GET', '/v1/billing')).json().subscription.status).toBe('active');
    provider.snapshots.set('sub_fixture', { ...snapshot, status: 'on_hold' });
    expect((await deliver(signedEvent({ type: 'payment.failed' }))).statusCode).toBe(200);
    expect((await request('GET', '/v1/billing')).json().subscription.status).toBe('on_hold');
    provider.snapshots.set('sub_fixture', { ...snapshot, cancel_at_next_billing_date: true });
    await deliver(signedEvent({ type: 'subscription.updated' }));
    expect((await request('GET', '/v1/billing')).json().subscription).toMatchObject({ status: 'active', cancelAtPeriodEnd: true });
    provider.snapshots.set('sub_fixture', { ...snapshot, status: 'cancelled' });
    await deliver(signedEvent({ type: 'subscription.active', timestamp: iso(-3) }));
    expect((await request('GET', '/v1/billing')).json().subscription.status).toBe('cancelled');
  });
  it('does not mint quota on a plan change and keeps consumed/reserved/ambiguous usage distinct', async () => {
    const snapshot = await bindKnown({ product_id: products.starter, recurring_pre_tax_amount: 2900 });
    await ledger('consumed', 9); await ledger('reserved', 4); await ledger('ambiguous', 2);
    provider.snapshots.set('sub_fixture', { ...snapshot, product_id: products.team, recurring_pre_tax_amount: 9900, previous_billing_date: iso(-1) });
    expect((await deliver(signedEvent({ type: 'subscription.plan_changed' }))).statusCode).toBe(200);
    const billing = (await request('GET', '/v1/billing')).json();
    expect(billing.usage).toEqual({ consumed: 9, reserved: 4, ambiguous: 2, remaining: 49985 });
    expect(new Date(billing.subscription.periodStart).toISOString()).toBe(snapshot.previous_billing_date);
    expect((await admin.query('select count(*)::int as count from usage_ledger where organization_id=$1', [org])).rows[0].count).toBe(3);
  });
  it('renews into a new provider period without deleting the previous ledger', async () => {
    const snapshot = await bindKnown({ previous_billing_date: iso(-31), next_billing_date: iso(-1) });
    await ledger('consumed', 9000, iso(-10));
    provider.snapshots.set('sub_fixture', { ...snapshot, previous_billing_date: iso(-0.5), next_billing_date: iso(29.5) });
    expect((await deliver(signedEvent({ type: 'subscription.renewed' }))).statusCode).toBe(200);
    expect((await request('GET', '/v1/billing')).json().usage).toEqual({ consumed: 0, reserved: 0, ambiguous: 0, remaining: 50000 });
    expect((await admin.query('select count(*)::int as count from usage_ledger where organization_id=$1', [org])).rows[0].count).toBe(1);
  });
  it('fails closed on unknown products and retries provider failures without losing the event', async () => {
    const snapshot = await bindKnown();
    const event = signedEvent();
    provider.fail = true;
    expect((await deliver(event)).statusCode).toBe(503);
    expect((await admin.query('select count(*)::int as count from billing_events where organization_id=$1', [org])).rows[0].count).toBe(0);
    provider.fail = false;
    provider.snapshots.set('sub_fixture', { ...snapshot, product_id: 'unmapped' });
    expect((await deliver(event)).statusCode).toBe(200);
    expect((await request('GET', '/v1/billing')).json().subscription).toMatchObject({ status: 'billing_review', allowance: 0 });
    provider.snapshots.set('sub_fixture', snapshot);
    await deliver(signedEvent());
    expect((await request('GET', '/v1/billing')).json().subscription).toMatchObject({ status: 'active', allowance: 50000 });
  });
  it('reconciles missed checkout events, expires trials and tolerates disconnected configuration', async () => {
    await request('POST', '/v1/billing/checkout', { plan: 'starter' });
    provider.snapshots.set('sub_fixture', fixtureSubscription({ metadata: { aq_checkout_binding: provider.checkouts[0].binding } }));
    provider.checkoutTarget = 'sub_fixture';
    await admin.query("update subscriptions set period_end=now()-interval '1 hour' where organization_id=$1", [otherOrg]);
    const reconciliation = await reconcileBilling(provider, { pageSize: 1 });
    expect(reconciliation).toMatchObject({ reconciled: 1, expiredTrials: 1, failed: 0 });
    expect(reconciliation.checked).toBeGreaterThanOrEqual(2);
    expect((await request('GET', '/v1/billing')).json().subscription.status).toBe('active');
    expect(await reconcileBilling(null)).toMatchObject({ reconciled: 0, disconnected: true });
  });
});

describe('team roles, invitations and retention', () => {
  it('protects self changes and owner/admin roles, then applies a demotion to the existing session', async () => {
    expect((await request('PATCH', `/v1/team/members/${users.owner.id}`, { role: 'viewer' })).json().error.code).toBe('self_membership_change');
    expect((await request('DELETE', `/v1/team/members/${users.owner.id}`, undefined, 'admin')).statusCode).toBe(403);
    expect((await request('PATCH', `/v1/team/members/${users.member.id}`, { role: 'admin' }, 'admin')).statusCode).toBe(403);
    expect((await request('POST', '/v1/team/invitations', { email: users.invitee.email, role: 'admin' }, 'admin')).statusCode).toBe(403);
    expect((await request('PATCH', `/v1/team/members/${users.admin.id}`, { role: 'viewer' })).statusCode).toBe(200);
    expect((await request('POST', '/v1/team/invitations', { email: users.invitee.email, role: 'member' }, 'admin')).statusCode).toBe(403);
    expect((await request('GET', '/v1/team', undefined, 'admin')).json().canManage).toBe(false);
    expect((await admin.query("select count(*)::int as count from memberships where organization_id=$1 and role='owner'", [org])).rows[0].count).toBe(1);
  });
  it('serializes competing owner demotions and always leaves an owner', async () => {
    await request('PATCH', `/v1/team/members/${users.member.id}`, { role: 'owner' });
    const responses = await Promise.all([
      request('PATCH', `/v1/team/members/${users.member.id}`, { role: 'viewer' }),
      request('PATCH', `/v1/team/members/${users.owner.id}`, { role: 'viewer' }, 'member'),
    ]);
    expect(responses.map(response => response.statusCode).sort()).toEqual([200, 403]);
    expect((await admin.query("select count(*)::int as count from memberships where organization_id=$1 and role='owner'", [org])).rows[0].count).toBe(1);
  });
  it('accepts a token only for its matching authenticated profile and is idempotent without role resets', async () => {
    const invitation = await request('POST', '/v1/team/invitations', { email: users.invitee.email.toUpperCase(), role: 'admin' });
    expect(invitation.statusCode).toBe(201);
    expect(invitation.json().delivery).toBe('not_configured');
    const token = new URL(invitation.json().invitationUrl).searchParams.get('invitation')!;
    expect((await request('POST', '/v1/team/invitations/accept', { token }, 'viewer')).statusCode).toBe(404);
    expect((await request('POST', '/v1/team/invitations/accept', { token }, 'invitee')).json()).toMatchObject({ organizationId: org, role: 'admin', alreadyAccepted: false });
    await request('PATCH', `/v1/team/members/${users.invitee.id}`, { role: 'viewer' });
    expect((await request('POST', '/v1/team/invitations/accept', { token }, 'invitee')).json()).toMatchObject({ role: 'viewer', alreadyAccepted: true });
    expect((await request('GET', '/v1/team', undefined, 'invitee')).json().invitations).toEqual([]);
  });
  it('reserves the last member seat atomically across concurrent invitations', async () => {
    await admin.query('delete from memberships where organization_id=$1 and user_id=any($2::uuid[])', [org, [users.admin.id, users.viewer.id]]);
    await admin.query("update subscriptions set plan='starter',allowance=10000 where organization_id=$1", [org]);
    const responses = await Promise.all([request('POST', '/v1/team/invitations', { email: users.invitee.email, role: 'member' }), request('POST', '/v1/team/invitations', { email: users.outsider.email, role: 'viewer' })]);
    expect(responses.map(response => response.statusCode).sort()).toEqual([201, 402]);
    expect((await request('GET', '/v1/team')).json().invitations).toHaveLength(1);
  });
  it('rejects revoked/expired invitations and prevents admin management of admin invitations', async () => {
    const invitation = (await request('POST', '/v1/team/invitations', { email: users.invitee.email, role: 'admin' })).json();
    const token = new URL(invitation.invitationUrl).searchParams.get('invitation')!;
    expect((await request('DELETE', `/v1/team/invitations/${invitation.id}`, undefined, 'admin')).statusCode).toBe(403);
    expect((await request('DELETE', `/v1/team/invitations/${invitation.id}`)).statusCode).toBe(200);
    expect((await request('POST', '/v1/team/invitations/accept', { token }, 'invitee')).statusCode).toBe(404);
    const next = (await request('POST', '/v1/team/invitations', { email: users.invitee.email, role: 'viewer' })).json();
    await admin.query("update team_invitations set expires_at=now()-interval '1 hour' where id=$1", [next.id]);
    expect((await request('POST', '/v1/team/invitations/accept', { token: new URL(next.invitationUrl).searchParams.get('invitation') }, 'invitee')).statusCode).toBe(404);
  });
  it('limits retention to owner-controlled 1–30 days and leaves billing usage intact', async () => {
    await bindKnown(); await ledger('consumed', 5);
    expect((await request('PATCH', '/v1/workspace/settings', { retentionDays: 7 }, 'admin')).statusCode).toBe(403);
    for (const retentionDays of [0, 31, 1.5]) expect((await request('PATCH', '/v1/workspace/settings', { retentionDays })).statusCode).toBe(400);
    expect((await request('PATCH', '/v1/workspace/settings', { retentionDays: 7 })).json()).toMatchObject({ retentionDays: 7 });
    expect((await request('GET', '/v1/workspace/settings', undefined, 'viewer')).json().retentionDays).toBe(7);
    expect((await request('GET', '/v1/billing')).json().usage.consumed).toBe(5);
  });
});
