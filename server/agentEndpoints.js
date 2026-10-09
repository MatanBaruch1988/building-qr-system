// The one list of the endpoints of the read-only agent API (GET /api/agent/v1/*). Each endpoint is written here once:
//   - server/routes/agent.js registers the routes from it (a handler without a row here, or a row without a handler, stops the
//     server from starting), so the router and this list cannot disagree;
//   - server/schemaDoc.js builds the `endpoints` part of GET /api/agent/v1/schema from it (key and text);
//   - server/agentOpenApi.js builds the OpenAPI document that GET /api/agent/v1/openapi.json serves from it (the paths, the
//     operationIds, the query parameters from the filters), so an endpoint that is a row here is in that document too;
//   - tests/agent-docs.test.js reads it as a table: for every row it compares the route, the envelope and the filters with
//     schemaDoc and docs/agent-api.md, so a new endpoint is one more row here (and its handler), and the test checks its
//     documents. tests/agent-openapi.test.js does the same for the OpenAPI document.
//
// The order of the rows is the order in which /schema lists the endpoints: it is part of what an agent reads, so a row is added
// where the documents should show it, and the existing rows keep their place.
//
// The text of a row is what an agent reads in /schema. Every number it quotes from server/config.js is written from the constant
// (never typed), as in server/schemaDoc.js: tests/agent-docs.test.js reads this file for typed numbers too.
import { DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE, MAX_REFUSAL_PAGE_SIZE, FILTER_TEXT_MAX_LENGTH } from './config.js'
import { SCAN_FILTERS } from './scans.js'
import { REFUSAL_FILTERS } from './scanRefusals.js'

/**
 * One endpoint of the agent API.
 * @typedef {object} AgentEndpoint
 * @property {string} id  a short name that is also usable as an OpenAPI operationId (`listScans`): letters and digits, unique
 * @property {string} [summary]  a short title for the OpenAPI document ("List scans"); left out, it is the id spelled out
 * @property {'GET'} method  everything in this API is read-only
 * @property {string} path  the route pattern exactly as server/router.js registers it, under /agent/v1 (no /api in front)
 * @property {readonly string[]} filters  every parameter that the endpoint reads from the query, in the order the documents
 *   list them; empty for an endpoint that reads none
 * @property {readonly string[] | null} envelope  the keys of the top level of the JSON answer, in the order the answer writes
 *   them; null when the answer is not a fixed envelope of keys that the documents list (the schema document itself)
 * @property {string} description  the text that GET /schema serves for the endpoint
 */

/** The key of an endpoint in the `endpoints` object of /schema, and the form that the tests and the documents use: `GET /api/agent/v1/scans`. */
export const endpointKey = (/** @type {Pick<AgentEndpoint, 'method' | 'path'>} */ e) => `${e.method} /api${e.path}`

/** Freezes a row, so that nothing can change the list while the server runs. @param {AgentEndpoint} e */
const row = (e) => Object.freeze({ ...e, filters: Object.freeze([...e.filters]), envelope: e.envelope && Object.freeze([...e.envelope]) })

/** @type {readonly AgentEndpoint[]} */
export const AGENT_ENDPOINTS = Object.freeze([
  row({
    id: 'listScans',
    summary: 'List scans',
    method: 'GET',
    path: '/agent/v1/scans',
    filters: [...SCAN_FILTERS, 'format'], // `format` is read by the route itself (server/routes/agent.js), the others by listScans
    envelope: ['scans', 'count', 'next_cursor'],
    description:
      'Query: from, to (YYYY-MM-DD = a calendar day in Israel time, or an ISO date-time that carries Z or an offset), ' +
      `point_id, provider_id (uuids), service_type, flag (both text, cut to ${FILTER_TEXT_MAX_LENGTH} characters), ` +
      'outcome (accepted|rejected|all, default accepted), ' +
      'include_voided, include_demo (only true or 1 mean yes; anything else means no), order (asc|desc, default desc), ' +
      `limit (1-${MAX_PAGE_SIZE}, default ${DEFAULT_PAGE_SIZE}; a larger number is cut to ${MAX_PAGE_SIZE}, not refused), ` +
      'cursor (from next_cursor), ' +
      'format (csv for CSV; any other value, or none, returns JSON). ' +
      'Returns { scans, count, next_cursor }: count is the number of scans in this page (not the total), ' +
      'next_cursor is null on the last page. With format=csv the body is CSV and next_cursor is in the X-Next-Cursor header ' +
      '(absent on the last page). CSV: flags are joined with ";", booleans are the text true/false, null is an empty cell.',
  }),
  row({
    id: 'listRefusals',
    summary: 'List the visits that were not counted',
    method: 'GET',
    path: '/agent/v1/refusals',
    filters: [...REFUSAL_FILTERS],
    envelope: ['refusals', 'count', 'next_cursor'],
    description:
      'Query: from, to (YYYY-MM-DD = a calendar day in Israel time, or an ISO date-time that carries Z or an offset; they bound the ' +
      'time at which the server refused the visit), point_id, provider_id (uuids), ' +
      `limit (default ${DEFAULT_PAGE_SIZE}, at most ${MAX_REFUSAL_PAGE_SIZE}: a bigger number is cut to ${MAX_REFUSAL_PAGE_SIZE}, not refused), ` +
      'cursor (from next_cursor). ' +
      'Returns { refusals, count, next_cursor }: the visits that the server turned away for good, newest first. A refusal is not a ' +
      'scan and never counts as attendance, and it is not a scan with an outcome of rejected_far or rejected_no_location (those are ' +
      'in /scans): it is a visit that did not become a scan at all. count is the number of refusals in this page (not the total), ' +
      'next_cursor is null on the last page. See refusal_fields and refusal_codes.',
  }),
  row({
    id: 'listPoints',
    summary: 'List service points',
    method: 'GET',
    path: '/agent/v1/points',
    filters: [],
    envelope: ['points'],
    description: 'Returns { points } with every service point, including inactive ones (is_active=false). See points_fields.',
  }),
  row({
    id: 'listProviders',
    summary: 'List service providers',
    method: 'GET',
    path: '/agent/v1/providers',
    filters: [],
    envelope: ['providers'],
    description:
      'Returns { providers } with every service provider, including inactive ones, with last_scan_at and the health of the ' +
      "provider's phones as numbers over all of them (never a row per phone). See providers_fields.",
  }),
  row({
    id: 'getBuilding',
    summary: 'Read the building',
    method: 'GET',
    path: '/agent/v1/building',
    filters: [],
    envelope: ['building'],
    description:
      'Returns { building } with the name and the address of the building, as the committee typed them. A text the committee has ' +
      'not set is an empty string. See building_fields.',
  }),
  row({
    id: 'getSchema',
    summary: 'Read the contract of this API',
    method: 'GET',
    path: '/agent/v1/schema',
    filters: [],
    envelope: null,
    description: 'This document.',
  }),
  row({
    id: 'getOpenApi',
    summary: 'Read the OpenAPI description of this API',
    method: 'GET',
    path: '/agent/v1/openapi.json',
    filters: [],
    envelope: null,
    description:
      'The OpenAPI 3.1 description of this API, for tools that read OpenAPI: every endpoint with its parameters, the shape of ' +
      'every answer, the errors and the Bearer key. It is built from the same list of endpoints as this document.',
  }),
  row({
    id: 'getHealth',
    summary: 'Check that the API is alive',
    method: 'GET',
    path: '/agent/v1/health',
    filters: [],
    envelope: ['ok', 'server_time', 'server_time_local'],
    description:
      'Liveness. Returns { ok, server_time (UTC ISO), server_time_local (YYYY-MM-DD HH:mm:ss in the building time zone) }.',
  }),
])
