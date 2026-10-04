// Thin fetch wrapper for the new /api. Always bounded by a timeout: a phone on one bar of signal
// must never leave a spinner hanging (the old app could).

/** @import { ErrorBody } from '../../shared/types.js' */

export class ApiError extends Error {
  /**
   * @param {number} status  the HTTP status, or 0 when the request never got a usable answer
   * @param {string} code  the machine's word for the failure (the `code` of the server's error, or 'timeout' / 'network' / 'bad_response')
   * @param {string} [message]
   * @param {ErrorBody} [extra]  the whole `error` member of the server's answer, when there was one
   */
  constructor(status, code, message, extra) {
    super(message || code)
    this.status = status // 0 = the request never got a usable answer (offline / timeout / cut off)
    this.code = code
    this.extra = extra
  }
  /** True when retrying later can work: no signal, timeout, a cut-off reply, or a server hiccup. */
  get transient() {
    return this.status === 0 || this.status >= 500
  }
}

/**
 * @typedef {object} ApiOptions
 * @property {string} [method]  default 'GET'
 * @property {unknown} [body]  sent as JSON; left out, a write sends `{}`
 * @property {string} [token]  the provider's device token, sent as a Bearer token
 * @property {number} [timeoutMs]  default 10 s
 * @property {AbortSignal} [signal]  aborts the request from the caller's side
 */

/**
 * Calls the API and returns the parsed JSON of a 2xx answer, or throws an ApiError.
 * @param {string} path  after /api, starting with a slash
 * @param {ApiOptions} [options]
 * @returns {Promise<any>}
 */
export async function api(path, { method = 'GET', body, token, timeoutMs = 10_000, signal } = {}) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort('timeout'), timeoutMs)
  if (signal) signal.addEventListener('abort', () => controller.abort('aborted'), { once: true })
  const noAnswer = (err) => new ApiError(0, controller.signal.reason === 'timeout' ? 'timeout' : 'network', err?.message)

  // The timer keeps running until the body has been read: headers arriving and then the body stalling
  // (one bar of signal) must time out too.
  try {
    let res
    try {
      res = await fetch(`/api${path}`, {
        method,
        signal: controller.signal,
        headers: {
          // The server requires JSON on every write (CSRF hardening), even bodiless DELETEs.
          ...(method !== 'GET' ? { 'Content-Type': 'application/json' } : {}),
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
        body: body === undefined ? (method === 'GET' ? undefined : '{}') : JSON.stringify(body),
      })
    } catch (err) {
      throw noAnswer(err)
    }

    let data = null
    let readable = true
    try {
      data = await res.json()
    } catch (err) {
      if (controller.signal.aborted) throw noAnswer(err) // cut off or timed out while reading
      readable = false
    }

    if (!res.ok) {
      /** @type {ErrorBody | undefined} */
      const e = data?.error
      throw new ApiError(res.status, e?.code ?? 'bad_response', e?.message ?? res.statusText, e)
    }
    // A 200 that is not our JSON (captive-portal page, truncated body) is not an answer from our server:
    // the visit was not recorded, so callers treat it like no signal and keep the data to retry.
    if (!readable || data === null) throw new ApiError(0, 'bad_response', 'Unexpected response')
    return data
  } finally {
    clearTimeout(timer)
  }
}
