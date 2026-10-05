// What happens when a screen breaks while it renders (the plumbing behind src/ui/ErrorBoundary.jsx): the one line that
// is logged, the words of the fallback screen, and the "Reload the app" action.
//
// Nothing here may depend on React state or on a provider (I18nProvider, the theme store): a fallback that needs the
// thing that broke is no fallback.
import { currentApp, APP_COMMITTEE } from '../appKind.js'
import { isUpdateReady, applyUpdate } from '../worker/update.js'
import { DEFAULT_LANG, dirOf, pickLang, readStoredLang, translate } from '../i18n/core.js'
import { noteClientError, currentPlace } from './errorReport.js'
import { ERROR_NAME_RE } from '../../shared/contract.js'

// An error's `name` is the class of the error (TypeError, RangeError, ...): not a value that anybody typed. Anything that
// does not look like such a name (a thrown string, an object with a free-text `name`) is reported as "UnknownError". The shape
// is ERROR_NAME_RE of shared/contract.js, the same one that the server applies to a name that an app reports.
export function errorName(error) {
  try {
    const name = error?.name
    return typeof name === 'string' && ERROR_NAME_RE.test(name) ? name : 'UnknownError'
  } catch {
    return 'UnknownError' // a getter that throws
  }
}

/**
 * The one line that is logged for a crash: which app and the error's name. Never the message, the stack or the
 * component stack: in a browser they can hold what a person typed (a name, a password field) or a value from the server,
 * the same rule as server/logSafe.js. There is no error reporting service: this line is all there is, for a person who
 * connects a phone to a computer to look at.
 */
export const crashLine = (error, app) => `Screen crash (${app} app): ${errorName(error)}`

export function logCrash(error, app = currentApp()) {
  console.error(crashLine(error, app))
}

/**
 * What is done for a crash: the console line (logCrash), and a note in the outbox of src/ui/errorReport.js (kind `crash`, the screen
 * that the app said it was showing, the error's name and nothing else), which goes to the server with the next report, after sign-in.
 * It never throws: a handler that fails inside React's error handler would only make things worse.
 */
export function reportCrash(error) {
  logCrash(error)
  try {
    noteClientError({ kind: 'crash', place: currentPlace(), name: errorName(error) })
  } catch {
    /* noteClientError does not throw; this is for currentPlace */
  }
}

/**
 * The options of createRoot (main.jsx). React's own handler for an error that a boundary caught prints the error with
 * its message and the component stack, so ours replaces it: it is the only way to keep those out of the console.
 * `onUncaughtError` is for what no boundary caught (the fallback itself breaking), which leaves a blank page. Both are a crash,
 * and both go to reportCrash.
 */
export const crashRootOptions = {
  onCaughtError: (error) => reportCrash(error),
  onUncaughtError: (error) => reportCrash(error),
}

// ---- what nothing caught ----------------------------------------------------------------------------------------------

/**
 * Is this the address of a file on our own origin? An error from another origin reaches `window` with its details hidden (its
 * `filename` is empty, or masked by the browser): the sign-in script of Google is the one that comes up, and it is not ours to report.
 * @param {unknown} filename  the `filename` of an ErrorEvent
 * @param {string} origin  `location.origin`
 */
export function isOwnOrigin(filename, origin) {
  if (typeof filename !== 'string' || filename === '') return false
  try {
    return new URL(filename).origin === origin
  } catch {
    return false // not an address
  }
}

/**
 * Starts noting what nothing caught: an error that reaches `window`, only when it comes from a file of our own origin (isOwnOrigin; a
 * cross-origin "Script error." says nothing and is ignored), and a promise that was rejected with nobody to handle it. Both are kind
 * `unhandled`, with the error's class as the name (errorName) or, for a rejection with something that is not an Error (a string, an
 * object, nothing), the fixed code `non_error`. The message, the file name and the line are never read. The default handling of the
 * browser stays as it is: nothing here prevents the console line, so it is not a way to hide an error. It never throws, which also keeps
 * a failure in here from raising the very events it listens for.
 * @param {object} [options]
 * @param {EventTarget} [options.target]
 * @param {string} [options.origin]
 * @param {import('../worker/storage.js').StorageLike} [options.storage]
 * @returns {() => void}  stops noting
 */
export function watchUnhandledErrors({ target = window, origin = window.location.origin, storage } = {}) {
  /** @param {Event} event */
  const onError = (event) => {
    try {
      const { filename, error } = /** @type {ErrorEvent} */ (event)
      if (!isOwnOrigin(filename, origin)) return
      noteClientError({ kind: 'unhandled', place: currentPlace(), name: errorName(error) }, storage)
    } catch {
      /* never an error inside an error handler */
    }
  }
  /** @param {Event} event */
  const onRejection = (event) => {
    try {
      const { reason } = /** @type {PromiseRejectionEvent} */ (event)
      const what = reason instanceof Error ? { name: errorName(reason) } : { code: 'non_error' }
      noteClientError({ kind: 'unhandled', place: currentPlace(), ...what }, storage)
    } catch {
      /* never an error inside an error handler */
    }
  }
  target.addEventListener('error', onError)
  target.addEventListener('unhandledrejection', onRejection)
  return () => {
    target.removeEventListener('error', onError)
    target.removeEventListener('unhandledrejection', onRejection)
  }
}

/**
 * The words of the fallback screen. The committee app is Hebrew only. The provider app is in the language that the
 * person chose on this phone, read straight from where I18nProvider saves it (the provider itself may be the thing
 * that broke), else Hebrew.
 */
export function crashText(app) {
  const lang = app === APP_COMMITTEE ? DEFAULT_LANG : pickLang({ stored: readStoredLang() })
  return {
    lang,
    dir: dirOf(lang),
    title: translate(lang, 'crash.title'),
    retry: translate(lang, 'crash.retry'),
    reload: translate(lang, 'crash.reload'),
  }
}

// If applying a waiting update does not reload the page by itself (the waiting worker is gone), reload after this long.
export const UPDATE_RELOAD_FALLBACK_MS = 4000

/**
 * "Reload the app". When a new version is already downloaded and waiting (src/worker/update.js), apply it: it reloads the
 * page into the new version, which may be the very fix for this crash. Otherwise a plain reload.
 *
 * It signs nobody out and clears nothing on the phone: a bug that is only passing must not sign every service provider out.
 * What was stored and cannot be used is dealt with where it is read (a session without provider details is removed by
 * loadSession in src/worker/session.js), so a stored value cannot keep this screen coming back.
 */
export function reloadApp({ updateReady = isUpdateReady, apply = applyUpdate, reload = () => window.location.reload() } = {}) {
  if (updateReady()) {
    try {
      apply()
      setTimeout(reload, UPDATE_RELOAD_FALLBACK_MS)
      return
    } catch {
      /* fall through to a plain reload */
    }
  }
  reload()
}
