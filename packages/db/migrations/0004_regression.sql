-- Publishing always creates a new manifest. Content cannot change after publication.
create unique index datasets_version on datasets(organization_id,project_id,name,kind,version);
create index datasets_cases on datasets using gin(cases jsonb_path_ops);
revoke update on datasets,experiments from aq_app;

-- Explicit deletion of curated cases also removes their derived experiment reports.
do $$ declare relation record; begin
  for relation in select conname from pg_constraint where conrelid='experiments'::regclass and confrelid='datasets'::regclass and contype='f' loop
    execute format('alter table experiments drop constraint %I',relation.conname);
  end loop;
end $$;
alter table experiments add constraint experiments_dataset_fk foreign key(organization_id,project_id,dataset_id)
  references datasets(organization_id,project_id,id) on delete cascade;
