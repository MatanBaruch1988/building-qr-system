import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react'
import { api } from '../api/client.js'

/** What the committee app is called when the committee has not named the building: the brand text and the end of the window title. */
export const APP_NAME = 'נוכחות בבניין'

/** @typedef {{ name: string, setName: (name: string) => void }} BuildingNameState */

// Outside the provider (a screen drawn on its own, as the tests do): no name, and nothing to tell.
const NONE = /** @type {BuildingNameState} */ (Object.freeze({ name: '', setName: () => {} }))
const BuildingNameContext = createContext(NONE)

/**
 * Holds the building's name for the whole committee app: the sign-in screen, the side bar, the top bar and the title of the window
 * read it, and the Committee tab tells it when the name has been saved, so the brand follows at once with no reload.
 *
 * Where it comes from: the public route answers before anyone signs in (the sign-in screen shows the name), and it is also what the
 * brand shows until the committee's own route has answered (no flash of the plain brand on a reload). The committee's own answer
 * (`setName`, from the shell after sign-in and from the Committee tab) is the one that counts: an older public answer that arrives
 * after it (the CDN may keep that route for a minute) never replaces it. A failed request changes nothing: the plain brand stays.
 * @param {{ children: import('react').ReactNode }} props
 */
export function BuildingNameProvider({ children }) {
  const [name, setNameState] = useState('')
  const settled = useRef(false)
  const setName = useCallback((/** @type {string} */ next) => {
    settled.current = true
    setNameState(next)
  }, [])

  useEffect(() => {
    let cancelled = false
    api('/public/building', { timeoutMs: 8000 })
      .then((res) => {
        const next = res?.building?.name
        if (typeof next === 'string' && !settled.current && !cancelled) setNameState(next)
      })
      .catch(() => {}) // no signal or a server hiccup: the plain brand
    return () => {
      cancelled = true
    }
  }, [])

  const value = useMemo(() => ({ name, setName }), [name, setName])
  return <BuildingNameContext.Provider value={value}>{children}</BuildingNameContext.Provider>
}

/**
 * The building's name ('' for none) and `setName`, which tells the app a name that the server has now.
 * @returns {BuildingNameState}
 */
export function useBuildingName() {
  return useContext(BuildingNameContext)
}
