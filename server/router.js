import { ApiError, assertSafeWrite, bad } from './http.js'

const routes = []

function compile(pattern) {
  return pattern.split('/').filter(Boolean)
}

export function route(method, pattern, handler) {
  routes.push({ method, segments: compile(pattern), handler })
}

function match(segments, path) {
  const parts = path.split('/').filter(Boolean)
  if (parts.length !== segments.length) return null
  const params = {}
  for (let i = 0; i < segments.length; i++) {
    if (segments[i].startsWith(':')) {
      try {
        params[segments[i].slice(1)] = decodeURIComponent(parts[i])
      } catch {
        throw bad('bad_request', 'Malformed URL')
      }
    } else if (segments[i] !== parts[i]) return null
  }
  return params
}

function send(res, { status = 200, json, text, headers = {} }) {
  res.statusCode = status
  res.setHeader('Cache-Control', 'no-store')
  for (const [k, v] of Object.entries(headers)) res.setHeader(k, v)
  if (text !== undefined) {
    if (!res.getHeader('Content-Type')) res.setHeader('Content-Type', 'text/plain; charset=utf-8')
    res.end(text)
  } else {
    res.setHeader('Content-Type', 'application/json; charset=utf-8')
    res.end(JSON.stringify(json ?? {}))
  }
}

/** On Vercel `req.body` is a lazy getter that throws on malformed JSON; the dev server sets it eagerly. */
function readBody(req) {
  let body
  try {
    body = req.body
  } catch {
    throw bad('invalid_json', 'Invalid JSON')
  }
  return body && typeof body === 'object' && !Array.isArray(body) ? body : {}
}

/** Database "bad data" errors are the caller's fault (400/409), not a server fault. */
function fromDatabaseError(err) {
  const code = typeof err?.code === 'string' ? err.code : ''
  if (code.startsWith('22')) return new ApiError(400, 'invalid_input', 'A value is out of range or malformed')
  if (code === '23505' || code === '23503') return new ApiError(409, 'conflict', 'Conflicts with existing data')
  return null
}

/**
 * The one log line for an error that no route handled, built only from fields that cannot carry personal data.
 * Never log the raw error: a Postgres error also carries `detail` (usually the values of the failing row, for example
 * "Key (email)=(...) already exists."), `where`, `table`, `column` and `parameters`, and the runtime logs are kept and read
 * by more people than the committee. What is safe: the method, the path without the query string (that can hold a QR
 * code or a name), the error's `name`, its `code` (for Postgres the SQLSTATE, which says what went wrong) and the stack
 * frames (where it happened). Not the `message`: a library or database error can quote an input or a row value in it
 * (an e-mail, a name, a coordinate), and flattening or cutting it does not make it safe. The stack is kept only from its
 * frame lines, because its first line repeats the message. Everything is flattened to one line and cut to a length.
 */
function describeUnhandled(req, raw) {
  const flat = (value, max) => String(value).replace(/\s+/g, ' ').trim().slice(0, max)
  const parts = ['unhandled API error:', flat(req?.method ?? '', 10), flat(String(req?.url ?? '').split(/[?#]/)[0], 200)]
  if (!(raw instanceof Error)) {
    // Anything can be thrown (a string, an object): its content is not known to be safe, so only its type is logged.
    parts.push(`thrown ${typeof raw}`)
    return parts.join(' ')
  }
  parts.push(flat(raw.name || 'Error', 60))
  if (typeof raw.code === 'string' || typeof raw.code === 'number') parts.push(`code=${flat(raw.code, 40)}`)
  const frames = String(raw.stack ?? '')
    .split('\n')
    .filter((line) => /^\s*at /.test(line))
    .slice(0, 10)
    .map((line) => flat(line, 300))
  if (frames.length) parts.push(`stack: ${frames.join(' | ')}`)
  return parts.join(' ')
}

/** Single entry point for every /api/* request (Vercel function and local dev server share it). */
export async function handle(req, res) {
  try {
    const url = new URL(req.url, 'http://local')
    const path = url.pathname.replace(/^\/api/, '') || '/'

    let allowed = false
    for (const r of routes) {
      const params = match(r.segments, path)
      if (!params) continue
      allowed = true
      if (r.method !== req.method) continue
      assertSafeWrite(req)
      const out = await r.handler({
        req,
        res,
        url,
        params,
        query: Object.fromEntries(url.searchParams),
        body: readBody(req),
      })
      const shaped = out && (out.json !== undefined || out.text !== undefined || out.status) ? out : { json: out }
      return send(res, shaped)
    }
    throw allowed
      ? new ApiError(405, 'method_not_allowed', 'Method not allowed')
      : new ApiError(404, 'not_found', 'Unknown endpoint')
  } catch (raw) {
    const err = raw instanceof ApiError ? raw : fromDatabaseError(raw)
    if (err) {
      return send(res, {
        status: err.status,
        json: { error: { code: err.code, message: err.message, ...(err.extra || {}) } },
      })
    }
    console.error(describeUnhandled(req, raw))
    return send(res, { status: 500, json: { error: { code: 'server_error', message: 'Something went wrong' } } })
  }
}
