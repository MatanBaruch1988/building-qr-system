// Pure i18n logic (no React), so it can be unit-tested.
import he from './he.js'
import en from './en.js'
import ru from './ru.js'
import ar from './ar.js'
import { formatTime } from '../../shared/datetime.js'

export const LANGS = [
  { code: 'he', label: 'עברית', dir: 'rtl' },
  { code: 'en', label: 'English', dir: 'ltr' },
  { code: 'ru', label: 'Русский', dir: 'ltr' },
  { code: 'ar', label: 'العربية', dir: 'rtl' },
]
export const DICTS = { he, en, ru, ar }
export const DEFAULT_LANG = 'he'
export const dirOf = (lang) => LANGS.find((l) => l.code === lang)?.dir ?? 'rtl'
/**
 * @param {unknown} code
 * @returns {code is string}
 */
export const isLang = (code) => LANGS.some((l) => l.code === code)

// Unicode "first strong isolate" … "pop directional isolate": keeps a name in another script
// (e.g. "Cleaning Co" inside Hebrew text) from scrambling the surrounding punctuation and numbers.
const FSI = '⁨'
const PDI = '⁩'

export function translate(lang, key, params) {
  const raw = DICTS[lang]?.[key] ?? DICTS[DEFAULT_LANG][key] ?? key
  if (!params) return raw
  return raw.replace(/\{(\w+)\}/g, (m, name) => (name in params ? `${FSI}${params[name]}${PDI}` : m))
}

/**
 * The person's own choice on this phone, otherwise Hebrew. The committee does not set a language for anyone: it is
 * the person's choice, kept on their phone (see I18nProvider), the same as light/dark.
 * The phone's own language is deliberately NOT used: most phones here are set to English, but the people
 * using this app expect it to open in Hebrew.
 * @param {{ stored?: unknown }} [options]  `stored` is whatever the phone had kept: a language code, nothing, or rubbish
 */
export function pickLang({ stored } = {}) {
  return isLang(stored) ? stored : DEFAULT_LANG
}

const LOCALES = { he: 'he-IL', en: 'en-GB', ru: 'ru-RU', ar: 'ar-u-nu-latn' } // Arabic with Western digits

export function makeFormatters(lang) {
  const locale = LOCALES[lang] ?? LOCALES.he
  const meters = new Intl.NumberFormat(locale, { style: 'unit', unit: 'meter', unitDisplay: 'short', maximumFractionDigits: 0 })
  const km = new Intl.NumberFormat(locale, { style: 'unit', unit: 'kilometer', unitDisplay: 'short', maximumFractionDigits: 1 })
  return {
    time: formatTime, // HH:MM in the building's time, the same in every language (shared/datetime.js)
    distance: (m) => (m >= 1000 ? km.format(m / 1000) : meters.format(Math.max(1, Math.round(m)))),
  }
}
