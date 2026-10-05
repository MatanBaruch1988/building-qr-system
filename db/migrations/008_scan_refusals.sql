-- A visit that the server refuses leaves a trace (ADR 0007, "Visits not counted"). A provider's phone drops a queued check-in
-- when the server refuses it with a permanent code (point_inactive, not_assigned, unknown_code, ...), and until now the server
-- kept nothing, so the committee never learned that a visit was not counted. The same refusals happen online (POST /api/scan),
-- where the person sees a message and the committee sees nothing. Expand only (see AGENTS.md, "Database and API changes"): a
-- new table that nothing reads or writes yet, so the deployment that keeps serving while this one is built cannot be broken.
-- No schema-qualified names on purpose: tests run this inside a throwaway schema.
--
-- Why a table of its own and not a new scans.outcome: the agent API exposes scans.outcome, so a new value would reach the
-- committee's AI agent unannounced; a scan needs a point, and a refusal can name none (unknown_code); and recordScan replays
-- an existing scan id, so a refusal stored as a scan would be refused for ever, even after the point is switched back on.
create table scan_refusals (
  id             bigserial primary key,
  -- Millisecond precision on purpose, like scans.checked_in_at (002): the committee's list pages by a cursor on (at, id) that
  -- JavaScript builds (milliseconds), so the column must not hold finer values that such a cursor could not represent.
  at             timestamptz(3) not null default now(),
  scan_id        uuid,                                   -- the phone's id of the check-in, when it sent a valid one
  source         text not null check (source in ('online', 'offline_sync')),
  code           text not null check (char_length(code) between 1 and 40),
  -- Plain references with no foreign keys, like scans since 005: a provider, a phone or a point that is deleted later must
  -- not take its refusals with it. The names are snapshots, like scans.provider_name and scans.point_name. The limits are
  -- those of the names elsewhere (NAME_MAX_LENGTH, 120): a point's name, and for a provider the company, a separator of 3
  -- characters and the contact name (120 + 3 + 120 = 243).
  provider_id    uuid not null,
  provider_name  text not null check (char_length(provider_name) <= 243),
  device_id      uuid,
  point_id       uuid,                                   -- null when the code named no point
  point_name     text check (char_length(point_name) <= 120),
  client_time    timestamptz                             -- the phone's clock, as reported, when it can be believed
);

-- One refusal per check-in: an item that is sent again (a lost answer, a retry of the batch) is not counted twice. A row with
-- no scan id (the phone sent none that is valid) is not covered, because a missing id cannot be told from another one.
create unique index scan_refusals_scan_id_key on scan_refusals (scan_id) where scan_id is not null;

-- The lookups of the committee's list: the newest first (also the cursor), and one provider's or one point's history.
create index scan_refusals_at_idx on scan_refusals (at desc, id desc);
create index scan_refusals_provider_idx on scan_refusals (provider_id, at desc);
create index scan_refusals_point_idx on scan_refusals (point_id, at desc);

-- Append-only, the same way as audit_log (007) and scans (002, 004). A row is never edited. A row is never deleted either,
-- with one exception that nothing uses today: a delete inside a transaction that has said so with
-- `select set_config('app.refusal_retention', 'on', true)` (transaction-local). It is there for the day a legal retention
-- period for refused visits is decided: that job would set it in its own transaction, after a change of the project's rules.
-- Until then the setting is never set and every delete is refused.
create function scan_refusals_guard() returns trigger language plpgsql as $$
begin
  if tg_op = 'DELETE' and coalesce(current_setting('app.refusal_retention', true), '') = 'on' then
    return old;
  end if;
  raise exception 'scan_refusals is append-only: % is not allowed', lower(tg_op);
end $$;
create trigger scan_refusals_guard_trg before update or delete on scan_refusals
  for each row execute function scan_refusals_guard();

-- The statement that empties a table does not run row triggers, so it is refused on its own, always (no exception: a
-- retention period deletes the rows that are due, it never empties the table). The operation is named from tg_op, so that
-- the message reads the same as the one of the row guard.
create function scan_refusals_block_truncate() returns trigger language plpgsql as $$
begin
  raise exception 'scan_refusals is append-only: % is not allowed', lower(tg_op);
end $$;
create trigger scan_refusals_no_truncate before truncate on scan_refusals
  for each statement execute function scan_refusals_block_truncate();

comment on table scan_refusals is
  'A visit that the server refused with a permanent code (the codes the phone drops a queued check-in for). Append-only. Not a scan: it never counts as attendance and is not part of the agent API.';
