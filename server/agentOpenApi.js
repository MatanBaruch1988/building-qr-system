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
//
// The one exception is the detail of an entry of the audit log: its keys depend on the action, and an entry holds only the keys that
// its action wrote. So there is one schema for each action that has a detail (AuditDetail<Action>, written from AUDIT_DETAIL_ALLOW of
// server/audit.js, the list of the keys of each action that the agent may be shown, and from schemaDoc.audit_actions, which says what
// each key means), its keys are all optional, and the `detail` of an entry is null or any one of them. A key that the list does not
// have is not in the schema, so the closed check of the test fails on a key that an answer gains.
import { STATUS_CODES } from 'node:http'
import {
  TIMEZONE, DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE, MAX_REFUSAL_PAGE_SIZE, MAX_AUDIT_PAGE_SIZE, FILTER_TEXT_MAX_LENGTH, API_KEY_PREFIX,
  COUNTS_MAX_DAYS, COUNTS_MAX_ROWS,
} from './config.js'
import { AGENT_ENDPOINTS } from './agentEndpoints.js'
import { AGENT_SCAN_CSV_COLUMNS } from './scans.js'
import { AUDIT_GROUPS } from './auditRead.js'
import { COUNT_GROUPS } from './scanCounts.js'
import { AUDIT_ACTOR_TYPES, AUDIT_DETAIL_ALLOW } from './audit.js'
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

// ---------- the audit log ----------

/** "api_key.delete" -> "AuditDetailApiKeyDelete": the name of the schema of the detail of an action. @param {string} action */
export const auditDetailSchemaName = (action) =>
  `AuditDetail${action.split(/[._]/).map((word) => word.charAt(0).toUpperCase() + word.slice(1)).join('')}`

const idArray = { type: 'array', items: uuid }
const idsChangeSchema = {
  type: ['object', 'null'],
  required: ['added', 'removed'],
  properties: {
    added: { ...idArray, description: 'The ids that the update added.' },
    removed: { ...idArray, description: 'The ids that the update removed.' },
  },
}

/**
 * The schema of one value of a detail, from its kind in AUDIT_DETAIL_ALLOW (server/audit.js explains the kinds). Every value can be
 * null: a text that looks like a secret, or a value of the wrong kind, is shown as null.
 * @param {any} kind
 * @returns {Record<string, any>}
 */
function kindSchema(kind) {
  const name = typeof kind === 'string' ? kind : kind.kind
  switch (name) {
    case 'text': return orNull(string)
    case 'count': // a whole number, 0 or more
    case 'integer': return orNull(integer)
    case 'number': return orNull(number)
    case 'boolean': return orNull(boolean)
    case 'timestamp': return orNull(dateTime)
    case 'uuids': return orNull(idArray)
    case 'ids_change': return idsChangeSchema
    case 'ids_or_change': return { anyOf: [orNull(idArray), idsChangeSchema] }
    case 'enum': return { type: ['string', 'null'], enum: [...kind.values, null] }
    case 'changes':
      return {
        type: ['object', 'null'],
        properties: Object.fromEntries(
          Object.entries(kind.fields).map(([field, fieldKind]) => [
            field,
            {
              type: 'object',
              description: `The field ${field}, before and after the update.`,
              required: ['from', 'to'],
              properties: {
                from: { ...kindSchema(fieldKind), description: 'The value before the update (null: it was empty).' },
                to: { ...kindSchema(fieldKind), description: 'The value after the update (null: it is empty now).' },
              },
            },
          ]),
        ),
      }
    default:
      throw new Error(`${FILE}: the kind "${name}" in AUDIT_DETAIL_ALLOW (server/audit.js) is not one that this file can type.`)
  }
}

/**
 * The schema of the detail of every action that has a detail, by the name of the schema: an object whose keys are the keys that
 * AUDIT_DETAIL_ALLOW allows for the action, all optional, each typed from its kind and described by schemaDoc.audit_actions. The
 * actions and the keys of AUDIT_DETAIL_ALLOW and of schemaDoc must be the same, or the server does not start. An action whose detail is
 * always null has no schema.
 */
function auditDetailSchemas() {
  const described = schemaDoc.audit_actions
  const problems = []
  for (const action of Object.keys(AUDIT_DETAIL_ALLOW)) {
    if (!Object.hasOwn(described, action)) problems.push(`the action "${action}" is in AUDIT_DETAIL_ALLOW but server/schemaDoc.js does not describe it (audit_actions)`)
  }
  for (const action of Object.keys(described)) {
    if (!Object.hasOwn(AUDIT_DETAIL_ALLOW, action)) problems.push(`the action "${action}" is described in server/schemaDoc.js (audit_actions) but has no entry in AUDIT_DETAIL_ALLOW (server/audit.js)`)
  }
  for (const group of AUDIT_GROUPS) {
    if (!Object.hasOwn(schemaDoc.audit_groups, group)) problems.push(`the group "${group}" is a value of the group filter but server/schemaDoc.js does not describe it (audit_groups)`)
  }
  for (const group of Object.keys(schemaDoc.audit_groups)) {
    if (!AUDIT_GROUPS.includes(/** @type {any} */ (group))) problems.push(`the group "${group}" is described in server/schemaDoc.js (audit_groups) but is not a value of the group filter`)
  }
  /** @type {Record<string, object>} */
  const schemas = {}
  for (const [action, allow] of Object.entries(AUDIT_DETAIL_ALLOW)) {
    const row = described[/** @type {keyof typeof described} */ (action)]
    if (!row) continue // already in the problems
    const keys = Object.keys(allow)
    const texts = row.detail
    for (const key of keys) if (!Object.hasOwn(texts, key)) problems.push(`the key "${key}" of ${action} is allowed in AUDIT_DETAIL_ALLOW but server/schemaDoc.js does not describe it`)
    for (const key of Object.keys(texts)) if (!keys.includes(key)) problems.push(`the key "${key}" of ${action} is described in server/schemaDoc.js but is not allowed in AUDIT_DETAIL_ALLOW`)
    if (!keys.length) continue
    schemas[auditDetailSchemaName(action)] = {
      type: 'object',
      description: `The detail of ${action}: ${row.meaning} Every key is optional: an entry holds the keys that its action wrote, and no others.`,
      properties: Object.fromEntries(keys.map((key) => [key, { ...kindSchema(/** @type {any} */ (allow)[key]), description: /** @type {any} */ (texts)[key] ?? '' }])),
    }
  }
  if (problems.length) throw new Error(`${FILE}: the audit actions of server/audit.js and server/schemaDoc.js differ: ${problems.join('; ')}.`)
  return schemas
}

// ---------- the counts ----------

/**
 * What each value of group_by means, as a list for a description: the groups of COUNT_GROUPS (server/scanCounts.js) and the groups that
 * server/schemaDoc.js describes (count_groups) must be the same, or the server does not start.
 */
function countGroupsText() {
  const described = Object.keys(schemaDoc.count_groups)
  const problems = [
    ...COUNT_GROUPS.filter((g) => !described.includes(g)).map((g) => `the group "${g}" is a value of group_by but server/schemaDoc.js does not describe it (count_groups)`),
    ...described.filter((g) => !COUNT_GROUPS.includes(/** @type {any} */ (g))).map((g) => `the group "${g}" is described in server/schemaDoc.js (count_groups) but is not a value of group_by`),
  ]
  if (problems.length) throw new Error(`${FILE}: the groups of the counts differ: ${problems.join('; ')}.`)
  return Object.entries(schemaDoc.count_groups).map(([group, meaning]) => `- ${group}: ${meaning}`).join('\n')
}

function componentSchemas() {
  const auditDetails = auditDetailSchemas()
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

    CountRow: describedObject(
      'CountRow',
      {
        day: orNull(day),
        provider_id: orNull(uuid),
        provider_name: orNull(string),
        point_id: orNull(uuid),
        point_name: orNull(string),
        service_type: orNull(string),
        count: { ...integer, minimum: 0 },
      },
      schemaDoc.count_fields,
    ),
    CountList: plainObject(
      {
        group_by: {
          type: 'array',
          items: oneOf(COUNT_GROUPS),
          uniqueItems: true,
          description: 'The grouping that was asked for, written in the fixed order of the rows (day, provider, point, service_type), whatever the order of the request. Empty when the answer is not grouped: it is then one row, the total.',
        },
        counts: { type: 'array', items: ref('schemas', 'CountRow'), description: 'One row for each group that has a visit (a not grouped answer has its one row even when there is none), ordered by the grouping.' },
        total: { ...integer, minimum: 0, description: 'The sum of the counts: the number of scans that GET /scans returns for the same filters.' },
      },
      'The answer of the counts endpoint: how many visits there are for the filters, grouped as asked. A dimension that was not grouped by is null in every row. ' +
        `An answer of more than ${COUNTS_MAX_ROWS} rows is refused with a 400, never cut. What each group is:\n${countGroupsText()}`,
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

    AuditEntry: describedObject(
      'AuditEntry',
      {
        id: integer,
        at: dateTime,
        action: string,
        entity: orNull(string),
        entity_id: orNull(string),
        entity_name: orNull(string),
        actor_type: oneOf(AUDIT_ACTOR_TYPES),
        actor_id: orNull(string),
        actor_name: orNull(string),
        actor_deleted: boolean,
        detail: { anyOf: [{ type: 'null' }, ...Object.keys(auditDetails).map((name) => ref('schemas', name))] },
      },
      schemaDoc.audit_fields,
    ),
    AuditList: plainObject(
      {
        entries: { type: 'array', items: ref('schemas', 'AuditEntry'), description: 'One page of the audit log, newest first.' },
        count: { type: 'integer', minimum: 0, description: 'The number of entries in this page (not the total).' },
        next_cursor: { ...orNull(string), description: 'Pass it as the cursor to get the next page. Null on the last page.' },
      },
      'One page of the audit log of the committee: what the committee changed and who signed in, one entry for each. The log is append-only. ' +
        'The detail of an entry is null or has the keys that its action allows (the schemas AuditDetail<Action>), never a secret. ' +
        `What each action means:\n${Object.entries(schemaDoc.audit_actions).map(([action, row]) => `- ${action}: ${row.meaning}`).join('\n')}`,
    ),
    ...auditDetails,

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
 * @type {Record<string, { description: string, schema: object, required?: boolean, style?: 'form', explode?: boolean }>}
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
  group_by: {
    description:
      `How to group the counts: a comma list of ${COUNT_GROUPS.join(', ')}, each at most once, in any order (the rows of the answer are in the fixed order of the list). ` +
      `None, or empty, is one row: the total. A value that is not in the list, or a repeat, is refused. The answer may have ${COUNTS_MAX_ROWS} rows at most. What each is:\n${countGroupsText()}`,
    schema: { type: 'array', items: oneOf(COUNT_GROUPS), uniqueItems: true, maxItems: COUNT_GROUPS.length },
    style: 'form',
    explode: false,
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
 * @type {Record<string, Record<string, { description: string, schema: object, required?: boolean, style?: 'form', explode?: boolean }>>}
 */
const ENDPOINT_PARAMETERS = {
  countScans: {
    from: {
      description:
        `The first day or moment to count. REQUIRED, and together with to the range covers at most ${COUNTS_MAX_DAYS} days. A calendar day (YYYY-MM-DD) means that whole day in the building time zone (${TIMEZONE}). ` +
        'An ISO 8601 date-time that carries Z or an offset is an exact moment. A date-time without Z or an offset is refused. It means what it means in the scans list, so the counts add up to those scans.',
      schema: DAY_OR_MOMENT,
      required: true,
    },
    to: {
      description:
        `The last day or moment to count, in the same two forms as from. REQUIRED. A calendar day (YYYY-MM-DD) includes that whole day in ${TIMEZONE}. ` +
        `A range that covers more than ${COUNTS_MAX_DAYS} days is refused (the field is to).`,
      schema: DAY_OR_MOMENT,
      required: true,
    },
  },
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
  listAudit: {
    from: {
      description:
        `The oldest entry to include, by the time of the change. A calendar day (YYYY-MM-DD) means that day in the building time zone (${TIMEZONE}). ` +
        'An ISO 8601 date-time that carries Z or an offset is an exact moment. A date-time without Z or an offset is refused.',
      schema: DAY_OR_MOMENT,
    },
    to: {
      description:
        `The newest entry to include, in the same two forms as from. A calendar day (YYYY-MM-DD) includes that whole day in ${TIMEZONE}.`,
      schema: DAY_OR_MOMENT,
    },
    group: {
      description:
        'Only the entries of one group: the part of the action before the dot (point.update is in point). What each group is:\n' +
        Object.entries(schemaDoc.audit_groups).map(([name, meaning]) => `- ${name}: ${meaning}`).join('\n'),
      schema: oneOf(AUDIT_GROUPS),
    },
    actor_id: {
      description:
        'Only the changes made by this committee member (the actor_id of an entry). The daily job and the commands of the owner have no id, ' +
        'so no actor_id matches them: look for them by the actor_type of the entries.',
      schema: uuid,
    },
    entity: {
      description:
        'Only the entries about this kind of thing: point, provider, admin (a committee member), api_key, scan or building. ' +
        `Use it with entity_id for the history of one thing. ${TEXT_FILTER_NOTE}`,
      schema: string,
    },
    entity_id: {
      description:
        'Only the entries about the thing with this id (the entity_id of an entry). A deleted point, provider, member, key or scan keeps ' +
        `its entries, and its id still works here. ${TEXT_FILTER_NOTE}`,
      schema: string,
    },
    limit: {
      description:
        `The most entries in one page. A larger number is cut to ${MAX_AUDIT_PAGE_SIZE}, not refused. Zero, a negative number or a value ` +
        'that is not a whole number is refused.',
      schema: { type: 'integer', minimum: 1, maximum: MAX_AUDIT_PAGE_SIZE, default: DEFAULT_PAGE_SIZE },
    },
    cursor: {
      description:
        'The next_cursor of the previous page, to get the page after it. Keep every other parameter the same. A value that this endpoint ' +
        'did not return is refused (the cursor of /scans or of /refusals is not one).',
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
  countScans: { description: 'The number of visits, grouped as asked.', content: json('CountList') },
  listRefusals: { description: 'A page of the visits that the server refused.', content: json('RefusalList') },
  listAudit: { description: 'A page of the audit log of the committee.', content: json('AuditList') },
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
      return {
        name,
        in: 'query',
        ...(parameter.required ? { required: true } : {}),
        ...(parameter.style ? { style: parameter.style, explode: parameter.explode } : {}),
        description: parameter.description,
        schema: parameter.schema,
      }
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
