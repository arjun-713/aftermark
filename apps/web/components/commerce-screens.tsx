"use client";

import { useEffect, useRef, useState, type CSSProperties } from "react";
import Link from "next/link";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowUpRight, RotateCw, UserPlus } from "lucide-react";
import { api, json, when, RequestError } from "../lib/api";
import { useScope } from "./app-shell";
import {
  Badge,
  CopyButton,
  Empty,
  ErrorState,
  Loading,
  Modal,
  PageHeader,
} from "./ui";

type Role = "owner" | "admin" | "member" | "viewer";
type Plan = "trial" | "starter" | "team";
type PlanDetails = {
  price: number;
  allowance: number;
  projects: number;
  members: number;
};
type Billing = {
  configured: boolean;
  environment: "test_mode" | "live_mode" | null;
  canManage: boolean;
  portalAvailable: boolean;
  trialDays: number;
  plans: Record<Plan, PlanDetails>;
  subscription: {
    plan: Plan;
    status: string;
    allowance: number;
    periodStart: string;
    periodEnd: string;
    cancelAtPeriodEnd: boolean;
    reconciledAt: string | null;
    syncError: string | null;
  };
  usage: {
    consumed: number;
    reserved: number;
    ambiguous: number;
    remaining: number;
  };
};
type Member = { id: string; name: string; email: string; role: Role };
type Invitation = {
  id: string;
  email: string;
  role: Exclude<Role, "owner">;
  created_at: string;
  expires_at: string;
  delivery: "sent" | "failed" | "not_configured";
};
type Team = {
  members: Member[];
  invitations: Invitation[];
  memberLimit: number;
  canManage: boolean;
  canAssignAdmin: boolean;
};
type CreatedInvitation = Invitation & { invitationUrl: string };
type WorkspaceSettings = { id: string; name: string; retentionDays: number };
type TeamChange = { workspaceId: string } & (
  | { kind: "role"; member: Member; role: Role }
  | { kind: "remove"; member: Member }
  | { kind: "revoke"; invitation: Invitation }
);
const numberCell: CSSProperties = {
  textAlign: "right",
  fontVariantNumeric: "tabular-nums",
};
const inlineActions: CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 8,
  flexWrap: "wrap",
};
const titleCase = (value: string) =>
  value.charAt(0).toUpperCase() + value.slice(1).replaceAll("_", " ");
const count = (value: number) => value.toLocaleString();
const message = (error: unknown) =>
  error instanceof Error
    ? error.message
    : "The change could not be saved. Please try again.";
const date = (value: string) =>
  new Date(value).toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    year: "numeric",
  });

function SettingsTabs({
  current,
}: {
  current: "team" | "billing" | "retention";
}) {
  return (
    <nav className="tabs settings-tabs" aria-label="Workspace settings">
      {(
        [
          ["keys", "API keys"],
          ["team", "Team"],
          ["billing", "Usage & billing"],
          ["retention", "Retention"],
        ] as const
      ).map(([id, label]) => (
        <Link
          href={`/app/settings/${id}`}
          className={current === id ? "selected" : ""}
          aria-current={current === id ? "page" : undefined}
          key={id}
        >
          {label}
        </Link>
      ))}
    </nav>
  );
}

function redirectToBilling(url: string) {
  const parsed = new URL(url);
  if (
    parsed.protocol !== "https:" ||
    !(
      parsed.hostname === "dodopayments.com" ||
      parsed.hostname.endsWith(".dodopayments.com")
    )
  )
    throw new Error(
      "The billing provider returned an invalid link. Refresh and try again.",
    );
  window.location.assign(parsed.href);
}

export function BillingSettings() {
  const s = useScope();
  const client = useQueryClient();
  const [plan, setPlan] = useState<"starter" | "team">("starter");
  const [returned, setReturned] = useState(false);
  const [waiting, setWaiting] = useState(false);
  const billingWorkspace = useRef(s.workspaceId);
  useEffect(() => {
    const url = new URL(window.location.href);
    if (
      !["payment_id", "subscription_id", "status"].some((key) =>
        url.searchParams.has(key),
      )
    )
      return;
    setReturned(true);
    setWaiting(true);
    for (const key of [
      "payment_id",
      "subscription_id",
      "status",
      "license_key",
      "email",
    ])
      url.searchParams.delete(key);
    window.history.replaceState(
      window.history.state,
      "",
      `${url.pathname}${url.search}${url.hash}`,
    );
    const timeout = window.setTimeout(() => setWaiting(false), 75000);
    return () => window.clearTimeout(timeout);
  }, []);
  const billing = useQuery<Billing>({
    queryKey: ["billing", s.workspaceId],
    queryFn: () => api("/billing", s.workspaceId),
    enabled: !!s.workspaceId,
    refetchInterval: waiting ? 3000 : false,
  });
  useEffect(() => {
    if (
      billing.data?.subscription.status === "active" &&
      billing.data.subscription.plan !== "trial"
    )
      setWaiting(false);
  }, [billing.data?.subscription.status, billing.data?.subscription.plan]);
  const payment = useMutation({
    mutationFn: async (action: "checkout" | "portal") => {
      const result = await api<{ url: string }>(
        `/billing/${action}`,
        s.workspaceId,
        {
          method: "POST",
          ...(action === "checkout" ? { body: json({ plan }) } : {}),
        },
      );
      redirectToBilling(result.url);
    },
    onError: () => {
      void client.invalidateQueries({ queryKey: ["billing", s.workspaceId] });
    },
  });
  useEffect(() => {
    if (billingWorkspace.current === s.workspaceId) return;
    billingWorkspace.current = s.workspaceId;
    payment.reset();
    setReturned(false);
    setWaiting(false);
  }, [s.workspaceId]);
  const data = billing.data;
  const sub = data?.subscription;
  const permitted = data?.canManage && s.role === "owner";
  const active =
    sub &&
    ["active", "trialing"].includes(sub.status) &&
    Date.parse(sub.periodEnd) > Date.now();
  const totalHeld = data ? data.usage.reserved + data.usage.ambiguous : 0;
  const accounted = data ? data.usage.consumed + totalHeld : 0;
  const refresh = (
    <button
      className="btn secondary"
      onClick={() => billing.refetch()}
      disabled={billing.isFetching}
    >
      <RotateCw size={14} />
      {billing.isFetching ? "Refreshing…" : "Refresh"}
    </button>
  );
  return (
    <>
      <PageHeader
        title="Usage & billing"
        description="Evaluation allowance and payment management for this workspace."
        action={refresh}
      />
      <SettingsTabs current="billing" />
      {billing.isPending ? (
        <Loading rows={5} />
      ) : billing.error ? (
        <ErrorState error={billing.error} retry={() => billing.refetch()} />
      ) : data && sub ? (
        <>
          {returned && (
            <p className="quiet-notice" role="status">
              {waiting
                ? "Checking your payment confirmation. Access updates after the payment provider confirms your subscription."
                : active && sub.plan !== "trial"
                  ? "Your subscription is confirmed. The allowance below is ready to use."
                  : "Payment confirmation is still pending. Refresh in a moment or contact your workspace owner if your payment completed."}
            </p>
          )}
          {!active && (
            <p className="quiet-notice" role="status">
              {sub.status === "billing_review"
                ? "Your billing details need attention. New evaluations are paused until the subscription is verified."
                : `New evaluations are paused because this subscription is ${Date.parse(sub.periodEnd) <= Date.now() ? "past its period end" : sub.status.replaceAll("_", " ")}.`}
            </p>
          )}
          <div className="metric-strip" style={{ marginBottom: 20 }}>
            <div>
              <span>Evaluations remaining</span>
              <strong>{count(data.usage.remaining)}</strong>
              <p>
                {active
                  ? `Available until ${date(sub.periodEnd)}`
                  : "Allowance available after reactivation"}
              </p>
            </div>
            <div>
              <span>Consumed this period</span>
              <strong style={{ fontSize: 24 }}>
                {count(data.usage.consumed)}
              </strong>
              <p>Completed evaluation units</p>
            </div>
            <div>
              <span>Held for evaluations</span>
              <strong style={{ fontSize: 24 }}>{count(totalHeld)}</strong>
              <p>
                {count(data.usage.reserved)} reserved ·{" "}
                {count(data.usage.ambiguous)} awaiting reconciliation
              </p>
            </div>
          </div>
          <section className="settings-row" style={{ padding: "24px 0" }}>
            <div>
              <h2>{titleCase(sub.plan)} plan</h2>
              <p>
                {date(sub.periodStart)} – {date(sub.periodEnd)}. Each evaluation
                consumes one unit; model token usage is tracked separately.
              </p>
              {sub.cancelAtPeriodEnd && (
                <p>
                  Cancellation is scheduled for the period end. Access continues
                  until {date(sub.periodEnd)} while the subscription is active.
                </p>
              )}
            </div>
            <div className="settings-panel">
              <div
                style={{ ...inlineActions, justifyContent: "space-between" }}
              >
                <Badge
                  value={
                    sub.status === "active" || sub.status === "trialing"
                      ? "connected"
                      : sub.status === "billing_review"
                        ? "review"
                        : "unknown"
                  }
                  label={titleCase(sub.status)}
                />
                {data.environment === "test_mode" && (
                  <span className="muted small">Test billing</span>
                )}
              </div>
              <p>
                <strong>{count(accounted)}</strong> of {count(sub.allowance)}{" "}
                evaluations consumed or held.
              </p>
              <div
                className="quota-track"
                role="meter"
                aria-label="Evaluation allowance used or held"
                aria-valuemin={0}
                aria-valuemax={Math.max(1, sub.allowance)}
                aria-valuenow={Math.min(accounted, Math.max(1, sub.allowance))}
                aria-valuetext={`${count(data.usage.consumed)} consumed, ${count(data.usage.reserved)} reserved, ${count(data.usage.ambiguous)} awaiting reconciliation, ${count(data.usage.remaining)} remaining`}
                style={{ display: "flex" }}
              >
                {[
                  { units: data.usage.consumed, opacity: 1 },
                  { units: data.usage.reserved, opacity: 0.5 },
                  { units: data.usage.ambiguous, opacity: 0.25 },
                ].map((segment, index) => (
                  <span
                    key={index}
                    style={{
                      width: `${sub.allowance > 0 ? Math.min(100, (segment.units / sub.allowance) * 100) : 0}%`,
                      opacity: segment.opacity,
                      flexShrink: 1,
                    }}
                  />
                ))}
              </div>
              <p className="muted">
                Reservations and requests with uncertain outcomes remain held.
                Both count toward the evaluation limit.
              </p>
              {sub.reconciledAt && (
                <p className="muted">
                  Payment status checked {when(sub.reconciledAt)}.
                </p>
              )}
            </div>
          </section>
          <section className="settings-row" style={{ padding: "24px 0" }}>
            <div>
              <h2>Payment management</h2>
              <p>
                {sub.plan === "trial"
                  ? `Your ${data.trialDays}-day trial has a fixed evaluation allowance. Choose a paid plan to continue after it ends.`
                  : "Manage payment details, plan changes and cancellation in the billing portal. Your confirmed subscription controls evaluation access."}
              </p>
              {!permitted && <p>Only a workspace owner can manage payments.</p>}
            </div>
            <div className="settings-panel">
              {!data.configured ? (
                <>
                  <Badge value="disconnected" label="Billing disconnected" />
                  <p>
                    Payments are unavailable until billing setup is complete.
                    Your current allowance and period end still apply.
                  </p>
                </>
              ) : data.portalAvailable ? (
                <>
                  <h3>Customer billing portal</h3>
                  <p>
                    Review payment details or change your plan. Updated
                    allowance appears after your subscription change is
                    confirmed.
                  </p>
                  <button
                    className="btn primary"
                    disabled={!permitted || payment.isPending}
                    onClick={() => payment.mutate("portal")}
                  >
                    {payment.isPending
                      ? "Opening portal…"
                      : "Manage subscription"}
                    <ArrowUpRight size={14} />
                  </button>
                </>
              ) : (
                <form
                  onSubmit={(event) => {
                    event.preventDefault();
                    payment.mutate("checkout");
                  }}
                >
                  <label htmlFor="billing-plan">Monthly plan</label>
                  <select
                    id="billing-plan"
                    value={plan}
                    onChange={(event) =>
                      setPlan(event.target.value as "starter" | "team")
                    }
                    disabled={!permitted || payment.isPending}
                  >
                    {(["starter", "team"] as const).map((name) => (
                      <option key={name} value={name}>
                        {titleCase(name)} · ${data.plans[name].price}/month ·{" "}
                        {count(data.plans[name].allowance)} evaluations
                      </option>
                    ))}
                  </select>
                  <p className="small muted" style={{ marginTop: 12 }}>
                    The hosted checkout shows your payment total before you
                    subscribe. Opening checkout does not change this workspace’s
                    allowance.
                  </p>
                  <div className="form-footer">
                    <span className="muted small">USD · monthly billing</span>
                    <button
                      className="btn primary"
                      type="submit"
                      disabled={!permitted || payment.isPending}
                    >
                      {payment.isPending
                        ? "Opening checkout…"
                        : "Continue to checkout"}
                      <ArrowUpRight size={14} />
                    </button>
                  </div>
                </form>
              )}
              {payment.error && (
                <p className="form-error" role="alert">
                  {message(payment.error)}
                </p>
              )}
            </div>
          </section>
          <section style={{ marginTop: 28 }} aria-labelledby="plan-limits">
            <div className="section-heading">
              <h2 id="plan-limits">Plan allowances</h2>
              <span className="muted small">
                Hard limits · no automatic overage charges
              </span>
            </div>
            <div className="table-frame">
              <table className="data-table">
                <thead>
                  <tr>
                    <th>Plan</th>
                    <th style={numberCell}>Price</th>
                    <th style={numberCell}>Evaluations</th>
                    <th style={numberCell}>Members</th>
                    <th style={numberCell}>Projects</th>
                  </tr>
                </thead>
                <tbody>
                  {(["trial", "starter", "team"] as const).map((name) => (
                    <tr key={name}>
                      <td>
                        <span style={inlineActions}>
                          {titleCase(name)}
                          {name === sub.plan && (
                            <span className="neutral-tag">Current</span>
                          )}
                        </span>
                      </td>
                      <td style={numberCell}>
                        {name === "trial"
                          ? `${data.trialDays} days free`
                          : `$${data.plans[name].price}/month`}
                      </td>
                      <td style={numberCell}>
                        {count(data.plans[name].allowance)}
                      </td>
                      <td style={numberCell}>
                        {count(data.plans[name].members)}
                      </td>
                      <td style={numberCell}>
                        {count(data.plans[name].projects)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>
        </>
      ) : null}
    </>
  );
}

export function TeamSettings() {
  const s = useScope();
  const client = useQueryClient();
  const workspaceRef = useRef(s.workspaceId);
  workspaceRef.current = s.workspaceId;
  const team = useQuery<Team>({
    queryKey: ["team", s.workspaceId],
    queryFn: () => api("/team", s.workspaceId),
    enabled: !!s.workspaceId,
  });
  const [inviteOpen, setInviteOpen] = useState(false);
  const [email, setEmail] = useState("");
  const [inviteRole, setInviteRole] = useState<"admin" | "member" | "viewer">(
    "member",
  );
  const [created, setCreated] = useState<CreatedInvitation | null>(null);
  const [change, setChange] = useState<TeamChange | null>(null);
  const invite = useMutation({
    gcTime: 0,
    mutationFn: (input: {
      workspaceId: string;
      email: string;
      role: typeof inviteRole;
    }) =>
      api<CreatedInvitation>("/team/invitations", input.workspaceId, {
        method: "POST",
        body: json({ email: input.email, role: input.role }),
      }),
    onSuccess: (data, input) => {
      if (workspaceRef.current === input.workspaceId) {
        setCreated(data);
        setEmail("");
      }
      void client.invalidateQueries({ queryKey: ["team", input.workspaceId] });
    },
  });
  const update = useMutation({
    mutationFn: (input: TeamChange) =>
      input.kind === "revoke"
        ? api(`/team/invitations/${input.invitation.id}`, input.workspaceId, {
            method: "DELETE",
          })
        : api(`/team/members/${input.member.id}`, input.workspaceId, {
            method: input.kind === "role" ? "PATCH" : "DELETE",
            ...(input.kind === "role"
              ? { body: json({ role: input.role }) }
              : {}),
          }),
    onSuccess: (_data, input) => {
      if (workspaceRef.current === input.workspaceId) {
        setChange(null);
        s.notify(
          input.kind === "role"
            ? "Workspace role updated."
            : input.kind === "remove"
              ? "Workspace access removed."
              : "Invitation revoked.",
        );
      }
      void client.invalidateQueries({ queryKey: ["team", input.workspaceId] });
      void client.invalidateQueries({ queryKey: ["me"] });
    },
    onError: (_error, input) => {
      void client.invalidateQueries({ queryKey: ["team", input.workspaceId] });
    },
  });
  useEffect(() => {
    setInviteOpen(false);
    setCreated(null);
    setEmail("");
    setInviteRole("member");
    setChange(null);
    invite.reset();
    update.reset();
  }, [s.workspaceId]);
  const closeInvite = (open: boolean) => {
    if (invite.isPending) return;
    setInviteOpen(open);
    if (!open) {
      setCreated(null);
      setEmail("");
      invite.reset();
    }
  };
  const data = team.data;
  const seats = data ? data.members.length + data.invitations.length : 0;
  const full = data ? seats >= data.memberLimit : false;
  const owners =
    data?.members.filter((member) => member.role === "owner").length ?? 0;
  const openChange = (value: TeamChange) => {
    update.reset();
    setChange(value);
  };
  return (
    <>
      <PageHeader
        title="Team"
        description={
          data
            ? `${count(data.members.length)} ${data.members.length === 1 ? "member" : "members"} · ${count(data.invitations.length)} pending ${data.invitations.length === 1 ? "invitation" : "invitations"} · ${count(data.memberLimit)} seats on your plan.`
            : "People and permissions in this workspace."
        }
        action={
          data?.canManage ? (
            <button
              className="btn primary"
              onClick={() => {
                setCreated(null);
                invite.reset();
                setInviteOpen(true);
              }}
              disabled={full}
            >
              <UserPlus size={14} />
              Invite member
            </button>
          ) : undefined
        }
      />
      <SettingsTabs current="team" />
      {team.isPending ? (
        <Loading rows={5} />
      ) : team.error ? (
        <ErrorState error={team.error} retry={() => team.refetch()} />
      ) : data ? (
        <>
          {full && (
            <p className="quiet-notice">
              {seats > data.memberLimit
                ? "This workspace is above its member allowance."
                : "All member seats are in use or reserved."}{" "}
              Revoke a pending invitation, remove a member or change your plan
              before inviting someone else. Existing members keep their access.
            </p>
          )}
          {!data.canManage && (
            <p className="quiet-notice">
              You can view workspace members. An owner or administrator can
              manage invitations and access.
            </p>
          )}
          <div className="table-frame">
            <table className="data-table">
              <thead>
                <tr>
                  <th>Workspace member</th>
                  <th>Role</th>
                  <th>Access</th>
                </tr>
              </thead>
              <tbody>
                {data.members.map((member) => {
                  const self = member.id === s.user?.id;
                  const editable =
                    data.canManage &&
                    !self &&
                    (data.canAssignAdmin ||
                      !["owner", "admin"].includes(member.role));
                  const lastOwner = member.role === "owner" && owners <= 1;
                  return (
                    <tr key={member.id}>
                      <td>
                        <div className="identity-cell">
                          <strong>
                            {member.name}
                            {self ? " (you)" : ""}
                          </strong>
                          <span
                            className="muted"
                            style={{ overflowWrap: "anywhere" }}
                          >
                            {member.email}
                          </span>
                        </div>
                      </td>
                      <td>
                        {editable && !lastOwner ? (
                          <select
                            aria-label={`Role for ${member.name}`}
                            value={member.role}
                            onChange={(event) =>
                              openChange({
                                kind: "role",
                                workspaceId: s.workspaceId,
                                member,
                                role: event.target.value as Role,
                              })
                            }
                            style={{
                              width: "auto",
                              minWidth: 100,
                              marginBottom: 0,
                            }}
                          >
                            {(data.canAssignAdmin
                              ? ["owner", "admin", "member", "viewer"]
                              : ["member", "viewer"]
                            ).map((role) => (
                              <option value={role} key={role}>
                                {titleCase(role)}
                              </option>
                            ))}
                          </select>
                        ) : (
                          titleCase(member.role)
                        )}
                      </td>
                      <td>
                        {editable && !lastOwner ? (
                          <button
                            className="btn text-button small"
                            style={{ color: "var(--negative)" }}
                            onClick={() =>
                              openChange({
                                kind: "remove",
                                workspaceId: s.workspaceId,
                                member,
                              })
                            }
                          >
                            Remove
                          </button>
                        ) : (
                          <span className="muted small">
                            {self
                              ? "Your account"
                              : lastOwner
                                ? "Last owner"
                                : "Owner managed"}
                          </span>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          {data.canManage && (
            <section
              style={{ marginTop: 32 }}
              aria-labelledby="pending-invitations"
            >
              <div className="section-heading">
                <h2 id="pending-invitations">Pending invitations</h2>
                <span className="muted small">
                  Each invitation reserves a seat
                </span>
              </div>
              {!data.invitations.length ? (
                <Empty title="No pending invitations">
                  Invite a teammate to give them access to this workspace.
                </Empty>
              ) : (
                <div className="table-frame">
                  <table className="data-table">
                    <thead>
                      <tr>
                        <th>Email</th>
                        <th>Role</th>
                        <th>Delivery</th>
                        <th>Expires</th>
                        <th />
                      </tr>
                    </thead>
                    <tbody>
                      {data.invitations.map((invitation) => (
                        <tr key={invitation.id}>
                          <td>{invitation.email}</td>
                          <td>{titleCase(invitation.role)}</td>
                          <td>
                            <Badge
                              value={
                                invitation.delivery === "sent"
                                  ? "connected"
                                  : "unknown"
                              }
                              label={
                                invitation.delivery === "sent"
                                  ? "Email sent"
                                  : invitation.delivery === "failed"
                                    ? "Email failed"
                                    : "Share link manually"
                              }
                            />
                          </td>
                          <td>{date(invitation.expires_at)}</td>
                          <td>
                            {data.canAssignAdmin ||
                            invitation.role !== "admin" ? (
                              <button
                                className="btn text-button small"
                                onClick={() =>
                                  openChange({
                                    kind: "revoke",
                                    workspaceId: s.workspaceId,
                                    invitation,
                                  })
                                }
                              >
                                Revoke
                              </button>
                            ) : (
                              <span className="muted small">Owner managed</span>
                            )}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </section>
          )}
          <section className="settings-row">
            <div>
              <h2>Workspace roles</h2>
              <p>
                Role changes apply to the person’s next request, including an
                existing signed-in session. Ask another owner to change your own
                role.
              </p>
            </div>
            <div className="settings-panel">
              <dl style={{ display: "grid", gap: 12 }}>
                {[
                  [
                    "Owner",
                    "Workspace access, billing and retention settings.",
                  ],
                  [
                    "Admin",
                    "Members, viewers and day-to-day workspace administration.",
                  ],
                  [
                    "Member",
                    "Agent runs, evaluation work and review decisions.",
                  ],
                  ["Viewer", "Read access to workspace runs and results."],
                ].map(([role, text]) => (
                  <div key={role}>
                    <dt style={{ fontWeight: 500, fontSize: 12 }}>{role}</dt>
                    <dd className="muted small" style={{ margin: "3px 0 0" }}>
                      {text}
                    </dd>
                  </div>
                ))}
              </dl>
            </div>
          </section>
        </>
      ) : null}
      <Modal
        open={inviteOpen}
        onOpenChange={closeInvite}
        title={created ? "Invitation ready" : "Invite a teammate"}
        description={
          created
            ? `Invitation for ${created.email}. It expires ${date(created.expires_at)}.`
            : "Choose an email and workspace role. The invitation reserves one member seat for seven days."
        }
      >
        {created ? (
          <>
            <p className="quiet-notice">
              {created.delivery === "sent"
                ? "The invitation email has been sent. You can also copy the invitation link below."
                : created.delivery === "failed"
                  ? "The invitation was saved, but its email could not be sent. Copy this link and share it with your teammate."
                  : "Email delivery is unavailable. Copy this link and share it with your teammate."}
            </p>
            <label htmlFor="invitation-link">Invitation link</label>
            <div className="secret-display">
              <code id="invitation-link">{created.invitationUrl}</code>
              <CopyButton
                value={created.invitationUrl}
                label="Copy invitation"
              />
            </div>
            <p className="muted small">
              This link is shown once. After closing, revoke this invitation and
              create another if you need a new link.
            </p>
            <div className="form-footer">
              <span className="muted small">
                {titleCase(created.role)} access
              </span>
              <button
                className="btn primary"
                onClick={() => closeInvite(false)}
              >
                Done
              </button>
            </div>
          </>
        ) : (
          <form
            onSubmit={(event) => {
              event.preventDefault();
              invite.mutate({
                workspaceId: s.workspaceId,
                email,
                role: inviteRole,
              });
            }}
          >
            <div className="form-two">
              <div>
                <label htmlFor="invitation-email">Email address</label>
                <input
                  id="invitation-email"
                  type="email"
                  autoComplete="email"
                  required
                  maxLength={254}
                  value={email}
                  onChange={(event) => setEmail(event.target.value)}
                  disabled={invite.isPending}
                />
              </div>
              <div>
                <label htmlFor="invitation-role">Workspace role</label>
                <select
                  id="invitation-role"
                  value={inviteRole}
                  onChange={(event) =>
                    setInviteRole(event.target.value as typeof inviteRole)
                  }
                  disabled={invite.isPending}
                >
                  {(data?.canAssignAdmin
                    ? ["member", "viewer", "admin"]
                    : ["member", "viewer"]
                  ).map((role) => (
                    <option key={role} value={role}>
                      {titleCase(role)}
                    </option>
                  ))}
                </select>
              </div>
            </div>
            <p className="muted small" style={{ marginTop: 16 }}>
              They will sign in with this email before accepting. Members can
              work with evaluations; viewers have read access.
            </p>
            {invite.error && (
              <p className="form-error" role="alert">
                {message(invite.error)}
              </p>
            )}
            <div className="form-footer">
              <button
                type="button"
                className="btn secondary"
                onClick={() => closeInvite(false)}
                disabled={invite.isPending}
              >
                Cancel
              </button>
              <button
                className="btn primary"
                type="submit"
                disabled={invite.isPending || full}
              >
                {invite.isPending
                  ? "Creating invitation…"
                  : "Create invitation"}
              </button>
            </div>
          </form>
        )}
      </Modal>
      <Modal
        open={!!change}
        onOpenChange={(open) => {
          if (!open && !update.isPending) setChange(null);
        }}
        title={
          change?.kind === "role"
            ? `Change role to ${titleCase(change.role)}?`
            : change?.kind === "revoke"
              ? "Revoke this invitation?"
              : "Remove workspace access?"
        }
        description={
          change?.kind === "role"
            ? `${change.member.email} will receive ${change.role} permissions on their next request. Their existing session remains signed in.`
            : change?.kind === "revoke"
              ? `The invitation for ${change.invitation.email} will stop working and its reserved seat will be released.`
              : change
                ? `${change.member.email} will lose access to this workspace immediately. Their account and other workspaces are kept.`
                : ""
        }
      >
        {update.error && (
          <p className="form-error" role="alert">
            {message(update.error)}
          </p>
        )}
        <div className="form-footer">
          <button
            className="btn secondary"
            onClick={() => setChange(null)}
            disabled={update.isPending}
          >
            Cancel
          </button>
          <button
            className={`btn ${change?.kind === "role" ? "primary" : "danger"}`}
            onClick={() => change && update.mutate(change)}
            disabled={update.isPending}
          >
            {update.isPending
              ? "Saving…"
              : change?.kind === "role"
                ? "Change role"
                : change?.kind === "revoke"
                  ? "Revoke invitation"
                  : "Remove member"}
          </button>
        </div>
      </Modal>
    </>
  );
}

export function RetentionSettings() {
  const s = useScope();
  const client = useQueryClient();
  const settings = useQuery<WorkspaceSettings>({
    queryKey: ["workspace-settings", s.workspaceId],
    queryFn: () => api("/workspace/settings", s.workspaceId),
    enabled: !!s.workspaceId,
  });
  const [days, setDays] = useState("");
  const [confirm, setConfirm] = useState(false);
  useEffect(() => {
    setDays(settings.data ? String(settings.data.retentionDays) : "");
    setConfirm(false);
  }, [settings.data?.retentionDays, s.workspaceId]);
  const save = useMutation({
    mutationFn: (input: { workspaceId: string; retentionDays: number }) =>
      api<WorkspaceSettings>("/workspace/settings", input.workspaceId, {
        method: "PATCH",
        body: json({ retentionDays: input.retentionDays }),
      }),
    onSuccess: (data, input) => {
      client.setQueryData(["workspace-settings", input.workspaceId], data);
      setConfirm(false);
      s.notify(
        `Trace retention saved: ${data.retentionDays} ${data.retentionDays === 1 ? "day" : "days"}.`,
      );
    },
  });
  useEffect(() => {
    save.reset();
    setConfirm(false);
  }, [s.workspaceId]);
  const valid = /^\d+$/.test(days) && Number(days) >= 1 && Number(days) <= 30;
  const dirty = settings.data && Number(days) !== settings.data.retentionDays;
  const owner = s.role === "owner";
  const commit = () =>
    save.mutate({ workspaceId: s.workspaceId, retentionDays: Number(days) });
  return (
    <>
      <PageHeader
        title="Retention"
        description="Control how long detailed agent traces remain available in this workspace."
      />
      <SettingsTabs current="retention" />
      {settings.isPending ? (
        <Loading rows={4} />
      ) : settings.error ? (
        <ErrorState error={settings.error} retry={() => settings.refetch()} />
      ) : settings.data ? (
        <section className="settings-row">
          <div>
            <h2>Trace content retention</h2>
            <p>
              Keep detailed trace and evaluation content for 1–30 days. A
              shorter period makes older content eligible to expire.
            </p>
            <p>
              Evaluation usage and your billing period are tracked separately.
              Changing retention does not restore evaluation units.
            </p>
            {!owner && <p>Only a workspace owner can change retention.</p>}
          </div>
          <div className="settings-panel">
            <form
              onSubmit={(event) => {
                event.preventDefault();
                if (!valid || !owner || !dirty) return;
                save.reset();
                if (Number(days) < settings.data.retentionDays)
                  setConfirm(true);
                else commit();
              }}
            >
              <label htmlFor="retention-days">Keep content for</label>
              <div style={{ ...inlineActions, gap: 12 }}>
                <input
                  id="retention-days"
                  type="number"
                  min={1}
                  max={30}
                  step={1}
                  required
                  value={days}
                  onChange={(event) => setDays(event.target.value)}
                  aria-describedby="retention-help"
                  aria-invalid={days !== "" && !valid}
                  disabled={!owner || save.isPending}
                  style={{ maxWidth: 110, marginBottom: 0 }}
                />
                <span className="muted small">days</span>
              </div>
              <p
                id="retention-help"
                className="small muted"
                style={{ marginTop: 16 }}
              >
                Current policy: {settings.data.retentionDays}{" "}
                {settings.data.retentionDays === 1 ? "day" : "days"}.
                {valid && dirty
                  ? ` Saving will keep detailed content for ${Number(days)} ${Number(days) === 1 ? "day" : "days"}.`
                  : " Expired trace content is no longer available for inspection."}
              </p>
              {days !== "" && !valid && (
                <p className="form-error" role="alert">
                  Enter a whole number from 1 to 30.
                </p>
              )}
              {save.error && (
                <p className="form-error" role="alert">
                  {message(save.error)}
                </p>
              )}
              <div className="form-footer">
                <span className="muted small">
                  Applies to {settings.data.name}
                </span>
                <button
                  className="btn primary"
                  type="submit"
                  disabled={!owner || !valid || !dirty || save.isPending}
                >
                  {save.isPending ? "Saving…" : "Save retention"}
                </button>
              </div>
            </form>
          </div>
        </section>
      ) : null}
      <Modal
        open={confirm}
        onOpenChange={(open) => {
          if (!save.isPending) setConfirm(open);
        }}
        title={`Keep trace content for ${Number(days)} ${Number(days) === 1 ? "day" : "days"}?`}
        description="Older trace and evaluation content will become eligible to expire. Expired content cannot be recovered by increasing this setting later. Billing usage stays counted for its billing period."
      >
        {save.error && (
          <p className="form-error" role="alert">
            {message(save.error)}
          </p>
        )}
        <div className="form-footer">
          <button
            className="btn secondary"
            onClick={() => setConfirm(false)}
            disabled={save.isPending}
          >
            Keep current policy
          </button>
          <button
            className="btn primary"
            onClick={commit}
            disabled={save.isPending || !owner || !valid}
          >
            {save.isPending ? "Saving…" : "Save shorter retention"}
          </button>
        </div>
      </Modal>
    </>
  );
}

export function TeamInvitationAcceptance() {
  const s = useScope();
  const client = useQueryClient();
  const captured = useRef(false);
  const [token, setToken] = useState<string | null>();
  useEffect(() => {
    if (captured.current) return;
    captured.current = true;
    const url = new URL(window.location.href);
    const candidate = url.searchParams.get("invitation");
    setToken(candidate && /^[\w-]{40,128}$/.test(candidate) ? candidate : null);
    url.searchParams.delete("invitation");
    window.history.replaceState(
      window.history.state,
      "",
      `${url.pathname}${url.search}${url.hash}`,
    );
  }, []);
  const accept = useMutation({
    gcTime: 0,
    mutationFn: () => {
      if (!token)
        throw new Error("Open the original invitation link to continue.");
      return api<{
        organizationId: string;
        role: Role;
        alreadyAccepted: boolean;
      }>("/team/invitations/accept", undefined, {
        method: "POST",
        body: json({ token }),
      });
    },
    onSuccess: async (result) => {
      setToken(null);
      try {
        localStorage.setItem("aq-workspace", result.organizationId);
      } catch {
        /* Membership remains valid when browser storage is unavailable. */
      }
      await client.invalidateQueries({ queryKey: ["me"] });
      window.location.assign("/app");
    },
  });
  const unavailable =
    accept.error instanceof RequestError &&
    [404, 409, 410].includes(accept.error.status);
  return (
    <>
      <PageHeader
        title="Join a workspace"
        description="Accept your Agent Quality team invitation."
      />
      {token === undefined || !s.user ? (
        <Loading rows={3} />
      ) : accept.isSuccess ? (
        <p className="quiet-notice" role="status">
          Invitation accepted. Opening your workspace…
        </p>
      ) : !token ? (
        <Empty title="Invitation unavailable">
          Open the original invitation link. It may have expired, been revoked,
          or already been accepted.
          <div style={{ marginTop: 16 }}>
            <Link className="btn secondary" href="/app">
              Back to workspace
            </Link>
          </div>
        </Empty>
      ) : (
        <section className="settings-row">
          <div>
            <h2>Your invitation</h2>
            <p>
              Accepting adds your account to the invited workspace. Your email
              must match the email the invitation was sent to.
            </p>
          </div>
          <div className="settings-panel">
            <h3>Signed in as {s.user.name || "workspace member"}</h3>
            <p style={{ overflowWrap: "anywhere" }}>{s.user.email}</p>
            {accept.error && (
              <p className="form-error" role="alert">
                {unavailable
                  ? "This invitation is expired, revoked, already used, or belongs to another email. Ask the workspace owner for a new invitation if needed."
                  : message(accept.error)}
              </p>
            )}
            <div className="form-footer">
              <Link className="btn secondary" href="/app">
                Cancel
              </Link>
              <button
                className="btn primary"
                onClick={() => accept.mutate()}
                disabled={accept.isPending || unavailable}
              >
                {accept.isPending ? "Joining workspace…" : "Accept invitation"}
              </button>
            </div>
            <p className="muted small">
              Using the wrong account? Sign in with the invited email, then
              reopen the original invitation link.
            </p>
          </div>
        </section>
      )}
    </>
  );
}
