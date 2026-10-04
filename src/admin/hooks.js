import { useCallback, useEffect, useRef, useState } from 'react'

/** Loads data once, then on demand. Keeps the previous data on screen while reloading. */
export function useLoad(fn, deps = []) {
  const [state, setState] = useState({ status: 'loading', data: null, error: null })
  const fnRef = useRef(fn)
  fnRef.current = fn
  const load = useCallback(async () => {
    try {
      const data = await fnRef.current()
      setState({ status: 'ready', data, error: null })
    } catch (error) {
      setState((s) => ({ status: 'error', data: s.data, error }))
    }
  }, [])
  // eslint-disable-next-line react-hooks/exhaustive-deps -- the caller's `deps` decide when to load again; `load` never changes
  useEffect(() => { load() }, deps)
  return { ...state, reload: load }
}

export const SERVICE_TYPES = [
  { value: 'cleaning', label: 'ניקיון' },
  { value: 'gardening', label: 'גינון' },
  { value: 'maintenance', label: 'תחזוקה' },
  { value: 'other', label: 'אחר' },
]
export const serviceLabel = (value) => SERVICE_TYPES.find((s) => s.value === value)?.label ?? value ?? ''

// Every date and time on the committee screens is written by the shared module: DD/MM/YYYY and HH:MM.
export { formatDateTime } from '../../shared/datetime.js'
