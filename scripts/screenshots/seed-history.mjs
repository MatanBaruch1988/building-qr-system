// Adds a week of visits to the scratch schema of the screenshots, so that the History tab has rows to show, and makes every
// sample point one that checks the location. Run by the spec of the screenshots (scripts/screenshots/screenshots.spec.mjs)
// after the sample seed (scripts/dev-seed.mjs, which makes the providers and the points and has no scans), never by hand and
// never against a real table.
// Usage: node scripts/screenshots/seed-history.mjs <schema>
//
// The visits go through recordScan, the function that records a real one, with the time of the visit passed in, so they are
// ordinary accepted scans with the flags that a real one would get. Their days are relative to the day of the run (yesterday
// back to five days ago, at the same hours every time), so that they fall in the history's default week. Every provider,
// point and code is one that the sample seed made up.
import { randomUUID } from 'node:crypto'
import { loadEnv } from '../../server/loadEnv.js'
import { SAMPLE_POINT } from '../sample-data.mjs'
import { assertScreenshotsSchema } from './settings.mjs'

loadEnv()

// The schema half of the run's guard, on the schema that this script writes to.
const schema = assertScreenshotsSchema(process.argv[2])
process.env.DB_SCHEMA = schema

const { getPool, query } = await import('../../server/db.js')
const { assertNotProduction } = await import('../../server/dbGuard.js')
const { recordScan } = await import('../../server/scans.js')
const { TIMEZONE } = await import('../../server/config.js')
const { SOURCE_ONLINE, GPS_MODE_REQUIRED } = await import('../../shared/contract.js')

try {
  await assertNotProduction(getPool())
} catch (err) {
  console.error(err.message)
  process.exit(1)
}

// The committee app saves every point as one that checks the location (src/admin/views/PointsView.jsx), so the pictures show the
// points as a new installation has them. The sample seed keeps its other modes on purpose: the server still serves a point that an
// older installation saved without the check, and the end-to-end tests cover that. Every sample point has a pin, which the mode
// needs. Before the check for scans below, so that a second run of this script makes the same points.
await query('update points set gps_mode = $1 where gps_mode <> $1', [GPS_MODE_REQUIRED])

const { rows: existing } = await query('select count(*)::int n from scans')
if (existing[0].n > 0) {
  console.log(`Schema "${schema}" already has scans: left as it is.`)
  await getPool().end()
  process.exit(0)
}

const provider = async (company) => (await query('select * from providers where company = $1', [company])).rows[0]
const people = {
  cleaner: await provider('ניקיון'),
  gardener: await provider('גינון'),
  ivan: await provider('Уборка'),
  john: await provider('Cleaning Co'),
}
const codes = {
  lobby: 'BQR-dev00000000000000000001', // GPS checked if there is one
  basement: 'BQR-dev00000000000000000002', // no GPS check
  gym: 'BQR-dev00000000000000000003', // GPS required, only for the cleaner
}
const here = { lat: SAMPLE_POINT.lat, lng: SAMPLE_POINT.lng, accuracy: 12 }

// [days ago, "HH:MM" in the building's time, who, where, whether the phone gave its position]
const VISITS = [
  [1, '07:41', 'gardener', 'lobby', true],
  [1, '08:06', 'cleaner', 'lobby', true],
  [1, '08:24', 'cleaner', 'gym', true],
  [1, '13:12', 'ivan', 'basement', false],
  [1, '17:35', 'john', 'lobby', false], // no position: the row carries the "location not verified" flag
  [2, '07:48', 'gardener', 'lobby', true],
  [2, '08:10', 'cleaner', 'lobby', true],
  [2, '08:32', 'cleaner', 'gym', true],
  [2, '13:05', 'ivan', 'basement', false],
  [3, '07:52', 'gardener', 'lobby', true],
  [3, '08:15', 'cleaner', 'lobby', true],
  [3, '08:40', 'cleaner', 'gym', true],
  [4, '08:02', 'cleaner', 'lobby', true],
  [4, '17:28', 'john', 'basement', false],
  [5, '07:45', 'gardener', 'lobby', true],
  [5, '08:09', 'cleaner', 'lobby', true],
]

// The instant of "HH:MM on the day that is `days` before today in the building's time zone", worked out by the database so that
// the hour is the same whatever the time of day of the run (and the zone's own rules apply, not a guess of ours).
const instant = async (days, hhmm) =>
  (await query(
    `select (((now() at time zone $1)::date - $2::int) + $3::time) at time zone $1 as at`,
    [TIMEZONE, days, hhmm],
  )).rows[0].at

for (const [days, hhmm, who, where, withPosition] of VISITS) {
  await recordScan({
    provider: people[who],
    deviceId: null,
    input: { id: randomUUID(), code: codes[where], gps: withPosition ? here : null },
    source: SOURCE_ONLINE,
    now: await instant(days, hhmm),
  })
}
console.log(`Added ${VISITS.length} visits to schema "${schema}".`)
await getPool().end()
