-- Expand-only migration: old API/worker versions continue to work during rollout.
alter table runs add column if not exists content_archived_at timestamptz;
alter table archives add column if not exists expires_at timestamptz;
alter table archives add column if not exists purpose text not null default 'archive' check(purpose in ('archive','export'));
alter table archives add column if not exists bytes bigint not null default 0;
create index if not exists archives_expiry on archives(organization_id,expires_at);
create unique index if not exists one_run_archive on archives(organization_id,project_id,run_id) where purpose='archive';

create table operations_daily_metrics (
 organization_id uuid not null, project_id uuid not null, day date not null,
 decision text not null check(decision in ('pass','fail','review','unknown','pending')),
 processing text not null check(processing in ('pending','processing','completed','error','partial','unknown')),
 execution text not null check(execution in ('running','completed','failed','cancelled','unknown')),
 count bigint not null default 0 check(count>=0),
 primary key(organization_id,project_id,day,decision,processing,execution),
 foreign key(organization_id,project_id) references projects on delete cascade
);
create table operations_deletions (
 organization_id uuid not null references organizations on delete cascade,
 id uuid primary key, kind text not null check(kind in ('workspace','project','run','dataset')),
 project_id uuid, target_id text not null, journal_checksum text not null,
 state text not null default 'pending' check(state in ('pending','complete')),
 created_at timestamptz not null default now(), completed_at timestamptz
);
create table operations_object_cleanup (
 organization_id uuid not null, id uuid primary key default gen_random_uuid(), object_path text not null,
 created_at timestamptz not null default now(), not_before timestamptz not null default now()
);
create table operations_heartbeats (
 organization_id uuid primary key references organizations on delete cascade,
 last_success_at timestamptz not null, archived bigint not null, expired bigint not null, deleted bigint not null
);
alter table deletion_journal add column if not exists id uuid not null default gen_random_uuid();
alter table deletion_journal add column if not exists kind text not null default 'workspace';
alter table deletion_journal add column if not exists project_hash text;
alter table deletion_journal add column if not exists target_hash text;
create unique index if not exists deletion_journal_id on deletion_journal(id);

do $$ declare t text; begin
 foreach t in array array['operations_daily_metrics','operations_deletions','operations_object_cleanup','operations_heartbeats'] loop
  execute format('alter table %I enable row level security',t);
  execute format('alter table %I force row level security',t);
  execute format('create policy tenant_scope on %I using (organization_id=current_org()) with check (organization_id=current_org())',t);
  execute format('grant select,insert,update,delete on %I to aq_app',t);
 end loop;
end $$;
-- Only opaque UUIDs cross this maintenance discovery boundary. No trace, identity or credentials.
create function operations_workspace_ids() returns setof uuid language sql security definer set search_path=public,pg_temp as $$
 select id from organizations order by id
$$;
create function operations_cleanup_workspace_ids() returns setof uuid language sql security definer set search_path=public,pg_temp as $$
 select distinct organization_id from operations_object_cleanup where not_before<=now()
$$;
create function operations_record_deletion(record_id uuid,org uuid,org_hash text,deletion_kind text,proj_hash text,tgt_hash text)
returns void language plpgsql security definer set search_path=public,pg_temp as $$ begin
 if org is distinct from current_org() then raise exception 'Invalid workspace'; end if;
 insert into deletion_journal(id,organization_hash,kind,project_hash,target_hash) values(record_id,org_hash,deletion_kind,proj_hash,tgt_hash) on conflict(id) do nothing;
end $$;
create function operations_target_deleted(org_hash text,proj_hash text,tgt_hash text) returns boolean language sql security definer set search_path=public,pg_temp as $$
 select exists(select 1 from deletion_journal where organization_hash=org_hash and (kind='workspace' or (project_hash=proj_hash and (kind='project' or target_hash=tgt_hash))))
$$;
-- Accounting UUIDs/units must survive detailed run deletion, including 31-day subscription periods.
do $$ declare constraint_name text; begin
 for constraint_name in select conname from pg_constraint where conrelid='usage_ledger'::regclass and confrelid='evaluations'::regclass and contype='f' loop
  execute format('alter table usage_ledger drop constraint %I',constraint_name);
 end loop;
end $$;
alter table usage_ledger add constraint usage_project_scope foreign key(organization_id,project_id) references projects on delete cascade;
create function operations_prune_audit(org uuid) returns void language plpgsql security definer set search_path=public,pg_temp as $$ begin
 if org is distinct from current_org() then raise exception 'Invalid workspace'; end if;
 delete from audit_events where organization_id=org and created_at<now()-interval '365 days';
end $$;
revoke all on function operations_workspace_ids(),operations_cleanup_workspace_ids(),operations_record_deletion(uuid,uuid,text,text,text,text),operations_target_deleted(text,text,text),operations_prune_audit(uuid) from public;
grant execute on function operations_workspace_ids(),operations_cleanup_workspace_ids(),operations_record_deletion(uuid,uuid,text,text,text,text),operations_target_deleted(text,text,text),operations_prune_audit(uuid) to aq_app;
