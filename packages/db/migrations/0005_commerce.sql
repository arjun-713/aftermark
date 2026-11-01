alter table subscriptions add column cancel_at_period_end boolean not null default false;
alter table subscriptions add column provider_product_id text;
alter table subscriptions add column billing_sync_error text;
create unique index subscriptions_customer_workspace on subscriptions(customer_id) where customer_id is not null;

create table billing_checkout_intents (
  organization_id uuid not null references organizations on delete cascade,
  id uuid not null default gen_random_uuid(),
  binding_hash text not null unique,
  plan text not null check(plan in ('starter','team')),
  status text not null check(status in ('creating','ready','ambiguous','rejected','bound')),
  provider_checkout_id text,
  checkout_url text,
  created_by uuid not null references users,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null default (now()+interval '24 hours'),
  primary key(organization_id,id)
);
alter table billing_checkout_intents enable row level security;
alter table billing_checkout_intents force row level security;
create policy tenant_scope on billing_checkout_intents using(organization_id=current_org()) with check(organization_id=current_org());
grant select,insert,update,delete on billing_checkout_intents to aq_app;

alter table billing_events add column organization_id uuid references organizations on delete cascade;
alter table billing_events add column body_hash text;
alter table billing_events add column event_type text;
-- Global event IDs remain inaccessible to the application role outside these functions.
revoke all on billing_events from aq_app;

create function billing_resolve_target(p_subscription text,p_binding_hash text)
returns uuid language plpgsql security definer set search_path=pg_catalog,public as $$
declare target uuid;
begin
  if length(p_subscription) not between 1 and 200 then return null; end if;
  select organization_id into target from public.subscriptions where provider_id=p_subscription;
  if target is not null then return target; end if;
  if p_binding_hash is null or p_binding_hash !~ '^[a-f0-9]{64}$' then return null; end if;
  select i.organization_id into target from public.billing_checkout_intents i
  join public.subscriptions s on s.organization_id=i.organization_id
  where i.binding_hash=p_binding_hash and i.status in('creating','ready','ambiguous') and s.provider_id is null;
  return target;
end $$;

create function billing_claim_event(p_id text,p_subscription text,p_hash text,p_type text)
returns text language plpgsql security definer set search_path=pg_catalog,public as $$
declare event public.billing_events%rowtype;
begin
  if public.current_org() is null or length(p_id) not between 1 and 200 or length(p_subscription) not between 1 and 200 or p_hash !~ '^[a-f0-9]{64}$' or length(p_type) not between 1 and 100 then raise exception 'Invalid billing event scope'; end if;
  if not exists(select 1 from public.subscriptions where organization_id=public.current_org() and provider_id=p_subscription) then raise exception 'Invalid billing subscription scope'; end if;
  insert into public.billing_events(id,subscription_id,organization_id,body_hash,event_type)
    values(p_id,p_subscription,public.current_org(),p_hash,p_type) on conflict(id) do nothing;
  select * into event from public.billing_events where id=p_id for update;
  if event.organization_id is distinct from public.current_org() or event.subscription_id<>p_subscription or event.body_hash is distinct from p_hash or event.event_type is distinct from p_type then return 'conflict'; end if;
  return case when event.processed_at is null then 'pending' else 'processed' end;
end $$;

create function billing_finish_event(p_id text,p_subscription text)
returns void language plpgsql security definer set search_path=pg_catalog,public as $$
begin
  if public.current_org() is null then raise exception 'Invalid billing event scope'; end if;
  update public.billing_events set processed_at=now()
  where id=p_id and subscription_id=p_subscription and organization_id=public.current_org();
  if not found then raise exception 'Invalid billing event scope'; end if;
end $$;

-- Only narrow identifiers required for a server-side, paginated daily sweep.
create function billing_reconciliation_targets(p_after uuid,p_limit int)
returns table(organization_id uuid,provider_id text,checkout_id text)
language sql security definer set search_path=pg_catalog,public as $$
  select s.organization_id,s.provider_id,i.provider_checkout_id from public.subscriptions s
  left join lateral (select provider_checkout_id from public.billing_checkout_intents
    where organization_id=s.organization_id and status='ready' and provider_checkout_id is not null
    order by created_at desc limit 1) i on s.provider_id is null
  where public.current_org() is null and public.current_user_id() is null
    and (p_after is null or s.organization_id>p_after)
  order by s.organization_id limit greatest(1,least(p_limit,1000))
$$;

create table team_invitations (
  organization_id uuid not null references organizations on delete cascade,
  id uuid not null default gen_random_uuid(),
  email text not null,
  role text not null check(role in('admin','member','viewer')),
  token_hash text not null unique,
  created_by uuid not null references users,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null default(now()+interval '7 days'),
  accepted_at timestamptz,
  accepted_by uuid references users,
  revoked_at timestamptz,
  delivery text not null default 'not_configured' check(delivery in('not_configured','sent','failed')),
  primary key(organization_id,id)
);
create unique index team_pending_email on team_invitations(organization_id,lower(email)) where accepted_at is null and revoked_at is null;
alter table team_invitations enable row level security;
alter table team_invitations force row level security;
create policy tenant_scope on team_invitations using(organization_id=current_org()) with check(organization_id=current_org());
grant select,insert,update,delete on team_invitations to aq_app;

create function workspace_member_profiles(p_org uuid)
returns table(id uuid,email text,name text,role text)
language sql stable security definer set search_path=pg_catalog,public as $$
  select u.id,u.email,u.name,m.role from public.memberships m join public.users u on u.id=m.user_id
  where m.organization_id=p_org and p_org=public.current_org()
    and exists(select 1 from public.memberships actor where actor.organization_id=p_org and actor.user_id=public.current_user_id())
  order by case m.role when 'owner' then 1 when 'admin' then 2 when 'member' then 3 else 4 end,u.name,u.id
$$;

create function resolve_team_invitation(p_hash text)
returns uuid language sql stable security definer set search_path=pg_catalog,public as $$
  select i.organization_id from public.team_invitations i join public.users u on lower(u.email)=lower(i.email)
  where i.token_hash=p_hash and u.id=public.current_user_id()
    and ((i.accepted_by=u.id and i.accepted_at is not null) or (i.accepted_at is null and i.revoked_at is null and i.expires_at>now()))
$$;

revoke all on function billing_resolve_target(text,text),billing_claim_event(text,text,text,text),billing_finish_event(text,text),billing_reconciliation_targets(uuid,int),workspace_member_profiles(uuid),resolve_team_invitation(text) from public;
grant execute on function billing_resolve_target(text,text),billing_claim_event(text,text,text,text),billing_finish_event(text,text),billing_reconciliation_targets(uuid,int),workspace_member_profiles(uuid),resolve_team_invitation(text) to aq_app;
