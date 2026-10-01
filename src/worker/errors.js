// Server refusals that have their own plain-language message (i18n keys `error.<code>`) in every language.
// Anything else shows the generic "something went wrong, try again" message with a retry button.
export const KNOWN_ERROR_CODES = ['invalid_code', 'unknown_code', 'point_inactive', 'not_assigned', 'invalid_session']

const KNOWN = new Set(KNOWN_ERROR_CODES)

export const isKnownError = (code) => KNOWN.has(code)
export const errorMessageKey = (code) => (KNOWN.has(code) ? `error.${code}` : 'error.generic')
