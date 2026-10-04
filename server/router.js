import { Answer, ApiError, assertSafeWrite, bad } from './http.js'
import { accessFor } from './access.js'

const routes = []

function compile(pattern) {
  return pattern.split('/').filter(Boolean)
}

/**
 * Registers a route. Its access (public, or the guard of its role) comes from the policy in server/access.js and is fixed
 * here, so this throws for a route that the policy does not cover and the server cannot start with an unguarded route.
 * There is deliberately nothing else to pass and no other way to register a route.
 */
export function route(method, pattern, handler) {
  const access = accessFor(method, pattern)
  if (access.public !== true && typeof access.check !== 'function') {
    throw new Error(`${method} ${pattern} has no guard: the access policy (server/access.js) gave it neither public nor a check`)
  }
  routes.push({ method, pattern, segments: compile(pattern), handler, access })
}

/**
 * A frozen copy of every registered route as `{ method, path }` (the path pattern exactly as it was registered, with
 * `:name` for a parameter). It exists for tests/route-auth.test.js, which walks the table to prove that every route
 * that is not on its PUBLIC list refuses a request without credentials. Requests never use it.
 */
export function routeTable() {
  return Object.freeze(routes.map((r) => Object.freeze({ method: r.method, path: r.pattern })))
}

function decode(part) {
  try {
    return decodeURIComponent(part)
  } catch {
    throw bad('bad_request', 'Malformed URL')
  }
}

/**
 * Whether the path is this route's: the same number of segments and the same text in every fixed one. It reads no
 * parameter (nothing is decoded), so finding the route says nothing about the values in the path.
 */
function matches(segments, path) {
  const parts = path.split('/').filter(Boolean)
  if (parts.length !== segments.length) return false
  return segments.every((segment, i) => segment.startsWith(':') || segment === parts[i])
}

/**
 * The values of the `:name` parameters of a path that `matches`, decoded. They are for the handler, so they are built only
 * after the guard of the route has let the request in; a segment that is not valid percent-encoding is a 400 `bad_request`
 * from there on. (Without a route for the method, no guard and no handler run: see the end of handle().)
 */
function paramsOf(segments, path) {
  const parts = path.split('/').filter(Boolean)
  const params = {}
  for (let i = 0; i < segments.length; i++) {
    if (segments[i].startsWith(':')) params[segments[i].slice(1)] = decode(parts[i])
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

    const sameShape = [] // the routes of this path, whatever their method
    for (const r of routes) {
      if (!matches(r.segments, path)) continue
      sameShape.push(r)
      if (r.method !== req.method) continue
      matched = r
      assertSafeWrite(req)
      // The guard of the route runs before anything else: no code of the handler, and nothing of the request that is made
      // for it (the body, the query, the parameters), until the guard has let the request in. A refusal ends the request.
      const auth = r.access.public === true ? undefined : await r.access.check(req)
      const out = await r.handler({
        req,
        res,
        url,
        params: paramsOf(r.segments, path),
        query: Object.fromEntries(url.searchParams),
        body: readBody(req),
        auth,
      })
      const shaped = out && (out.json !== undefined || out.text !== undefined || out.status) ? out : { json: out }
      return send(res, shaped)
    }
    if (sameShape.length) {
      // The path is a route's but not for this method (405). No guard and no handler run for it, so nothing is exposed by
      // checking the parameters here: a malformed one is the same 400 as it always was for such a path.
      for (const r of sameShape) paramsOf(r.segments, path)
      throw new ApiError(405, 'method_not_allowed', 'Method not allowed')
    }
    throw new ApiError(404, 'not_found', 'Unknown endpoint')
  } catch (raw) {
    if (raw instanceof Answer) return send(res, raw.out)
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
