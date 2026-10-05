// The server's own ping to its check on healthchecks.io (docs/adr/0007-observability-in-our-own-postgres.md, step 2). The
// owner's computer is not on all the time and the host has no alerts, so the server tells healthchecks.io itself, and
// healthchecks.io e-mails and notifies the owner. server/alerts.js is the only caller today.
//
// The address is a secret: anybody who has it can say that the app is fine, or failing. It lives in HEALTH_HEARTBEAT_URL,
// only in the Production environment of Vercel (docs/runbooks/secrets.md), and is read from the environment at every call,
// never kept. It is never logged, never returned and never written to a file, and neither is any part of it, and nothing is
// said about why a request failed beyond a fixed word in the result (a network error can quote the host name, and the
// address is the thing to protect). With no address, or one that is not safe to use, nothing at all happens: that is every
// Preview deployment, every local run and every test.
//
// What is sent: a POST with a plain-text body of at most HEARTBEAT_BODY_MAX_BYTES, to the address (`ok`), to the address with
// /fail added (`fail`) or with /log added (`log`: an event that does not change the state of the check). The caller writes the
// body, and AGENTS.md (Safety) says what it may hold: counts, route patterns, codes and dates written by shared/datetime.js,
// never a message, a requested path or personal data. The safety choices are those of the heartbeat of the backup
// (scripts/backup-db.mjs): https only, no user name or password in the address, redirect: 'error' (an answer that sends the
// secret address somewhere else is not an answer to trust), a timeout, and the answer is not read. The difference is that this
// one runs inside a request: exactly one try, no pause and no retry.
import { HEARTBEAT_TIMEOUT_MS, HEARTBEAT_BODY_MAX_BYTES } from './config.js'

/** The ending that each signal adds to the address. */
const SIGNAL_PATHS = Object.freeze({ ok: '', fail: '/fail', log: '/log' })

const TIMED_OUT = Symbol('timed out')

/**
 * The address to ping for `signal`, or null: HEALTH_HEARTBEAT_URL as it is now, when it is an https address without a user name
 * or a password, with /fail or /log added for those signals.
 * @param {string} signal  'ok', 'fail' or 'log'
 * @returns {URL | null}
 */
function targetFor(signal) {
  const text = String(process.env.HEALTH_HEARTBEAT_URL ?? '').trim()
  if (!text) return null
  let target
  try {
    target = new URL(text)
  } catch {
    return null
  }
  if (target.protocol !== 'https:' || target.username || target.password) return null
  // The ending goes on the path, before any query string that the address has.
  target.pathname = `${target.pathname.replace(/\/+$/, '')}${SIGNAL_PATHS[signal]}`
  return target
}

/** Whether HEALTH_HEARTBEAT_URL is set to an address that sendHeartbeat would use. Says nothing about the address. */
export function isHeartbeatConfigured() {
  return targetFor('ok') !== null
}

/**
 * `text` cut to at most `max` bytes of UTF-8, without cutting a character in half.
 * @param {string} text
 * @param {number} max
 */
export function cutToBytes(text, max) {
  const bytes = new TextEncoder().encode(text)
  if (bytes.length <= max) return text
  // A character that was cut in half decodes to U+FFFD, which is dropped: the result is never longer than `max` bytes.
  return new TextDecoder().decode(bytes.subarray(0, max)).replace(/\uFFFD+$/u, '')
}

/**
 * @typedef {object} HeartbeatResult
 * @property {boolean} sent  true when healthchecks.io answered 2xx
 * @property {string} [reason]  when not sent, one fixed word: `not_configured` (no address), `invalid_url` (not https, or a user name
 *   or a password in it), `bad_signal`, `timeout`, `rejected` (it answered, but not 2xx) or `failed` (no answer: a network
 *   error, a refused redirect). A word of ours, never the text of an error and never a part of the address.
 */

/**
 * Pings the check once and says whether it worked. Never throws, never logs, and never waits longer than `timeoutMs`
 * (even for a `fetcher` that ignores its signal and never answers).
 *
 * @param {object} [options]
 * @param {'ok' | 'fail' | 'log'} [options.signal]  which address: the base, base/fail or base/log (default `ok`)
 * @param {string} [options.body]  plain text, cut to HEARTBEAT_BODY_MAX_BYTES bytes. See the header for what it may hold
 * @param {typeof fetch} [options.fetcher]  fetch (a test passes its own, so that nothing reaches the network)
 * @param {number} [options.timeoutMs]  default HEARTBEAT_TIMEOUT_MS
 * @returns {Promise<HeartbeatResult>}
 */
export async function sendHeartbeat(options) {
  let timer
  try {
    const { signal = 'ok', body = '', fetcher = globalThis.fetch, timeoutMs = HEARTBEAT_TIMEOUT_MS } = options ?? {}
    if (!Object.hasOwn(SIGNAL_PATHS, signal)) return { sent: false, reason: 'bad_signal' }
    if (!String(process.env.HEALTH_HEARTBEAT_URL ?? '').trim()) return { sent: false, reason: 'not_configured' }
    const target = targetFor(signal)
    if (!target) return { sent: false, reason: 'invalid_url' }

    const text = cutToBytes(String(body ?? ''), HEARTBEAT_BODY_MAX_BYTES)
    const controller = new AbortController()
    // The abort frees the connection of a fetch that honours it; the race below is for one that does not. A late failure of the
    // request (after the timer won) is handled by the race itself: it listens to both.
    const answer = await Promise.race([
      fetcher(target.href, {
        method: 'POST',
        headers: { 'Content-Type': 'text/plain; charset=utf-8' },
        ...(text ? { body: text } : {}),
        // The address is a secret: an answer that sends it elsewhere is not an answer to trust.
        redirect: 'error',
        signal: controller.signal,
      }),
      new Promise((resolve) => {
        timer = setTimeout(() => {
          // Settle first, then abort: a fetch that rejects on abort must not win the race and be taken for a network error.
          resolve(TIMED_OUT)
          controller.abort()
        }, Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : HEARTBEAT_TIMEOUT_MS)
      }),
    ])
    if (answer === TIMED_OUT) return { sent: false, reason: 'timeout' }
    // The answer says OK and nothing else: it is not read, and the connection is let go (not waited for: this is inside a request).
    try {
      void answer.body?.cancel().catch(() => {})
    } catch {
      // nothing to say
    }
    return answer.status >= 200 && answer.status < 300 ? { sent: true } : { sent: false, reason: 'rejected' }
  } catch {
    // Silent on purpose: the message of a network error can name the host, and the host is part of the secret.
    return { sent: false, reason: 'failed' }
  } finally {
    clearTimeout(timer)
  }
}
