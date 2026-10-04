import { ApiError, assertSafeWrite, bad } from './http.js'

const routes = []

function compile(pattern) {
  return pattern.split('/').filter(Boolean)
}

export function route(method, pattern, handler) {
  routes.push({ method, pattern, segments: compile(pattern), handler })
}

/**
 * A frozen copy of every registered route as `{ method, path }` (the path pattern exactly as it was registered, with
 * `:name` for a parameter). It exists for tests/route-auth.test.js, which walks the table to prove that every route
 * that is not on its PUBLIC list refuses a request without credentials. Requests never use it.
 */
export function routeTable() {
  return Object.freeze(routes.map((r) => Object.freeze({ method: r.method, path: r.pattern })))
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
 * by more people than the committee. What is safe: the route that matched, as it is written in the code (`/admin/
 * providers/:id`, never the path that was asked for: a path segment or the query string can hold a QR code, a name or an
 * e-mail), the error's `name`, its `code` (for Postgres the SQLSTATE, which says what went wrong) and the stack frames
 * (where it happened). Not the `message`: a library or database error can quote an input or a row value in it (an
 * e-mail, a name, a coordinate), and flattening or cutting it does not make it safe. Everything is flattened to one line
 * and cut to a length.
 */
function describeUnhandled(matched, raw) {
  const flat = (value, max) => String(value).replace(/\s+/g, ' ').trim().slice(0, max)
  const parts = ['unhandled API error:', matched ? `${matched.method} /api/${matched.segments.join('/')}` : '(no route)']
  if (!(raw instanceof Error)) {
    // Anything can be thrown (a string, an object): its content is not known to be safe, so only its type is logged.
    parts.push(`thrown ${typeof raw}`)
    return parts.join(' ')
  }
  parts.push(flat(raw.name || 'Error', 60))
  if (typeof raw.code === 'string' || typeof raw.code === 'number') parts.push(`code=${flat(raw.code, 40)}`)
  const frames = stackFrames(raw).map((line) => flat(line, 300))
  if (frames.length) parts.push(`stack: ${frames.join(' | ')}`)
  return parts.join(' ')
}

/**
 * The frame lines of an error's stack, without the message. V8 starts the stack with "<name>: <message>", and the message
 * can hold newlines, so a line of it can look like a frame ("bad\n    at someone@example.com"). The header is cut off by
 * finding the message in it; when the message is not there (it was changed after the stack was taken), no frame is
 * trusted. After the header the frames are the lines that follow, up to the first line that is not a frame.
 */
function stackFrames(raw) {
  const stack = String(raw.stack ?? '')
  const message = String(raw.message ?? '')
  let rest = stack
  if (message) {
    const start = stack.indexOf(message)
    if (start < 0 || start > 200) return []
    rest = stack.slice(start + message.length)
  }
  const frames = []
  for (const line of rest.split('\n').slice(1)) {
    if (!/^\s*at /.test(line) || frames.length === 10) break
    frames.push(line)
  }
  return frames
}

/** Single entry point for every /api/* request (Vercel function and local dev server share it). */
export async function handle(req, res) {
  let matched = null
  try {
    const url = new URL(req.url, 'http://local')
    const path = url.pathname.replace(/^\/api/, '') || '/'

    let allowed = false
    for (const r of routes) {
      const params = match(r.segments, path)
      if (!params) continue
      allowed = true
      if (r.method !== req.method) continue
      matched = r
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
    console.error(describeUnhandled(matched, raw))
    return send(res, { status: 500, json: { error: { code: 'server_error', message: 'Something went wrong' } } })
  }
}
