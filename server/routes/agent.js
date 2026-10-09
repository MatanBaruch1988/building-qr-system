import { route } from '../router.js'
import { query } from '../db.js'
import { toCsv } from '../http.js'
import { requireApiKey } from '../auth.js'
import { listAgentScans, AGENT_SCAN_CSV_COLUMNS, toLocal } from '../scans.js'
import { listAgentRefusals } from '../scanRefusals.js'
import { listAgentAudit } from '../auditRead.js'
import { readBuilding } from '../building.js'
import { PHONE_HEALTH_LATERAL } from '../deviceStatus.js'
import { commit } from '../health.js'
import { schemaDoc } from '../schemaDoc.js'
import { openApiDocument } from '../agentOpenApi.js'
import { AGENT_ENDPOINTS } from '../agentEndpoints.js'

// Read-only surface for the external agent. Nothing here writes (the guard's own bookkeeping for the key apart), and secrets (QR
// tokens, password hashes, device tokens) are never returned. The agent is the committee's analyst (owner decision of 08/10/2026,
// AGENTS.md "Safety"): it reads what the committee app shows, and every answer here is built field by field, so a column that is
// added to a table later does not reach it by itself.
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

async function getBuilding({ req }) {
  await requireApiKey(req)
  // The two texts the committee typed, and nothing of the row (not who saved it, not when).
  const { name, address } = await readBuilding()
  return { building: { name, address } }
}

// The last seven columns are the health of the provider's ACTIVE phones, as numbers and times over all of them (the lateral of
// server/deviceStatus.js, the very SQL of the committee's providers list): never the label or the browser string of a phone, the hash of
// its token, its own build, or a row per phone. They are fields added after the others, which are as they were. $1 is the server's
// build, which the lateral compares the phones' builds with.
async function listProviders({ req }) {
  await requireApiKey(req)
  const { rows } = await query(
    `select p.id, p.company, p.contact_name, p.service_type, p.is_active, p.is_demo, p.created_at,
            (select max(s.checked_in_at) from scans s
              where s.provider_id = p.id and s.outcome = 'accepted' and s.voided_at is null) as last_scan_at,
            phones.active_devices, phones.waiting, phones.oldest_waiting_at, phones.outdated_devices,
            phones.last_sync_at, phones.not_accepted_total, phones.overflow_total
       from providers p
       ${PHONE_HEALTH_LATERAL}
      order by p.company, p.contact_name`,
    [commit()],
  )
  return { providers: rows }
}

async function listScansHandler({ req, query: q }) {
  await requireApiKey(req)
  const { scans, next_cursor } = await listAgentScans(q)
  if (q.format === 'csv') {
    return {
      text: toCsv(scans, AGENT_SCAN_CSV_COLUMNS, { bom: false }), // machine reader: no byte-order mark
      headers: {
        'Content-Type': 'text/csv; charset=utf-8',
        // The cursor can't ride in the CSV body, so it goes in a header.
        ...(next_cursor ? { 'X-Next-Cursor': next_cursor } : {}),
      },
    }
  }
  return { scans, count: scans.length, next_cursor }
}

// The visits that the server refused (a point that was switched off, a person who is not assigned, a code that names nothing, ...):
// not scans, never attendance. The filters, the validation and the paging are the committee's own (server/scanRefusals.js reads
// them once for both), and the answer is built field by field there: no phone, no QR code, no position.
async function listRefusalsHandler({ req, query: q }) {
  await requireApiKey(req)
  const { refusals, next_cursor } = await listAgentRefusals(q)
  return { refusals, count: refusals.length, next_cursor }
}

// The audit log of the committee (owner decision of 08/10/2026: the agent is the committee's analyst, AGENTS.md "Safety"). The filters,
// the validation, the paging and the cursor are the committee's own (server/auditRead.js reads them once for both). The entry is written
// field by field there, and its detail goes out only through the allow-list of its action (AUDIT_DETAIL_ALLOW in server/audit.js) with a
// text that looks like a secret turned into null: never the first characters of a key, a token, a hash, a phone's label or an address.
async function listAuditHandler({ req, query: q }) {
  await requireApiKey(req)
  const { entries, next_cursor } = await listAgentAudit(q)
  return { entries, count: entries.length, next_cursor }
}

/** The handler of every endpoint of the registry, by its id. */
const HANDLERS = {
  getBuilding, getHealth, getOpenApi, getSchema, listAudit: listAuditHandler, listPoints, listProviders, listRefusals: listRefusalsHandler,
  listScans: listScansHandler,
}

const registered = new Set(AGENT_ENDPOINTS.map((endpoint) => endpoint.id))
for (const id of Object.keys(HANDLERS)) {
  if (!registered.has(id)) throw new Error(`server/routes/agent.js has a handler "${id}" that has no row in server/agentEndpoints.js`)
}
for (const endpoint of AGENT_ENDPOINTS) {
  const handler = HANDLERS[/** @type {keyof typeof HANDLERS} */ (endpoint.id)]
  if (!handler) throw new Error(`server/agentEndpoints.js has the endpoint "${endpoint.id}" and server/routes/agent.js has no handler for it`)
  route(endpoint.method, endpoint.path, handler)
}
