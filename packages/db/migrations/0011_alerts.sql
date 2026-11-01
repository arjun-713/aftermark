create table alert_destinations (
 organization_id uuid not null,project_id uuid not null,id uuid not null default gen_random_uuid(),
 name text not null check(length(name) between 1 and 80),url text not null check(length(url)<=2048),
 enabled boolean not null default true,secret_envelope jsonb not null,secret_version int not null default 1,
 decisions text[] not null default array['fail','review','unknown']::text[] check(cardinality(decisions) between 1 and 4 and decisions<@array['pass','fail','review','unknown']::text[]),
 created_by uuid not null references users,created_at timestamptz not null default now(),updated_at timestamptz not null default now(),
 primary key(organization_id,project_id,id),unique(organization_id,project_id,url),
 foreign key(organization_id,project_id) references projects on delete cascade
);
create table alert_deliveries (
 organization_id uuid not null,project_id uuid not null,id uuid not null default gen_random_uuid(),
 destination_id uuid not null,evaluation_id uuid not null,raw_body text not null check(octet_length(raw_body)<=4096),
 state text not null default 'pending' check(state in('pending','delivering','retrying','delivered','dead_letter','disabled')),
 generation int not null default 0,attempt_count int not null default 0,generation_attempts int not null default 0,
 replay_count int not null default 0,queue_job_id uuid,last_status int,last_error text,
 created_at timestamptz not null default now(),last_attempt_at timestamptz,delivered_at timestamptz,last_replayed_at timestamptz,
 primary key(organization_id,project_id,id),unique(organization_id,project_id,evaluation_id,destination_id),
 foreign key(organization_id,project_id,destination_id) references alert_destinations on delete cascade,
 foreign key(organization_id,project_id,evaluation_id) references evaluations on delete cascade,
 check(generation>=0 and attempt_count>=0 and generation_attempts between 0 and 5 and replay_count between 0 and 3)
);
create index alert_deliveries_health on alert_deliveries(organization_id,project_id,state,created_at);
do $$ declare t text; begin
 foreach t in array array['alert_destinations','alert_deliveries'] loop
  execute format('alter table %I enable row level security',t);
  execute format('alter table %I force row level security',t);
  execute format('create policy tenant_scope on %I using(organization_id=current_org()) with check(organization_id=current_org())',t);
  execute format('grant select,insert,update,delete on %I to aq_app',t);
 end loop;
end $$;
