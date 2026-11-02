alter table storage_resources drop constraint storage_resources_category_check;
alter table storage_resources add constraint storage_resources_category_check check(category in('runs','events','event_keys','evidence','evaluations','evaluation_attempts','reviews','review_decisions','datasets','experiments','calibration_reports','archives','archive_objects','cleanup_records','alert_payloads'));
