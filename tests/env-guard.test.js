// loadEnv refuses an env file that was pulled from Vercel production, and still never takes the platform's own keys.
// No database: each test writes a file into a temporary directory and process.env is restored afterwards.
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { loadEnv } from '../server/loadEnv.js'

const KEYS = ['VERCEL', 'VERCEL_ENV', 'VERCEL_TARGET_ENV', 'TURBO_TOKEN', 'NX_DAEMON', 'ENV_GUARD_TEST_VALUE']
let dir
let saved

const writeEnv = (text) => {
  const file = path.join(dir, '.env.local')
  fs.writeFileSync(file, text)
  return file
}

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'env-guard-'))
  saved = Object.fromEntries(KEYS.map((key) => [key, process.env[key]]))
  for (const key of KEYS) delete process.env[key]
})

afterEach(() => {
  for (const key of KEYS) {
    if (saved[key] === undefined) delete process.env[key]
    else process.env[key] = saved[key]
  }
  fs.rmSync(dir, { recursive: true, force: true })
})

describe('loadEnv and production', () => {
  it('throws on a file with VERCEL_ENV="production"', () => {
    const file = writeEnv('ENV_GUARD_TEST_VALUE=x\nVERCEL_ENV="production"\n')
    expect(() => loadEnv([file])).toThrow(/pulled from Vercel production/)
    expect(() => loadEnv([file])).toThrow(/non-production database/)
    expect(() => loadEnv([file])).toThrow(/\.env\.example/)
  })

  it('throws on VERCEL_TARGET_ENV=production without quotes', () => {
    const file = writeEnv('VERCEL_TARGET_ENV=production\n')
    expect(() => loadEnv([file])).toThrow(/pulled from Vercel production/)
  })

  it('throws on single quotes, spaces and Windows line endings too', () => {
    expect(() => loadEnv([writeEnv("VERCEL_ENV='production'\r\n")])).toThrow(/Vercel production/)
    expect(() => loadEnv([writeEnv('VERCEL_ENV= production \r\n')])).toThrow(/Vercel production/)
  })

  it('loads nothing from a refused file', () => {
    expect(() => loadEnv([writeEnv('ENV_GUARD_TEST_VALUE=x\nVERCEL_ENV="production"\n')])).toThrow()
    expect(process.env.ENV_GUARD_TEST_VALUE).toBeUndefined()
  })

  it('accepts VERCEL_ENV="development" and VERCEL_ENV="preview"', () => {
    expect(() => loadEnv([writeEnv('VERCEL_ENV="development"\n')])).not.toThrow()
    expect(() => loadEnv([writeEnv('VERCEL_ENV=preview\n')])).not.toThrow()
  })

  it('accepts a file without VERCEL_ENV and loads its values', () => {
    loadEnv([writeEnv('ENV_GUARD_TEST_VALUE="hello"\n')])
    expect(process.env.ENV_GUARD_TEST_VALUE).toBe('hello')
  })

  it('does not overwrite a value that is already set', () => {
    process.env.ENV_GUARD_TEST_VALUE = 'kept'
    loadEnv([writeEnv('ENV_GUARD_TEST_VALUE=other\n')])
    expect(process.env.ENV_GUARD_TEST_VALUE).toBe('kept')
  })

  it('never copies VERCEL, TURBO or NX keys into process.env', () => {
    loadEnv([writeEnv('VERCEL=1\nVERCEL_ENV="development"\nVERCEL_TARGET_ENV="development"\nTURBO_TOKEN=t\nNX_DAEMON=false\nENV_GUARD_TEST_VALUE=1\n')])
    expect(process.env.ENV_GUARD_TEST_VALUE).toBe('1')
    for (const key of ['VERCEL', 'VERCEL_ENV', 'VERCEL_TARGET_ENV', 'TURBO_TOKEN', 'NX_DAEMON']) {
      expect(process.env[key], key).toBeUndefined()
    }
  })

  it('skips a file that does not exist', () => {
    expect(() => loadEnv([path.join(dir, 'missing.env')])).not.toThrow()
  })
})
