create extension if not exists pgcrypto;
do $$ begin
  if not exists (select from pg_roles where rolname='aq_app') then
    create role aq_app login password 'local_app_password' nosuperuser nobypassrls;
  end if;
end $$;
create schema if not exists pgboss authorization aq_app;
create table users (id uuid primary key, email text unique not null, name text not null, password_hash text, created_at timestamptz not null default now());
create table organizations (id uuid primary key default gen_random_uuid(), name text not null, created_at timestamptz not null default now(), retention_days int not null default 30 check(retention_days between 1 and 30));
create table memberships (organization_id uuid not null references organizations on delete cascade, user_id uuid not null references users on delete cascade, role text not null check(role in ('owner','admin','member','viewer')), primary key(organization_id,user_id));
create table projects (organization_id uuid not null references organizations on delete cascade, id uuid not null default gen_random_uuid(), name text not null, created_at timestamptz not null default now(), active_policy_id uuid, primary key(organization_id,id));
create table api_keys (organization_id uuid not null, project_id uuid not null, id uuid not null default gen_random_uuid(), name text not null, prefix text not null, secret_hash text not null unique, scopes text[] not null, revoked_at timestamptz, created_at timestamptz not null default now(), primary key(organization_id,project_id,id), foreign key(organization_id,project_id) references projects on delete cascade);
create table policies (organization_id uuid not null, project_id uuid not null, id uuid not null default gen_random_uuid(), version int not null, definition jsonb not null, hash text not null, created_at timestamptz not null default now(), created_by uuid references users, primary key(organization_id,project_id,id), unique(organization_id,project_id,version), foreign key(organization_id,project_id) references projects on delete cascade);
alter table projects add foreign key(organization_id,id,active_policy_id) references policies(organization_id,project_id,id) deferrable initially deferred;
create table runs (organization_id uuid not null, project_id uuid not null, id text not null, agent text not null default 'Agent', agent_version text not null, environment text not null, execution_status text not null default 'running', started_at timestamptz not null, completed_at timestamptz, last_event_at timestamptz not null, revision int not null default 1, auto_evaluations int not null default 0, latest_evaluation_id uuid, expired_at timestamptz, primary key(organization_id,project_id,id), foreign key(organization_id,project_id) references projects on delete cascade);
create index runs_recent on runs(organization_id,project_id,started_at desc,id);
create index runs_filters on runs(organization_id,project_id,environment,agent_version,execution_status);
create table event_keys (organization_id uuid not null, project_id uuid not null, event_id text not null, run_id text not null, hash text not null, primary key(organization_id,project_id,event_id), foreign key(organization_id,project_id,run_id) references runs on delete cascade);
create table events (organization_id uuid not null, project_id uuid not null, event_id text not null, run_id text not null, event jsonb not null, ingested_at timestamptz not null default now(), primary key(organization_id,project_id,event_id,ingested_at), foreign key(organization_id,project_id,run_id) references runs on delete cascade) partition by range(ingested_at);
do $$ declare d date:=date_trunc('month',now()); begin
  execute format('create table events_%s partition of events for values from (%L) to (%L)', to_char(d,'YYYY_MM'),d,d+interval '1 month');
end $$;
create table events_default partition of events default;
create index events_run on events(organization_id,project_id,run_id);
create index events_search on events using gin(to_tsvector('simple', event->'payload'->>'text'));
create table evidence (organization_id uuid not null, project_id uuid not null, id uuid not null default gen_random_uuid(), run_id text not null, receipt_id text, hash text, body jsonb not null, created_at timestamptz not null default now(), primary key(organization_id,project_id,id), unique(organization_id,project_id,receipt_id), foreign key(organization_id,project_id,run_id) references runs on delete cascade);
create table evaluations (organization_id uuid not null, project_id uuid not null, id uuid not null default gen_random_uuid(), run_id text not null, revision int not null, policy_id uuid not null, policy_hash text not null, processing text not null default 'pending', assessment jsonb, frozen_input jsonb, provider_response jsonb, created_at timestamptz not null default now(), completed_at timestamptz, primary key(organization_id,project_id,id), unique(organization_id,project_id,run_id,revision,policy_id), foreign key(organization_id,project_id,run_id) references runs on delete cascade, foreign key(organization_id,project_id,policy_id) references policies);
alter table runs add foreign key(organization_id,project_id,latest_evaluation_id) references evaluations(organization_id,project_id,id) deferrable initially deferred;
create table reviews (organization_id uuid not null, project_id uuid not null, id uuid not null default gen_random_uuid(), evaluation_id uuid not null, run_id text not null, assigned_to uuid references users, version int not null default 1, status text not null default 'open', decision text, annotation text, created_at timestamptz not null default now(), primary key(organization_id,project_id,id), unique(organization_id,project_id,evaluation_id), foreign key(organization_id,project_id,evaluation_id) references evaluations on delete cascade, foreign key(organization_id,project_id,run_id) references runs on delete cascade);
create table review_decisions (organization_id uuid not null, project_id uuid not null, id uuid not null default gen_random_uuid(), review_id uuid not null, reviewer_id uuid not null references users, version int not null, decision text not null, annotation text not null, created_at timestamptz not null default now(), primary key(organization_id,project_id,id), foreign key(organization_id,project_id,review_id) references reviews on delete cascade);
create table datasets (organization_id uuid not null, project_id uuid not null, id uuid not null default gen_random_uuid(), name text not null, kind text not null check(kind in ('agent_regression','evaluator_calibration')), version int not null default 1, cases jsonb not null, hash text not null, created_at timestamptz not null default now(), primary key(organization_id,project_id,id), foreign key(organization_id,project_id) references projects on delete cascade);
create table experiments (organization_id uuid not null, project_id uuid not null, id uuid not null default gen_random_uuid(), name text not null, dataset_id uuid not null, policy_id uuid not null, candidates jsonb not null, created_at timestamptz not null default now(), primary key(organization_id,project_id,id), foreign key(organization_id,project_id,dataset_id) references datasets, foreign key(organization_id,project_id,policy_id) references policies);
create table connections (organization_id uuid not null, project_id uuid not null, id uuid not null default gen_random_uuid(), provider text not null, name text not null, credential jsonb not null, status text not null default 'connected', last_checked_at timestamptz, created_at timestamptz not null default now(), primary key(organization_id,project_id,id), unique(organization_id,project_id,provider), foreign key(organization_id,project_id) references projects on delete cascade);
create table oauth_states (organization_id uuid not null, project_id uuid not null, state_hash text primary key, provider text not null, user_id uuid not null references users, expires_at timestamptz not null, foreign key(organization_id,project_id) references projects on delete cascade);
create table subscriptions (organization_id uuid primary key references organizations on delete cascade, plan text not null default 'trial', status text not null default 'trialing', allowance int not null default 1000, period_start timestamptz not null default now(), period_end timestamptz not null default (now()+interval '14 days'), provider_id text unique, customer_id text, reconciled_at timestamptz);
create table usage_ledger (organization_id uuid not null, project_id uuid not null, evaluation_id uuid not null, state text not null check(state in ('reserved','consumed','released','ambiguous')), units int not null default 1, tokens int not null default 0, created_at timestamptz not null default now(), primary key(organization_id,project_id,evaluation_id), foreign key(organization_id,project_id,evaluation_id) references evaluations on delete cascade);
create table billing_events (id text primary key, subscription_id text not null, received_at timestamptz not null default now(), processed_at timestamptz);
create table audit_events (organization_id uuid not null references organizations on delete cascade, id uuid primary key default gen_random_uuid(), user_id uuid, action text not null, resource_id text, metadata jsonb not null default '{}', created_at timestamptz not null default now());
create table deletion_journal (organization_hash text not null, deleted_at timestamptz not null default now());
create table archives (organization_id uuid not null, project_id uuid not null, id uuid not null default gen_random_uuid(), run_id text not null, object_path text not null, checksum text not null, created_at timestamptz not null default now(), primary key(organization_id,project_id,id), foreign key(organization_id,project_id,run_id) references runs on delete cascade);

create function current_org() returns uuid language sql stable as $$ select nullif(current_setting('app.org_id',true),'')::uuid $$;
create function current_user_id() returns uuid language sql stable as $$ select nullif(current_setting('app.user_id',true),'')::uuid $$;
do $$ declare t text; begin
  foreach t in array array['organizations','memberships','projects','api_keys','policies','runs','event_keys','events','evidence','evaluations','reviews','review_decisions','datasets','experiments','connections','oauth_states','subscriptions','usage_ledger','audit_events','archives'] loop
    execute format('alter table %I enable row level security',t);
    execute format('alter table %I force row level security',t);
    execute format('create policy tenant_scope on %I using (%I = current_org()) with check (%I = current_org())',t,case when t='organizations' then 'id' else 'organization_id' end,case when t='organizations' then 'id' else 'organization_id' end);
  end loop;
end $$;
create policy own_memberships on memberships for select using(user_id=current_user_id());
create policy own_organization on organizations for select using(id in(select organization_id from memberships where user_id=current_user_id()));
alter table users enable row level security;
alter table users force row level security;
create policy own_user on users using(id=current_user_id());
grant usage on schema public,pgboss to aq_app;
grant select,insert,update,delete on all tables in schema public to aq_app;
do $$ declare child regclass; begin
  for child in select inhrelid::regclass from pg_inherits where inhparent='events'::regclass loop
    execute format('revoke all on %s from aq_app',child);
  end loop;
end $$;
revoke all on schema_migrations,billing_events,deletion_journal from aq_app;
revoke delete,update on policies,review_decisions from aq_app;

create function authenticate_key(digest text) returns table(organization_id uuid,project_id uuid,id uuid,scopes text[]) language sql security definer set search_path=public as $$
  select k.organization_id,k.project_id,k.id,k.scopes from api_keys k where k.secret_hash=digest and k.revoked_at is null
$$;
create function local_user(email_address text) returns table(id uuid,email text,name text,password_hash text) language sql security definer set search_path=public as $$ select u.id,u.email,u.name,u.password_hash from users u where lower(u.email)=lower(email_address) $$;
create function provision_user(user_id uuid,email_address text,display_name text) returns void language sql security definer set search_path=public as $$ insert into users(id,email,name) values(user_id,email_address,display_name) on conflict(id) do update set email=excluded.email,name=excluded.name $$;
create function create_workspace(user_id uuid,workspace_name text) returns uuid language plpgsql security definer set search_path=public as $$
declare org uuid; begin
 if user_id is distinct from current_user_id() then raise exception 'Invalid identity'; end if;
 insert into organizations(name) values(workspace_name) returning id into org;
 insert into memberships values(org,user_id,'owner');
 insert into subscriptions(organization_id) values(org);
 return org;
end $$;
revoke all on function authenticate_key(text), local_user(text),provision_user(uuid,text,text),create_workspace(uuid,text) from public;
grant execute on function authenticate_key(text),local_user(text),provision_user(uuid,text,text),create_workspace(uuid,text) to aq_app;
