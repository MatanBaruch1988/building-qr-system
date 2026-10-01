-- Deleting on purpose, for every kind of tile in the committee app (see 004 for points and single scan rows).
--
-- 1) A provider can be deleted without touching the scans recorded for them. A scan keeps provider_name (the snapshot
--    made when it was recorded); provider_id and device_id stay on it as plain references that may outlive the rows
--    they point at, the same as point_id since 004. Nothing else about the history changes: the scans guard still
--    refuses every edit other than voiding, and every delete that does not come through the committee's own route.
alter table scans drop constraint if exists scans_provider_id_fkey;
alter table scans drop constraint if exists scans_device_id_fkey;

-- 2) What belongs to a provider goes with them: "who may scan here" and the phones they stayed signed in on (so a
--    deleted provider is signed out of every phone at once).
alter table point_providers drop constraint if exists point_providers_provider_id_fkey;
alter table point_providers
  add constraint point_providers_provider_id_fkey foreign key (provider_id) references providers (id) on delete cascade;
alter table provider_devices drop constraint if exists provider_devices_provider_id_fkey;
alter table provider_devices
  add constraint provider_devices_provider_id_fkey foreign key (provider_id) references providers (id) on delete cascade;

-- 3) A committee member's sign-in sessions go with them. The audit log keeps who did what: it holds the id as plain
--    text and has no foreign key.
alter table admin_sessions drop constraint if exists admin_sessions_admin_id_fkey;
alter table admin_sessions
  add constraint admin_sessions_admin_id_fkey foreign key (admin_id) references admins (id) on delete cascade;
