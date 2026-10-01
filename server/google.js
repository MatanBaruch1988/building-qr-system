// "Sign in with Google" for the committee. The browser gets a signed ID token from Google (Google
// Identity Services); the server verifies it here and then checks the e-mail against the admins list.
import { createRemoteJWKSet, jwtVerify } from 'jose'
import { ApiError, unauthorized } from './http.js'

const GOOGLE_ISSUERS = ['https://accounts.google.com', 'accounts.google.com']
const googleKeys = createRemoteJWKSet(new URL('https://www.googleapis.com/oauth2/v3/certs'))

/**
 * Builds a verifier for one OAuth client id. `keys` is injectable so tests can sign their own tokens;
 * in production it is Google's published key set (fetched and cached by jose).
 */
export function createGoogleVerifier({ clientId, keys = googleKeys }) {
  return async function verify(credential) {
    if (!clientId) throw new ApiError(503, 'google_not_configured', 'Google sign-in is not configured on the server')
    let payload
    try {
      ;({ payload } = await jwtVerify(credential, keys, { issuer: GOOGLE_ISSUERS, audience: clientId }))
    } catch {
      throw unauthorized('google_invalid', 'Google sign-in could not be verified')
    }
    if (payload.email_verified !== true || typeof payload.email !== 'string' || typeof payload.sub !== 'string') {
      throw unauthorized('google_email_unverified', 'The Google account e-mail is not verified')
    }
    return { email: payload.email.toLowerCase(), name: typeof payload.name === 'string' ? payload.name : '', sub: payload.sub }
  }
}

let override = null
/** Tests replace the verifier; production leaves this null. */
export const setGoogleVerifier = (fn) => {
  override = fn
}

export const verifyGoogleCredential = (credential) =>
  (override ?? createGoogleVerifier({ clientId: process.env.GOOGLE_CLIENT_ID }))(credential)
