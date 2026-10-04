import { randomBytes, scrypt, timingSafeEqual, createHash } from 'node:crypto'
import { promisify } from 'node:util'

// promisify() cannot pick one of the overloads of scrypt() (the one with `options`), so its type is written out here.
const scryptAsync = /** @type {(password: string, salt: Buffer, keylen: number, options: import('node:crypto').ScryptOptions) => Promise<Buffer>} */ (
  promisify(scrypt)
)
const N = 16384
const R = 8
const P = 1
const KEYLEN = 32

/** Format: scrypt$N$r$p$salt$hash (base64url). Salted and slow, unlike the old bare SHA-256. */
export async function hashPassword(password) {
  const salt = randomBytes(16)
  const hash = await scryptAsync(password, salt, KEYLEN, { N, r: R, p: P })
  return ['scrypt', N, R, P, salt.toString('base64url'), hash.toString('base64url')].join('$')
}

export async function verifyPassword(password, stored) {
  if (!stored || typeof password !== 'string') return false
  const parts = stored.split('$')
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false
  const [, n, r, p, salt, hash] = parts
  const expected = Buffer.from(hash, 'base64url')
  const actual = await scryptAsync(password, Buffer.from(salt, 'base64url'), expected.length, {
    N: Number(n),
    r: Number(r),
    p: Number(p),
  })
  return actual.length === expected.length && timingSafeEqual(actual, expected)
}

let dummyHash
/** Spends the same time as a real password check, so "unknown account" and "wrong password" look alike. */
export async function burnPasswordCheck(password) {
  dummyHash ??= hashPassword('not-a-real-password')
  await verifyPassword(String(password), await dummyHash)
}

/** Random secret token. Tokens are high-entropy, so a fast SHA-256 is enough for storage. */
export const randomToken = (prefix = '') => prefix + randomBytes(32).toString('base64url')

export const sha256 = (value) => createHash('sha256').update(value).digest('hex')
