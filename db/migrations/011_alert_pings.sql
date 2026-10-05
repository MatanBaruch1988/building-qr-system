-- The alert throttle of the server (docs/adr/0007-observability-in-our-own-postgres.md, step 2). The owner's computer is not
-- on all the time and the host has no alerts, so the first unhandled server error of a building day pings the owner's check
-- on healthchecks.io at once (server/alerts.js, server/heartbeat.js). This table remembers which days were already announced,
-- so that the second error of the same day, on any instance of the function, sends nothing.
-- Expand only (see AGENTS.md, "Database and API changes"): a new table that nothing already running reads or writes, so the old
-- deployment and the installed apps keep working while this one is built.
--
-- One row is one building day (the day in the time zone of the building, shared/datetime.js, written as a date): the key is
-- the day, so `insert ... on conflict do nothing returning day` is the whole decision, and of two errors that arrive at the
-- same moment exactly one gets the row back and sends the ping. There is no personal data in it, and nothing about the error:
-- a date and the moment the row was made. Deleted 30 days after the day by the retention job (server/retention.js).
-- No schema-qualified names on purpose: tests run this inside a throwaway schema.

create table alert_pings (
  day date primary key,
  sent_at timestamptz not null default now()
);

comment on table alert_pings is
  'The days (in the time zone of the building) whose first server error was announced to the owner. One date per day that had an error, no personal data. Deleted 30 days after the day (server/retention.js).';
comment on column alert_pings.day is
  'The building day that was announced.';
comment on column alert_pings.sent_at is
  'When the row was made, which is when the alert for that day was attempted.';
