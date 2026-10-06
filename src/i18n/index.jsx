import { createContext, useCallback, useContext, useLayoutEffect, useMemo, useState } from 'react'
import { LANGS, LANG_STORAGE_KEY, readStoredLang, translate, pickLang, dirOf, makeFormatters, isLang, pageTitle } from './core.js'

const I18nContext = createContext(null)

/**
 * Provides t(), formatters and language switching. The language is the person's own choice: it is saved on this phone
 * (localStorage, like the light/dark choice) only when they change it, and it stays after signing out. Until then the
 * app is in Hebrew. `buildingName` is the building's name, if the committee set one: the title of the window starts with it.
 */
export function I18nProvider({ children, buildingName = '' }) {
  const [stored, setStored] = useState(readStoredLang)
  const lang = pickLang({ stored })
  const dir = dirOf(lang)

  useLayoutEffect(() => {
    document.documentElement.lang = lang
    document.documentElement.dir = dir
    document.title = pageTitle(lang, buildingName) // the tab / "add to home screen" title follows the language too
    return () => {
      // The admin screens are Hebrew-only for now.
      document.documentElement.lang = 'he'
      document.documentElement.dir = 'rtl'
      document.title = translate('he', 'app.name')
    }
  }, [lang, dir, buildingName])

  const setLang = useCallback((code) => {
    if (!isLang(code)) return
    try {
      localStorage.setItem(LANG_STORAGE_KEY, code)
    } catch {
      /* private mode: the choice just won't persist */
    }
    setStored(code)
  }, [])

  const value = useMemo(
    () => ({
      lang,
      dir,
      setLang,
      langs: LANGS,
      t: (key, params) => translate(lang, key, params),
      ...makeFormatters(lang),
    }),
    [lang, dir, setLang],
  )
  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>
}

export function useI18n() {
  const ctx = useContext(I18nContext)
  if (!ctx) throw new Error('useI18n must be used inside <I18nProvider>')
  return ctx
}
