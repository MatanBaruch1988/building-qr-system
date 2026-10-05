// What happens when a screen breaks while it renders (the plumbing behind src/ui/ErrorBoundary.jsx): the one line that
// is logged, the words of the fallback screen, and the "Reload the app" action.
//
// Nothing here may depend on React state or on a provider (I18nProvider, the theme store): a fallback that needs the
// thing that broke is no fallback.
import { currentApp, APP_COMMITTEE } from '../appKind.js'
import { isUpdateReady, applyUpdate } from '../worker/update.js'
import { DEFAULT_LANG, dirOf, pickLang, readStoredLang, translate } from '../i18n/core.js'

// An error's `name` is the class of the error (TypeError, RangeError, ...): not a value that anybody typed. Anything that
// does not look like such a name (a thrown string, an object with a free-text `name`) is reported as "UnknownError".
const NAME_SHAPE = /^[A-Za-z][A-Za-z0-9_$]{0,63}$/

export function errorName(error) {
  try {
    const name = error?.name
    return typeof name === 'string' && NAME_SHAPE.test(name) ? name : 'UnknownError'
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
 * The options of createRoot (main.jsx). React's own handler for an error that a boundary caught prints the error with
 * its message and the component stack, so ours replaces it: it is the only way to keep those out of the console.
 * `onUncaughtError` is for what no boundary caught (the fallback itself breaking), which leaves a blank page.
 */
export const crashRootOptions = {
  onCaughtError: (error) => logCrash(error),
  onUncaughtError: (error) => logCrash(error),
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
