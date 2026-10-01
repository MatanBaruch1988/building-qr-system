// One-time import of the old Firestore data (exported to JSON) into Postgres.
// Idempotent: rows are matched by legacy_id / deterministic ids, so running it twice is safe.
import { createHash } from 'node:crypto'
import { TIMEZONE } from './config.js'

const SERVICE_TYPES = [
  [/ניקיון|ניקוי|clean/i, 'cleaning'],
  [/גינון|גנן|garden/i, 'gardening'],
]
const inferServiceType = (text) => SERVICE_TYPES.find(([re]) => re.test(text || ''))?.[1] ?? null

// Deterministic UUID from a Firestore id, so re-imports hit the same row.
function uuidFrom(text) {
  const h = createHash('sha1').update('building-qr:' + text).digest('hex')
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-5${h.slice(13, 16)}-a${h.slice(17, 20)}-${h.slice(20, 32)}`
}

/** Firestore timestamps exported as {__ts}, or old ISO strings. */
function ts(v) {
  const raw = v?.__ts ?? v
  if (typeof raw !== 'string') return null
  const d = new Date(raw)
  return Number.isNaN(d.getTime()) ? null : d.toISOString()
}

const numOrNull = (v) => (v !== null && v !== undefined && v !== '' && Number.isFinite(Number(v)) ? Number(v) : null)
const DEMO_NAME = /בדיקות|בדיקה|\btest\b|\bdemo\b|דמו/i

function tokenFromQr(qrCode) {
  if (typeof qrCode !== 'string') return null
  if (/^BQR-[A-Za-z0-9-]{6,80}$/.test(qrCode)) return qrCode
  try {
    const code = new URL(qrCode).searchParams.get('code')
    return code && /^BQR-[A-Za-z0-9-]{6,80}$/.test(code) ? code : null
  } catch {
    return null
  }
}

export async function importFirestore(client, data) {
  const { locations = [], workers = [], scans = [], failedScans = [] } = data
  const report = {
    firestore: { locations: locations.length, workers: workers.length, scans: scans.length, failedScans: failedScans.length },
    inserted: { points: 0, providers: 0, assignments: 0, scans: 0 },
    alreadyPresent: { points: 0, providers: 0 },
    warnings: [],
  }
  const warn = (msg) => report.warnings.push(msg)

  // --- providers first (assignments and scans refer to them)
  const providerByLegacy = new Map()
  for (const w of workers) {
    if (!w.id) {
      warn('worker without an id, skipped')
      continue
    }
    const company = (w.company || w.name || '').trim()
    if (!company) {
      warn(`worker ${w.id}: no name, skipped`)
      continue
    }
    const contact = (w.company ? w.name : '') || '' // with no company the name IS the company: no second copy
    const demo = DEMO_NAME.test(company) || DEMO_NAME.test(contact)
    const r = await client.query(
      `insert into providers (company, contact_name, service_type, is_active, is_demo, legacy_id, created_at)
       values ($1, $2, $3, $4, $5, $6, coalesce($7::timestamptz, now()))
       on conflict (legacy_id) do nothing returning id`,
      [company, contact, inferServiceType(company), w.isActive !== false, demo, w.id, ts(w.createdAt)],
    )
    if (demo) warn(`provider "${company}": looks like a test account, marked as DEMO (its scans stay out of reports)`)
    if (r.rows.length) {
      report.inserted.providers++
      providerByLegacy.set(w.id, { id: r.rows[0].id, company, contact })
    } else {
      report.alreadyPresent.providers++
      const ex = await client.query('select id, company, contact_name from providers where legacy_id = $1', [w.id])
      providerByLegacy.set(w.id, { id: ex.rows[0].id, company: ex.rows[0].company, contact: ex.rows[0].contact_name })
    }
  }
  if (workers.length) {
    warn('provider passwords cannot be migrated (old PINs were unsalted SHA-256): set a new password for each provider in the admin screen')
  }

  // --- points
  const pointByLegacy = new Map()
  for (const l of locations) {
    if (!l.id) {
      warn(`location "${l.name}" has no id, skipped`)
      continue
    }
    if (!l.name) {
      warn(`location ${l.id}: no name, skipped`)
      continue
    }
    let token = tokenFromQr(l.qrCode)
    if (!token) {
      token = 'BQR-' + createHash('sha1').update('regen:' + l.id).digest('hex').slice(0, 24)
      warn(`location "${l.name}": no readable QR code, generated a new one (needs re-printing)`)
    }
    const radius = Number(l.radiusMeters)
    const r = await client.query(
      `insert into points (name, description, lat, lng, radius_m, is_active, qr_token, legacy_id, created_at)
       values ($1, $2, $3, $4, $5, $6, $7, $8, coalesce($9::timestamptz, now()))
       on conflict (legacy_id) do nothing returning id`,
      [
        l.name.trim(), l.description || '', numOrNull(l.latitude), numOrNull(l.longitude),
        Number.isInteger(radius) && radius >= 1 && radius <= 1000 ? radius : 50,
        l.isActive !== false, token, l.id, ts(l.createdAt),
      ],
    )
    if (r.rows.length) {
      report.inserted.points++
      pointByLegacy.set(l.id, { id: r.rows[0].id, name: l.name.trim() })
    } else {
      report.alreadyPresent.points++
      const ex = await client.query('select id, name from points where legacy_id = $1', [l.id])
      pointByLegacy.set(l.id, ex.rows[0])
    }

    const assigned = [...new Set([...(l.assignedWorkerIds || []), l.assignedWorkerId].filter(Boolean))]
    let kept = 0
    for (const legacyWorker of assigned) {
      const p = providerByLegacy.get(legacyWorker)
      if (!p) {
        warn(`location "${l.name}": assigned worker ${legacyWorker} no longer exists, dropped`)
        continue
      }
      kept++
      const a = await client.query(
        'insert into point_providers (point_id, provider_id) values ($1, $2) on conflict do nothing',
        [pointByLegacy.get(l.id).id, p.id],
      )
      report.inserted.assignments += a.rowCount
    }
    if (assigned.length && !kept) {
      // The old app then let nobody scan it; an empty assignment list means "open to every provider".
      warn(`location "${l.name}": every assigned worker was deleted, so it is now OPEN TO ALL providers. Assign it in the admin screen if that is not intended`)
    }
  }

  // --- scans (successful) and failedScans (geofence rejections)
  const insertScan = async (doc, kind) => {
    if (!doc.id) {
      warn(`${kind} without an id, skipped`)
      return
    }
    const point = pointByLegacy.get(doc.locationId)
    const provider = providerByLegacy.get(doc.workerId)
    if (!point || !provider) {
      warn(`${kind} ${doc.id}: refers to a missing ${!point ? 'point' : 'provider'}, skipped`)
      return
    }
    const checkedIn = ts(doc.originalTimestamp) || ts(doc.createdAt) || ts(doc.timestamp)
    if (!checkedIn) {
      warn(`${kind} ${doc.id}: no usable time, skipped`)
      return
    }
    const rejected = kind === 'failedScan'
    const flags = ['legacy_import']
    if (doc.syncedFromOffline) flags.push('offline_sync')
    const r = await client.query(
      `insert into scans (id, point_id, provider_id, point_name, provider_name, service_type,
          checked_in_at, client_time, local_date, source, outcome, distance_m, gps_accuracy_m, flags)
       values ($1,$2,$3,$4,$5,$6,$7,$8,(($7::timestamptz) at time zone $9)::date,$10,$11,$12,$13,$14)
       on conflict (id) do nothing`,
      [
        uuidFrom(`${kind}:${doc.id}`), point.id, provider.id,
        doc.locationName || point.name,
        provider.contact ? `${provider.company} – ${provider.contact}` : provider.company,
        inferServiceType(provider.company),
        checkedIn, ts(doc.timestamp), TIMEZONE,
        doc.syncedFromOffline ? 'offline_sync' : 'online',
        rejected ? 'rejected_far' : 'accepted',
        numOrNull(doc.distanceMeters) === null ? null : Math.round(numOrNull(doc.distanceMeters)),
        numOrNull(doc.gpsAccuracy) === null ? null : Math.round(numOrNull(doc.gpsAccuracy)),
        flags,
      ],
    )
    report.inserted.scans += r.rowCount
  }
  for (const s of scans) await insertScan(s, 'scan')
  for (const f of failedScans) await insertScan(f, 'failedScan')

  return report
}
