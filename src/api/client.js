// Thin fetch wrapper for the new /api. Always bounded by a timeout: a phone on one bar of signal
// must never leave a spinner hanging (the old app could).

export class ApiError extends Error {
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
