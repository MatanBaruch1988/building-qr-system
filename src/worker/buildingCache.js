import { safeStorage, readJson } from './storage.js'

// The key has a version suffix, like the others: the shape can change later and the old one is read (or ignored).
// The shape grew without a new key: { address } became { address, name }. A phone that saved the old one has no `name`, and it is
// read as '' (no name); a phone that runs an older version of the app reads only `address` out of the new one and ignores the rest.
const KEY = 'qr.building.v1'

/**
 * The building's two texts for the header of the provider app.
 * @typedef {object} CachedBuilding
 * @property {string} address  empty means show no address
 * @property {string} name  empty means no name
 */

/**
 * Reads what the server answered (`building` of GET /api/public/building) as the two texts, or null when it is not an answer of ours.
 * The address must be text. The name is text too, but an answer with no name at all (a server from before names existed) means no name.
 * @param {unknown} building
 * @returns {CachedBuilding | null}
 */
export function parseBuilding(building) {
  if (building === null || typeof building !== 'object') return null
  const { address, name = '' } = /** @type {{ address?: unknown, name?: unknown }} */ (building)
  return typeof address === 'string' && typeof name === 'string' ? { address, name } : null
}

/**
 * Remembers the building's address and name on the phone, so the header can show them on the first paint and with no signal.
 * Stored as { address, name }, and an empty one is stored too (the committee may have cleared it: the phone must follow).
 * @param {CachedBuilding} building
 */
export function setCachedBuilding({ address, name }, storage = safeStorage) {
  storage.setItem(KEY, JSON.stringify({ address, name }))
}

/**
 * What the phone remembers: an empty text for each that was never saved or is not text. A value saved before names existed has
 * no `name`, so its name is ''.
 * @returns {CachedBuilding}
 */
export function getCachedBuilding(storage = safeStorage) {
  const saved = readJson(storage, KEY, null)
  return {
    address: typeof saved?.address === 'string' ? saved.address : '',
    name: typeof saved?.name === 'string' ? saved.name : '',
  }
}
