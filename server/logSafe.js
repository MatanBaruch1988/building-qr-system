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
