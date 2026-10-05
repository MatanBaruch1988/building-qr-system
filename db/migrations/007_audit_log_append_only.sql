-- The audit log becomes a trustworthy record: nothing can change or remove a row, the name of the committee member is kept
-- on the row, and the two lookups of the coming audit screen are indexed. Expand only (see AGENTS.md, "Database and API
-- changes"): the deployment that keeps serving while this one is built only ever inserts into audit_log, so a guard on
-- update, delete and truncate, a new nullable column and two indexes cannot break it.
-- No schema-qualified names on purpose: tests run this inside a throwaway schema.

-- 1) Append-only, the same way as scans (002, 004). A row is never edited. A row is never deleted either, with one
--    exception that nothing uses today: a delete inside a transaction that has said so with
--    `select set_config('app.audit_retention', 'on', true)` (transaction-local, like app.allow_scan_delete on scans). It is
--    there for the day a legal retention period for the audit log is decided: that job would set it in its own transaction,
--    after a change of the project's rules. Until then the setting is never set and every delete is refused.
create function audit_log_guard() returns trigger language plpgsql as $$
begin
  if tg_op = 'DELETE' and coalesce(current_setting('app.audit_retention', true), '') = 'on' then
    return old;
  end if;
  raise exception 'audit_log is append-only: % is not allowed', lower(tg_op);
end $$;
create trigger audit_log_guard_trg before update or delete on audit_log
  for each row execute function audit_log_guard();

-- The statement that empties a table does not run row triggers, so it is refused on its own, always (no exception: a
-- retention period deletes the rows that are due, it never empties the table). The operation is named from tg_op, so
-- that the message reads the same as the one of the row guard.
create function audit_log_block_truncate() returns trigger language plpgsql as $$
begin
  raise exception 'audit_log is append-only: % is not allowed', lower(tg_op);
end $$;
create trigger audit_log_no_truncate before truncate on audit_log
  for each statement execute function audit_log_block_truncate();

-- 2) The name of the actor as it was when the action happened, so that the log stays readable after a committee member is
--    deleted (actor_id is a plain text reference with no foreign key, and the admins row goes away with the member). Null
--    for the rows that were written before this column existed and for the system actor (the daily job).
alter table audit_log add column actor_name text check (char_length(actor_name) <= 200);

comment on column audit_log.actor_name is
  'The name of the committee member (or the e-mail when the member has no name) at the time of the action. Null for older rows and for the system actor. At most 200 characters.';

-- 3) The lookups of the audit screen: the newest entries first, and the history of one thing.
create index audit_log_at_idx on audit_log (at desc, id desc);
create index audit_log_entity_idx on audit_log (entity, entity_id, at desc);
