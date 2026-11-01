create table calibration_reports (
  organization_id uuid not null, project_id uuid not null, id uuid not null default gen_random_uuid(), detector_hash text not null,
  report jsonb not null, passed boolean not null, approved_by uuid not null references users, created_at timestamptz not null default now(),
  primary key(organization_id,project_id,id), foreign key(organization_id,project_id) references projects on delete cascade
);
alter table calibration_reports enable row level security;
alter table calibration_reports force row level security;
create policy tenant_scope on calibration_reports using(organization_id=current_org()) with check(organization_id=current_org());
grant select,insert on calibration_reports to aq_app;
