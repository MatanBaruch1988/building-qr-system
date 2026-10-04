// Server refusals that have their own plain-language message (i18n keys `error.<code>`) in every language.
// Anything else shows the generic "something went wrong, try again" message with a retry button.
import {
  SCAN_ERROR_INVALID_CODE, SCAN_ERROR_UNKNOWN_CODE, SCAN_ERROR_POINT_INACTIVE, SCAN_ERROR_NOT_ASSIGNED,
} from '../../shared/contract.js'

export const KNOWN_ERROR_CODES = [
  SCAN_ERROR_INVALID_CODE, SCAN_ERROR_UNKNOWN_CODE, SCAN_ERROR_POINT_INACTIVE, SCAN_ERROR_NOT_ASSIGNED, 'invalid_session',
]

const KNOWN = new Set(KNOWN_ERROR_CODES)

export const isKnownError = (code) => KNOWN.has(code)
export const errorMessageKey = (code) => (KNOWN.has(code) ? `error.${code}` : 'error.generic')
