export class ApiError extends Error {
  constructor(status, code, message, extra) {
    super(message || code)
    this.status = status
    this.code = code
    this.extra = extra
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

/** A JSON number, or a non-blank numeric string. Blank strings, booleans, arrays, objects are errors. */
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
