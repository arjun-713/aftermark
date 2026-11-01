-- Accounting rows contain opaque resource identities and byte counts, never trace bodies.
create table storage_budgets (
 organization_id uuid primary key references organizations on delete cascade,
 used_bytes bigint not null default 0 check(used_bytes>=0),
 initialized boolean not null default false,
 updated_at timestamptz not null default now()
);
create table storage_resources (
 organization_id uuid not null references organizations on delete cascade,
 category text not null check(category in('runs','events','event_keys','evidence','evaluations','reviews','review_decisions','datasets','experiments','calibration_reports','archives','archive_objects','cleanup_records','alert_payloads')),
 resource_key text not null check(length(resource_key) between 1 and 4096),
 project_id uuid,run_id text,
 bytes bigint not null check(bytes>=0),
 state text not null check(state in('reserved','retained')),
 unmeasured boolean not null default false,
 updated_at timestamptz not null default now(),
 primary key(organization_id,category,resource_key)
);
-- No project/run FK: pending private objects outlive pointer and project deletion.
create index storage_resources_scope on storage_resources(organization_id,project_id,run_id);
do $$ declare relation text; begin
 foreach relation in array array['storage_budgets','storage_resources'] loop
  execute format('alter table %I enable row level security',relation);
  execute format('alter table %I force row level security',relation);
  execute format('create policy tenant_scope on %I using(organization_id=current_org()) with check(organization_id=current_org())',relation);
  execute format('grant select,insert,update,delete on %I to aq_app',relation);
 end loop;
end $$;
-- Existing tenants are backfilled under the same workspace budget lock on the
-- first accounting mutation, or explicitly with bootstrapStorageBudget().
