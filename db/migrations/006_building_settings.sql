-- The building's own settings, edited by the committee in the committee app (Committee tab). Expand only: a new table,
-- nothing that the code already running reads or writes is touched, so the old deployment and the installed apps keep
-- working while this one is built.
--
-- One row, enforced by the database: id is always 1. The address starts empty and stays empty until a committee member
-- types one. It is deliberately not in the code or in the translation files, because the repository is public and each
-- committee runs its own copy.
-- No schema-qualified names on purpose: tests run this inside a throwaway schema.

create table building_settings (
  id          smallint primary key default 1 check (id = 1),
  address     text not null default '' check (char_length(address) <= 200),
  updated_at  timestamptz not null default now(),
  -- The committee member who saved it last. A plain reference that is emptied when that member is deleted (the audit
  -- log keeps who did what: it holds the id as text and has no foreign key).
  updated_by  uuid references admins (id) on delete set null
);

comment on table building_settings is
  'Settings of the building, a single row (id = 1) that the committee edits in the committee app.';
comment on column building_settings.id is
  'Always 1: the check constraint allows no second row.';
comment on column building_settings.address is
  'The street address shown at the top of the service providers app, as the committee typed it. Empty means show nothing. At most 200 characters.';
comment on column building_settings.updated_at is
  'When a committee member last saved the settings.';
comment on column building_settings.updated_by is
  'The committee member (admins.id) who last saved them. Null when nobody has, or when that member was deleted.';

insert into building_settings (id) values (1) on conflict (id) do nothing;
