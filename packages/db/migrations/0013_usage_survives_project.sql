-- Evaluation units belong to the workspace billing period, not the lifetime of
-- detailed runs, evaluations or projects. Retain only their opaque UUIDs here.
do $$ declare relation record; begin
 for relation in select conname from pg_constraint
   where conrelid='usage_ledger'::regclass and contype='f'
     and confrelid in('projects'::regclass,'evaluations'::regclass) loop
  execute format('alter table usage_ledger drop constraint %I',relation.conname);
 end loop;
end $$;
alter table usage_ledger add constraint usage_organization_scope
 foreign key(organization_id) references organizations on delete cascade;
