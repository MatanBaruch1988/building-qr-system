-- How much each agent key is used (AGENTS.md, Safety, "The committee's agent is its analyst"). The guard of the agent API
-- (requireApiKey in server/auth.js) counts every request of a key here, and the same count is what limits a key: a key that
-- made too many requests in the current minute, or in the building's day, is answered with 429 `rate_limited` (the two limits
-- are AGENT_KEY_MAX_PER_MINUTE and AGENT_KEY_MAX_PER_DAY in server/config.js). Expand only (see AGENTS.md, "Database and API
-- changes"): a new table that nothing already running reads or writes, so the old deployment keeps working while this one is
-- built, and an old deployment that serves a key meanwhile simply does not count it.
--
-- One row is one key in one minute (the minute is date_trunc('minute', now()), a point in time, so the building's day is
-- the sum of the rows from its midnight on). The row is made by `insert ... on conflict (key_id, minute) do update`, so a
-- loop of requests is one row per minute, never one row per request: a key makes at most 1440 rows a day, however often it is
-- called.
--   requests  the requests that were let through (answered by the endpoint, whatever its answer). Only these count against
--             the limits, so a key that is limited does not keep itself limited by asking again.
--   refused   the requests that were turned away with 429 because the key was over a limit. Never counted in `requests`.
-- There is nothing about a person in it: a key, a minute and two counts. A deleted key takes its rows with it. The retention
-- job deletes the rows whose minute is older than 90 days (owner decision of 08/10/2026, server/retention.js).
-- No schema-qualified names on purpose: tests run this inside a throwaway schema.

create table api_key_usage (
  key_id    uuid not null references api_keys (id) on delete cascade,
  minute    timestamptz not null,
  requests  int not null default 0 check (requests >= 0),
  refused   int not null default 0 check (refused >= 0),
  -- The guard reads "this key since the start of the day" and writes "this key, this minute": both are served by the key.
  primary key (key_id, minute)
);

-- The retention job deletes by age across all keys, which the key above cannot serve.
create index api_key_usage_minute_idx on api_key_usage (minute);

comment on table api_key_usage is
  'How many requests each agent key made, one row per key per minute. Nothing about a person. The guard of the agent API writes it and limits a key by it. Deleted 90 days after the minute (server/retention.js).';
comment on column api_key_usage.key_id is
  'The agent key. A deleted key takes its rows with it.';
comment on column api_key_usage.minute is
  'The minute (date_trunc(''minute'', now())) of the requests, as a point in time. The building''s day is the sum of the minutes from its midnight.';
comment on column api_key_usage.requests is
  'The requests of this minute that the guard let through. They are what the limits count.';
comment on column api_key_usage.refused is
  'The requests of this minute that the guard refused with 429 rate_limited because the key was over a limit. Not counted in requests.';
