# Workspace team and retention

All team routes use the authenticated application user ID, including the Supabase `sub` identity provisioned at sign-in. Roles are loaded from workspace membership on every request and checked again under the subscription lock for mutations. Membership changes take effect for the person's existing session on their next request. API keys cannot manage membership or billing.

Owners can invite admins, members or viewers, and can change or remove another person's membership. Admins can invite and manage members and viewers. They cannot assign admin/owner, edit an admin/owner, or manage admin invitations. Every self role change or self removal is rejected. Owner changes are serialized and the workspace must keep an owner. Lowering a paid plan never automatically removes existing members; an over-limit workspace must reduce seats before it can invite or accept another member.

Members and viewers can list their workspace directory. The scoped `workspace_member_profiles` function returns only ID, name, email and role for a workspace the current actor belongs to; it cannot read another workspace or expose password hashes. Pending invitations are visible only to owners/admins. The global `users` RLS policy remains unchanged.

Each active pending invitation reserves one member seat. Creation, acceptance and membership mutations share a subscription-row lock, preventing concurrent requests from exceeding the plan's limit. Invitations use 256-bit random tokens, store only SHA-256 digests, expire after seven days and require an authenticated profile with the exact normalized invitation email. Acceptance never uses a caller-supplied workspace or user ID. Repeating an accepted invitation preserves the current membership role; it cannot undo a later demotion or restore removed access. Revoked and expired invitations cannot be accepted.

When `RESEND_API_KEY` and `RESEND_FROM_EMAIL` are configured, the server sends a plain-text invitation through the fixed [Resend send-email API](https://resend.com/docs/api-reference/emails/send-email), with an invitation-specific idempotency key. Without them, creation returns `delivery:"not_configured"` and a one-time `invitationUrl` for manual sharing. Delivery failures leave a valid pending invitation and return `delivery:"failed"`. Listing invitations never returns the token or token digest. Local tests replace delivery with a fixture and send no email.

The authenticated API requires `x-workspace-id`, except acceptance:

| Method and path | Body | Result |
| --- | --- | --- |
| `GET /v1/team` | — | `{members,invitations,memberLimit,canManage,canAssignAdmin}` |
| `POST /v1/team/invitations` | `{email,role:"admin"|"member"|"viewer"}` | 201 with invitation and `invitationUrl` |
| `POST /v1/team/invitations/accept` | `{token}` | `{organizationId,role,alreadyAccepted}`; no workspace/project header required |
| `DELETE /v1/team/invitations/:id` | — | Revokes a pending invitation |
| `PATCH /v1/team/members/:userId` | `{role:"owner"|"admin"|"member"|"viewer"}` | Changes another member's role |
| `DELETE /v1/team/members/:userId` | — | Removes another member |
| `GET /v1/workspace/settings` | — | `{id,name,retentionDays}` |
| `PATCH /v1/workspace/settings` | `{retentionDays:1..30}` | Owner-only retention change |

Invitation links use `/app/team?invitation=TOKEN`. After sign-in, the UI submits the token to the acceptance route and selects the returned workspace. The request itself does not need an existing workspace membership. Tokens should be removed from the address bar after acceptance.

The retention setting accepts whole days from 1 through 30. It updates the trace/evaluation content retention policy and creates an audit entry. It does not clear usage, reset a subscription period, change a plan, delete a run immediately or extend the billing allowance. Content expiry and the content-free billing ledger have independent operations policies.
