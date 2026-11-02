-- Fixed, argument-free maintenance creates the current and next two month partitions.
-- The runtime role receives no general DDL permission or direct partition access.
create function operations_ensure_event_partitions() returns void
language plpgsql security definer set search_path=public,pg_temp as $$
declare month_start date; month_end date; partition_name text; offset_month int;
begin
  if not pg_try_advisory_xact_lock(103242101) then return; end if;
  for offset_month in 0..2 loop
    month_start := (date_trunc('month',now() at time zone 'UTC') + make_interval(months=>offset_month))::date;
    month_end := (month_start + interval '1 month')::date;
    partition_name := 'events_' || to_char(month_start,'YYYY_MM');
    if to_regclass('public.' || partition_name) is null then
      lock table events in access exclusive mode;
      execute format('create table %I (like events including all)',partition_name);
      -- A restarted installation can already have this month's rows in the default
      -- partition. Move them atomically before validating the attachment constraint.
      execute format('with moved as (delete from events_default where ingested_at >= %L::timestamptz and ingested_at < %L::timestamptz returning *) insert into %I select * from moved',month_start::text || ' 00:00:00+00',month_end::text || ' 00:00:00+00',partition_name);
      execute format('alter table events attach partition %I for values from (%L) to (%L)',partition_name,month_start::text || ' 00:00:00+00',month_end::text || ' 00:00:00+00');
      execute format('alter table %I enable row level security',partition_name);
      execute format('alter table %I force row level security',partition_name);
      execute format('revoke all on %I from public,aq_app',partition_name);
    end if;
  end loop;
end $$;
revoke all on function operations_ensure_event_partitions() from public;
grant execute on function operations_ensure_event_partitions() to aq_app;
select operations_ensure_event_partitions();
