// The OpenAPI 3.1 description of the read-only agent API, served at GET /api/agent/v1/openapi.json (behind the agent key, like
// /schema). It tells a tool that reads OpenAPI (an agent platform's tool import, a client generator) what the API accepts and
// what it answers. The prose for a reader (what a field means, the flags, the rules of a scan) stays in /schema: this document
// points to it.
//
// It is built once, when the server starts, and nothing here is written by hand twice. Every part comes from where the fact
// already lives, so that a change there changes this document with it:
//   - the paths, the operationIds, the summaries, the descriptions and the query parameters (by name, in order) come from the
//     registry of server/agentEndpoints.js, so an endpoint that is a row there is in this document;
//   - the enums come from shared/ (the flags, the outcomes, the sources, the GPS modes, the codes of a refused visit), the page
//     sizes, the longest text filter and the key prefix from server/config.js, the CSV columns (the agent's) from server/scans.js;
//   - the description of every field of a point, a provider, a scan, a refused visit and the building comes from server/schemaDoc.js,
//     and the errors (the status, the codes and what they mean) are built from schemaDoc.errors, so a new error code there is in
//     every error response here.
//
// What is written here: the type of every field (a field that schemaDoc describes and this file does not type, or the other way
// round, stops the server from starting), the description of every query parameter (a filter in the registry without one stops it
// too, and so does an endpoint without an answer below; an endpoint whose filter of the same name means something else, such as
// the page size of the refused visits, has its own description of it), and the few values that only server/scans.js knows (the
// values of the `outcome`, `order` and `format` filters). tests/agent-openapi.test.js proves all of it: the document is valid OpenAPI 3.1, its
// paths are the routes, its parameters the filters, its enums and limits the constants, and every real answer fits its schema.
//
// Every object that an answer holds lists all its fields as required: the keys are always there (a value that can be missing is
// null, written as a type list). The document does not close the objects (`additionalProperties: false`), so that a client that
// validates answers with it does not break when a field is added; the test closes them, so that a field that an answer gains
// fails there until this file types it.
import { STATUS_CODES } from 'node:http'
import { TIMEZONE, DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE, MAX_REFUSAL_PAGE_SIZE, FILTER_TEXT_MAX_LENGTH, API_KEY_PREFIX } from './config.js'
import { AGENT_ENDPOINTS } from './agentEndpoints.js'
import { AGENT_SCAN_CSV_COLUMNS } from './scans.js'
import { schemaDoc } from './schemaDoc.js'
import { SCAN_FLAGS } from '../shared/flags.js'
import { SCAN_OUTCOMES, SCAN_SOURCES, GPS_MODES, OUTCOME_ACCEPTED, SYNC_PERMANENT_ERROR_CODES } from '../shared/contract.js'

const FILE = 'server/agentOpenApi.js'

/** Where the agent API lives (the registry writes its paths under it); the document names it once, as its server. */
const BASE_PATH = '/agent/v1'

/** The statuses that say the URL or the method is wrong, not what an operation answers: only in the shared responses. */
const ROUTING_STATUSES = Object.freeze([404, 405])

/** @param {'schemas' | 'responses'} kind @param {string} name */
const ref = (kind, name) => ({ $ref: `#/components/${kind}/${name}` })

// ---------- the types of the fields ----------

const string = { type: 'string' }
const integer = { type: 'integer' }
const number = { type: 'number' }
const boolean = { type: 'boolean' }
const uuid = { type: 'string', format: 'uuid' }
const dateTime = { type: 'string', format: 'date-time' }
const day = { type: 'string', format: 'date' }
const localDateTime = { type: 'string', pattern: /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.source }
/** @param {readonly string[]} values */
const oneOf = (values) => ({ type: 'string', enum: [...values] })
/** A value that can be null is written as a type list, as OpenAPI 3.1 (JSON Schema 2020-12) has it. @param {{ type: string }} schema */
const orNull = (schema) => ({ ...schema, type: [schema.type, 'null'] })

/**
 * An object whose fields are all required, each with the description that schemaDoc gives it. The fields typed here and the
 * fields that schemaDoc describes must be the same names, or the server does not start.
 * @param {string} name  the schema, for the message
 * @param {Record<string, object>} types  the type of every field, in the order of the answer
 * @param {Record<string, string>} descriptions  schemaDoc's description of every field
 */
function describedObject(name, types, descriptions) {
  const typed = Object.keys(types)
  const described = Object.keys(descriptions)
  const problems = [
    ...typed.filter((k) => !described.includes(k)).map((k) => `"${k}" is typed here but server/schemaDoc.js does not describe it`),
    ...described.filter((k) => !typed.includes(k)).map((k) => `"${k}" is described in server/schemaDoc.js but not typed here`),
  ]
  if (problems.length) throw new Error(`${FILE}: the fields of ${name} and the descriptions of server/schemaDoc.js differ: ${problems.join('; ')}.`)
  return {
    type: 'object',
    required: typed,
    properties: Object.fromEntries(typed.map((k) => [k, { ...types[k], description: descriptions[k] }])),
  }
}

/** An object with the given fields, all required, each described here (for the answers that schemaDoc has no field list for). */
function plainObject(/** @type {Record<string, object>} */ fields, /** @type {string} */ description) {
  const names = Object.keys(fields)
  return { type: 'object', description, required: names, properties: fields }
}

function componentSchemas() {
  return {
    Health: plainObject(
      {
        ok: { ...boolean, description: 'Always true when the API answers.' },
        server_time: { ...dateTime, description: 'The server clock, UTC ISO.' },
        server_time_local: { ...localDateTime, description: `The same instant as YYYY-MM-DD HH:mm:ss in ${TIMEZONE}.` },
      },
      'Liveness and the server time.',
    ),

    Point: describedObject(
      'Point',
      {
        id: uuid,
        name: string,
        description: orNull(string),
        service_type: orNull(string),
        gps_mode: oneOf(GPS_MODES),
        lat: orNull(number),
        lng: orNull(number),
        radius_m: integer,
        is_active: boolean,
        created_at: dateTime,
        assigned_provider_ids: { type: 'array', items: uuid },
      },
      schemaDoc.points_fields,
    ),
    PointList: plainObject(
      { points: { type: 'array', items: ref('schemas', 'Point'), description: 'Every service point, including inactive ones.' } },
      'The answer of the points endpoint.',
    ),

    Provider: describedObject(
      'Provider',
      {
        id: uuid,
        company: string,
        contact_name: orNull(string),
        service_type: orNull(string),
        is_active: boolean,
        is_demo: boolean,
        created_at: dateTime,
        last_scan_at: orNull(dateTime),
        active_devices: integer,
        waiting: integer,
        oldest_waiting_at: orNull(dateTime),
        outdated_devices: integer,
        last_sync_at: orNull(dateTime),
        not_accepted_total: integer,
        overflow_total: integer,
      },
      schemaDoc.providers_fields,
    ),
    ProviderList: plainObject(
      { providers: { type: 'array', items: ref('schemas', 'Provider'), description: 'Every service provider, including inactive ones.' } },
      'The answer of the providers endpoint.',
    ),

    Building: describedObject('Building', { name: string, address: string }, schemaDoc.building_fields),
    BuildingAnswer: plainObject(
      { building: { ...ref('schemas', 'Building'), description: 'The name and the address of the building, as the committee typed them.' } },
      'The answer of the building endpoint.',
    ),

    Scan: describedObject(
      'Scan',
      {
        id: uuid,
        checked_in_at: dateTime,
        checked_in_local: localDateTime,
        local_date: day,
        point_id: uuid,
        point_name: string,
        provider_id: uuid,
        provider_name: string,
        service_type: orNull(string),
        source: oneOf(SCAN_SOURCES),
        outcome: oneOf(SCAN_OUTCOMES),
        distance_m: orNull(integer),
        gps_accuracy_m: orNull(integer),
        flags: { type: 'array', items: oneOf(SCAN_FLAGS) },
        voided: boolean,
        void_reason: orNull(string),
        voided_at: orNull(dateTime),
        voided_by: orNull(string),
        received_at: dateTime,
        device_id: orNull(uuid),
      },
      { ...schemaDoc.time_fields, ...schemaDoc.scan_fields },
    ),
    ScanList: plainObject(
      {
        scans: { type: 'array', items: ref('schemas', 'Scan'), description: 'One page of scans, in the order that was asked for.' },
        count: { type: 'integer', minimum: 0, description: 'The number of scans in this page (not the total).' },
        next_cursor: { ...orNull(string), description: 'Pass it as the cursor to get the next page. Null on the last page.' },
      },
      'One page of scans (the JSON answer; with format=csv the answer is CSV).',
    ),

    Refusal: describedObject(
      'Refusal',
      {
        id: integer,
        at: dateTime,
        scan_id: orNull(uuid),
        source: oneOf(SCAN_SOURCES),
        code: oneOf(SYNC_PERMANENT_ERROR_CODES),
        provider_id: uuid,
        provider_name: string,
        point_id: orNull(uuid),
        point_name: orNull(string),
        client_time: orNull(dateTime),
      },
      schemaDoc.refusal_fields,
    ),
    RefusalList: plainObject(
      {
        refusals: { type: 'array', items: ref('schemas', 'Refusal'), description: 'One page of refused visits, newest first.' },
        count: { type: 'integer', minimum: 0, description: 'The number of refusals in this page (not the total).' },
        next_cursor: { ...orNull(string), description: 'Pass it as the cursor to get the next page. Null on the last page.' },
      },
      'One page of the visits that the server refused (they are not scans and never count as attendance). What each code means:\n' +
        Object.entries(schemaDoc.refusal_codes).map(([code, meaning]) => `- ${code}: ${meaning}`).join('\n'),
    ),

    SchemaDocument: {
      type: 'object',
      description:
        'The contract of this API as JSON: the meaning of every field, flag, outcome and rule. Its keys are described in the ' +
        'document itself and can grow; read it, do not validate it.',
    },
    OpenApiDocument: {
      type: 'object',
      description: 'This document: an OpenAPI 3.1 description of this API. It has the keys of an OpenAPI document; only the main ones are listed here.',
      required: ['openapi', 'info', 'paths'],
      properties: {
        openapi: { type: 'string', description: 'The version of OpenAPI that this document follows (3.1.x).' },
        info: { type: 'object', description: 'The title and version of this API.' },
        paths: { type: 'object', description: 'Every endpoint, with its parameters and answers.' },
      },
      additionalProperties: true,
    },

    Error: {
      type: 'object',
      description: 'The answer to a request that was refused or failed. Each error response lists the codes it can carry.',
      required: ['error'],
      properties: {
        error: {
          type: 'object',
          required: ['code', 'message'],
          properties: {
            code: { type: 'string', description: 'A stable code to act on.' },
            message: { type: 'string', description: 'For a person to read. Do not parse it.' },
            field: { type: 'string', description: 'With invalid_filter: the name of the parameter that was refused.' },
            request_id: { type: 'string', description: 'With server_error on the host: an id to give to whoever reads the host log.' },
          },
        },
      },
    },
  }
}

// ---------- the query parameters ----------

const DAY_OR_MOMENT = { anyOf: [day, dateTime] }
const TEXT_FILTER_NOTE = `Text longer than ${FILTER_TEXT_MAX_LENGTH} characters is cut to ${FILTER_TEXT_MAX_LENGTH} before it is compared.`
const YES_NOTE = 'Only true or 1 mean yes; any other value means no.'

/**
 * Every query parameter of the registry, by name: how it is documented. A filter that an endpoint of the registry lists and that
 * is not here stops the server from starting, with the name of the endpoint. The values of outcome, order and format are the ones
 * that server/scans.js (and the route) accept: tests/agent-openapi.test.js sends each of them to the real route.
 * @type {Record<string, { description: string, schema: object }>}
 */
const PARAMETERS = {
  from: {
    description:
      `The oldest scan to include. A calendar day (YYYY-MM-DD) means that day in the building time zone (${TIMEZONE}). ` +
      'An ISO 8601 date-time that carries Z or an offset is an exact moment. A date-time without Z or an offset is refused.',
    schema: DAY_OR_MOMENT,
  },
  to: {
    description:
      `The newest scan to include, in the same two forms as from. A calendar day (YYYY-MM-DD) includes that whole day in ${TIMEZONE}.`,
    schema: DAY_OR_MOMENT,
  },
  point_id: { description: 'Only the scans of this service point. A deleted point keeps its scans, and its id still works here.', schema: uuid },
  provider_id: { description: 'Only the scans of this service provider. A deleted provider keeps its scans, and its id still works here.', schema: uuid },
  service_type: { description: `Only the scans of this service type (for example cleaning). ${TEXT_FILTER_NOTE}`, schema: string },
  flag: { description: `Only the scans that carry this flag. ${TEXT_FILTER_NOTE} What each flag means: see flags in /schema.`, schema: oneOf(SCAN_FLAGS) },
  outcome: {
    description:
      'Which scans: accepted (real check-ins, the default), rejected (every refused attempt, whatever the reason) or all. ' +
      'The outcome of each refused attempt is in the outcome field of the scan.',
    schema: { type: 'string', enum: [OUTCOME_ACCEPTED, 'rejected', 'all'], default: OUTCOME_ACCEPTED },
  },
  include_voided: {
    description: `Include the scans that a committee member cancelled (voided). They are left out by default. ${YES_NOTE}`,
    schema: { ...boolean, default: false },
  },
  include_demo: {
    description: `Include the scans of the demo account (test data, flagged demo). They are left out by default. ${YES_NOTE}`,
    schema: { ...boolean, default: false },
  },
  order: {
    description: 'The order of the scans by time of the visit: desc is the newest first (the default), asc the oldest first. Keep the same order while paging.',
    schema: { type: 'string', enum: ['asc', 'desc'], default: 'desc' },
  },
  limit: {
    description:
      `The most scans in one page. A larger number is cut to ${MAX_PAGE_SIZE}, not refused. Zero, a negative number or a value ` +
      'that is not a whole number is refused.',
    schema: { type: 'integer', minimum: 1, maximum: MAX_PAGE_SIZE, default: DEFAULT_PAGE_SIZE },
  },
  cursor: {
    description:
      'The next_cursor of the previous page (or the X-Next-Cursor header of a CSV page), to get the page after it. Keep every ' +
      'other parameter the same. A value that this API did not return is refused.',
    schema: string,
  },
  format: {
    description:
      'csv returns the page as CSV (text/csv) and puts the cursor of the next page in the X-Next-Cursor header. json, any other ' +
      'value, or none, returns JSON.',
    schema: { type: 'string', enum: ['json', 'csv'], default: 'json' },
  },
}

/**
 * The parameters whose name is also a filter of another endpoint but whose meaning here is another one (a refused visit is not a scan,
 * and its page is cut at its own size), by the id of the endpoint and then by name. A name that is not here is described by PARAMETERS.
 * @type {Record<string, Record<string, { description: string, schema: object }>>}
 */
const ENDPOINT_PARAMETERS = {
  listRefusals: {
    from: {
      description:
        `The oldest refused visit to include, by the time at which the server refused it. A calendar day (YYYY-MM-DD) means that day in the building time zone (${TIMEZONE}). ` +
        'An ISO 8601 date-time that carries Z or an offset is an exact moment. A date-time without Z or an offset is refused.',
      schema: DAY_OR_MOMENT,
    },
    to: {
      description:
        `The newest refused visit to include, in the same two forms as from. A calendar day (YYYY-MM-DD) includes that whole day in ${TIMEZONE}.`,
      schema: DAY_OR_MOMENT,
    },
    point_id: {
      description: 'Only the visits refused at this service point. A deleted point keeps its refusals, and its id still works here. A refusal that named no point is matched by no point_id.',
      schema: uuid,
    },
    provider_id: {
      description: 'Only the refused visits of this service provider. A deleted provider keeps its refusals, and its id still works here.',
      schema: uuid,
    },
    limit: {
      description:
        `The most refusals in one page. A bigger number is cut to ${MAX_REFUSAL_PAGE_SIZE}, not refused. Zero, a negative number or a value ` +
        'that is not a whole number is refused.',
      schema: { type: 'integer', minimum: 1, maximum: MAX_REFUSAL_PAGE_SIZE, default: DEFAULT_PAGE_SIZE },
    },
    cursor: {
      description:
        'The next_cursor of the previous page, to get the page after it. Keep every other parameter the same. A value that this endpoint ' +
        'did not return is refused (the cursor of /scans is not one).',
      schema: string,
    },
  },
}

// ---------- the answers ----------

const json = (/** @type {string} */ schema) => ({ 'application/json': { schema: ref('schemas', schema) } })

/**
 * The 200 answer of every endpoint of the registry, by its id. An endpoint without one stops the server from starting.
 * @type {Record<string, object>}
 */
const ANSWERS = {
  listScans: {
    description:
      'A page of scans. With format=csv the answer is CSV (text/csv) instead of JSON, and the cursor of the next page is in the ' +
      'X-Next-Cursor header.',
    headers: {
      'X-Next-Cursor': {
        description: 'With format=csv only: the cursor of the next page, to pass as the cursor. Absent on the last page.',
        schema: string,
      },
    },
    content: {
      ...json('ScanList'),
      'text/csv': {
        schema: {
          type: 'string',
          description:
            `A header line and then one scan per line, with these columns in this order: ${AGENT_SCAN_CSV_COLUMNS.join(', ')}. The flags ` +
            'are joined with ";", booleans are the text true or false, a null is an empty cell. There is no byte-order mark.',
        },
      },
    },
  },
  listRefusals: { description: 'A page of the visits that the server refused.', content: json('RefusalList') },
  listPoints: { description: 'Every service point.', content: json('PointList') },
  listProviders: { description: 'Every service provider.', content: json('ProviderList') },
  getBuilding: { description: 'The name and the address of the building.', content: json('BuildingAnswer') },
  getSchema: { description: 'The contract of this API.', content: json('SchemaDocument') },
  getOpenApi: { description: 'This document.', content: json('OpenApiDocument') },
  getHealth: { description: 'The API is alive.', content: json('Health') },
}

// ---------- the errors ----------

/** "BadRequest" for 400, "TooManyRequests" for 429: the name of the response in components.responses. @param {number} status */
const responseName = (status) => (STATUS_CODES[status] ?? `Status${status}`).replace(/[^A-Za-z0-9]/g, '')

/**
 * The error responses, built from schemaDoc.errors: one response per status, listing the codes of that status and what each
 * means. Every text there starts with "<status>: ". `all` is every response (for components.responses), `attached` the ones that
 * every operation can answer (the statuses of the URL and the method are not among them).
 */
function errorResponses() {
  /** @type {Map<number, { code: string, meaning: string }[]>} */
  const byStatus = new Map()
  for (const [code, text] of Object.entries(schemaDoc.errors)) {
    if (code === 'shape') continue
    const m = /^(\d{3}): ([\s\S]*)$/.exec(text)
    if (!m) throw new Error(`${FILE}: errors.${code} in server/schemaDoc.js does not start with "<status>: " ("${text}").`)
    const status = Number(m[1])
    byStatus.set(status, [...(byStatus.get(status) ?? []), { code, meaning: m[2] }])
  }
  const all = {}
  const attached = {}
  for (const status of [...byStatus.keys()].sort((a, b) => a - b)) {
    const codes = byStatus.get(status) ?? []
    const name = responseName(status)
    all[name] = {
      description: `${STATUS_CODES[status] ?? 'Error'}. The code says which:\n${codes.map((c) => `- ${c.code}: ${c.meaning}`).join('\n')}`,
      content: {
        'application/json': {
          schema: {
            allOf: [
              ref('schemas', 'Error'),
              { type: 'object', properties: { error: { type: 'object', properties: { code: { type: 'string', enum: codes.map((c) => c.code) } } } } },
            ],
          },
        },
      },
    }
    if (!ROUTING_STATUSES.includes(status)) attached[status] = ref('responses', name)
  }
  return { all, attached }
}

// ---------- the paths ----------

/** "getOpenApi" -> "Get open api": the title of an endpoint whose row has no summary. @param {string} id */
const spelled = (id) => {
  const words = id.replace(/([A-Z])/g, ' $1').toLowerCase()
  return words.charAt(0).toUpperCase() + words.slice(1)
}

function buildPaths(/** @type {Record<number, object>} */ attached) {
  const paths = {}
  for (const endpoint of AGENT_ENDPOINTS) {
    if (!endpoint.path.startsWith(`${BASE_PATH}/`)) throw new Error(`${FILE}: the path ${endpoint.path} of ${endpoint.id} is not under ${BASE_PATH}.`)
    const parameters = endpoint.filters.map((name) => {
      const parameter = ENDPOINT_PARAMETERS[endpoint.id]?.[name] ?? PARAMETERS[name]
      if (!parameter) throw new Error(`${FILE}: the filter "${name}" of ${endpoint.id} has no description in PARAMETERS: add it.`)
      return { name, in: 'query', description: parameter.description, schema: parameter.schema }
    })
    const answer = ANSWERS[endpoint.id]
    if (!answer) throw new Error(`${FILE}: the endpoint ${endpoint.id} has no 200 answer in ANSWERS: add it.`)
    const path = endpoint.path.slice(BASE_PATH.length)
    paths[path] = {
      ...paths[path],
      [endpoint.method.toLowerCase()]: {
        operationId: endpoint.id,
        summary: endpoint.summary ?? spelled(endpoint.id),
        description: endpoint.description,
        ...(parameters.length ? { parameters } : {}),
        responses: { 200: answer, ...attached },
      },
    }
  }
  return paths
}

// ---------- the document ----------

/** Freezes the whole document, so that nothing can change what the server serves. */
function deepFreeze(/** @type {any} */ value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value)
    for (const inner of Object.values(value)) deepFreeze(inner)
  }
  return value
}

/** Builds the OpenAPI document from the registry, schemaDoc, the constants and the tables above. */
export function buildOpenApi() {
  const errors = errorResponses()
  return deepFreeze({
    openapi: '3.1.0',
    info: {
      title: 'Building attendance, read-only agent API',
      version: schemaDoc.version,
      description:
        `${schemaDoc.purpose}\n\n` +
        'This document describes the endpoints, their query parameters, the shape of every answer and the errors. What the fields, ' +
        'flags and rules mean is written in prose in GET /schema of this same API (read it first); it is more current than any text ' +
        'copied elsewhere.',
    },
    servers: [{ url: `/api${BASE_PATH}`, description: 'This installation: the path is relative to the address this document was fetched from.' }],
    security: [{ AgentKey: [] }],
    paths: buildPaths(errors.attached),
    components: {
      schemas: componentSchemas(),
      responses: errors.all,
      securitySchemes: {
        AgentKey: {
          type: 'http',
          scheme: 'bearer',
          bearerFormat: `${API_KEY_PREFIX}...`,
          description:
            'The key that the committee creates in the Agent tab of the committee app, and can revoke at any time. Send it as ' +
            `"Authorization: Bearer <key>"; a key starts with ${API_KEY_PREFIX}. It is checked before anything else about the request.`,
        },
      },
    },
  })
}

/** The document, built once when the server starts. */
export const openApiDocument = buildOpenApi()
