-- Building QR attendance: initial schema.
-- Design goals: simple, agent-readable, history never lost (soft-disable, no hard deletes).
-- No schema-qualified names on purpose: tests run this inside a throwaway schema.

create table points (
  id            uuid primary key default gen_random_uuid(),
  name          text not null,
  description   text not null default '',
  service_type  text,                                   -- free text, e.g. 'cleaning', 'gardening'
  gps_mode      text not null default 'optional'
                check (gps_mode in ('required', 'optional', 'none')),
  lat           double precision,
  lng           double precision,
  radius_m      integer not null default 50 check (radius_m between 1 and 1000),
  is_active     boolean not null default true,
  qr_token      text not null unique,                   -- full legacy code 'BQR-...' so printed QRs keep working
  legacy_id     text unique,                            -- Firestore doc id (migration idempotency)
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);

create table providers (
  id             uuid primary key default gen_random_uuid(),
  company        text not null,
  contact_name   text not null default '',
  service_type   text,
  lang           text not null default 'he' check (lang in ('he', 'en', 'ru', 'ar')),
  password_hash  text,                                  -- scrypt; null = cannot log in until the committee sets one
  is_active      boolean not null default true,
  legacy_id      text unique,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now()
);

-- Which providers may scan which point. A point with no rows here is open to every provider.
create table point_providers (
  point_id     uuid not null references points (id) on delete restrict,
  provider_id  uuid not null references providers (id) on delete restrict,
  primary key (point_id, provider_id)
);

-- One row per phone a provider stayed signed in on. Revocable.
create table provider_devices (
  id            uuid primary key default gen_random_uuid(),
  provider_id   uuid not null references providers (id) on delete restrict,
  token_hash    text not null unique,
  label         text not null default '',
  created_at    timestamptz not null default now(),
  last_seen_at  timestamptz not null default now(),
  revoked_at    timestamptz
);
create index provider_devices_provider_idx on provider_devices (provider_id);

create table scans (
  id             uuid primary key,                      -- generated on the phone: retries are idempotent
  point_id       uuid not null references points (id) on delete restrict,
  provider_id    uuid not null references providers (id) on delete restrict,
  point_name     text not null,                         -- snapshots: history stays readable after renames
  provider_name  text not null,
  service_type   text,
  checked_in_at  timestamptz not null,                  -- best estimate of when it happened (see received_at)
  received_at    timestamptz not null default now(),    -- server clock, always trustworthy
  client_time    timestamptz,                           -- phone clock, as reported
  local_date     date not null,                         -- checked_in_at as a calendar date in Asia/Jerusalem
  source         text not null check (source in ('online', 'offline_sync')),
  outcome        text not null check (outcome in ('accepted', 'rejected_far', 'rejected_no_location')),
  distance_m     integer,
  gps_accuracy_m integer,
  device_id      uuid references provider_devices (id) on delete restrict,
  flags          text[] not null default '{}',
  voided_at      timestamptz,
  void_reason    text
);
create index scans_checked_in_idx on scans (checked_in_at desc, id);
create index scans_point_idx on scans (point_id, checked_in_at desc);
create index scans_provider_idx on scans (provider_id, checked_in_at desc);
create index scans_local_date_idx on scans (local_date);

-- History is append-only: no deletes, and the only edit allowed is voiding.
create function scans_guard() returns trigger language plpgsql as $$
begin
  if tg_op = 'DELETE' then
    raise exception 'scans are append-only: void a scan instead of deleting it';
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
create trigger scans_guard_trg before update or delete on scans
  for each row execute function scans_guard();

-- What an agent usually wants: real check-ins only.
create view v_attendance as
  select id, checked_in_at, local_date, point_id, point_name, provider_id, provider_name,
         service_type, source, distance_m, gps_accuracy_m, flags
  from scans
  where outcome = 'accepted' and voided_at is null;

create table admins (
  id             uuid primary key default gen_random_uuid(),
  email          text not null unique,                  -- stored lower-case
  name           text not null default '',
  password_hash  text not null,
  is_active      boolean not null default true,
  created_at     timestamptz not null default now()
);

create table admin_sessions (
  id          uuid primary key default gen_random_uuid(),
  admin_id    uuid not null references admins (id) on delete restrict,
  token_hash  text not null unique,
  created_at  timestamptz not null default now(),
  expires_at  timestamptz not null,
  revoked_at  timestamptz
);

-- Read-only keys for the external agent.
create table api_keys (
  id            uuid primary key default gen_random_uuid(),
  name          text not null,
  key_prefix    text not null,                          -- first characters, to recognise a key in the UI
  key_hash      text not null unique,
  created_at    timestamptz not null default now(),
  last_used_at  timestamptz,
  revoked_at    timestamptz
);

-- Failed-login bookkeeping, shared across serverless instances (an in-memory map is not).
create table auth_attempts (
  id     bigserial primary key,
  scope  text not null,                                 -- 'provider' | 'admin'
  key    text not null,                                 -- e.g. provider id + ip
  at     timestamptz not null default now()
);
create index auth_attempts_lookup_idx on auth_attempts (scope, key, at desc);

create table audit_log (
  id          bigserial primary key,
  at          timestamptz not null default now(),
  actor_type  text not null,                            -- 'admin' | 'system'
  actor_id    text,
  action      text not null,
  entity      text,
  entity_id   text,
  detail      jsonb
);
