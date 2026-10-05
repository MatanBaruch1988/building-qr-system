-- Server errors are recorded in our own database (docs/adr/0007-observability-in-our-own-postgres.md, step 1). The runtime
-- log of the host is kept for about one hour, so an error at night is gone before anybody looks. Expand only (see AGENTS.md,
-- "Database and API changes"): a new table that nothing already running reads or writes, so the old deployment and the
-- installed apps keep working while this one is built.
--
-- One row is one KIND of event in one HOUR, with a count, not one row per event: the same failure repeated a thousand times
-- is one row with count 1000, so the table stays small and a loop of failures cannot fill the database. The key of a row is
-- (bucket, source, kind, place, method, status, code, app_build), and server/errorLog.js is the only code that writes it
-- (an insert that adds 1 to the count when the row of this hour is already there).
--
-- Safe fields only (AGENTS.md, Safety). Never a message, a requested path or query string, a body, a token, a name, a QR
-- code or a position: `place` is the route as it is written in the code (/admin/points/:id) or a fixed screen key, `code` is
-- the error code or name (a SQLSTATE, a socket errno, an error class), never its message. The columns are cut by the
-- checks below as well as by the code, so a value that is too long is refused by the database and not stored.
--
-- Only the server writes today (source 'server', kind 'error'). The other values of source and kind are for the coming
-- steps of the same topic (the provider's phone, the committee app, refused requests, slow requests), so that the
-- vocabulary is decided once. tests/error-log.test.js compares the lists in server/errorLog.js with these checks.
-- No schema-qualified names on purpose: tests run this inside a throwaway schema.

create table app_errors (
  id bigserial primary key,
  -- date_trunc('hour', now()) when the event happened: one row per hour for each key.
  bucket timestamptz not null,
  -- Written with `= any (array[...])` and not with `in`, on purpose: it is the same constraint for the database, but
  -- tests/contract.test.js and tests/agent-docs.test.js read the latest check on a column named source that uses `in`, in
  -- all the migrations, as the vocabulary of scans.source, and they would take this one for it.
  source text not null check (source = any (array['server', 'provider_app', 'committee_app'])),
  kind text not null check (kind in ('error', 'refusal', 'slow', 'crash', 'unhandled', 'signed_out')),
  -- The route as written in the code, or a fixed screen key. Never the path that was asked for.
  place text not null check (char_length(place) between 1 and 120),
  method text not null default '' check (method in ('', 'GET', 'POST', 'PUT', 'PATCH', 'DELETE')),
  status smallint not null default 0 check (status between 0 and 599),
  -- failureLabel(err) of server/logSafe.js: the error's code or name, never its message.
  code text not null default '' check (char_length(code) <= 60),
  app_build text not null default '' check (char_length(app_build) <= 40),
  count integer not null default 1 check (count > 0),
  first_at timestamptz not null default now(),
  last_at timestamptz not null default now(),
  -- The Vercel request id (x-vercel-id) of the latest event, to find that request in the host's log within the hour.
  last_request_id text check (char_length(last_request_id) <= 128),
  constraint app_errors_key unique (bucket, source, kind, place, method, status, code, app_build)
);

-- The retention job (server/retention.js) deletes by last_at, and the coming screen lists the newest events first.
create index app_errors_last_at_idx on app_errors (last_at desc);

comment on table app_errors is
  'Recorded events of the app (server errors today), one row per kind of event per hour with a count. Safe fields only: no message, no requested path, no body, no token, no name. Deleted 90 days after last_at (server/retention.js).';
comment on column app_errors.bucket is
  'The hour of the event (date_trunc(''hour'', now())): the row is shared by every event of the same key in that hour.';
comment on column app_errors.source is
  'Where the event happened: server, provider_app (a service provider''s phone) or committee_app.';
comment on column app_errors.kind is
  'What kind of event: error (an unhandled server error), refusal, slow, crash, unhandled, signed_out.';
comment on column app_errors.place is
  'The route as it is written in the code (for example /admin/points/:id) or a fixed screen key. Never the path that was asked for. 1 to 120 characters.';
comment on column app_errors.method is
  'The HTTP method, or an empty string when the event is not a request.';
comment on column app_errors.status is
  'The HTTP status of the answer, or 0 when the event is not a request.';
comment on column app_errors.code is
  'The error code or name (a SQLSTATE, a socket errno, an error class), never its message. At most 60 characters.';
comment on column app_errors.app_build is
  'The build that was running (the first 7 characters of the commit), or an empty string when it is not known. At most 40 characters.';
comment on column app_errors.count is
  'How many events of this key happened in this hour.';
comment on column app_errors.first_at is
  'When the first event of this row happened.';
comment on column app_errors.last_at is
  'When the latest event of this row happened. The retention period counts from here.';
comment on column app_errors.last_request_id is
  'The Vercel request id (x-vercel-id) of the latest event, when the request carried a well-formed one. At most 128 characters.';
