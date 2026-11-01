import { randomBytes } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { tenant, rows, sql, type Tx } from '@agent-quality/db';
import { plans, type Role } from '@agent-quality/contracts';
import { config } from '../../../packages/db/src/config.ts';
import { billingConfig, billingDigest, BillingError, DodoProvider, processBillingWebhook, type BillingProvider } from '../../../packages/billing/src/index.ts';
import { authorize, userIdentity, type Identity } from './auth.ts';
import { ApiError, assert } from './errors.ts';

type InvitationMessage = { id: string; email: string; url: string; workspace: string };
export type CommerceOptions = { provider?: BillingProvider | null; webhookKey?: string; sendInvitation?: (message: InvitationMessage) => Promise<'sent' | 'failed' | 'not_configured'> };

async function actor(tx: Tx, identity: Identity, allowed?: Role[]) {
  const [subscription] = await rows<any>(tx, sql`select * from subscriptions where organization_id=${identity.organizationId} for update`);
  const [membership] = await rows<{ role: Role }>(tx, sql`select role from memberships where user_id=${identity.userId}`);
  assert(membership, 403, 'forbidden', 'You no longer have access to this workspace.');
  assert(!allowed || allowed.includes(membership.role), 403, 'forbidden', 'Your workspace role does not allow this action.');
  assert(subscription, 404, 'not_found', 'Workspace subscription not found.');
  return { role: membership.role, subscription };
}

const audit = (tx: Tx, a: Identity, action: string, id: string) => tx.execute(sql`insert into audit_events(organization_id,user_id,action,resource_id) values(${a.organizationId},${a.userId},${action},${id})`);
async function billingAction<T>(work: () => Promise<T>): Promise<T> {
  try { return await work(); } catch (error) {
    if (error instanceof BillingError) throw new ApiError(error.status, error.code, error.status === 401 ? 'Webhook authentication failed.' : error.status === 409 ? 'Billing state changed. Refresh and try again.' : 'Billing is temporarily unavailable. Please retry.');
    throw error;
  }
}

async function sendInvitation(message: InvitationMessage): Promise<'sent' | 'failed' | 'not_configured'> {
  if (!process.env.RESEND_API_KEY || !process.env.RESEND_FROM_EMAIL) return 'not_configured';
  try {
    const result = await fetch('https://api.resend.com/emails', { method: 'POST', redirect: 'error', signal: AbortSignal.timeout(8000), headers: { authorization: `Bearer ${process.env.RESEND_API_KEY}`, 'content-type': 'application/json', 'idempotency-key': `aq-team-invite-${message.id}` }, body: JSON.stringify({ from: process.env.RESEND_FROM_EMAIL, to: [message.email], subject: `Join ${message.workspace} on Agent Quality`, text: `You have been invited to ${message.workspace}. Sign in with ${message.email}, then accept your invitation:\n\n${message.url}\n\nThis invitation expires in seven days.` }) });
    return result.ok ? 'sent' : 'failed';
  } catch { return 'failed'; }
}

export async function commerceRoutes(app: FastifyInstance, options: CommerceOptions = {}) {
  const configured = billingConfig();
  const provider = options.provider === undefined ? (configured ? new DodoProvider(configured) : null) : options.provider;
  const requireProvider = () => { assert(provider, 503, 'billing_not_configured', 'Billing is not configured for this workspace.'); return provider; };
  const billingReturnUrl = `${config.WEB_ORIGIN}/app/settings/billing`;

  app.get('/v1/billing', async request => {
    const a = await authorize(request, { sessionOnly: true });
    return tenant(a.organizationId, a.userId, async tx => {
      const { role, subscription: sub } = await actor(tx, a);
      const [usage] = await rows<any>(tx, sql`select coalesce(sum(units) filter(where state='consumed'),0)::int as consumed,coalesce(sum(units) filter(where state='reserved'),0)::int as reserved,coalesce(sum(units) filter(where state='ambiguous'),0)::int as ambiguous from usage_ledger where created_at>=${sub.period_start} and created_at<${sub.period_end}`);
      return { configured: Boolean(provider), environment: provider?.environment ?? null, canManage: role === 'owner', subscription: { plan: sub.plan, status: sub.status, allowance: sub.allowance, periodStart: sub.period_start, periodEnd: sub.period_end, cancelAtPeriodEnd: sub.cancel_at_period_end, reconciledAt: sub.reconciled_at, syncError: sub.billing_sync_error }, usage: { ...usage, remaining: Math.max(0, sub.allowance - usage.consumed - usage.reserved - usage.ambiguous) }, plans, trialDays: 14, portalAvailable: Boolean(provider && sub.customer_id) };
    });
  });

  app.post('/v1/billing/checkout', async request => {
    const a = await authorize(request, { roles: ['owner'], sessionOnly: true });
    const { plan } = z.object({ plan: z.enum(['starter', 'team']) }).strict().parse(request.body);
    const client = requireProvider();
    const intent = await tenant(a.organizationId, a.userId, async tx => {
      const { subscription: sub } = await actor(tx, a, ['owner']);
      assert(!sub.provider_id, 409, 'billing_use_portal', 'Manage your existing subscription in the billing portal.');
      const [existing] = await rows<any>(tx, sql`select id,plan,status,checkout_url from billing_checkout_intents where status in('creating','ready','ambiguous') and expires_at>now() order by created_at desc limit 1`);
      if (existing) {
        assert(existing.plan === plan && existing.status === 'ready' && existing.checkout_url, 409, 'checkout_pending', 'A checkout is already pending. Reuse it or wait for it to expire.');
        return { id: existing.id as string, url: existing.checkout_url as string };
      }
      const binding = randomBytes(32).toString('base64url');
      const [record] = await rows<{ id: string }>(tx, sql`insert into billing_checkout_intents(organization_id,binding_hash,plan,status,created_by) values(${a.organizationId},${billingDigest(binding)},${plan},'creating',${a.userId}) returning id`);
      const [user] = await rows<{ email: string; name: string }>(tx, sql`select email,name from users where id=${a.userId}`);
      assert(user, 403, 'profile_required', 'Sign in again to update your account profile.');
      return { id: record.id, binding, user, customerId: sub.customer_id as string | null };
    });
    if ('url' in intent) return { checkoutId: intent.id, url: intent.url, reused: true };
    return billingAction(async () => {
      try {
        const checkout = await client.createCheckout({ productId: client.productIds[plan], binding: intent.binding, email: intent.user.email, name: intent.user.name, customerId: intent.customerId, returnUrl: billingReturnUrl });
        await tenant(a.organizationId, a.userId, async tx => {
          // The intent may already be bound by a fast webhook; never revert it.
          await tx.execute(sql`update billing_checkout_intents set status=case when status='bound' then 'bound' else 'ready' end,provider_checkout_id=${checkout.sessionId},checkout_url=case when status='bound' then null else ${checkout.url} end where id=${intent.id}`);
          await audit(tx, a, 'billing.checkout_created', intent.id);
        });
        return { checkoutId: intent.id, url: checkout.url, reused: false };
      } catch (error) {
        await tenant(a.organizationId, a.userId, tx => tx.execute(sql`update billing_checkout_intents set status=${error instanceof BillingError && error.code === 'billing_provider_rejected' ? 'rejected' : 'ambiguous'} where id=${intent.id} and status='creating'`));
        throw error;
      }
    });
  });

  app.post('/v1/billing/portal', async request => {
    const a = await authorize(request, { roles: ['owner'], sessionOnly: true });
    const client = requireProvider();
    return billingAction(() => tenant(a.organizationId, a.userId, async tx => {
      const { subscription: sub } = await actor(tx, a, ['owner']);
      assert(sub.customer_id && sub.provider_id, 409, 'billing_customer_missing', 'Complete a checkout before opening the billing portal.');
      const portal = await client.createPortal(sub.customer_id, billingReturnUrl);
      await audit(tx, a, 'billing.portal_opened', a.organizationId);
      return portal;
    }));
  });

  app.get('/v1/team', async request => {
    const a = await authorize(request, { sessionOnly: true });
    return tenant(a.organizationId, a.userId, async tx => {
      const { role, subscription } = await actor(tx, a);
      const members = await rows(tx, sql`select * from workspace_member_profiles(${a.organizationId})`);
      const invitations = ['owner', 'admin'].includes(role) ? await rows(tx, sql`select id,email,role,created_at,expires_at,delivery from team_invitations where accepted_at is null and revoked_at is null and expires_at>now() order by created_at desc`) : [];
      return { members, invitations, memberLimit: plans[subscription.plan as keyof typeof plans].members, canManage: ['owner', 'admin'].includes(role), canAssignAdmin: role === 'owner' };
    });
  });

  app.post('/v1/team/invitations', async (request, reply) => {
    const a = await authorize(request, { roles: ['owner', 'admin'], sessionOnly: true });
    const body = z.object({ email: z.email().max(254).transform(value => value.toLowerCase()), role: z.enum(['admin', 'member', 'viewer']) }).strict().parse(request.body);
    const token = randomBytes(32).toString('base64url');
    const created = await tenant(a.organizationId, a.userId, async tx => {
      const { role, subscription } = await actor(tx, a, ['owner', 'admin']);
      assert(role === 'owner' || body.role !== 'admin', 403, 'forbidden', 'Only an owner can invite an administrator.');
      const members = await rows<any>(tx, sql`select * from workspace_member_profiles(${a.organizationId})`);
      assert(!members.some(member => member.email.toLowerCase() === body.email), 409, 'already_member', 'This person is already a workspace member.');
      await tx.execute(sql`update team_invitations set revoked_at=now() where accepted_at is null and revoked_at is null and expires_at<=now()`);
      const pending = await rows<any>(tx, sql`select email from team_invitations where accepted_at is null and revoked_at is null and expires_at>now()`);
      assert(!pending.some(invite => invite.email === body.email), 409, 'invitation_exists', 'An invitation is already pending for this email.');
      assert(members.length + pending.length < plans[subscription.plan as keyof typeof plans].members, 402, 'member_limit', 'The workspace member allowance is exhausted.');
      const [invitation] = await rows<any>(tx, sql`insert into team_invitations(organization_id,email,role,token_hash,created_by) values(${a.organizationId},${body.email},${body.role},${billingDigest(token)},${a.userId}) returning id,email,role,expires_at`);
      const [workspace] = await rows<{ name: string }>(tx, sql`select name from organizations where id=${a.organizationId}`);
      await audit(tx, a, 'team.invited', invitation.id);
      return { invitation, workspace: workspace.name };
    });
    const invitationUrl = `${config.WEB_ORIGIN}/app/team?invitation=${encodeURIComponent(token)}`;
    const delivery = await (options.sendInvitation ?? sendInvitation)({ id: created.invitation.id, email: body.email, url: invitationUrl, workspace: created.workspace });
    await tenant(a.organizationId, a.userId, tx => tx.execute(sql`update team_invitations set delivery=${delivery} where id=${created.invitation.id}`));
    return reply.code(201).send({ ...created.invitation, delivery, invitationUrl });
  });

  app.post('/v1/team/invitations/accept', async request => {
    const uid = await userIdentity(request);
    const { token } = z.object({ token: z.string().min(40).max(128).regex(/^[\w-]+$/) }).strict().parse(request.body);
    const hash = billingDigest(token);
    const [target] = await tenant('', uid, tx => rows<{ organization_id: string | null }>(tx, sql`select resolve_team_invitation(${hash}) as organization_id`));
    assert(target.organization_id, 404, 'invitation_unavailable', 'This invitation is expired, revoked, or belongs to another email.');
    const org = target.organization_id;
    return tenant(org, uid, async tx => {
      const [subscription] = await rows<any>(tx, sql`select * from subscriptions where organization_id=${org} for update`);
      const [invitation] = await rows<any>(tx, sql`select * from team_invitations where token_hash=${hash} for update`);
      const [user] = await rows<{ email: string }>(tx, sql`select email from users where id=${uid}`);
      assert(invitation && user && invitation.email.toLowerCase() === user.email.toLowerCase(), 404, 'invitation_unavailable', 'This invitation is unavailable.');
      const [membership] = await rows<{ role: Role }>(tx, sql`select role from memberships where user_id=${uid}`);
      if (invitation.accepted_at) {
        assert(invitation.accepted_by === uid && membership, 409, 'invitation_used', 'This invitation was already used.');
        return { organizationId: org, role: membership.role, alreadyAccepted: true };
      }
      assert(!invitation.revoked_at && new Date(invitation.expires_at) > new Date(), 410, 'invitation_unavailable', 'This invitation has expired or was revoked.');
      if (!membership) {
        const [{ count }] = await rows<{ count: number }>(tx, sql`select count(*)::int as count from memberships`);
        assert(count < plans[subscription.plan as keyof typeof plans].members, 402, 'member_limit', 'The workspace member allowance is exhausted.');
        await tx.execute(sql`insert into memberships(organization_id,user_id,role) values(${org},${uid},${invitation.role})`);
      }
      await tx.execute(sql`update team_invitations set accepted_at=now(),accepted_by=${uid} where id=${invitation.id}`);
      await tx.execute(sql`insert into audit_events(organization_id,user_id,action,resource_id) values(${org},${uid},'team.invitation_accepted',${invitation.id})`);
      return { organizationId: org, role: membership?.role ?? invitation.role, alreadyAccepted: false };
    });
  });

  app.delete('/v1/team/invitations/:id', async request => {
    const a = await authorize(request, { roles: ['owner', 'admin'], sessionOnly: true });
    const { id } = z.object({ id: z.uuid() }).parse(request.params);
    return tenant(a.organizationId, a.userId, async tx => {
      const { role } = await actor(tx, a, ['owner', 'admin']);
      const [invitation] = await rows<{ role: Role }>(tx, sql`select role from team_invitations where id=${id} and accepted_at is null and revoked_at is null`);
      assert(invitation, 404, 'not_found', 'Pending invitation not found.');
      assert(role === 'owner' || invitation.role !== 'admin', 403, 'forbidden', 'Only an owner can revoke an administrator invitation.');
      await tx.execute(sql`update team_invitations set revoked_at=now() where id=${id}`);
      await audit(tx, a, 'team.invitation_revoked', id);
      return { ok: true };
    });
  });

  const changeMember = async (a: Identity, userId: string, newRole: Role | null) => tenant(a.organizationId, a.userId, async tx => {
    const { role } = await actor(tx, a, ['owner', 'admin']);
    assert(userId !== a.userId, 409, 'self_membership_change', 'Ask another owner or administrator to change your membership.');
    const [member] = await rows<{ role: Role }>(tx, sql`select role from memberships where user_id=${userId} for update`);
    assert(member, 404, 'not_found', 'Workspace member not found.');
    assert(role === 'owner' || !['owner', 'admin'].includes(member.role) && (!newRole || ['member', 'viewer'].includes(newRole)), 403, 'forbidden', 'Only an owner can change an owner or administrator role.');
    if (member.role === 'owner' && newRole !== 'owner') {
      const [{ count }] = await rows<{ count: number }>(tx, sql`select count(*)::int as count from memberships where role='owner'`);
      assert(count > 1, 409, 'last_owner', 'The workspace must keep at least one owner.');
    }
    if (newRole) await tx.execute(sql`update memberships set role=${newRole} where user_id=${userId}`);
    else await tx.execute(sql`delete from memberships where user_id=${userId}`);
    await audit(tx, a, newRole ? 'team.role_changed' : 'team.member_removed', userId);
    return { ok: true };
  });

  app.patch('/v1/team/members/:userId', async request => {
    const a = await authorize(request, { roles: ['owner', 'admin'], sessionOnly: true });
    const { userId } = z.object({ userId: z.uuid() }).parse(request.params);
    const { role } = z.object({ role: z.enum(['owner', 'admin', 'member', 'viewer']) }).strict().parse(request.body);
    return changeMember(a, userId, role);
  });
  app.delete('/v1/team/members/:userId', async request => {
    const a = await authorize(request, { roles: ['owner', 'admin'], sessionOnly: true });
    const { userId } = z.object({ userId: z.uuid() }).parse(request.params);
    return changeMember(a, userId, null);
  });

  app.get('/v1/workspace/settings', async request => {
    const a = await authorize(request, { sessionOnly: true });
    return tenant(a.organizationId, a.userId, async tx => {
      await actor(tx, a);
      const [workspace] = await rows(tx, sql`select id,name,retention_days as "retentionDays" from organizations where id=${a.organizationId}`);
      return workspace;
    });
  });
  app.patch('/v1/workspace/settings', async request => {
    const a = await authorize(request, { roles: ['owner'], sessionOnly: true });
    const { retentionDays } = z.object({ retentionDays: z.number().int().min(1).max(30) }).strict().parse(request.body);
    return tenant(a.organizationId, a.userId, async tx => {
      await actor(tx, a, ['owner']);
      const [workspace] = await rows(tx, sql`update organizations set retention_days=${retentionDays} where id=${a.organizationId} returning id,name,retention_days as "retentionDays"`);
      await audit(tx, a, 'workspace.retention_changed', a.organizationId);
      return workspace;
    });
  });

  // An encapsulated parser preserves exact bytes without changing other JSON APIs.
  await app.register(async webhook => {
    webhook.removeContentTypeParser('application/json');
    webhook.addContentTypeParser('application/json', { parseAs: 'buffer', bodyLimit: 262144 }, (_request, body, done) => done(null, body));
    webhook.post('/v1/billing/webhook', async request => {
      const client = requireProvider();
      const secret = options.webhookKey ?? process.env.DODO_PAYMENTS_WEBHOOK_KEY;
      assert(secret, 503, 'billing_not_configured', 'Billing webhooks are not configured.');
      assert(Buffer.isBuffer(request.body), 400, 'invalid_webhook_payload', 'Webhook body is invalid.');
      return billingAction(() => processBillingWebhook(request.body as Buffer, request.headers, client, secret));
    });
  });
}
