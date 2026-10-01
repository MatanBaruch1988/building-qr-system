// Tunable rules in one place. Kept as plain constants: this is a one-building app.

export const TIMEZONE = 'Asia/Jerusalem'

// Same provider + same point within this window is treated as one visit, not two.
export const SCAN_COOLDOWN_MINUTES = 10

// "Soft GPS" (see docs): a reading counts only when the phone says it is accurate to within this many metres.
// A vaguer one (or none) cannot be judged: 'required' points refuse it, 'optional' points accept and flag it.
export const GPS_MAX_USABLE_ACCURACY_M = 150

// When a reading counts, the phone has to be inside the point's circle, with two allowances (every judged mode):
//  - a few metres for a pin that was placed by hand on a map,
//  - the phone's own reported inaccuracy (a weak reading is not the worker's fault), credited up to a cap so a
//    very vague reading cannot stretch the circle far.
// At the usual outdoor accuracy (~10 m) a 50 m point therefore accepts up to ~75 m; at most 50 + 15 + 50 = 115 m.
export const GPS_PIN_TOLERANCE_M = 15
export const GPS_MAX_ACCURACY_CREDIT_M = 50

// Offline scans keep the phone's clock only if it is plausible.
export const MAX_SYNC_BATCH = 20
export const CLOCK_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000
export const CLOCK_MAX_FUTURE_MS = 5 * 60 * 1000
export const CLOCK_SKEW_FLAG_MS = 5 * 60 * 1000

// Login throttling (per 15-minute window). Every attempt is charged BEFORE the password is checked,
// so a burst of parallel guesses cannot slip through, and each attempt counts on three levels:
//  - this account from this network address (a typo-prone person is not locked out by strangers),
//  - this account overall (a slow distributed guesser still hits a wall),
//  - this network address overall (bounds the scrypt CPU an attacker can burn).
export const LOGIN_MAX_FAILURES = 8
export const LOGIN_MAX_PER_ACCOUNT = 40
export const LOGIN_MAX_PER_IP = 60
export const LOGIN_WINDOW_MINUTES = 15

export const ADMIN_SESSION_DAYS = 14
export const ADMIN_COOKIE = 'qr_admin'

export const PASSWORD_MIN_LENGTH = 8
export const SERVICE_LANGS = ['he', 'en', 'ru', 'ar']

export const DEFAULT_PAGE_SIZE = 100
export const MAX_PAGE_SIZE = 500
