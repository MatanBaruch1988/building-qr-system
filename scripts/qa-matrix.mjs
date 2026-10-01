// End-to-end QA: every provider x every printed QR x GPS situations, against the REAL imported data
// (same points, same assignments) in a throwaway schema. Nothing touches the real tables.
// Usage: node scripts/qa-matrix.mjs [firestore-export-dir]
import fs from 'node:fs'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { setupDb, call } from '../tests/helpers.js'
import { importFirestore } from '../server/importFirestore.js'
import { hashPassword } from '../server/crypto.js'

const dir = process.argv[2] ?? path.join('..', 'backups', 'firestore-2026-10-01')
const read = (n) => (fs.existsSync(path.join(dir, `${n}.json`)) ? JSON.parse(fs.readFileSync(path.join(dir, `${n}.json`), 'utf8')) : [])
const PASSWORD = 'qa-matrix-pass-1'

const db = await setupDb()
const problems = []
const note = (msg) => problems.push(msg)

try {
  const c = await db.pool.connect()
  await c.query('begin')
  const report = await importFirestore(c, { locations: read('locations'), workers: read('workers'), scans: read('scans'), failedScans: read('failedScans') })
  await c.query('commit')
  c.release()
  console.log(`imported: ${JSON.stringify(report.inserted)}`)

  const hash = await hashPassword(PASSWORD)
  await db.pool.query('update providers set password_hash = $1', [hash])

  const providers = (await db.pool.query('select id, company, contact_name, is_demo from providers order by company')).rows
  const points = (await db.pool.query(
    `select p.id, p.name, p.gps_mode, p.lat, p.lng, p.qr_token,
            coalesce(array_agg(pp.provider_id) filter (where pp.provider_id is not null), '{}') as assigned
       from points p left join point_providers pp on pp.point_id = p.id group by p.id order by p.name`,
  )).rows
  const OLD_URL = (t) => `https://building-qr-system.web.app/scan?code=${t}`

  console.log(`\n${providers.length} providers x ${points.length} points\n`)

  // public lookups first: what a not-yet-signed-in phone sees
  for (const p of points) {
    const r = await call('GET', `/api/public/points/resolve?code=${encodeURIComponent(OLD_URL(p.qr_token))}`)
    if (r.status !== 200 || r.json.point?.name !== p.name) note(`resolve ${p.name}: ${r.status} ${r.text}`)
  }

  const rows = []
  for (const prov of providers) {
    const login = await call('POST', '/api/session', { body: { provider_id: prov.id, password: PASSWORD } })
    if (login.status !== 200) { note(`login ${prov.company}/${prov.contact_name}: ${login.status} ${login.text}`); continue }
    const token = login.json.token
    const label = `${prov.contact_name || prov.company}${prov.is_demo ? ' [demo]' : ''}`

    for (const pt of points) {
      // the demo account may scan everywhere; everyone else only where assigned (no assignment = anyone)
      const allowed = prov.is_demo || pt.assigned.length === 0 || pt.assigned.includes(prov.id)
      const here = { lat: Number(pt.lat), lng: Number(pt.lng), accuracy: 10 }
      const away = { lat: here.lat + 0.05, lng: here.lng, accuracy: 10 }
      const code = OLD_URL(pt.qr_token)
      const scan = (gps) => call('POST', '/api/scan', { token, body: { id: randomUUID(), code, client_time: new Date().toISOString(), gps } })

      const far = await scan(away) // clearly far
      const none = await scan(null) // no GPS at all (basement)
      const near = await scan(here) // good fix at the point

      const brief = (r) => (r.status !== 200 ? `${r.status}:${r.json?.error?.code}` : `${r.json.scan.outcome}${r.json.duplicate ? '(dup)' : ''}${r.json.scan.flags.length ? '[' + r.json.scan.flags.join(',') + ']' : ''}`)
      rows.push({ provider: label, point: pt.name, gps_mode: pt.gps_mode, allowed: allowed ? 'yes' : 'no', far: brief(far), none: brief(none), near: brief(near) })

      // --- expectations
      if (!allowed) {
        for (const [n, r] of [['far', far], ['none', none], ['near', near]]) {
          if (r.status !== 403 || r.json?.error?.code !== 'not_assigned') note(`${label} @ ${pt.name} (${n}): expected 403 not_assigned, got ${brief(r)}`)
        }
        continue
      }
      // allowed provider
      const expectFar = pt.gps_mode === 'none' ? 'accepted' : 'rejected_far'
      if (far.status !== 200 || far.json.scan.outcome !== expectFar) note(`${label} @ ${pt.name}: far fix expected ${expectFar}, got ${brief(far)}`)
      const expectNone = pt.gps_mode === 'required' ? 'rejected_no_location' : 'accepted'
      if (none.status !== 200 || none.json.scan.outcome !== expectNone) note(`${label} @ ${pt.name}: no GPS expected ${expectNone}, got ${brief(none)}`)
      if (near.status !== 200 || near.json.scan.outcome !== 'accepted') note(`${label} @ ${pt.name}: near fix expected accepted, got ${brief(near)}`)
      // the demo account's scans must be tagged
      if (prov.is_demo && near.status === 200 && !near.json.scan.flags.includes('demo')) note(`${label} @ ${pt.name}: demo scan not tagged`)
      if (!prov.is_demo && near.status === 200 && near.json.scan.flags.includes('demo')) note(`${label} @ ${pt.name}: non-demo scan tagged demo`)
    }

    // the person's own list and an offline batch
    const mine = await call('GET', '/api/my/scans', { token })
    if (mine.status !== 200) note(`${label}: /my/scans ${mine.status}`)
    const allowedPt = points.find((p) => p.assigned.length === 0 || p.assigned.includes(prov.id))
    if (allowedPt) {
      const batch = [
        { id: randomUUID(), code: OLD_URL(allowedPt.qr_token), client_time: new Date(Date.now() - 3 * 3600_000).toISOString() },
        { id: randomUUID(), code: 'BQR-doesnotexist00000', client_time: new Date().toISOString() },
      ]
      const sync = await call('POST', '/api/scans/sync', { token, body: { scans: batch } })
      if (sync.status !== 200 || sync.json.results.length !== 2 || sync.json.results[1].ok !== false) note(`${label}: sync batch odd: ${sync.status} ${sync.text}`)
    }
  }

  console.table(rows)

  // deactivated provider / point
  const victim = providers.find((p) => !p.is_demo)
  const tk = (await call('POST', '/api/session', { body: { provider_id: victim.id, password: PASSWORD } })).json.token
  await db.pool.query('update providers set is_active = false where id = $1', [victim.id])
  const afterOff = await call('GET', '/api/session', { token: tk })
  if (afterOff.status !== 401) note(`deactivated provider still has a session (${afterOff.status})`)
  await db.pool.query('update providers set is_active = true where id = $1', [victim.id])

  console.log(problems.length ? `\n${problems.length} PROBLEM(S):\n- ${problems.join('\n- ')}` : '\nAll expectations hold.')
} finally {
  await db.teardown()
}
process.exit(problems.length ? 1 : 0)
