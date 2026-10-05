// Which tab of the committee app is open. The address says it (`/admin#history`), so that a reload, the back button and a
// link to a tab all land on the same tab.
//
// The address is an external store, and React reads it with `useSyncExternalStore`. After it has subscribed, React reads the
// store once more and draws again if the value moved. That closes the window between the first render and the moment the
// listener is attached: a plain `useState` that read the address in its initial state, and attached a `hashchange` listener
// in an effect, lost a change that came in between (a link opened right after sign-in) and stayed on the first tab.
//
// The app changes the tab by setting `location.hash`, and the browser fires `hashchange` for that, so the subscription
// below is all the store needs. A change made with `history.replaceState` or `pushState` fires nothing: whoever adds one has
// to tell the store (call the `onChange` that `subscribe` was given) or use `location.hash` instead.
import { useSyncExternalStore } from 'react'

/**
 * The tab that the address names: the key after the `#`, or the first key when the address names none of them (no
 * hash, or one that is not a tab). The first of `keys` is therefore the tab that opens by default.
 * @param {string[]} keys
 * @param {string} [hash]  default: the address of the page now
 * @returns {string}
 */
export const tabFromHash = (keys, hash = window.location.hash) => keys.find((key) => key === hash.slice(1)) ?? keys[0]

/** One function for the life of the module, so that React does not subscribe again on every render. */
function subscribe(onChange) {
  window.addEventListener('hashchange', onChange)
  return () => window.removeEventListener('hashchange', onChange)
}

/** Opens a tab: sets the address, and the browser's `hashchange` tells the subscribers. */
export function goToTab(key) {
  window.location.hash = key
}

/**
 * The open tab and the function that opens another one.
 * @param {string[]} keys  the keys of the tabs, the first one is the default (keep the array the same on every render)
 * @returns {[string, (key: string) => void]}
 */
export function useTab(keys) {
  // The snapshot is a string, so React compares it by value: the same tab twice is no change.
  const tab = useSyncExternalStore(subscribe, () => tabFromHash(keys))
  return [tab, goToTab]
}
