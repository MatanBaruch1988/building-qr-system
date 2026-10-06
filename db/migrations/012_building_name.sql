-- The building's name, next to its address in the one row of building_settings (migration 006). Expand only: a new column
-- with a default, so the code that is already running keeps working while this one is built. The old code's upsert
-- (insert into building_settings (id, address, updated_at, updated_by) ... on conflict do update set address = ...) names
-- no other column, so it fills in the default on an insert and leaves the stored name alone on an update.
--
-- Like the address, the name starts empty and stays empty until a committee member types one: it is not in the code or in the
-- translation files, because the repository is public and each committee runs its own copy.
-- No schema-qualified names on purpose: tests run this inside a throwaway schema.

alter table building_settings add column name text not null default '' check (char_length(name) <= 80);

comment on column building_settings.name is
  'The name of the building, as the committee typed it (for example what the residents call it). Empty means no name. At most 80 characters.';
