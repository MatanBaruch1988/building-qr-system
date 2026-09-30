// Tunable rules in one place. Kept as plain constants: this is a one-building app.

export const TIMEZONE = 'Asia/Jerusalem'

// Same provider + same point within this window is treated as one visit, not two.
export const SCAN_COOLDOWN_MINUTES = 10

// "Soft GPS" (see docs): a scan is only rejected when the phone reports a usable fix
// that is clearly far away. Anything vaguer is accepted and flagged.
export const GPS_MAX_USABLE_ACCURACY_M = 150
export const GPS_REJECT_MARGIN_M = 250

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
