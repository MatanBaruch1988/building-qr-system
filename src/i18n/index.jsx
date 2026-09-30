import React, { createContext, useCallback, useContext, useLayoutEffect, useMemo, useState } from 'react'
import { LANGS, translate, pickLang, dirOf, makeFormatters, isLang } from './core.js'

const STORAGE_KEY = 'qr.lang'
const I18nContext = createContext(null)

const readStored = () => {
  try {
    return localStorage.getItem(STORAGE_KEY)
  } catch {
    return null
  }
}

/**
 * Provides t(), formatters and language switching. `providerLang` is the signed-in provider's
 * profile language; it applies only until the person picks a language on this phone.
 */
export function I18nProvider({ providerLang, children }) {
  const [stored, setStored] = useState(readStored)
  const lang = pickLang({ stored, provider: providerLang, browser: navigator.languages ?? [navigator.language] })
  const dir = dirOf(lang)

  useLayoutEffect(() => {
    document.documentElement.lang = lang
    document.documentElement.dir = dir
    document.title = translate(lang, 'app.name') // the tab / "add to home screen" title follows the language too
    return () => {
      // The admin screens are Hebrew-only for now.
      document.documentElement.lang = 'he'
      document.documentElement.dir = 'rtl'
      document.title = translate('he', 'app.name')
    }
  }, [lang, dir])

  const setLang = useCallback((code) => {
    if (!isLang(code)) return
    try {
      localStorage.setItem(STORAGE_KEY, code)
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
