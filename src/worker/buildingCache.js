import { safeStorage, readJson } from './storage.js'

// The key has a version suffix, like the others: the shape can change later and the old one is read (or ignored).
const KEY = 'qr.building.v1'

/**
 * Remembers the building's address on the phone, so the header can show it on the first paint and with no signal.
 * Stored as { address }, and an empty address is stored too (the committee may have cleared it: the phone must follow).
 */
export function getCachedAddress(storage = safeStorage) {
  const saved = readJson(storage, KEY, null)
  return typeof saved?.address === 'string' ? saved.address : ''
}

export function setCachedAddress(address, storage = safeStorage) {
  storage.setItem(KEY, JSON.stringify({ address }))
}
