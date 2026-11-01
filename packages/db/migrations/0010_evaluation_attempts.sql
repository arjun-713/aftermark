-- Recovery may send the first semantic request, but must never collect new observations
-- into the already frozen input. This marker is outside that immutable JSON snapshot.
alter table evaluations add column quota_retry_frozen boolean not null default false;
create table evaluation_attempts (
  organization_id uuid not null,
  project_id uuid not null,
  evaluation_id uuid not null,
  attempt_number integer not null check(attempt_number>0),
  reason text not null check(reason='quota_denied'),
  processing text not null check(processing='error'),
  assessment jsonb not null,
  frozen_input_hash text not null check(frozen_input_hash ~ '^[a-f0-9]{64}$'),
  policy_hash text not null,
  completed_at timestamptz not null,
  requested_by uuid references users on delete set null,
  requested_at timestamptz not null default now(),
  primary key(organization_id,project_id,evaluation_id,attempt_number),
  foreign key(organization_id,project_id,evaluation_id) references evaluations(organization_id,project_id,id) on delete cascade
);
alter table evaluation_attempts enable row level security;
alter table evaluation_attempts force row level security;
create policy tenant_scope on evaluation_attempts using(organization_id=current_org()) with check(organization_id=current_org());
grant select,insert on evaluation_attempts to aq_app;
revoke update,delete on evaluation_attempts from aq_app;
