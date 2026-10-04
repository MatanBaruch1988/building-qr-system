// "What is one of our QR codes": the one definition. The phone (src/worker/hooks.js) and the server (server/scans.js,
// server/routes/provider.js) both read a scanned code with it, so they cannot disagree about what a valid one is. The
// pattern itself is in shared/contract.js.
import { QR_TOKEN_RE } from './contract.js'

/** Accepts the full printed URL (…/scan?code=BQR-…) or the bare BQR-… token. Returns the token, or null. */
export function parseQrToken(input) {
  if (typeof input !== 'string') return null
  const raw = input.trim()
  if (QR_TOKEN_RE.test(raw)) return raw
  try {
    const code = new URL(raw).searchParams.get('code')
    return code && QR_TOKEN_RE.test(code) ? code : null
  } catch {
    return null
  }
}
