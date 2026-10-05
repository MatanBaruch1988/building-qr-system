// What the server may write to the runtime log about a failure it handled itself (a failed health query, an idle database
// connection that dropped). The logs are kept by the host and read by more people than the committee, so a line holds only
// fields that cannot carry personal data. Never log an error object, `err.message` or any other field of it: the message
// of a library or database error can quote an input or a row value (an e-mail, a name, a database user), and a Postgres
// error also carries `detail`, `where`, `table`, `column` and `parameters`. Flattening or cutting a message does not make
// it safe. The unhandled errors of the router go through `describeUnhandled` in server/router.js, which follows the same rule.

/** `value` as one line (every run of white space becomes one space) of at most `max` characters. */
export const oneLine = (value, max) => String(value).replace(/\s+/g, ' ').trim().slice(0, max)

/**
 * The label of a failure for a log line: the error's `code` when it is a string or a number (for Postgres the SQLSTATE,
 * which says what went wrong; for a socket the errno name), else its `name`, else its type. Never the message. Only an
 * Error is asked for its fields: anything else can be thrown, its content is not known to be safe, so only its type is said.
 * Use it as one string, for example `console.error(`health/db failed: ${failureLabel(err)}`)`, never as a second argument.
 */
export function failureLabel(err) {
  if (err instanceof Error) {
    for (const [field, max] of [
      ['code', 40],
      ['name', 60],
    ]) {
      const value = err[field]
      if (typeof value !== 'string' && typeof value !== 'number') continue
      const text = oneLine(value, max)
      if (text) return text
    }
    return 'Error'
  }
  return `thrown ${typeof err}`
}

/**
 * An error whose message is a sentence that our own code wrote, put together only from values that are not data: a file name
 * of db/migrations, a number, an HTTP status, a fixed word. Such a message may be printed as it is (`buildFailureText` in
 * server/productionMigrate.js does). Never build one from the message of another error or from a value that came from
 * outside: a database or library message can quote a row value, and then the message is not safe to print.
 */
export class SafeMessageError extends Error {}

// The condition names of the SQLSTATE codes that a migration plausibly hits, spelled as in appendix A of the PostgreSQL
// documentation ("PostgreSQL Error Codes"). A Map, so that a key such as `constructor` is not a code.
const SQLSTATE_NAMES = new Map([
  ['0A000', 'feature_not_supported'],
  ['22P02', 'invalid_text_representation'],
  ['23502', 'not_null_violation'],
  ['23503', 'foreign_key_violation'],
  ['23505', 'unique_violation'],
  ['23514', 'check_violation'],
  ['25P02', 'in_failed_sql_transaction'],
  ['40P01', 'deadlock_detected'],
  ['42601', 'syntax_error'],
  ['42701', 'duplicate_column'],
  ['42703', 'undefined_column'],
  ['42704', 'undefined_object'],
  ['42710', 'duplicate_object'],
  ['42883', 'undefined_function'],
  ['42P01', 'undefined_table'],
  ['42P07', 'duplicate_table'],
  ['55P03', 'lock_not_available'],
  ['57014', 'query_canceled'],
])

/**
 * The PostgreSQL condition name of a SQLSTATE code (`42P01` is `undefined_table`), or null for a code that is not in the
 * short list above (and for anything that is not a string). The name is a word of ours, so it is safe to print: it says what
 * kind of failure it was, which the bare code does not say to a person who does not know the codes by heart.
 */
export function sqlstateName(code) {
  return typeof code === 'string' ? (SQLSTATE_NAMES.get(code) ?? null) : null
}
