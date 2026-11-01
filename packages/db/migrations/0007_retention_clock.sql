-- The retention clock belongs to the server, never to a customer-supplied event timestamp.
alter table runs add column first_ingested_at timestamptz;
update runs r set first_ingested_at=least(now(),coalesce(
 (select min(e.ingested_at) from events e where e.organization_id=r.organization_id and e.project_id=r.project_id and e.run_id=r.id),now()));
alter table runs alter column first_ingested_at set default clock_timestamp();
alter table runs alter column first_ingested_at set not null;
create function enforce_run_retention_clock() returns trigger language plpgsql set search_path=public,pg_temp as $$ begin
 if tg_op='INSERT' then
  new.first_ingested_at:=clock_timestamp();
 elsif new.first_ingested_at is distinct from old.first_ingested_at then
  raise exception 'The server retention clock is immutable';
 end if;
 return new;
end $$;
create trigger runs_server_retention_clock before insert or update on runs for each row execute function enforce_run_retention_clock();
revoke all on function enforce_run_retention_clock() from public;
grant execute on function enforce_run_retention_clock() to aq_app;
create index runs_retention_clock on runs(organization_id,first_ingested_at);
