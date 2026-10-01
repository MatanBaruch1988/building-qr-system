// The real Google ID-token verifier, exercised with tokens signed by a key pair generated here
// (production uses Google's published keys; everything else is identical).
import { describe, it, expect, beforeAll } from 'vitest'
import { SignJWT, generateKeyPair, exportJWK, createLocalJWKSet } from 'jose'
import { createGoogleVerifier } from '../server/google.js'

const CLIENT_ID = 'test-client.apps.googleusercontent.com'
let keys, privateKey, otherPrivateKey, verify

const token = ({ key = privateKey, iss = 'https://accounts.google.com', aud = CLIENT_ID, exp = '10m', claims = {} } = {}) =>
  new SignJWT({ email: 'Matan@Example.com', email_verified: true, name: 'Matan', ...claims })
    .setProtectedHeader({ alg: 'RS256', kid: 'k1' })
    .setIssuer(iss).setAudience(aud).setSubject('google-sub-1').setIssuedAt().setExpirationTime(exp)
    .sign(key)

beforeAll(async () => {
  const pair = await generateKeyPair('RS256')
  privateKey = pair.privateKey
  otherPrivateKey = (await generateKeyPair('RS256')).privateKey
  keys = createLocalJWKSet({ keys: [{ ...(await exportJWK(pair.publicKey)), kid: 'k1', alg: 'RS256', use: 'sig' }] })
  verify = createGoogleVerifier({ clientId: CLIENT_ID, keys })
})

describe('Google ID token verification', () => {
  it('accepts a genuine token and normalises the e-mail', async () => {
    expect(await verify(await token())).toEqual({ email: 'matan@example.com', name: 'Matan', sub: 'google-sub-1' })
    expect(await verify(await token({ iss: 'accounts.google.com' }))).toMatchObject({ email: 'matan@example.com' })
  })

  it.each([
    ['a token signed with someone else\'s key', () => token({ key: otherPrivateKey })],
    ['a token for another app (wrong audience)', () => token({ aud: 'someone-else.apps.googleusercontent.com' })],
    ['a token from another issuer', () => token({ iss: 'https://evil.example' })],
    ['an expired token', () => token({ exp: Math.floor(Date.now() / 1000) - 3600 })],
    ['garbage', () => 'not.a.jwt'],
    ['an empty string', () => ''],
  ])('refuses %s', async (_name, make) => {
    await expect(verify(await make())).rejects.toMatchObject({ status: 401, code: 'google_invalid' })
  })

  it('refuses an account whose e-mail Google has not verified', async () => {
    await expect(verify(await token({ claims: { email_verified: false } }))).rejects.toMatchObject({ status: 401, code: 'google_email_unverified' })
    await expect(verify(await token({ claims: { email_verified: 'true' } }))).rejects.toMatchObject({ code: 'google_email_unverified' })
    await expect(verify(await token({ claims: { email: undefined } }))).rejects.toMatchObject({ code: 'google_email_unverified' })
  })

  it('says so plainly when the server has no Google client id configured', async () => {
    const unconfigured = createGoogleVerifier({ clientId: undefined, keys })
    await expect(unconfigured(await token())).rejects.toMatchObject({ status: 503, code: 'google_not_configured' })
  })

  it('refuses an unsigned token (alg none)', async () => {
    const unsigned = `${Buffer.from('{"alg":"none"}').toString('base64url')}.${Buffer.from(JSON.stringify({ iss: 'https://accounts.google.com', aud: CLIENT_ID, email: 'a@b.c', email_verified: true, sub: 'x', exp: 9999999999 })).toString('base64url')}.`
    await expect(verify(unsigned)).rejects.toMatchObject({ code: 'google_invalid' })
  })
})
