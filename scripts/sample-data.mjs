// The invented sample values that the tests, the E2E suite and the dev seed (scripts/dev-seed.mjs) share. Plain data:
// no test framework and no app code, so Vitest, Playwright and a node script can all import it.
//
// EVERY value in this file is made up. The repository is public, so a fixture must never be a real place, a real
// person or a printed code:
//   - the location is open sea in the eastern Mediterranean, more than 100 km from any shore (the coast of Cyprus is
//     the nearest land), so it is nobody's home and no building;
//   - the two Hebrew names are the Hebrew "John Doe" placeholders (Ploni and Almoni), not first names of real people;
//   - the legacy QR tokens have the shape of the codes that were printed for the old app, but the timestamps and the
//     suffixes are obviously invented, so none of them can be a code that someone has really printed.
// To change a value, change it here. Do not paste a real name, coordinate or code into a test, and do not copy one into
// a fixture from the committee's real data.

/** The sample point: where the scratch schema's points are, and where every E2E project starts as a person standing. */
export const SAMPLE_POINT = Object.freeze({ lat: 34.1234, lng: 31.5678 })

/** Due north of the sample point by 0.05 degrees of latitude (about 5.5 km, whatever the longitude): clearly far. */
export const SAMPLE_FAR_POINT = Object.freeze({ lat: 34.1734, lng: 31.5678 })

/**
 * The sample point as an old location typed with two decimals (about 430 m from it): the shape of coarse data in the
 * old Firestore records that the importer reads.
 */
export const SAMPLE_COARSE_POINT = Object.freeze({ lat: 34.12, lng: 31.57 })

/**
 * First names of the two Hebrew-speaking sample providers, by what they do. In an alphabetical list the gardener comes
 * before the cleaner: a test that sorts the providers by name relies on that order.
 */
export const SAMPLE_PROVIDER_NAMES = Object.freeze({ cleaner: 'פלוני', gardener: 'אלמוני' })

/**
 * Codes in the legacy format of the old app: BQR-<timestamp in ms>-<the same timestamp>-<6 characters>. The server
 * accepts any BQR- code of 6 to 80 letters, digits and hyphens (server/scanLogic.js), and the importer keeps such a
 * code as it is, so that printed QRs keep working.
 */
export const SAMPLE_LEGACY_TOKENS = Object.freeze({
  lobby: 'BQR-1000000000001-1000000000001-sampl1',
  gym: 'BQR-1000000000002-1000000000002-sampl2',
  orphan: 'BQR-1000000000003-1000000000003-sampl3',
  printed: 'BQR-1000000000004-1000000000004-sampl4',
})
