-- Hardening after the first review, and Google sign-in for the committee.

-- Committee members sign in with Google: the admins table is an allow-list of e-mail addresses.
alter table admins drop column password_hash;
alter table admins add column google_sub text unique;   -- filled on first sign-in
alter table admins add column last_login_at timestamptz;

-- A demo account (for showing or trying the app) signs in with a password like any provider, but its
-- scans are tagged 'demo' and kept out of reports and the attendance view.
alter table providers add column is_demo boolean not null default false;

-- Millisecond precision: the pagination cursor is built in JavaScript (ms), so the column must not
-- hold finer values that a cursor could not represent. The view depends on the column, so recreate it.
drop view v_attendance;
alter table scans alter column checked_in_at type timestamptz(3);
create view v_attendance as
  select id, checked_in_at, local_date, point_id, point_name, provider_id, provider_name,
         service_type, source, distance_m, gps_accuracy_m, flags
  from scans
  where outcome = 'accepted' and voided_at is null and not ('demo' = any(flags));

-- Match the query's `order by checked_in_at desc, id desc`.
drop index scans_checked_in_idx;
create index scans_checked_in_idx on scans (checked_in_at desc, id desc);

-- TRUNCATE bypasses row-level triggers, so block it explicitly.
create function scans_block_truncate() returns trigger language plpgsql as $$
begin
  raise exception 'scans are append-only: truncate is not allowed';
end $$;
create trigger scans_no_truncate before truncate on scans
  for each statement execute function scans_block_truncate();
