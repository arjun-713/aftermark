alter table runs add column instance_id uuid not null default gen_random_uuid();
alter table runs add constraint runs_instance_unique unique(organization_id,project_id,id,instance_id);
create function keep_run_instance() returns trigger language plpgsql as $$ begin
  if new.instance_id is distinct from old.instance_id then raise exception 'Run instance identifiers are immutable'; end if;
  return new;
end $$;
create trigger immutable_run_instance before update of instance_id on runs for each row execute function keep_run_instance();

alter table evaluations add column run_instance_id uuid;
update evaluations e set run_instance_id=r.instance_id from runs r where e.organization_id=r.organization_id and e.project_id=r.project_id and e.run_id=r.id;
alter table evaluations alter column run_instance_id set not null;
alter table evaluations add constraint evaluations_run_instance_fk foreign key(organization_id,project_id,run_id,run_instance_id)
  references runs(organization_id,project_id,id,instance_id) on delete cascade;
create function bind_evaluation_instance() returns trigger language plpgsql as $$ begin
  if new.run_instance_id is null then
    select instance_id into new.run_instance_id from runs where organization_id=new.organization_id and project_id=new.project_id and id=new.run_id;
  end if;
  return new;
end $$;
create trigger evaluation_instance before insert on evaluations for each row execute function bind_evaluation_instance();
