// Whether a text looks like a secret: a key, a hash, a token or an id. It runs in the browser (the committee's audit log leaves such
// a text out of the screen: src/admin/auditDescribe.js) and on the server, so the shape is written once, here.
//
// The shapes of a secret. `prefix_body` is how every key and token of this app starts (a short word, an underscore, the
// rest); a long run of letters and digits with no space is a hash, a token or an id. Neither is a thing that the committee
// has any use for on a screen, so neither is shown, whatever key it was found under.
const PREFIXED_TOKEN = /^[a-z]{2,5}_[A-Za-z0-9_-]{6,}$/i
const LONG_RUN = /^[A-Za-z0-9+/_=.-]{24,}$/

/**
 * True for a text that looks like a key, a hash, a token or an id: `abc_def123456`, or 24 or more characters of letters,
 * digits and `+/_=.-` with no space and at least one digit and one letter.
 * @param {unknown} value
 */
export function looksSecret(value) {
  if (typeof value !== 'string') return false
  const text = value.trim()
  return PREFIXED_TOKEN.test(text) || (LONG_RUN.test(text) && /\d/.test(text) && /[A-Za-z]/.test(text))
}
