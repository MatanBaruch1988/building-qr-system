/**
 * A request as the handlers see it: a Node request, with the parsed JSON in `body` (on Vercel `body` is a lazy getter that
 * throws on malformed JSON; the dev server sets it eagerly, see readBody in server/router.js).
 * @typedef {import('node:http').IncomingMessage & { body?: unknown }} ApiRequest
 */

/**
 * The complete answer of a route (what a handler returns, or what an Answer carries): `json` is the body, unless `text`
 * is set, and `headers` are added to the defaults of send() in server/router.js.
 * @typedef {object} SendResult
 * @property {number} [status]  default 200
 * @property {unknown} [json]
 * @property {string} [text]
 * @property {Record<string, string>} [headers]
 */

export class ApiError extends Error {
  /**
   * @param {number} status  the HTTP status
   * @param {string} code  the machine's word for the refusal (the `code` of the error that the client reads)
   * @param {string} [message]  an English sentence for a developer or a log (default: the code)
   * @param {Record<string, unknown>} [extra]  more fields for the `error` of the answer, for example `{ field }`
   */
  constructor(status, code, message, extra) {
    super(message || code)
    this.status = status
    this.code = code
    this.extra = extra
  }
}

/**
 * A complete answer (`{ status, json }`, the shape that a handler returns) that is thrown instead of returned, and that the
 * router sends as it is. It exists for a guard: a guard runs before the handler, so it cannot return the answer of its route,
 * and a failure of the guard itself (a database that is down) has to be answered in the shape of that route. Only
 * GET /api/health/db needs it (server/health.js). A refusal is still an ApiError.
 */
export class Answer {
  /** @param {SendResult} out */
  constructor(out) {
    this.out = out
  }
}

export const bad = (code, message, extra) => new ApiError(400, code, message, extra)
export const unauthorized = (code = 'unauthorized', message = 'Sign in required') =>
  new ApiError(401, code, message)
export const forbidden = (code = 'forbidden', message = 'Not allowed') => new ApiError(403, code, message)
export const notFound = (code = 'not_found', message = 'Not found') => new ApiError(404, code, message)
export const conflict = (code = 'conflict', message = 'Conflict') => new ApiError(409, code, message)

export function clientIp(req) {
  const fwd = req.headers['x-forwarded-for']
  if (fwd) return String(fwd).split(',')[0].trim()
  return req.socket?.remoteAddress || 'unknown'
}

/** A malformed cookie value must never turn into a 500: treat it as "no cookie". */
export function getCookie(req, name) {
  const header = req.headers.cookie
  if (!header) return null
  for (const part of header.split(';')) {
    const [k, ...rest] = part.trim().split('=')
    if (k !== name) continue
    try {
      return decodeURIComponent(rest.join('='))
    } catch {
      return null
    }
  }
  return null
}

/**
 * @typedef {object} CookieOptions
 * @property {number} [maxAgeSeconds]  how long the browser keeps the cookie; left out, it is a session cookie
 * @property {boolean} [secure]  `Secure`, true unless said otherwise (only the local dev server over http turns it off)
 */

/**
 * @param {string} name
 * @param {string} value
 * @param {CookieOptions} [options]
 */
export function cookieHeader(name, value, { maxAgeSeconds, secure = true } = {}) {
  const attrs = [`${name}=${encodeURIComponent(value)}`, 'Path=/', 'HttpOnly', 'SameSite=Lax']
  if (secure) attrs.push('Secure')
  if (maxAgeSeconds !== undefined) attrs.push(`Max-Age=${maxAgeSeconds}`)
  return attrs.join('; ')
}

export function bearerToken(req) {
  const h = req.headers.authorization || ''
  const m = /^Bearer\s+(\S+)$/i.exec(h)
  return m ? m[1] : null
}

/** The host the browser actually used (behind a proxy the Host header can be rewritten). */
const publicHost = (req) => String(req.headers['x-forwarded-host'] || req.headers.host || '').split(',')[0].trim()

/**
 * Cheap CSRF defence for cookie-authenticated writes: JSON only, and if the browser sent an
 * Origin it must be this host. (SameSite=Lax on the cookie is the first line of defence.)
 */
export function assertSafeWrite(req) {
  if (req.method === 'GET' || req.method === 'HEAD') return
  const type = String(req.headers['content-type'] || '')
  if (!type.toLowerCase().startsWith('application/json')) {
    throw bad('json_required', 'Content-Type must be application/json')
  }
  const origin = req.headers.origin
  if (origin) {
    let host
    try {
      host = new URL(origin).host
    } catch {
      throw forbidden('bad_origin', 'Bad origin')
    }
    if (host !== publicHost(req)) throw forbidden('bad_origin', 'Cross-origin write refused')
  }
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
export const isUuid = (v) => typeof v === 'string' && UUID_RE.test(v)

/** Returns the id in canonical lower-case (Postgres treats upper/lower case ids as the same row). */
export function requireUuid(value, code = 'invalid_id') {
  if (!isUuid(value)) throw bad(code, 'Invalid id')
  return value.toLowerCase()
}

/**
 * @typedef {object} StrOptions
 * @property {string} [field]  the name that a refusal reports (`{ field }` in the error); every caller passes it
 * @property {number} [max]  the longest text, in characters (default 200)
 * @property {boolean} [required]  a missing value is a 400 `missing_field` (default false: a missing value is `undefined`)
 * @property {boolean} [nonEmpty]  a blank text is a 400 `missing_field` too (default false)
 */

/**
 * A trimmed text, `undefined` when the value is missing and not required. Anything but a text is a 400.
 * @param {unknown} value
 * @param {StrOptions} [options]
 * @returns {string | undefined}
 */
export function str(value, { field, max = 200, required = false, nonEmpty = false } = {}) {
  if (value === undefined || value === null) {
    if (required) throw bad('missing_field', `${field} is required`, { field })
    return undefined
  }
  if (typeof value !== 'string') throw bad('invalid_field', `${field} must be text`, { field })
  const v = value.trim()
  if ((required || nonEmpty) && !v) throw bad('missing_field', `${field} is required`, { field })
  if (v.length > max) throw bad('invalid_field', `${field} is too long`, { field })
  return v
}

/**
 * @typedef {object} NumOptions
 * @property {string} [field]  the name that a refusal reports (`{ field }` in the error); every caller passes it
 * @property {number} [min]  the smallest value that is accepted (default: no limit)
 * @property {number} [max]  the largest value that is accepted (default: no limit)
 * @property {boolean} [integer]  only a whole number is accepted (default false)
 * @property {boolean} [required]  a missing value is a 400 `missing_field` (default false: a missing value is `undefined`)
 */

/**
 * A JSON number, or a non-blank numeric string. Blank strings, booleans, arrays, objects are errors.
 * @param {unknown} value
 * @param {NumOptions} [options]
 * @returns {number | undefined}
 */
export function num(value, { field, min = -Infinity, max = Infinity, integer = false, required = false } = {}) {
  if (value === undefined || value === null) {
    if (required) throw bad('missing_field', `${field} is required`, { field })
    return undefined
  }
  const isNumber = typeof value === 'number'
  const isNumeric = typeof value === 'string' && value.trim() !== ''
  const n = isNumber ? value : isNumeric ? Number(value) : NaN
  if (!Number.isFinite(n) || n < min || n > max || (integer && !Number.isInteger(n))) {
    throw bad('invalid_field', `${field} is out of range`, { field })
  }
  return n
}

/**
 * CSV with UTF-8 BOM (so Excel opens Hebrew/Arabic/Cyrillic correctly) unless `bom: false` (machine
 * consumers). Text cells that a spreadsheet would run as a formula are neutralised with a leading '.
 */
export function toCsv(rows, columns, { bom = true } = {}) {
  const esc = (v) => {
    if (v === null || v === undefined) return ''
    let s = Array.isArray(v) ? v.join(';') : v instanceof Date ? v.toISOString() : String(v)
    if (typeof v === 'string' && /^[=+\-@\t\r]/.test(s)) s = `'${s}`
    return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
  }
  const lines = [columns.join(',')]
  for (const row of rows) lines.push(columns.map((c) => esc(row[c])).join(','))
  return (bom ? '﻿' : '') + lines.join('\r\n') + '\r\n'
}
