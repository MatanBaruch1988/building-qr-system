-- Deleting on purpose. The history is still protected from accidents, but the committee can now clean up.
--
-- 1) A point can be deleted without touching the scans recorded there. A scan keeps point_name (the snapshot made when
--    it was recorded) and point_id as a plain reference that may outlive the point.
alter table scans drop constraint if exists scans_point_id_fkey;

-- 2) "Who may scan here" is configuration, not history: it goes with the point.
alter table point_providers drop constraint if exists point_providers_point_id_fkey;
alter table point_providers
  add constraint point_providers_point_id_fkey foreign key (point_id) references points (id) on delete cascade;

-- 3) A single scan row can be deleted, but only from the committee screen, which says so to the database for the
--    duration of its own transaction (and records who did it in audit_log). Any other delete is still refused, and
--    so is any edit other than voiding. TRUNCATE stays blocked (see 002).
create or replace function scans_guard() returns trigger language plpgsql as $$
begin
  if tg_op = 'DELETE' then
    if coalesce(current_setting('app.allow_scan_delete', true), '') = 'on' then
      return old;
    end if;
    raise exception 'scans are append-only: a row can be deleted only from the committee screen (it records who did it)';
  end if;
  if (new.id, new.point_id, new.provider_id, new.point_name, new.provider_name, new.service_type,
      new.checked_in_at, new.received_at, new.client_time, new.local_date, new.source, new.outcome,
      new.distance_m, new.gps_accuracy_m, new.device_id, new.flags)
     is distinct from
     (old.id, old.point_id, old.provider_id, old.point_name, old.provider_name, old.service_type,
      old.checked_in_at, old.received_at, old.client_time, old.local_date, old.source, old.outcome,
      old.distance_m, old.gps_accuracy_m, old.device_id, old.flags) then
    raise exception 'scans are append-only: only voided_at / void_reason may change';
  end if;
  return new;
end $$;
