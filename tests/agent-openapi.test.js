// The OpenAPI description of the agent API (server/agentOpenApi.js, served at GET /api/agent/v1/openapi.json) is built from the
// registry of the endpoints, the constants and schemaDoc. This test makes the CODE the source of truth and fails, naming what
// differs, when the document no longer matches it. What it proves:
//   a. the document (as built, and as the real route serves it) is valid OpenAPI 3.1: it passes the OpenAPI 3.1 JSON Schema of the
//      package @apidevtools/openapi-schemas, and every Schema Object in it is valid JSON Schema 2020-12 and compiles in strict Ajv
//      (an unknown keyword is an error);
//   b. its paths and operations are the agent routes of routeTable() (server/router.js), in both directions, with the operationId of
//      the registry row, the base path as its server, and the agent key as the security of every operation;
//   c. the query parameters of each operation are the filters of its registry row, in that order, and the real route accepts what
//      each parameter allows and refuses what it must refuse;
//   d. every enum is its constant (shared/), every minimum, maximum or default is its constant (server/config.js), and a keyword
//      that this file does not pin fails until it does;
//   e. the real answer of every JSON route (a database with every kind of scan, a deleted point and provider, a voided scan, a
//      rejected one) validates against its 200 schema CLOSED (additionalProperties false), so a field that an answer gains or loses
//      fails here until the document says so; and the CSV variant of /scans is what the document says;
//   f. the document that the route serves is the document that the module builds;
//   g. the error codes of the document are the ones of schemaDoc.errors, with their statuses, and the real error answers fit them.
// An endpoint, a filter or an error code that is added is checked here with no edit, except that a new filter needs its place in
// INVALID_VALUES (the values that the real route must refuse) and, when it has a limit or an enum, in PARAMETER_FACTS.
import { describe, it, expect, beforeAll, afterAll, vi, assert } from 'vitest'
import { STATUS_CODES } from 'node:http'
import { randomUUID } from 'node:crypto'
import { isDeepStrictEqual } from 'node:util'
import Ajv2020 from 'ajv/dist/2020.js'
import addFormats from 'ajv-formats'
import openApiSchemas from '@apidevtools/openapi-schemas'
import { setupDb, call, seedAdmin, adminCookie, mintAgentKey, revokeAgentKey } from './helpers.js'
import { SAMPLE_POINT, SAMPLE_FAR_POINT } from '../scripts/sample-data.mjs'
import '../server/index.js' // importing it registers every route file with the router
import { routeTable } from '../server/router.js'
import { getPool, setPool } from '../server/db.js'
import { schemaDoc } from '../server/schemaDoc.js'
import { AGENT_ENDPOINTS, endpointKey } from '../server/agentEndpoints.js'
import { buildOpenApi, openApiDocument } from '../server/agentOpenApi.js'
import { SCAN_CSV_COLUMNS } from '../server/scans.js'
import * as config from '../server/config.js'
import { SCAN_FLAGS } from '../shared/flags.js'
import { SCAN_OUTCOMES, SCAN_SOURCES, GPS_MODES, OUTCOME_ACCEPTED } from '../shared/contract.js'

const OPENAPI = 'server/agentOpenApi.js'
const HTTP_METHODS = ['get', 'put', 'post', 'delete', 'options', 'head', 'patch', 'trace']

/** The document as plain JSON, the way a client receives it (the module's own is frozen). */
const plain = (value) => JSON.parse(JSON.stringify(value))
const doc = plain(openApiDocument)

/** Fails with every problem on its own line. An empty list passes. */
function report(problems) {
  const unique = [...new Set(problems)]
  if (unique.length) assert.fail(`\n${unique.map((p) => `  - ${p}`).join('\n')}\n`)
}

/** The differences between two lists of names, one sentence each (`truth` is what the code has, `found` what the document has). */
function diffNames(thing, truth, found) {
  const problems = []
  for (const name of truth.names) if (!found.names.includes(name)) problems.push(`${thing} "${name}" is in ${truth.where} but is missing from ${found.where}.`)
  for (const name of found.names) if (!truth.names.includes(name)) problems.push(`${thing} "${name}" is in ${found.where} but not in ${truth.where}.`)
  const seen = new Set()
  for (const name of found.names) {
    if (seen.has(name)) problems.push(`${thing} "${name}" is listed twice in ${found.where}.`)
    seen.add(name)
  }
  return problems
}

/** The path of an endpoint as the agent calls it under /api/agent/v1: `/scans`. */
const pathOf = (e) => e.path.replace('/agent/v1', '')
const agentRoutes = () => routeTable().filter((r) => r.path.startsWith('/agent/v1/'))
const operationsOf = (document) =>
  Object.entries(document.paths).flatMap(([path, item]) =>
    Object.entries(item).filter(([method]) => HTTP_METHODS.includes(method)).map(([method, operation]) => ({ path, method, operation })),
  )
const operationOf = (e) => doc.paths[pathOf(e)]?.[e.method.toLowerCase()]

/** Every object and array inside a value, with the keys that lead to it: [['paths', '/scans'], {...}]. */
function* nodes(value, keys = []) {
  if (value && typeof value === 'object') {
    yield [keys, value]
    for (const [key, inner] of Object.entries(value)) yield* nodes(inner, [...keys, key])
  }
}

// ---------- the validators ----------

/** An Ajv that checks formats (uuid, date, date-time) and, when strict, refuses a keyword it does not know. */
const newAjv = (strict) => addFormats(new Ajv2020({ strict, allowUnionTypes: true, allErrors: true }))

/**
 * The OpenAPI 3.1 JSON Schema of the package, ready to compile. Two adjustments, both because of the iteration of the schema that
 * the package carries (2021-04-15), and neither loosens what it checks about the document itself:
 *   - Ajv resolves `$dynamicRef: "#meta"` (where the schema says "a Schema Object") wrongly: it applies the Parameter object to
 *     the schema of a parameter. In this file `meta` is only the placeholder `$defs/schema` (an object or a boolean), so the
 *     reference is made a plain `$ref` to it. The Schema Objects themselves are checked below (JSON Schema 2020-12, strict).
 *   - it says `format: uri` for a server url, which the OpenAPI specification lets be relative (a later iteration says
 *     uri-reference), so `uri` is read as `uri-reference` here, and the unknown `media-range` format is not checked.
 */
function openApiValidator() {
  const schema = JSON.parse(JSON.stringify(openApiSchemas.openapiV31).replaceAll('"$dynamicRef":"#meta"', '"$ref":"#/$defs/schema"'))
  const ajv = newAjv(false)
  ajv.addFormat('uri', ajv.formats['uri-reference'])
  ajv.addFormat('media-range', true)
  return ajv.compile(schema)
}
const validateOpenApi = openApiValidator()
const openApiErrors = (document) => (validateOpenApi(document) ? [] : (validateOpenApi.errors ?? []).map((e) => `${e.instancePath || '/'} ${e.message}`))

/** `#/components/schemas/Name` becomes `#/$defs/Name`: a schema of the document, made a root that Ajv can compile. */
const rewrite = (value) => JSON.parse(JSON.stringify(value).replaceAll('#/components/schemas/', '#/$defs/'))
/** A copy in which every object that lists properties is closed: a key that the schema does not list is a failure. */
function closed(value) {
  if (Array.isArray(value)) return value.map(closed)
  if (!value || typeof value !== 'object') return value
  const copy = Object.fromEntries(Object.entries(value).map(([key, inner]) => [key, closed(inner)]))
  if (copy.properties && typeof copy.properties === 'object' && copy.additionalProperties === undefined) copy.additionalProperties = false
  return copy
}
/** The validator of a Schema Object of the document (it may $ref the components). `strict` refuses unknown keywords; `shut` closes the objects. */
function compileSchema(schema, { strict = true, shut = false } = {}) {
  const defs = rewrite(doc.components.schemas)
  return newAjv(strict).compile({ ...rewrite(shut ? closed(schema) : schema), $defs: shut ? closed(defs) : defs })
}
const errorsOf = (validate) => (validate.errors ?? []).map((e) => `${e.instancePath || '/'} ${e.message}`)

// ======================================================================================================================
// a. valid OpenAPI 3.1
// ======================================================================================================================

describe('a. the document is valid OpenAPI 3.1', () => {
  it('passes the OpenAPI 3.1 JSON Schema', () => {
    report(openApiErrors(doc).map((e) => `${OPENAPI} builds a document that is not valid OpenAPI 3.1: ${e}`))
    expect(doc.openapi).toMatch(/^3\.1\.\d+$/)
  })

  it('the check itself is not vacuous: broken copies of the document fail it', () => {
    const broken = [
      ['a parameter with an unknown location', (d) => (d.paths['/scans'].get.parameters[0].in = 'nowhere')],
      ['an operation key that does not exist', (d) => (d.paths['/scans'].get.respnses = {})],
      ['no version in info', (d) => delete d.info.version],
      ['a security scheme without a type', (d) => delete d.components.securitySchemes.AgentKey.type],
      ['an operationId that is not text', (d) => (d.paths['/scans'].get.operationId = 5)],
      ['a version that is not 3.1', (d) => (d.openapi = '3.0.0')],
      ['a parameter schema that is not a schema', (d) => (d.paths['/scans'].get.parameters[0].schema = 'text')],
    ]
    for (const [what, change] of broken) {
      const copy = plain(doc)
      change(copy)
      expect(openApiErrors(copy).length, `the OpenAPI check accepted ${what}`).toBeGreaterThan(0)
    }
  })

  it('every Schema Object in it is valid JSON Schema 2020-12 and compiles in strict Ajv (no unknown keyword)', () => {
    const problems = []
    const metaSchema = newAjv(true)
    const where = []
    for (const [name, schema] of Object.entries(doc.components.schemas)) where.push([`components.schemas.${name}`, schema])
    for (const { path, method, operation } of operationsOf(doc)) {
      for (const parameter of operation.parameters ?? []) where.push([`${method} ${path} parameter ${parameter.name}`, parameter.schema])
      for (const [status, response] of Object.entries(operation.responses)) {
        if (response.$ref) continue
        for (const [type, content] of Object.entries(response.content ?? {})) where.push([`${method} ${path} ${status} ${type}`, content.schema])
        for (const [header, h] of Object.entries(response.headers ?? {})) where.push([`${method} ${path} ${status} header ${header}`, h.schema])
      }
    }
    for (const [name, response] of Object.entries(doc.components.responses)) {
      for (const [type, content] of Object.entries(response.content ?? {})) where.push([`components.responses.${name} ${type}`, content.schema])
    }
    for (const [label, schema] of where) {
      try {
        if (!metaSchema.validateSchema(rewrite(schema))) problems.push(`${label} is not valid JSON Schema 2020-12: ${metaSchema.errorsText(metaSchema.errors)}`)
        compileSchema(schema)
      } catch (err) {
        problems.push(`${label} does not compile: ${err.message}`)
      }
    }
    expect(where.length).toBeGreaterThan(10)
    report(problems)
  })

  it('every $ref points to something that exists', () => {
    const problems = []
    for (const [keys, node] of nodes(doc)) {
      if (typeof node.$ref !== 'string') continue
      const target = node.$ref.replace(/^#\//, '').split('/').reduce((value, key) => value?.[key], doc)
      if (target === undefined) problems.push(`${keys.join('.')} refers to ${node.$ref}, which is not in the document.`)
    }
    report(problems)
  })
})

// ======================================================================================================================
// b. the paths are the routes; the server; the security
// ======================================================================================================================

describe('b. the paths are the agent routes, the registry and the base path', () => {
  const server = doc.servers?.[0]?.url

  it('has one relative server: the base path of the agent API', () => {
    expect(doc.servers).toHaveLength(1)
    expect(server).toBe('/api/agent/v1')
  })

  it('the operations = the agent routes of routeTable() = the registry, in both directions', () => {
    const fromDoc = operationsOf(doc).map(({ path, method }) => `${method.toUpperCase()} ${server}${path}`)
    report([
      ...diffNames('endpoint', { where: 'the agent routes of routeTable() (server/router.js)', names: agentRoutes().map((r) => `${r.method} /api${r.path}`) }, { where: `the paths of the document (${OPENAPI})`, names: fromDoc }),
      ...diffNames('endpoint', { where: `the registry (server/agentEndpoints.js)`, names: AGENT_ENDPOINTS.map(endpointKey) }, { where: `the paths of the document (${OPENAPI})`, names: fromDoc }),
    ])
  })

  it('every operation has the operationId, the summary and the description of its registry row', () => {
    const problems = []
    for (const e of AGENT_ENDPOINTS) {
      const operation = operationOf(e)
      if (!operation) {
        problems.push(`${endpointKey(e)} has no operation in the document.`)
        continue
      }
      if (operation.operationId !== e.id) problems.push(`${endpointKey(e)} has the operationId "${operation.operationId}" but its row has the id "${e.id}".`)
      if (operation.description !== e.description) problems.push(`${endpointKey(e)} does not carry the description of its row.`)
      if (!operation.summary || (e.summary && operation.summary !== e.summary)) problems.push(`${endpointKey(e)} has the summary "${operation.summary}" (its row says "${e.summary}").`)
    }
    const ids = operationsOf(doc).map(({ operation }) => operation.operationId)
    if (new Set(ids).size !== ids.length) problems.push('Two operations have the same operationId.')
    report(problems)
  })

  it('has the registry row of the document itself, GET /openapi.json', () => {
    const row = AGENT_ENDPOINTS.find((e) => e.id === 'getOpenApi')
    expect(row, 'the registry has no row "getOpenApi"').toBeTruthy()
    expect(row.path).toBe('/agent/v1/openapi.json')
    expect(doc.paths['/openapi.json']?.get?.operationId).toBe('getOpenApi')
  })

  it('every operation needs the agent key (a bearer scheme with the key prefix), and none opts out', () => {
    const problems = []
    const scheme = doc.components.securitySchemes?.AgentKey
    if (scheme?.type !== 'http' || scheme?.scheme !== 'bearer') problems.push('components.securitySchemes.AgentKey is not an http bearer scheme.')
    if (!String(scheme?.bearerFormat).startsWith(config.API_KEY_PREFIX)) problems.push(`The bearerFormat of AgentKey does not start with the key prefix ${config.API_KEY_PREFIX}.`)
    if (JSON.stringify(doc.security) !== JSON.stringify([{ AgentKey: [] }])) problems.push('The security of the document is not [{ AgentKey: [] }], so an operation would not need the key.')
    for (const { path, method, operation } of operationsOf(doc)) {
      if (operation.security !== undefined && JSON.stringify(operation.security) !== JSON.stringify(doc.security)) problems.push(`${method} ${path} sets a security of its own.`)
    }
    report(problems)
  })

  it('has an info with the version of schemaDoc and a pointer to /schema, and the 200 answer of every operation', () => {
    expect(doc.info.version).toBe(schemaDoc.version)
    expect(doc.info.description).toContain('/schema')
    expect(doc.info.title).toBeTruthy()
    const problems = []
    for (const { path, method, operation } of operationsOf(doc)) {
      const ok = operation.responses?.['200']
      if (!ok?.description || !ok?.content?.['application/json']?.schema) problems.push(`${method} ${path} has no application/json 200 answer.`)
    }
    report(problems)
  })
})

// ======================================================================================================================
// c and d. the parameters = the filters; the enums and limits = the constants
// ======================================================================================================================

// The facts that a parameter states about its values (every enum, bound and default inside its schema), by name. A parameter whose
// schema states a fact that is not here, or lacks one that is, fails: a limit is a constant of server/config.js, an enum a constant
// of shared/ (the values of outcome, order and format are the literals of server/scans.js and the route: the black-box test below
// sends each of them to the real route and the unknown one too).
const KEYWORDS = ['enum', 'const', 'default', 'minimum', 'maximum', 'exclusiveMinimum', 'exclusiveMaximum', 'minLength', 'maxLength', 'minItems', 'maxItems', 'multipleOf']
const PARAMETER_FACTS = {
  flag: { enum: [...SCAN_FLAGS] },
  outcome: { enum: [OUTCOME_ACCEPTED, 'rejected', 'all'], default: OUTCOME_ACCEPTED },
  include_voided: { default: false },
  include_demo: { default: false },
  order: { enum: ['asc', 'desc'], default: 'desc' },
  limit: { minimum: 1, maximum: config.MAX_PAGE_SIZE, default: config.DEFAULT_PAGE_SIZE },
  format: { enum: ['json', 'csv'], default: 'json' },
}
// The same for the schemas of the components, by the path of the keyword (the key `enum` of Scan.properties.source is
// "Scan.properties.source.enum").
const SCHEMA_FACTS = {
  'Point.properties.gps_mode.enum': [...GPS_MODES],
  'Scan.properties.source.enum': [...SCAN_SOURCES],
  'Scan.properties.outcome.enum': [...SCAN_OUTCOMES],
  'Scan.properties.flags.items.enum': [...SCAN_FLAGS],
  'ScanList.properties.count.minimum': 0,
}
const factsOf = (schema) => Object.fromEntries([...nodes(schema)].flatMap(([, node]) => Object.entries(node).filter(([key]) => KEYWORDS.includes(key))))

describe('c. the query parameters of each operation are the filters of its registry row', () => {
  it('has, for every operation, the filters of its row as query parameters, in order, each optional and described', () => {
    const problems = []
    for (const e of AGENT_ENDPOINTS) {
      const operation = operationOf(e)
      const parameters = operation?.parameters ?? []
      problems.push(...diffNames('filter', { where: `the filters of ${endpointKey(e)} in the registry`, names: [...e.filters] }, { where: `the parameters of ${endpointKey(e)} in the document`, names: parameters.map((p) => p.name) }))
      if (parameters.map((p) => p.name).join() !== e.filters.join()) problems.push(`The parameters of ${endpointKey(e)} are not in the order of the filters of its row (${e.filters.join(', ')}).`)
      for (const p of parameters) {
        if (p.in !== 'query') problems.push(`The parameter ${p.name} of ${endpointKey(e)} is in "${p.in}", not in the query.`)
        if (p.required === true) problems.push(`The parameter ${p.name} of ${endpointKey(e)} is required, but every filter is optional.`)
        if (!p.description || p.description.trim().length < 10) problems.push(`The parameter ${p.name} of ${endpointKey(e)} has no real description.`)
        if (!p.schema) problems.push(`The parameter ${p.name} of ${endpointKey(e)} has no schema.`)
      }
      if (!e.filters.length && operation?.parameters !== undefined) problems.push(`${endpointKey(e)} reads no filter but has a parameters list.`)
    }
    report(problems)
  })

  it('the formats and types of the parameters: ids are uuids, the time bounds a date or a date-time, the switches booleans, limit an integer', () => {
    const parameter = (name) => doc.paths['/scans'].get.parameters.find((p) => p.name === name)?.schema
    expect(parameter('point_id')).toMatchObject({ type: 'string', format: 'uuid' })
    expect(parameter('provider_id')).toMatchObject({ type: 'string', format: 'uuid' })
    for (const name of ['from', 'to']) {
      expect(parameter(name).anyOf).toEqual([{ type: 'string', format: 'date' }, { type: 'string', format: 'date-time' }])
    }
    expect(parameter('include_voided').type).toBe('boolean')
    expect(parameter('include_demo').type).toBe('boolean')
    expect(parameter('limit').type).toBe('integer')
    for (const name of ['service_type', 'flag']) {
      expect(doc.paths['/scans'].get.parameters.find((p) => p.name === name).description, `the cut of the text filter ${name}`).toContain(String(config.FILTER_TEXT_MAX_LENGTH))
    }
  })
})

describe('d. every enum is its constant, every limit and default is its constant', () => {
  it('the parameters state exactly the facts of PARAMETER_FACTS', () => {
    const problems = []
    for (const { path, method, operation } of operationsOf(doc)) {
      for (const p of operation.parameters ?? []) {
        const found = factsOf(p.schema)
        const want = PARAMETER_FACTS[p.name] ?? {}
        if (!isDeepStrictEqual(found, want)) {
          problems.push(`The parameter ${p.name} of ${method} ${path} states ${JSON.stringify(found)} but the constants say ${JSON.stringify(want)}: change ${OPENAPI}, or PARAMETER_FACTS in this test if the constant is what is new.`)
        }
      }
    }
    report(problems)
  })

  it('the schemas of the components state exactly the facts of SCHEMA_FACTS', () => {
    const found = {}
    for (const [keys, node] of nodes(doc.components.schemas)) {
      if (Array.isArray(node)) continue
      for (const key of KEYWORDS) if (key in node) found[[...keys, key].join('.')] = node[key]
    }
    const problems = []
    for (const [where, value] of Object.entries(found)) {
      if (!(where in SCHEMA_FACTS)) problems.push(`components.schemas.${where} (${JSON.stringify(value)}) is not pinned to a constant in SCHEMA_FACTS of this test: pin it.`)
      else if (!isDeepStrictEqual(value, SCHEMA_FACTS[where])) problems.push(`components.schemas.${where} is ${JSON.stringify(value)} but its constant is ${JSON.stringify(SCHEMA_FACTS[where])}.`)
    }
    for (const where of Object.keys(SCHEMA_FACTS)) if (!(where in found)) problems.push(`SCHEMA_FACTS pins components.schemas.${where}, which the document no longer states.`)
    report(problems)
  })

  it('the enums of the flags, outcomes, sources and GPS modes are the lists of shared/ in full (nothing left out, nothing added)', () => {
    const scan = doc.components.schemas.Scan.properties
    expect(scan.flags.items.enum).toEqual([...SCAN_FLAGS])
    expect(scan.outcome.enum).toEqual([...SCAN_OUTCOMES])
    expect(scan.source.enum).toEqual([...SCAN_SOURCES])
    expect(doc.components.schemas.Point.properties.gps_mode.enum).toEqual([...GPS_MODES])
    // schemaDoc describes the same values.
    expect(Object.keys(schemaDoc.flags)).toEqual([...SCAN_FLAGS])
    expect(Object.keys(schemaDoc.outcomes)).toEqual([...SCAN_OUTCOMES])
    expect(Object.keys(schemaDoc.sources)).toEqual([...SCAN_SOURCES])
  })

  it('every field of an answer is described by schemaDoc, and every property of an object is required', () => {
    const problems = []
    for (const [name, fields] of [['Point', schemaDoc.points_fields], ['Provider', schemaDoc.providers_fields], ['Scan', { ...schemaDoc.time_fields, ...schemaDoc.scan_fields }]]) {
      const properties = doc.components.schemas[name].properties
      problems.push(...diffNames('field', { where: `schemaDoc (${name})`, names: Object.keys(fields) }, { where: `components.schemas.${name}`, names: Object.keys(properties) }))
      for (const [field, text] of Object.entries(fields)) {
        if (properties[field]?.description !== text) problems.push(`${name}.${field} does not carry the description of schemaDoc.`)
      }
    }
    for (const [name, schema] of Object.entries(doc.components.schemas)) {
      if (name === 'Error') continue // an error carries extra keys when it has them: its code and message are the required ones
      for (const [keys, node] of nodes(schema)) {
        if (!node.properties || Array.isArray(node)) continue
        const where = `components.schemas.${[name, ...keys].join('.')}`
        if ([...(node.required ?? [])].sort().join() !== Object.keys(node.properties).sort().join()) problems.push(`${where} does not require all its properties (the keys are always there; a missing value is null).`)
      }
    }
    report(problems)
  })
})

// ======================================================================================================================
// the real API: e, f, g, and the black-box half of c
// ======================================================================================================================

/** Values that the real route must refuse, by parameter: the 400 must be invalid_filter (invalid_cursor for the cursor) naming the parameter. */
const INVALID_VALUES = {
  from: ['2026-02-30', '2026-06-01T10:00:00', 'yesterday'],
  to: ['2026-02-30', '2026-06-01T10:00:00', 'yesterday'],
  point_id: ['zzz', '123'],
  provider_id: ['zzz', '123'],
  service_type: [], // any text: it is cut, never refused
  flag: [], // any text: a flag that no scan carries matches nothing
  outcome: ['zzz', 'ACCEPTED'],
  include_voided: [], // true or 1 mean yes, anything else no
  include_demo: [],
  order: ['zzz', 'up'],
  limit: ['0', '-1', 'abc', '1.5'],
  cursor: ['zzz'],
  format: [], // csv, or JSON for any other value
}

/** Values the document allows for a parameter schema, as the text of a query. */
function allowedValues(schema, sampleOf) {
  if (schema.anyOf) return schema.anyOf.flatMap((branch) => allowedValues(branch, sampleOf))
  if (schema.enum) return schema.enum.map(String)
  if (schema.type === 'boolean') return ['true', 'false', '1', '0']
  if (schema.type === 'integer') return [String(schema.minimum ?? 1), String(schema.maximum ?? 10), String(schema.default ?? 1)]
  if (schema.format === 'uuid') return [randomUUID()]
  if (schema.format === 'date') return ['2026-09-30']
  if (schema.format === 'date-time') return ['2026-09-30T10:00:00+03:00', '2026-09-30T07:00:00Z']
  return [sampleOf]
}

describe('the real agent API answers what the document says', () => {
  let db, key, revokedKey, cookie
  // One key may make AGENT_KEY_MAX_PER_MINUTE requests in a minute (server/config.js), and the tests below send more than
  // that in all (every documented value of every parameter is a request). So they work through keys, as
  // tests/agent-docs.test.js does: the same key is used for at most KEY_USES requests (counting the ones that never reach
  // the guard too, which only makes it safer), then a fresh one is made. No test depends on which key it gets.
  const KEY_USES = Math.floor((config.AGENT_KEY_MAX_PER_MINUTE * 2) / 3)
  let keyUses = 0
  async function currentKey() {
    if (keyUses >= KEY_USES) {
      key = (await mintAgentKey(cookie, 'agent openapi')).key
      keyUses = 0
    }
    keyUses += 1
    return key
  }
  const get = async (p, opts = {}) => call('GET', `/api/agent/v1${p}`, { token: await currentKey(), ...opts })
  /** The 200 JSON schema of a registry row, from the document. */
  const answerSchema = (e) => operationOf(e).responses['200'].content['application/json'].schema
  /** The schema behind a $ref to the components (or the schema itself). */
  const resolved = (schema) => (schema.$ref ? doc.components.schemas[schema.$ref.split('/').pop()] : schema)
  const validatorOf = (e) => compileSchema(answerSchema(e), { shut: true })
  const FULL = '/scans?outcome=all&include_voided=1&include_demo=1&limit=500'

  beforeAll(async () => {
    db = await setupDb()
    await seedAdmin(db.pool)
    cookie = await adminCookie()
    const post = async (p, body) => {
      const r = await call('POST', p, { cookie, body })
      if (r.status !== 201 && r.status !== 200) throw new Error(`seed ${p}: ${r.status} ${r.text}`)
      return r.json
    }
    const provider = async (body) => (await post('/api/admin/providers', { password: 'agent-openapi-1', ...body })).provider
    const cleaner = await provider({ company: 'Sparkle Cleaning', contact_name: 'Test', service_type: 'cleaning' })
    const gardener = await provider({ company: 'Green Gardens' }) // no contact name, no service type
    const demo = await provider({ company: 'Demo account', is_demo: true })
    const leaving = await provider({ company: 'Leaving Ltd' }) // deleted below: its scan stays
    await provider({ company: 'Never Came Ltd' }) // no scan at all: last_scan_at is null
    const HOME = SAMPLE_POINT
    const point = async (body) => (await post('/api/admin/points', body)).point
    const lobby = await point({ name: 'Lobby', description: 'Main entrance', service_type: 'cleaning', lat: HOME.lat, lng: HOME.lng, gps_mode: 'optional' })
    const basement = await point({ name: 'Basement', lat: HOME.lat, lng: HOME.lng, gps_mode: 'none', provider_ids: [cleaner.id] })
    const gate = await point({ name: 'Gate', lat: HOME.lat, lng: HOME.lng, gps_mode: 'required' })
    const gone = await point({ name: 'Shed', gps_mode: 'optional', lat: HOME.lat, lng: HOME.lng })
    await point({ name: 'Roof', gps_mode: 'none', is_active: false }) // no coordinates, switched off
    const session = async (p, password = 'agent-openapi-1') => (await call('POST', '/api/session', { body: { provider_id: p.id, password } })).json.token
    const [cleanerToken, gardenerToken, demoToken, leavingToken] = await Promise.all([session(cleaner), session(gardener), session(demo), session(leaving)])
    const scan = (token, p, gps) => call('POST', '/api/scan', { token, body: { id: randomUUID(), code: p.qr_token, ...(gps ? { gps } : {}) } })
    const north = (metres) => ({ lat: HOME.lat + metres / 111_195, lng: HOME.lng, accuracy: 8 })
    const results = [
      await scan(cleanerToken, lobby, { ...HOME, accuracy: 8 }), // accepted, with a distance
      await call('POST', '/api/scans/sync', { token: cleanerToken, body: { scans: [{ id: randomUUID(), code: basement.qr_token, client_time: '2020-01-01T10:00:00Z' }] } }), // offline_sync and clock_skew
      await scan(gardenerToken, gate, null), // a point that requires GPS, no fix: rejected_no_location
      await scan(gardenerToken, gate, { ...SAMPLE_FAR_POINT, accuracy: 8 }), // far: rejected_far
      await scan(gardenerToken, lobby, north(60)), // a bit outside the radius
      await scan(demoToken, lobby, { ...HOME, accuracy: 8 }), // the demo account: flag demo
      await scan(cleanerToken, gone, { ...HOME, accuracy: 8 }), // at a point that is deleted below
      await scan(leavingToken, lobby, { ...HOME, accuracy: 8, age_s: 120 }), // a remembered position: location_stale; voided and left below
    ]
    if (results.some((r) => r.status !== 200)) throw new Error(`a seed scan was refused: ${results.map((r) => r.status).join()}`)
    const leavingScan = results[7].json.scan
    await post(`/api/admin/scans/${leavingScan.id}/void`, { reason: 'test' })
    expect((await call('DELETE', `/api/admin/points/${gone.id}`, { cookie })).status).toBe(200)
    expect((await call('DELETE', `/api/admin/providers/${leaving.id}`, { cookie })).status).toBe(200)

    key = (await mintAgentKey(cookie, 'agent openapi')).key
    const spare = await mintAgentKey(cookie, 'agent openapi, revoked')
    revokedKey = spare.key
    await revokeAgentKey(cookie, spare.id)
  }, 120_000)

  afterAll(async () => db?.teardown())

  // ---- f ----

  it('f. the route serves, behind the key, the document that the module builds', async () => {
    const served = await get('/openapi.json')
    expect(served.status).toBe(200)
    expect(served.headers['content-type']).toMatch(/^application\/json/)
    expect(served.json).toEqual(plain(buildOpenApi()))
    expect(served.json).toEqual(doc)
    // And the served document is valid OpenAPI 3.1 as it arrives.
    report(openApiErrors(served.json).map((e) => `The served document is not valid OpenAPI 3.1: ${e}`))
  })

  it('f. the route is not public: no key, an unknown key and a revoked key are refused', async () => {
    const path = '/api/agent/v1/openapi.json'
    const refused = [
      [await call('GET', path), 'api_key_required'],
      [await call('GET', path, { token: `${config.API_KEY_PREFIX}unknown` }), 'api_key_invalid'],
      [await call('GET', path, { token: revokedKey }), 'api_key_invalid'],
    ]
    for (const [r, code] of refused) {
      expect(r.status).toBe(401)
      expect(r.json.error.code).toBe(code)
      expect(r.text).not.toContain('openapi')
    }
    expect((await call('POST', path, { token: await currentKey(), body: {} })).status).toBe(405)
  })

  // ---- e ----

  it('e. the real answer of every JSON route validates against its 200 schema, closed', async () => {
    const problems = []
    for (const e of AGENT_ENDPOINTS) {
      const validate = validatorOf(e)
      const urls = e.id === 'listScans' ? [pathOf(e), FULL] : [pathOf(e)]
      for (const url of urls) {
        const r = await get(url)
        if (r.status !== 200) {
          problems.push(`GET ${url} answered ${r.status}, so its answer cannot be checked.`)
          continue
        }
        if (!validate(r.json)) problems.push(`The real answer of GET ${url} does not fit its 200 schema in the document (${errorsOf(validate).slice(0, 4).join('; ')}). Update ${OPENAPI}, or the answer if it is what is wrong.`)
        // The envelope of the registry is the top level of the schema, in order.
        if (e.envelope) {
          const properties = Object.keys(resolved(answerSchema(e)).properties ?? {})
          if (properties.join() !== e.envelope.join()) problems.push(`The envelope of ${endpointKey(e)} (${e.envelope.join(', ')}) is not the top level of its schema (${properties.join(', ')}).`)
          if (Object.keys(r.json).join() !== e.envelope.join()) problems.push(`The real answer of ${endpointKey(e)} has the keys ${Object.keys(r.json).join(', ')}, the registry says ${e.envelope.join(', ')}.`)
        }
      }
    }
    report(problems)
  })

  it('e. the seed covers what the schemas allow, so the check above is not vacuous', async () => {
    const scans = (await get(FULL)).json.scans
    const points = (await get('/points')).json.points
    const providers = (await get('/providers')).json.providers
    const seen = (list, field) => new Set(list.map((x) => x[field]))
    const nullAndNot = (list, field) => seen(list, field).has(null) && [...seen(list, field)].some((v) => v !== null)
    const problems = []
    for (const outcome of SCAN_OUTCOMES) if (!seen(scans, 'outcome').has(outcome)) problems.push(`No seed scan has the outcome ${outcome}.`)
    for (const source of SCAN_SOURCES) if (!seen(scans, 'source').has(source)) problems.push(`No seed scan has the source ${source}.`)
    for (const field of ['service_type', 'distance_m', 'gps_accuracy_m', 'void_reason']) if (!nullAndNot(scans, field)) problems.push(`The seed scans do not have both a null and a value in ${field}.`)
    if (!seen(scans, 'voided').has(true) || !seen(scans, 'voided').has(false)) problems.push('The seed scans are not both voided and not voided.')
    const flags = new Set(scans.flatMap((s) => s.flags))
    for (const flag of ['offline_sync', 'clock_skew', 'demo', 'location_stale', 'location_outside_radius']) if (!flags.has(flag)) problems.push(`No seed scan carries the flag ${flag}.`)
    if (!scans.some((s) => !points.some((p) => p.id === s.point_id))) problems.push('No seed scan is at a deleted point.')
    if (!scans.some((s) => !providers.some((p) => p.id === s.provider_id))) problems.push('No seed scan is by a deleted provider.')
    if (!nullAndNot(points, 'lat') || !nullAndNot(points, 'lng') || !nullAndNot(points, 'service_type')) problems.push('The seed points do not have both a null and a value in lat, lng and service_type.')
    if (!points.some((p) => p.assigned_provider_ids.length) || !points.some((p) => !p.assigned_provider_ids.length)) problems.push('The seed points are not both assigned and open to everyone.')
    if (!nullAndNot(providers, 'last_scan_at')) problems.push('The seed providers do not have both a last_scan_at and none.')
    report(problems)
  })

  it('e. the closed check notices an added field, a missing field and a wrong type', async () => {
    const e = AGENT_ENDPOINTS.find((x) => x.id === 'listScans')
    const validate = validatorOf(e)
    const answer = (await get('/scans?limit=2')).json
    expect(validate(answer), errorsOf(validate).join('; ')).toBe(true)
    const changed = (change) => {
      const copy = plain(answer)
      change(copy)
      return copy
    }
    expect(validate(changed((a) => (a.scans[0].new_field = 1)))).toBe(false)
    expect(validate(changed((a) => delete a.scans[0].void_reason))).toBe(false)
    expect(validate(changed((a) => (a.scans[0].distance_m = '12')))).toBe(false)
    expect(validate(changed((a) => (a.scans[0].outcome = 'rejected_other')))).toBe(false)
    expect(validate(changed((a) => (a.scans[0].flags = ['new_flag'])))).toBe(false)
    expect(validate(changed((a) => (a.extra = true)))).toBe(false)
    expect(validate(changed((a) => delete a.next_cursor))).toBe(false)
  })

  it('e. paging: next_cursor is a string on a page that has another and null on the last, as the schema says', async () => {
    const first = (await get('/scans?outcome=all&limit=2')).json
    expect(typeof first.next_cursor).toBe('string')
    const last = (await get(FULL)).json
    expect(last.next_cursor).toBeNull()
    const validate = compileSchema(doc.components.schemas.ScanList, { shut: true })
    expect(validate(first), errorsOf(validate).join('; ')).toBe(true)
    expect(validate(last), errorsOf(validate).join('; ')).toBe(true)
  })

  it('e. the CSV variant is what the document says: text/csv, the columns of a scan, and the cursor in X-Next-Cursor', async () => {
    const ok = operationOf(AGENT_ENDPOINTS.find((x) => x.id === 'listScans')).responses['200']
    expect(Object.keys(ok.content)).toEqual(['application/json', 'text/csv'])
    expect(ok.content['text/csv'].schema.type).toBe('string')
    expect(Object.keys(ok.headers)).toEqual(['X-Next-Cursor'])
    expect(Object.keys(doc.components.schemas.Scan.properties)).toEqual(SCAN_CSV_COLUMNS)
    for (const column of SCAN_CSV_COLUMNS) expect(ok.content['text/csv'].schema.description, `the CSV column ${column}`).toContain(column)

    const page = await get('/scans?outcome=all&format=csv&limit=2')
    expect(page.headers['content-type']).toMatch(/^text\/csv/)
    expect(page.text.split('\r\n')[0]).toBe(SCAN_CSV_COLUMNS.join(','))
    const first = (await get('/scans?outcome=all&limit=2')).json.next_cursor
    expect(page.headers['x-next-cursor']).toBe(first) // the header is the cursor of the JSON page
    const all = await get('/scans?outcome=all&format=csv&limit=500')
    expect(all.headers['x-next-cursor']).toBeUndefined() // absent on the last page
  })

  // ---- c, black-box ----

  it('c. the real route accepts what each documented parameter allows, and refuses what it must refuse', async () => {
    const problems = []
    const cursor = (await get('/scans?outcome=all&limit=1')).json.next_cursor
    for (const e of AGENT_ENDPOINTS) {
      for (const parameter of operationOf(e).parameters ?? []) {
        const { name } = parameter
        if (!(name in INVALID_VALUES)) {
          problems.push(`${endpointKey(e)} documents the parameter "${name}", which INVALID_VALUES of this test does not know: add the values that the route must refuse (an empty list if it refuses none).`)
          continue
        }
        const sample = name === 'cursor' ? cursor : 'cleaning'
        for (const value of allowedValues(parameter.schema, sample)) {
          const r = await get(`${pathOf(e)}?${name}=${encodeURIComponent(value)}${name === 'limit' ? '' : '&limit=1'}`)
          if (r.status !== 200) problems.push(`${endpointKey(e)} with ${name}=${value}, which the document allows, answered ${r.status} ${r.json?.error?.code}.`)
        }
        for (const value of INVALID_VALUES[name]) {
          const r = await get(`${pathOf(e)}?${name}=${encodeURIComponent(value)}`)
          const code = name === 'cursor' ? 'invalid_cursor' : 'invalid_filter'
          if (r.status !== 400 || r.json?.error?.code !== code) problems.push(`${endpointKey(e)} with ${name}=${value} answered ${r.status} ${r.json?.error?.code}, not 400 ${code}.`)
          else if (name !== 'cursor' && r.json.error.field !== name) problems.push(`${endpointKey(e)} with ${name}=${value} named the field "${r.json.error.field}".`)
        }
      }
    }
    for (const name of Object.keys(INVALID_VALUES)) {
      if (!AGENT_ENDPOINTS.some((e) => e.filters.includes(name))) problems.push(`INVALID_VALUES of this test has "${name}", which no endpoint of the registry reads: remove it.`)
    }
    report(problems)
  }, 60_000)

  it('c. a limit above the maximum is cut, not refused, as the parameter says', async () => {
    const r = await get(`/scans?outcome=all&include_voided=1&include_demo=1&limit=${config.MAX_PAGE_SIZE + 1}`)
    expect(r.status).toBe(200)
    const description = doc.paths['/scans'].get.parameters.find((p) => p.name === 'limit').description
    expect(description).toContain(`cut to ${config.MAX_PAGE_SIZE}`)
  })

  // ---- g ----

  const nameOf = (status) => STATUS_CODES[status].replace(/[^A-Za-z0-9]/g, '')
  const schemaErrors = () =>
    Object.entries(schemaDoc.errors)
      .filter(([code]) => code !== 'shape')
      .map(([code, text]) => {
        const m = /^(\d{3}): ([\s\S]*)$/.exec(text)
        return { code, status: Number(m[1]), meaning: m[2] }
      })
  const responseCodes = (response) => response.content['application/json'].schema.allOf.flatMap((part) => [...nodes(part)].flatMap(([keys, node]) => (keys.at(-1) === 'code' && node.enum ? node.enum : [])))

  it('g. the error codes of the document are the codes of schemaDoc.errors, each under its status', () => {
    const problems = []
    const errors = schemaErrors()
    const inDocument = Object.values(doc.components.responses).flatMap(responseCodes)
    problems.push(...diffNames('error code', { where: 'schemaDoc.errors (server/schemaDoc.js)', names: errors.map((x) => x.code) }, { where: 'components.responses of the document', names: inDocument }))
    for (const { code, status, meaning } of errors) {
      const response = doc.components.responses[nameOf(status)]
      if (!response) problems.push(`schemaDoc.errors.${code} is a ${status}, but the document has no response "${nameOf(status)}".`)
      else {
        if (!responseCodes(response).includes(code)) problems.push(`The response ${nameOf(status)} does not list the code ${code}, which schemaDoc.errors gives the status ${status}.`)
        if (!response.description.includes(`- ${code}: ${meaning}`)) problems.push(`The response ${nameOf(status)} does not carry the text of schemaDoc.errors.${code}.`)
      }
    }
    for (const name of Object.keys(doc.components.responses)) {
      if (!errors.some((x) => nameOf(x.status) === name)) problems.push(`The response ${name} is in the document but no code of schemaDoc.errors has its status.`)
    }
    report(problems)
  })

  it('g. every operation answers the statuses of the codes, except 404 and 405 (the URL and the method), by reference', () => {
    const problems = []
    const statuses = [...new Set(schemaErrors().map((x) => x.status))]
    for (const { path, method, operation } of operationsOf(doc)) {
      for (const status of statuses) {
        const response = operation.responses[String(status)]
        if ([404, 405].includes(status)) {
          if (response) problems.push(`${method} ${path} lists ${status}, which is the status of a wrong URL or method, not of the operation.`)
        } else if (response?.$ref !== `#/components/responses/${nameOf(status)}`) {
          problems.push(`${method} ${path} does not answer ${status} with the shared response ${nameOf(status)}.`)
        }
      }
      for (const status of Object.keys(operation.responses)) {
        if (status !== '200' && !statuses.includes(Number(status))) problems.push(`${method} ${path} lists ${status}, which no code of schemaDoc.errors has.`)
      }
    }
    report(problems)
  })

  it('g. the real error answers fit the documented response of their status', async () => {
    const problems = []
    const checked = new Set()
    const check = (r, how, code) => {
      const status = r.status
      const response = doc.components.responses[nameOf(status)]
      if (!response) return problems.push(`${how} answered ${status}, which the document has no response for.`)
      const validate = compileSchema(response.content['application/json'].schema)
      if (!validate(r.json)) problems.push(`${how} answered ${status} ${r.json?.error?.code}, which does not fit the response ${nameOf(status)} (${errorsOf(validate).join('; ')}).`)
      if (r.json?.error?.code !== code) problems.push(`${how} answered the code ${r.json?.error?.code}, expected ${code}.`)
      checked.add(`${status} ${code}`)
    }
    check(await call('GET', '/api/agent/v1/scans'), 'no key', 'api_key_required')
    check(await call('GET', '/api/agent/v1/scans', { token: `${config.API_KEY_PREFIX}unknown` }), 'an unknown key', 'api_key_invalid')
    check(await get('/scans?order=up'), 'a bad order', 'invalid_filter')
    check(await get('/scans?cursor=zzz'), 'a bad cursor', 'invalid_cursor')
    check(await call('GET', '/api/agent/v1/health', { token: await currentKey(), badJsonBody: true }), 'a body that is not JSON', 'invalid_json')
    check(await call('GET', '/api/agent/v1/nope', {}), 'an unknown endpoint', 'not_found')
    check(await call('POST', '/api/agent/v1/scans', { token: await currentKey(), body: {} }), 'a POST', 'method_not_allowed')
    // A failure of the server itself: a database that cannot be reached, through the real route and the real router.
    const pool = getPool()
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {})
    setPool({ query: async () => { throw Object.assign(new Error('connection lost'), { code: 'ECONNRESET' }) } })
    try {
      check(await get('/scans'), 'a database that cannot be reached', 'server_error')
    } finally {
      setPool(pool)
      logged.mockRestore()
    }
    // The field of an invalid_filter is in the schema of the error.
    expect((await get('/scans?order=up')).json.error.field).toBe('order')
    expect(doc.components.schemas.Error.properties.error.properties.field.type).toBe('string')
    // Every code of the document that this test can cause was caused; the others (invalid_input, a rate limit...) are checked above by their text.
    expect(checked.size).toBeGreaterThanOrEqual(8)
    report(problems)
  })
})
