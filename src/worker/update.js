// "A new version is ready" plumbing between the service worker (main.jsx) and the UI.
// The new version is never applied on its own: a reload in the middle of a check-in would lose it.
let ready = false
let apply = null
const listeners = new Set()

export const setUpdater = (fn) => {
  apply = fn
}
export const markUpdateReady = () => {
  ready = true
  listeners.forEach((l) => l())
}
export const isUpdateReady = () => ready
export const subscribeUpdate = (l) => {
  listeners.add(l)
  return () => listeners.delete(l)
}
export const applyUpdate = () => apply?.(true)
