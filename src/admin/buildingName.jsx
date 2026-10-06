import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react'
import { api } from '../api/client.js'

/** What the committee app is called when the committee has not named the building: the brand text and the end of the window title. */
export const APP_NAME = 'נוכחות בבניין'

/**
 * @typedef {object} BuildingNameState
 * @property {string} name
 * @property {(name: string) => void} setName  a name that the server has now (an answer to a save, or a read that is as new)
 * @property {(request: () => Promise<unknown>) => Promise<void>} loadName  a read that may be slow: its answer counts only if
 *   no `setName` came while it was on its way
 */

// Outside the provider (a screen drawn on its own, as the tests do): no name, and nothing to tell.
const NONE = /** @type {BuildingNameState} */ (Object.freeze({ name: '', setName: () => {}, loadName: async () => {} }))
const BuildingNameContext = createContext(NONE)

/**
 * Holds the building's name for the whole committee app: the sign-in screen, the side bar, the top bar and the title of the window
 * read it, and the Committee tab tells it when the name has been saved, so the brand follows at once with no reload.
 *
 * Where it comes from: the public route answers before anyone signs in (the sign-in screen shows the name), and it is also what the
 * brand shows until the committee's own route has answered (no flash of the plain brand on a reload). The committee's own answer
 * (`setName`, from the shell after sign-in and from the Committee tab) is the one that counts: an older public answer that arrives
 * after it (the CDN may keep that route for a minute) never replaces it. The same holds for the shell's own read of the name
 * (`loadName`): if a save in the Committee tab came while it was on its way, its answer is older than the save and is dropped.
 * A failed request changes nothing: the plain brand stays.
 * @param {{ children: import('react').ReactNode }} props
 */
export function BuildingNameProvider({ children }) {
  const [name, setNameState] = useState('')
  const settled = useRef(false)
  const told = useRef(0) // how many times setName was called: a read that started before the last one is older than it
  const setName = useCallback((/** @type {string} */ next) => {
    settled.current = true
    told.current += 1
    setNameState(next)
  }, [])
  const loadName = useCallback(async (/** @type {() => Promise<unknown>} */ request) => {
    const asked = told.current
    const next = await request()
    if (typeof next === 'string' && told.current === asked) setName(next)
  }, [setName])

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

  const value = useMemo(() => ({ name, setName, loadName }), [name, setName, loadName])
  return <BuildingNameContext.Provider value={value}>{children}</BuildingNameContext.Provider>
}

/**
 * The building's name ('' for none), `setName`, which tells the app a name that the server has now, and `loadName`, for a read
 * that a save may overtake.
 * @returns {BuildingNameState}
 */
export function useBuildingName() {
  return useContext(BuildingNameContext)
}
