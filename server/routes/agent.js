import { route } from '../router.js'
import { query } from '../db.js'
import { toCsv } from '../http.js'
import { requireApiKey } from '../auth.js'
import { listScans, SCAN_CSV_COLUMNS, toLocal } from '../scans.js'
import { schemaDoc } from '../schemaDoc.js'
import { openApiDocument } from '../agentOpenApi.js'
import { AGENT_ENDPOINTS } from '../agentEndpoints.js'

// Read-only surface for the external agent. Nothing here writes, and secrets (QR tokens,
// password hashes, device tokens) are never returned.
//
// The routes are registered from the registry of server/agentEndpoints.js (the one list of the endpoints, with their ids,
// filters and envelopes), by id: see the end of this file. A handler without a row there, or a row without a handler here,
// stops the server at start-up, so the router, /schema and the documents cannot name different endpoints.

async function getHealth({ req }) {
  await requireApiKey(req)
  const { rows } = await query('select now() as now')
  return { ok: true, server_time: rows[0].now, server_time_local: toLocal(rows[0].now) }
}

async function getSchema({ req }) {
  await requireApiKey(req)
  return schemaDoc
}

// The OpenAPI description of this API, built once when the server starts (server/agentOpenApi.js). It says nothing about the
// data, only about the shape of the API, and it is behind the key like the rest.
async function getOpenApi({ req }) {
  await requireApiKey(req)
  return openApiDocument
}

async function listPoints({ req }) {
  await requireApiKey(req)
  const { rows } = await query(
    `select p.id, p.name, p.description, p.service_type, p.gps_mode, p.lat, p.lng, p.radius_m,
            p.is_active, p.created_at,
            coalesce(array_agg(pp.provider_id) filter (where pp.provider_id is not null), '{}') as assigned_provider_ids
       from points p left join point_providers pp on pp.point_id = p.id
      group by p.id order by p.name`,
  )
  return { points: rows }
}

async function listProviders({ req }) {
  await requireApiKey(req)
  const { rows } = await query(
    `select p.id, p.company, p.contact_name, p.service_type, p.is_active, p.is_demo, p.created_at,
            (select max(s.checked_in_at) from scans s
              where s.provider_id = p.id and s.outcome = 'accepted' and s.voided_at is null) as last_scan_at
       from providers p order by p.company, p.contact_name`,
  )
  return { providers: rows }
}

async function listScansHandler({ req, query: q }) {
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
}

/** The handler of every endpoint of the registry, by its id. */
const HANDLERS = { getHealth, getOpenApi, getSchema, listPoints, listProviders, listScans: listScansHandler }

const registered = new Set(AGENT_ENDPOINTS.map((endpoint) => endpoint.id))
for (const id of Object.keys(HANDLERS)) {
  if (!registered.has(id)) throw new Error(`server/routes/agent.js has a handler "${id}" that has no row in server/agentEndpoints.js`)
}
for (const endpoint of AGENT_ENDPOINTS) {
  const handler = HANDLERS[/** @type {keyof typeof HANDLERS} */ (endpoint.id)]
  if (!handler) throw new Error(`server/agentEndpoints.js has the endpoint "${endpoint.id}" and server/routes/agent.js has no handler for it`)
  route(endpoint.method, endpoint.path, handler)
}
