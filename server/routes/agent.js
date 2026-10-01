import { route } from '../router.js'
import { query } from '../db.js'
import { toCsv } from '../http.js'
import { requireApiKey } from '../auth.js'
import { listScans, SCAN_CSV_COLUMNS, toLocal } from '../scans.js'
import { schemaDoc } from '../schemaDoc.js'

// Read-only surface for the external agent. Nothing here writes, and secrets (QR tokens,
// password hashes, device tokens) are never returned.

route('GET', '/agent/v1/health', async ({ req }) => {
  await requireApiKey(req)
  const { rows } = await query('select now() as now')
  return { ok: true, server_time: rows[0].now, server_time_local: toLocal(rows[0].now) }
})

route('GET', '/agent/v1/schema', async ({ req }) => {
  await requireApiKey(req)
  return schemaDoc
})

route('GET', '/agent/v1/points', async ({ req }) => {
  await requireApiKey(req)
  const { rows } = await query(
    `select p.id, p.name, p.description, p.service_type, p.gps_mode, p.lat, p.lng, p.radius_m,
            p.is_active, p.created_at,
            coalesce(array_agg(pp.provider_id) filter (where pp.provider_id is not null), '{}') as assigned_provider_ids
       from points p left join point_providers pp on pp.point_id = p.id
      group by p.id order by p.name`,
  )
  return { points: rows }
})

route('GET', '/agent/v1/providers', async ({ req }) => {
  await requireApiKey(req)
  const { rows } = await query(
    `select p.id, p.company, p.contact_name, p.service_type, p.lang, p.is_active, p.is_demo, p.created_at,
            (select max(s.checked_in_at) from scans s
              where s.provider_id = p.id and s.outcome = 'accepted' and s.voided_at is null) as last_scan_at
       from providers p order by p.company, p.contact_name`,
  )
  return { providers: rows }
})

route('GET', '/agent/v1/scans', async ({ req, query: q }) => {
  await requireApiKey(req)
  const { scans, next_cursor } = await listScans(q)
  if (q.format === 'csv') {
    return {
      text: toCsv(scans, SCAN_CSV_COLUMNS, { bom: false }), // machine reader: no byte-order mark
      headers: {
        'Content-Type': 'text/csv; charset=utf-8',
        // The cursor can't ride in the CSV body, so it goes in a header.
        ...(next_cursor ? { 'X-Next-Cursor': next_cursor } : {}),
      },
    }
  }
  return { scans, count: scans.length, next_cursor }
})
