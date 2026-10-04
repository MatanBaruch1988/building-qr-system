// The agent API is described by hand in more than one place, and a description that nobody checks drifts: pull requests
// #33 and #36 fixed about a dozen places where it had. This test makes the CODE the source and fails, naming what is
// missing where, when a description no longer matches it. The descriptions are:
//   - server/schemaDoc.js: the JSON that GET /api/agent/v1/schema serves, read by the agent on every run;
//   - docs/agent-api.md: the same contract for a person (read here by its headings and its table and list shapes);
//   - src/admin/views/HistoryView.jsx: the Hebrew label of every flag in the committee's history screen.
// What is compared with what (the first of each line is the truth):
//   1. flags:          shared/flags.js = what server/ emits = schemaDoc.flags = the list in the md = FLAGS of HistoryView
//   2. scan fields:    the real /scans answer = the real CSV header = schemaDoc (time_fields + scan_fields) = the md example
//   3. points, providers and the envelopes of every answer: the real answers = schemaDoc = the md tables
//   4. endpoints:      the routes under /agent/v1 in routeTable() = schemaDoc.endpoints = the md table
//   5. filters:        what listScans really reads = SCAN_FILTERS = schemaDoc = the md (and the values they allow)
//   6. outcomes and sources: the check constraints of the scans table (db/migrations) = schemaDoc = the md
//   7. error codes:    what the real routes answer to a matrix of bad requests = schemaDoc.errors = the md table
//   8. numbers in prose: server/config.js = the prose of schemaDoc (written from the constant) = the md (typed)
// When a test here fails, update the document that the message names (or the code, if the code is what is wrong). A
// document that cannot be read any more (a heading or a table that moved) fails with the shape that the test expects.
import { describe, it, expect, beforeAll, afterAll, vi, assert } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { setupDb, call, seedAdmin, adminCookie } from './helpers.js'
import { SAMPLE_POINT } from '../scripts/sample-data.mjs'
import '../server/index.js' // importing it registers every route file with the router
import { routeTable } from '../server/router.js'
import { getPool, setPool } from '../server/db.js'
import { schemaDoc } from '../server/schemaDoc.js'
import * as config from '../server/config.js'
import * as flagsModule from '../shared/flags.js'
import { SCAN_FLAGS } from '../shared/flags.js'
import { SCAN_FILTERS, SCAN_CSV_COLUMNS, listScans } from '../server/scans.js'
import { evaluateGps, resolveClock } from '../server/scanLogic.js'

// ---------- where the documents are ----------

const MD = 'docs/agent-api.md'
const SCHEMA = 'server/schemaDoc.js'
const HISTORY = 'src/admin/views/HistoryView.jsx'
const FLAGS_FILE = 'shared/flags.js'

const abs = (relative) => fileURLToPath(new URL(`../${relative}`, import.meta.url))
const read = (relative) => fs.readFileSync(abs(relative), 'utf8').replace(/\r\n/g, '\n')
const md = read(MD)

// Where each list lives, as the failure messages name it.
const WHERE = {
  schemaFlags: `${SCHEMA} (the flags object)`,
  mdFlags: `${MD} (the list under "Flags are signals, not verdicts")`,
  historyFlags: `${HISTORY} (FLAGS)`,
  schemaEndpoints: `${SCHEMA} (the endpoints object)`,
  mdEndpoints: `${MD} (the table under "## Endpoints")`,
  mdEnvelopes: `${MD} (the table under "### Response envelopes")`,
  mdScanRow: `${MD} (the JSON example under "## A scan row")`,
  schemaScanFields: `${SCHEMA} (time_fields and scan_fields)`,
  schemaPoints: `${SCHEMA} (points_fields)`,
  schemaProviders: `${SCHEMA} (providers_fields)`,
  mdPoints: `${MD} (the point table under "## A point and a provider")`,
  mdProviders: `${MD} (the provider table under "## A point and a provider")`,
  schemaFilters: `${SCHEMA} (the Query list of the GET /scans endpoint)`,
  mdFilters: `${MD} (the first paragraph under the GET /scans filters heading)`,
  schemaOutcomes: `${SCHEMA} (outcomes)`,
  schemaSources: `${SCHEMA} (sources)`,
  mdOutcomes: `${MD} (the outcome table under "## Outcomes and sources")`,
  mdSources: `${MD} (the source table under "## Outcomes and sources")`,
  schemaErrors: `${SCHEMA} (errors)`,
  mdErrors: `${MD} (the table under "## Errors")`,
}

// ---------- reporting ----------

/** Fails with every problem on its own line. An empty list passes. */
function report(problems) {
  const unique = [...new Set(problems)]
  if (unique.length) assert.fail(`\n${unique.map((p) => `  - ${p}`).join('\n')}\n`)
}

/**
 * The differences between the names that the code has (`truth`) and the names that a document lists (`doc`), one sentence
 * each, saying what to update. `thing` is a noun for the sentences ("flag", "filter").
 */
function diffNames(thing, truth, doc) {
  const problems = []
  for (const name of truth.names) {
    if (!doc.names.includes(name)) problems.push(`${thing} "${name}" is in ${truth.where} but is missing from ${doc.where}: add it there.`)
  }
  for (const name of doc.names) {
    if (!truth.names.includes(name)) {
      problems.push(`${thing} "${name}" is listed in ${doc.where} but is not in ${truth.where}: remove it there (or add it to the code, if it is real).`)
    }
  }
  const seen = new Set()
  for (const name of doc.names) {
    if (seen.has(name)) problems.push(`${thing} "${name}" is listed twice in ${doc.where}: remove one.`)
    seen.add(name)
  }
  return problems
}

/** Compares one truth with several documents. */
const diffAll = (thing, truth, docs) => docs.flatMap((doc) => diffNames(thing, truth, doc))

// ---------- reading the Markdown, narrowly: by headings and by table and list shapes ----------

const headingLevel = (line) => /^(#{1,6}) /.exec(line)?.[1].length ?? 0

/** The text under a heading (the exact heading line) up to the next heading of the same or a higher level. */
function section(text, heading, where = MD) {
  const lines = text.split('\n')
  let fence = false
  let start = -1
  let level = 0
  for (let i = 0; i < lines.length; i++) {
    if (/^```/.test(lines[i])) fence = !fence
    if (fence || /^```/.test(lines[i])) continue
    if (start < 0) {
      if (lines[i] === heading) {
        start = i + 1
        level = headingLevel(lines[i])
      }
      continue
    }
    const l = headingLevel(lines[i])
    if (l && l <= level) return lines.slice(start, i).join('\n')
  }
  if (start < 0) {
    throw new Error(
      `${where} has no heading "${heading}". The drift test reads the document by its headings: keep the heading, or change it in tests/agent-docs.test.js too.`,
    )
  }
  return lines.slice(start).join('\n')
}

const cells = (line) => line.trim().replace(/^\||\|$/g, '').split('|').map((c) => c.trim())

/** Every table of a text: { before (the last non-empty line above it), header (cells), rows (cells of each row) }. */
function tables(text) {
  const lines = text.split('\n')
  const found = []
  for (let i = 0; i < lines.length; i++) {
    if (!lines[i].startsWith('|') || (i > 0 && lines[i - 1].startsWith('|'))) continue
    const block = []
    for (let j = i; j < lines.length && lines[j].startsWith('|'); j++) block.push(lines[j])
    let before = ''
    for (let j = i - 1; j >= 0 && !before; j--) before = lines[j].trim()
    found.push({ before, header: cells(block[0]), rows: block.slice(2).map(cells) })
  }
  return found
}

/** The one table of a section whose line above it matches `before` (or the first one when `before` is left out). */
function tableOf(text, what, before) {
  const all = tables(text)
  const t = before ? all.find((x) => before.test(x.before)) : all[0]
  if (!t) {
    throw new Error(
      `${MD} has no table ${what}. The drift test reads it by its shape (a Markdown table${before ? ` right under a line that matches ${before}` : ''}): keep that shape, or change the reader in tests/agent-docs.test.js.`,
    )
  }
  return t
}

const codes = (cell) => [...cell.matchAll(/`([^`]+)`/g)].map((m) => m[1])

/** Removes every (...) group, innermost first, so that what is left is the list of names around them. */
function stripParens(text) {
  let previous
  let out = text
  do {
    previous = out
    out = out.replace(/\([^()]*\)/g, '')
  } while (out !== previous)
  return out
}

/** The names inside the braces of '{ scans, count, next_cursor }' (a note in parentheses after a name is dropped). */
function braceKeys(text) {
  const inner = /\{([^}]*)\}/.exec(text)?.[1]
  if (inner === undefined) return null
  return stripParens(inner).split(',').map((s) => s.trim()).filter(Boolean)
}

// What the md says, read once.
const mdEndpoints = () =>
  tableOf(section(md, '## Endpoints'), 'of endpoints under "## Endpoints"').rows.map((r) => codes(r[0])[0])
const mdEnvelopes = () =>
  Object.fromEntries(
    tableOf(section(md, '### Response envelopes'), 'of the answers under "### Response envelopes"').rows.map((r) => [
      codes(r[0])[0],
      braceKeys(codes(r[1]).find((c) => c.startsWith('{')) ?? ''),
    ]),
  )
const mdFilterParagraph = () => section(md, '### `GET /scans` filters').trim().split(/\n\s*\n/)[0].replace(/\s*\n\s*/g, ' ')
const mdFilters = () => codes(stripParens(mdFilterParagraph()))
function mdFlags() {
  const lines = section(md, '## How to read it').split('\n')
  const start = lines.findIndex((l) => l.startsWith('- **Flags are signals'))
  if (start < 0) throw new Error(`${MD} has no bullet that starts with "- **Flags are signals" under "## How to read it": the flag list is read from the nested bullets under it.`)
  const names = []
  for (const line of lines.slice(start + 1)) {
    if (/^- /.test(line)) break
    const m = /^\s+- `([a-z_]+)`:/.exec(line)
    if (m) names.push(m[1])
  }
  return names
}
const mdScanRowKeys = () => {
  const block = /```json\n([\s\S]*?)\n```/.exec(section(md, '## A scan row'))?.[1]
  if (!block) throw new Error(`${MD} has no \`\`\`json block under "## A scan row": the scan fields are read from its keys.`)
  return Object.keys(JSON.parse(block))
}
const mdFieldTable = (before) =>
  tableOf(section(md, '## A point and a provider'), `of fields under "## A point and a provider"`, before).rows.flatMap((r) => codes(r[0]))
const mdValueTable = (header) => {
  const t = tables(section(md, '## Outcomes and sources')).find((x) => x.header[0] === header)
  if (!t) throw new Error(`${MD} has no table whose first column is ${header} under "## Outcomes and sources": the outcomes and the sources are read from it.`)
  return t.rows.flatMap((r) => codes(r[0]))
}
const mdErrorPairs = () =>
  tableOf(section(md, '## Errors'), 'of errors under "## Errors"').rows.map((r) => {
    const m = /^(\d{3}) ([a-z_]+)$/.exec(codes(r[0])[0] ?? '')
    if (!m) throw new Error(`${MD}: a row of the table under "## Errors" does not start with \`<status> <code>\` in backticks: "${r[0]}".`)
    return { pair: `${m[1]} ${m[2]}`, meaning: r[1] }
  })

// What schemaDoc says (the object that the endpoint serves), in the same shapes.
const schemaPairs = () =>
  Object.entries(schemaDoc.errors)
    .filter(([key]) => key !== 'shape')
    .map(([code, text]) => {
      const m = /^(\d{3}):/.exec(text)
      if (!m) throw new Error(`${SCHEMA}: errors.${code} does not start with "<status>:" ("${text}").`)
      return { pair: `${m[1]} ${code}`, meaning: text }
    })
const schemaScansText = schemaDoc.endpoints['GET /api/agent/v1/scans']
function schemaFilters() {
  const m = /^Query: (.*?)\. Returns \{/s.exec(schemaScansText ?? '')
  if (!m) throw new Error(`${SCHEMA}: the text of GET /api/agent/v1/scans must start with "Query: a, b (note), c ..." and continue with ". Returns {": the filters are read from that list.`)
  return stripParens(m[1]).split(',').map((s) => s.trim()).filter(Boolean)
}
const schemaEnvelope = (endpointKey) => braceKeys(/Returns (\{[^}]*\})/.exec(schemaDoc.endpoints[endpointKey] ?? '')?.[1] ?? '')

// ---------- reading the code ----------

const serverFiles = () => {
  const files = []
  const walk = (dir) => {
    for (const entry of fs.readdirSync(abs(dir), { withFileTypes: true })) {
      const rel = `${dir}/${entry.name}`
      if (entry.isDirectory()) walk(rel)
      else if (/\.(js|mjs)$/.test(entry.name)) files.push({ file: rel, text: read(rel) })
    }
  }
  walk('server')
  return files
}
const stripComments = (text) => text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')

/** The values that the latest check constraint `check (<column> in (...))` allows, from the migration files in order. */
function migrationAllowed(column) {
  const dir = abs('db/migrations')
  let latest = null
  for (const file of fs.readdirSync(dir).filter((f) => /^\d+_.*\.sql$/.test(f)).sort()) {
    const sql = fs.readFileSync(path.join(dir, file), 'utf8').replace(/--.*$/gm, '')
    for (const m of sql.matchAll(new RegExp(`check\\s*\\(\\s*${column}\\s+in\\s*\\(([^)]*)\\)\\s*\\)`, 'gi'))) {
      latest = { file, values: [...m[1].matchAll(/'([^']*)'/g)].map((x) => x[1]) }
    }
  }
  if (!latest) {
    throw new Error(
      `No migration in db/migrations defines "check (${column} in (...))". If the constraint changed shape, change migrationAllowed in tests/agent-docs.test.js to read the new one.`,
    )
  }
  return latest
}

const agentRoutes = () => routeTable().filter((r) => r.path.startsWith('/agent/v1/'))
const toFull = (method, p) => `${method} /api${p}`
const mdToFull = (endpoint) => endpoint.replace(/^(\w+) /, '$1 /api/agent/v1')

// ======================================================================================================================
// The readers themselves: a document reader that silently reads nothing would make every test below pass for nothing.
// ======================================================================================================================

describe('the readers of the Markdown', () => {
  const sample = ['# T', '', '## A', 'text', '```', '## not a heading', '```', '### B', 'x', '## C', '', 'Look (`/points`):', '', '| Key | Meaning |', '|---|---|', '| `id`, `lat` | one |', '| `name` | two |'].join('\n')
  it('reads a section up to the next heading of the same level, and ignores headings inside a code block', () => {
    expect(section(sample, '## A', 'sample')).toContain('## not a heading')
    expect(section(sample, '## A', 'sample')).toContain('### B')
    expect(section(sample, '## A', 'sample')).not.toContain('Look')
  })
  it('reads a table, its first column and the line above it', () => {
    const [t] = tables(section(sample, '## C', 'sample'))
    expect(t.before).toBe('Look (`/points`):')
    expect(t.header).toEqual(['Key', 'Meaning'])
    expect(t.rows.flatMap((r) => codes(r[0]))).toEqual(['id', 'lat', 'name'])
  })
  it('says which heading is missing when the document changed', () => {
    expect(() => section(sample, '## Nope', 'sample')).toThrow(/no heading "## Nope"/)
  })
  it('drops notes in parentheses, however nested', () => {
    expect(stripParens('a (b (c), d), e (f), g').replace(/\s+/g, '')).toBe('a,e,g')
    expect(braceKeys('{ ok, server_time (UTC ISO, then local), x }')).toEqual(['ok', 'server_time', 'x'])
  })
})

// ======================================================================================================================
// 1. Flags
// ======================================================================================================================

describe('flags: one list in shared/flags.js, and every description of it', () => {
  it(`${FLAGS_FILE} is consistent: every FLAG_ constant is in SCAN_FLAGS, and the list is frozen`, () => {
    const constants = Object.entries(flagsModule).filter(([name]) => name.startsWith('FLAG_')).map(([, value]) => value)
    report([
      ...diffNames('flag', { where: `the FLAG_ constants of ${FLAGS_FILE}`, names: constants }, { where: `SCAN_FLAGS in ${FLAGS_FILE}`, names: [...SCAN_FLAGS] }),
      ...(Object.isFrozen(SCAN_FLAGS) ? [] : [`SCAN_FLAGS in ${FLAGS_FILE} is not frozen: wrap it in Object.freeze.`]),
    ])
  })

  it('the shared list = schemaDoc.flags = the list in the md = FLAGS of the history screen', () => {
    const historyText = read(HISTORY)
    const block = /const FLAGS = \{\n([\s\S]*?)\n\}/.exec(historyText)?.[1]
    if (!block) throw new Error(`${HISTORY} has no "const FLAGS = {" block that ends with a "}" on its own line: the flag labels are read from it.`)
    const history = [...block.matchAll(/^\s+([a-z_]+): \{/gm)].map((m) => m[1])
    report(
      diffAll('flag', { where: `SCAN_FLAGS in ${FLAGS_FILE}`, names: [...SCAN_FLAGS] }, [
        { where: WHERE.schemaFlags, names: Object.keys(schemaDoc.flags) },
        { where: WHERE.mdFlags, names: mdFlags() },
        { where: WHERE.historyFlags, names: history },
      ]),
    )
  })

  it('every flag has a description that says something (schemaDoc)', () => {
    report(
      Object.entries(schemaDoc.flags)
        .filter(([, text]) => typeof text !== 'string' || text.trim().length < 10)
        .map(([name]) => `${WHERE.schemaFlags}: the flag "${name}" has no real description.`),
    )
  })

  it('server code writes a flag only through its constant (no string literal of a flag name), and emits every flag on the list', () => {
    const problems = []
    const files = serverFiles()
    for (const { file, text } of files) {
      stripComments(text).split('\n').forEach((line, i) => {
        for (const flag of SCAN_FLAGS) {
          if (!new RegExp(`(['"\`])${flag}\\1`).test(line)) continue
          // The value 'offline_sync' is also the name of a SOURCE of a scan (a different list, see the scans table), and
          // the source is written as text on a line that says `source` or sets the 'online' alternative.
          if (flag === flagsModule.FLAG_OFFLINE_SYNC && /\bsource\b|'online'/.test(line)) continue
          problems.push(`${file}:${i + 1} writes the flag "${flag}" as a string literal: import its constant from ${FLAGS_FILE} (a typo in a string is silent, one in an import is an error). Line: ${line.trim()}`)
        }
      })
    }
    const emitting = files.filter(({ file }) => file !== SCHEMA).map(({ text }) => stripComments(text)).join('\n')
    for (const [name, value] of Object.entries(flagsModule).filter(([n]) => n.startsWith('FLAG_'))) {
      if (!new RegExp(`\\b${name}\\b`).test(emitting)) {
        problems.push(`${FLAGS_FILE} lists the flag "${value}" (${name}) but no code under server/ uses ${name}: nothing emits it. Remove it from the list and the documents, or emit it.`)
      }
    }
    report(problems)
  })

  it('the scan rules emit only listed flags and only outcomes that the scans table allows', () => {
    const HOME = SAMPLE_POINT
    const north = (metres) => ({ lat: HOME.lat + metres / 111_195, lng: HOME.lng })
    const point = { lat: HOME.lat, lng: HOME.lng, radius_m: 50 }
    const emitted = new Set()
    const outcomes = new Set()
    const seen = (r) => {
      r.flags.forEach((f) => emitted.add(f))
      outcomes.add(r.outcome)
    }
    for (const mode of ['none', 'optional', 'required']) {
      for (const gps of [
        null,
        { ...north(0), accuracy: 8 }, // right at the point
        { ...north(60), accuracy: 5 }, // a bit outside the radius
        { ...north(5000), accuracy: 8 }, // far
        { ...north(0), accuracy: 8, age_s: 120 }, // a remembered position
        { ...north(0), accuracy: config.GPS_MAX_USABLE_ACCURACY_M + 1 }, // too vague to judge
      ]) {
        seen(evaluateGps({ mode, point, gps }))
      }
      seen(evaluateGps({ mode, point: { ...point, lat: null, lng: null }, gps: { ...north(0), accuracy: 8 } })) // a point with no coordinates
    }
    const now = new Date('2026-09-30T06:00:00Z')
    const ago = (ms) => new Date(now.getTime() - ms).toISOString()
    for (const [source, clientTime] of [
      ['online', ago(0)], ['online', ago(config.CLOCK_SKEW_FLAG_MS + 1000)], ['online', 'not a time'],
      ['offline_sync', ago(60_000)], ['offline_sync', ago(config.CLOCK_MAX_AGE_MS + 1000)], ['offline_sync', undefined],
      ['offline_sync', ago(-(config.CLOCK_MAX_FUTURE_MS + 1000))],
    ]) {
      seen({ ...resolveClock({ source, clientTime, now }), outcome: 'accepted' })
    }
    const allowed = migrationAllowed('outcome').values
    report([
      ...[...emitted].filter((f) => !SCAN_FLAGS.includes(f)).map((f) => `The scan rules (server/scanLogic.js) emit the flag "${f}", which is not in SCAN_FLAGS (${FLAGS_FILE}): add it there and to the three descriptions.`),
      ...[...outcomes].filter((o) => !allowed.includes(o)).map((o) => `The scan rules (server/scanLogic.js) produce the outcome "${o}", which the scans table does not allow (${migrationAllowed('outcome').file}).`),
    ])
  })
})

// ======================================================================================================================
// 4. Endpoints
// ======================================================================================================================

describe('endpoints: the routes = schemaDoc = the md table', () => {
  it('lists every /agent/v1 route, and only those', () => {
    const truth = { where: 'the routes of server/routes/agent.js (routeTable() in server/router.js)', names: agentRoutes().map((r) => toFull(r.method, r.path)) }
    report(
      diffAll('endpoint', truth, [
        { where: WHERE.schemaEndpoints, names: Object.keys(schemaDoc.endpoints) },
        { where: WHERE.mdEndpoints, names: mdEndpoints().map(mdToFull) },
      ]),
    )
  })

  it('the envelope table of the md names only real endpoints, and every endpoint text that says "Returns {" does too', () => {
    const real = agentRoutes().map((r) => toFull(r.method, r.path))
    const problems = []
    for (const endpoint of Object.keys(mdEnvelopes())) {
      if (!real.includes(mdToFull(endpoint))) problems.push(`${WHERE.mdEnvelopes} describes ${endpoint}, which is not an /agent/v1 route.`)
    }
    for (const [key, text] of Object.entries(schemaDoc.endpoints)) {
      if (/Returns \{/.test(text) && !real.includes(key)) problems.push(`${WHERE.schemaEndpoints} describes ${key}, which is not an /agent/v1 route.`)
    }
    report(problems)
  })
})

// ======================================================================================================================
// 6. Outcomes and sources (the part that needs no database; the database itself is cross-checked below)
// ======================================================================================================================

describe('outcomes and sources: the check constraints of the scans table = schemaDoc = the md', () => {
  it('outcomes', () => {
    const truth = { where: `the check constraint on scans.outcome (${migrationAllowed('outcome').file})`, names: migrationAllowed('outcome').values }
    report(
      diffAll('outcome', truth, [
        { where: WHERE.schemaOutcomes, names: Object.keys(schemaDoc.outcomes ?? {}) },
        { where: WHERE.mdOutcomes, names: mdValueTable('`outcome`') },
      ]),
    )
  })
  it('sources', () => {
    const truth = { where: `the check constraint on scans.source (${migrationAllowed('source').file})`, names: migrationAllowed('source').values }
    report(
      diffAll('source', truth, [
        { where: WHERE.schemaSources, names: Object.keys(schemaDoc.sources ?? {}) },
        { where: WHERE.mdSources, names: mdValueTable('`source`') },
      ]),
    )
  })
  it('no other rejected_ outcome is named anywhere in the prose of either document', () => {
    const allowed = migrationAllowed('outcome').values
    const named = (text) => [...new Set([...text.matchAll(/\brejected_[a-z_]+\b/g)].map((m) => m[0]))]
    report([
      ...named(md).filter((o) => !allowed.includes(o)).map((o) => `${MD} names the outcome "${o}", which the scans table does not allow.`),
      ...named(JSON.stringify(schemaDoc)).filter((o) => !allowed.includes(o)).map((o) => `${SCHEMA} names the outcome "${o}", which the scans table does not allow.`),
    ])
  })
})

// ======================================================================================================================
// 8. Numbers in prose
// ======================================================================================================================

const MINUTE = 60_000
const DAY = 86_400_000
// One entry per number that a document quotes from server/config.js. `want` is what each captured group must be, and
// `constant` names the constant of each group (one name when they are all the same).
// `md` is read from docs/agent-api.md (typed there), `schema` from the rendered schemaDoc (written from the constant).
const NUMBER_RULES = [
  { what: 'the duplicate window', constant: 'SCAN_COOLDOWN_MINUTES', want: [config.SCAN_COOLDOWN_MINUTES], md: /same provider at the same point within (\d+) minutes/i },
  { what: 'the best accuracy that makes a fix usable', constant: 'GPS_MAX_USABLE_ACCURACY_M', want: [config.GPS_MAX_USABLE_ACCURACY_M], md: /accuracy of (\d+) m or better/ },
  { what: 'the pin tolerance', constant: 'GPS_PIN_TOLERANCE_M', want: [config.GPS_PIN_TOLERANCE_M], md: /within the (\d+) m pin tolerance/ },
  { what: 'the pin tolerance (the GPS paragraph)', constant: 'GPS_PIN_TOLERANCE_M', want: [config.GPS_PIN_TOLERANCE_M], md: /radius \+ (\d+) m/ },
  { what: 'the accuracy credit', constant: 'GPS_MAX_ACCURACY_CREDIT_M', want: [config.GPS_MAX_ACCURACY_CREDIT_M], md: /accuracy up to (\d+) m/ },
  { what: 'the age after which a position is stale', constant: 'GPS_STALE_AFTER_S', want: [config.GPS_STALE_AFTER_S], md: /older than (\d+) seconds/, schema: /older than (\d+) seconds/ },
  { what: 'the clock difference that flags an online scan', constant: 'CLOCK_SKEW_FLAG_MS', want: [config.CLOCK_SKEW_FLAG_MS / MINUTE], md: /differed from the server by more than (\d+) minutes/, schema: /differed from the server time by more than (\d+) minutes/ },
  { what: 'how far in the future an offline phone time may be', constant: 'CLOCK_MAX_FUTURE_MS', want: [config.CLOCK_MAX_FUTURE_MS / MINUTE], md: /more than (\d+) minutes in the future/, schema: /more than (\d+) minutes in the future/ },
  { what: 'how old an offline phone time may be', constant: 'CLOCK_MAX_AGE_MS', want: [config.CLOCK_MAX_AGE_MS / DAY], md: /older than (\d+) days/, schema: /older than (\d+) days/ },
  { what: 'the limit range of a page', constant: ['MAX_PAGE_SIZE', 'DEFAULT_PAGE_SIZE'], want: [config.MAX_PAGE_SIZE, config.DEFAULT_PAGE_SIZE], md: /`limit` \(1 to (\d+), default (\d+)\)/, schema: /limit \(1-(\d+), default (\d+);/ },
  { what: 'where a larger limit is cut', constant: 'MAX_PAGE_SIZE', want: [config.MAX_PAGE_SIZE, config.MAX_PAGE_SIZE], md: /`limit` above (\d+) is cut to (\d+)/, schema: /a larger number is cut to (\d+), not refused/ },
  { what: 'the length of a text filter', constant: 'FILTER_TEXT_MAX_LENGTH', want: [config.FILTER_TEXT_MAX_LENGTH], md: /are cut to (\d+) characters/, schema: /cut to (\d+) characters/ },
]

describe('numbers in prose come from server/config.js', () => {
  const flat = (text) => text.replace(/\s+/g, ' ')
  const mdText = flat(md)
  const schemaText = flat(JSON.stringify(schemaDoc).replace(/\\"/g, '"'))
  const schemaSource = flat(read(SCHEMA))

  /** Every match of a pattern in a text must carry exactly the wanted numbers, and there must be one. */
  function check(rule, pattern, text, where) {
    const problems = []
    const all = [...text.matchAll(new RegExp(pattern.source, `${pattern.flags.replace('g', '')}g`))]
    if (!all.length) {
      problems.push(`${where} no longer says what the test looks for (${pattern}) about ${rule.what}: reword it to match, or change the pattern in NUMBER_RULES (tests/agent-docs.test.js).`)
    }
    for (const m of all) {
      m.slice(1).forEach((got, i) => {
        if (Number(got) !== rule.want[i]) {
          problems.push(`${where} says ${got} for ${rule.what} ("${m[0]}"), but ${[].concat(rule.constant)[i] ?? rule.constant} in server/config.js is ${rule.want[i]}: update the document.`)
        }
      })
    }
    return problems
  }

  it(`${MD} quotes the numbers of server/config.js correctly`, () => {
    report(NUMBER_RULES.filter((r) => r.md).flatMap((r) => check(r, r.md, mdText, MD)))
  })

  it(`${SCHEMA} says the numbers of server/config.js (as served)`, () => {
    report(NUMBER_RULES.filter((r) => r.schema).flatMap((r) => check(r, r.schema, schemaText, `${SCHEMA} (as served by /schema)`)))
  })

  it(`${SCHEMA} writes them from the constants and does not type them`, () => {
    const problems = []
    for (const rule of NUMBER_RULES.filter((r) => r.schema)) {
      for (const m of schemaSource.matchAll(new RegExp(rule.schema.source, 'g'))) {
        problems.push(`${SCHEMA} types the number in "${m[0]}" (${rule.what}): write it from ${[].concat(rule.constant).join(' and ')} with a template string, so that it cannot drift from server/config.js.`)
      }
    }
    report(problems)
  })

  it('the numbers that schemaDoc serves as data are the constants', () => {
    const rules = schemaDoc.rules
    const got = {
      'rules.duplicate_window_minutes': [rules.duplicate_window_minutes, config.SCAN_COOLDOWN_MINUTES],
      'rules.gps_policy.max_usable_accuracy_m': [rules.gps_policy.max_usable_accuracy_m, config.GPS_MAX_USABLE_ACCURACY_M],
      'rules.gps_policy.pin_tolerance_m': [rules.gps_policy.pin_tolerance_m, config.GPS_PIN_TOLERANCE_M],
      'rules.gps_policy.max_accuracy_credit_m': [rules.gps_policy.max_accuracy_credit_m, config.GPS_MAX_ACCURACY_CREDIT_M],
    }
    report(
      Object.entries(got).filter(([, [served, constant]]) => served !== constant).map(([key, [served, constant]]) => `${SCHEMA}: ${key} is ${served} but server/config.js says ${constant}.`),
    )
  })

  it('the date of the old import is the same in both documents', () => {
    const date = (text) => /imported from the old Firebase system on (\d{2}\/\d{2}\/\d{4})/i.exec(text)?.[1]
    const inSchema = date(schemaDoc.flags.legacy_import)
    const inMd = date(mdText)
    report(
      !inSchema || !inMd
        ? [`The legacy_import description no longer says "imported from the old Firebase system on DD/MM/YYYY" in ${!inSchema ? SCHEMA : MD}.`]
        : inSchema === inMd ? [] : [`${MD} says the old data was imported on ${inMd}, ${SCHEMA} says ${inSchema}: make them the same.`],
    )
  })
})

// ======================================================================================================================
// 2, 3, 5, 6 (database cross-check) and 7: what the real routes answer
// ======================================================================================================================

describe('the real agent API answers what the documents say', () => {
  let db, cookie, key, revokedKey
  const HOME = SAMPLE_POINT
  const get = (p, opts = {}) => call('GET', `/api/agent/v1${p}`, { token: key, ...opts })
  const withCursor = () => Buffer.from(JSON.stringify({ t: new Date().toISOString(), id: randomUUID() })).toString('base64url')

  beforeAll(async () => {
    db = await setupDb()
    await seedAdmin(db.pool)
    cookie = await adminCookie()
    const point = async (body) => (await call('POST', '/api/admin/points', { cookie, body })).json.point
    const lobby = await point({ name: 'Lobby', description: 'Main entrance', lat: HOME.lat, lng: HOME.lng, gps_mode: 'optional' })
    const basement = await point({ name: 'Basement', lat: HOME.lat, lng: HOME.lng, gps_mode: 'none' })
    const provider = (await call('POST', '/api/admin/providers', {
      cookie, body: { company: 'Sparkle Cleaning', contact_name: 'Test', service_type: 'cleaning', password: 'agent-docs-1' },
    })).json.provider
    const session = await call('POST', '/api/session', { body: { provider_id: provider.id, password: 'agent-docs-1' } })
    const token = session.json.token
    // An online scan with a good fix, and an upload from a phone with no signal and a clock that is years off: the second
    // one carries the flags offline_sync and clock_skew (the point has no GPS check, so no location flag).
    const online = await call('POST', '/api/scan', { token, body: { id: randomUUID(), code: lobby.qr_token, gps: { ...HOME, accuracy: 8 } } })
    const offline = await call('POST', '/api/scans/sync', { token, body: { scans: [{ id: randomUUID(), code: basement.qr_token, client_time: '2020-01-01T10:00:00Z' }] } })
    if (online.status !== 200 || offline.status !== 200 || !offline.json.results[0].ok) throw new Error('the seed scans were refused')
    const mintKey = async (name) => (await call('POST', '/api/admin/api-keys', { cookie, body: { name } })).json
    key = (await mintKey('agent docs')).key
    const spare = await mintKey('agent docs, revoked')
    revokedKey = spare.key
    await call('POST', `/api/admin/api-keys/${spare.api_key.id}/revoke`, { cookie })
  }, 120_000)

  afterAll(async () => db?.teardown())

  it('scan fields: the real answer = the CSV header = schemaDoc = the md example, and the CSV flags example is real', async () => {
    const json = (await get('/scans?outcome=all&include_demo=1&include_voided=1&limit=500')).json
    expect(json.scans.length).toBeGreaterThanOrEqual(2)
    const real = Object.keys(json.scans[0])
    const problems = []
    for (const s of json.scans) {
      if (Object.keys(s).join() !== real.join()) problems.push('The /scans answer does not give every scan the same keys in the same order (scanJson in server/scans.js).')
    }
    const csv = await get('/scans?outcome=all&format=csv&limit=500')
    const lines = csv.text.split('\r\n')
    const header = lines[0].split(',')
    const truth = { where: 'the real /scans answer (scanJson in server/scans.js)', names: real }
    problems.push(
      ...diffAll('scan field', truth, [
        { where: `the CSV header of the real /scans?format=csv answer (SCAN_CSV_COLUMNS in server/scans.js)`, names: header },
        { where: WHERE.schemaScanFields, names: [...Object.keys(schemaDoc.time_fields), ...Object.keys(schemaDoc.scan_fields)] },
        { where: WHERE.mdScanRow, names: mdScanRowKeys() },
      ]),
    )
    if (header.join() !== real.join()) problems.push(`The CSV columns (${header.join(',')}) are not in the order of a scan row (${real.join(',')}), but ${MD} says "the same columns as a scan row, in the same order".`)
    if (SCAN_CSV_COLUMNS.join() !== real.join()) problems.push('SCAN_CSV_COLUMNS in server/scans.js is not in the order of scanJson.')
    // The example of the md for the flags cell is what the code writes for a scan that has two flags.
    const example = /\(for example `([a-z_;]+)`\)/.exec(section(md, '### CSV').replace(/\s*\n\s*/g, ' '))?.[1]
    const flagged = json.scans.find((s) => s.flags.length === 2)
    if (!example) problems.push(`${MD} no longer gives "(for example \`a;b\`)" for the joined flags under "### CSV".`)
    else {
      const row = lines.find((l) => l.startsWith(`${flagged.id},`))?.split(',')
      const cell = row?.[header.indexOf('flags')]
      if (cell !== example) problems.push(`${MD} gives "${example}" as an example of the CSV flags cell, but the code writes "${cell}" for a scan with the flags ${flagged.flags.join(' and ')}.`)
    }
    report(problems)
  })

  it('points and providers: the real answers = schemaDoc = the md tables; and the envelope of every answer', async () => {
    const points = (await get('/points')).json
    const providers = (await get('/providers')).json
    const health = (await get('/health')).json
    const scans = (await get('/scans')).json
    expect(points.points.length).toBeGreaterThan(0)
    expect(providers.providers.length).toBeGreaterThan(0)
    const problems = [
      ...diffAll('point field', { where: 'the real /points answer (server/routes/agent.js)', names: Object.keys(points.points[0]) }, [
        { where: WHERE.schemaPoints, names: Object.keys(schemaDoc.points_fields) },
        { where: WHERE.mdPoints, names: mdFieldTable(/\(`\/points`\)/) },
      ]),
      ...diffAll('provider field', { where: 'the real /providers answer (server/routes/agent.js)', names: Object.keys(providers.providers[0]) }, [
        { where: WHERE.schemaProviders, names: Object.keys(schemaDoc.providers_fields) },
        { where: WHERE.mdProviders, names: mdFieldTable(/\(`\/providers`\)/) },
      ]),
    ]
    const envelopes = mdEnvelopes()
    for (const [endpoint, answer] of [['GET /scans', scans], ['GET /points', points], ['GET /providers', providers], ['GET /health', health]]) {
      const real = { where: `the real ${endpoint} answer`, names: Object.keys(answer) }
      const inMd = envelopes[endpoint]
      if (!inMd) problems.push(`${WHERE.mdEnvelopes} has no row for ${endpoint}: add one.`)
      else problems.push(...diffNames('top-level key', real, { where: `${WHERE.mdEnvelopes}, row ${endpoint}`, names: inMd }))
      const inSchema = schemaEnvelope(mdToFull(endpoint))
      if (!inSchema) problems.push(`${SCHEMA}: the text of ${mdToFull(endpoint)} no longer says "Returns { ... }".`)
      else problems.push(...diffNames('top-level key', real, { where: `${WHERE.schemaEndpoints}, ${mdToFull(endpoint)}`, names: inSchema }))
    }
    for (const [name, rows] of [['points_fields', schemaDoc.points_fields], ['providers_fields', schemaDoc.providers_fields], ['scan_fields', schemaDoc.scan_fields], ['time_fields', schemaDoc.time_fields]]) {
      for (const [field, text] of Object.entries(rows)) {
        if (typeof text !== 'string' || !text.trim()) problems.push(`${SCHEMA}: ${name}.${field} has no description.`)
      }
    }
    report(problems)
  })

  it('filters: what listScans reads = SCAN_FILTERS = schemaDoc = the md, with the values they allow', async () => {
    // The code: every property that listScans reads from its query. The values are all valid, so that no read is skipped
    // by an early refusal (the cursor is made the way the API makes one).
    const reads = new Set()
    const query = new Proxy(
      {
        from: '2026-01-01', to: '2100-01-01', point_id: randomUUID(), provider_id: randomUUID(), service_type: 'cleaning',
        flag: 'demo', outcome: 'all', include_voided: '1', include_demo: '1', order: 'asc', limit: '5', cursor: withCursor(),
      },
      { get: (target, prop) => (typeof prop === 'string' ? (reads.add(prop), target[prop]) : target[prop]) },
    )
    await listScans(query)
    const read = [...reads]
    const problems = [
      ...diffNames('filter', { where: 'what listScans reads in server/scans.js', names: read }, { where: 'SCAN_FILTERS in server/scans.js', names: [...SCAN_FILTERS] }),
    ]
    // The route also reads `format`: prove it by what it does.
    const asCsv = await get('/scans?format=csv&limit=1')
    const asJson = await get('/scans?format=json&limit=1')
    const asOther = await get('/scans?format=xml&limit=1')
    if (!/text\/csv/.test(asCsv.headers['content-type'] ?? '')) problems.push('GET /scans?format=csv does not answer text/csv: the filter "format" is documented but the route does not read it.')
    if (!Array.isArray(asJson.json?.scans) || !Array.isArray(asOther.json?.scans)) problems.push('GET /scans with format=json or an unknown format does not answer JSON, as both documents say.')
    const names = [...SCAN_FILTERS, 'format']
    const truth = { where: 'SCAN_FILTERS in server/scans.js (and `format`, read by server/routes/agent.js)', names }
    problems.push(...diffAll('filter', truth, [{ where: WHERE.schemaFilters, names: schemaFilters() }, { where: WHERE.mdFilters, names: mdFilters() }]))

    // The values: the documents list them, the route must accept each one and refuse another.
    const valuesIn = (name) => ({
      md: codes(new RegExp(`\`${name}\` \\(([^)]*)\\)`).exec(mdFilterParagraph())?.[1] ?? '').filter((v) => v !== 'default'),
      schema: (new RegExp(`${name} \\(([a-z|]+)`).exec(schemaScansText)?.[1] ?? '').split('|').filter(Boolean),
    })
    for (const name of ['outcome', 'order']) {
      const { md: inMd, schema: inSchema } = valuesIn(name)
      problems.push(...diffNames(`${name} value`, { where: WHERE.schemaFilters, names: inSchema }, { where: WHERE.mdFilters, names: inMd }))
      for (const value of new Set([...inMd, ...inSchema])) {
        const r = await get(`/scans?${name}=${value}&limit=1`)
        if (r.status !== 200) problems.push(`A document says ${name}=${value} is allowed, but the real route answers ${r.status} ${r.json?.error?.code}.`)
      }
    }
    const csvValues = valuesIn('format').md
    if (!csvValues.includes('csv')) problems.push(`${WHERE.mdFilters} no longer lists csv as a value of format.`)
    // A page larger than the limit is cut, not refused.
    const big = await get(`/scans?limit=${config.MAX_PAGE_SIZE + 1}`)
    if (big.status !== 200 || big.json.count > config.MAX_PAGE_SIZE) problems.push(`GET /scans?limit=${config.MAX_PAGE_SIZE + 1} is not cut to ${config.MAX_PAGE_SIZE} as both documents say (it answered ${big.status}).`)
    report(problems)
  }, 60_000)

  it('the scans table in the database allows exactly what the migrations say (so the parser of this test is right)', async () => {
    const { rows } = await db.pool.query(
      `select pg_get_constraintdef(c.oid) as def from pg_constraint c where c.conrelid = 'scans'::regclass and c.contype = 'c'`,
    )
    const problems = []
    for (const column of ['outcome', 'source']) {
      const defs = rows.map((r) => r.def).filter((d) => new RegExp(`\\b${column}\\b`).test(d))
      const inDatabase = defs.flatMap((d) => [...d.matchAll(/'([^']*)'::text/g)].map((m) => m[1]))
      const fromFiles = migrationAllowed(column)
      problems.push(...diffNames(`${column} value`, { where: `the check constraint of scans.${column} in the migrated database`, names: inDatabase }, { where: `the latest definition in db/migrations (${fromFiles.file}), as read by migrationAllowed in tests/agent-docs.test.js`, names: fromFiles.values }))
    }
    report(problems)
  })

  it('error codes: what the real routes answer to bad requests = schemaDoc.errors = the md table', async () => {
    const produced = new Map() // "400 invalid_filter" -> how it was caused
    const problems = []
    const note = (r, how) => {
      const pair = `${r.status} ${r.json?.error?.code}`
      if (!produced.has(pair)) produced.set(pair, how)
    }
    const expectPair = (r, how, status, code) => {
      note(r, how)
      if (r.status !== status || r.json?.error?.code !== code) {
        problems.push(`The test sent ${how} and expected ${status} ${code}, but the real route answered ${r.status} ${r.json?.error?.code}. If the behaviour changed on purpose, update both documents and this matrix.`)
      }
    }

    // The matrix of bad requests against every agent endpoint.
    for (const { method, path: p } of agentRoutes()) {
      const rel = p.replace('/agent/v1', '')
      expectPair(await call(method, `/api/agent/v1${rel}`, {}), `${method} ${rel} with no key`, 401, 'api_key_required')
      expectPair(await call(method, `/api/agent/v1${rel}`, { headers: { authorization: 'Basic abc' } }), `${method} ${rel} with a header that is not a Bearer key`, 401, 'api_key_required')
      expectPair(await call(method, `/api/agent/v1${rel}`, { token: 'not-a-key' }), `${method} ${rel} with a Bearer token that is not a qrk_ key`, 401, 'api_key_required')
      expectPair(await call(method, `/api/agent/v1${rel}`, { token: `${config.API_KEY_PREFIX}unknown` }), `${method} ${rel} with an unknown key`, 401, 'api_key_invalid')
      expectPair(await call(method, `/api/agent/v1${rel}`, { token: revokedKey }), `${method} ${rel} with a revoked key`, 401, 'api_key_invalid')
      expectPair(await call('POST', `/api/agent/v1${rel}`, { token: key, body: {} }), `POST ${rel}`, 405, 'method_not_allowed')
      expectPair(await call(method, `/api/agent/v1${rel}`, { token: key, badJsonBody: true }), `${method} ${rel} with a body that is not valid JSON`, 400, 'invalid_json')
    }
    expectPair(await get('/nope'), 'GET /nope', 404, 'not_found')
    expectPair(await call('GET', '/api/agent/nope', { token: key }), 'GET /api/agent/nope', 404, 'not_found')
    expectPair(await get('/scans?cursor=zzz'), 'a cursor that this API did not return', 400, 'invalid_cursor')

    // A failure of the server itself: a database that cannot be reached, through the real route and the real router.
    const pool = getPool()
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {})
    setPool({ query: async () => { throw Object.assign(new Error('connection lost'), { code: 'ECONNRESET' }) } })
    try {
      expectPair(await get('/scans'), 'GET /scans while the database cannot be reached', 500, 'server_error')
    } finally {
      setPool(pool)
      logged.mockRestore()
    }

    // The filters: every filter and the format, with values that are wrong in different ways. Which filters can be
    // refused is found from the answers, not written here. A refusal must name the filter that caused it.
    const refusable = new Set()
    for (const name of [...SCAN_FILTERS, 'format']) {
      for (const value of ['zzz', '0', '2026-02-30', '2026-06-01T10:00:00', 'a\u0000b']) {
        const r = await get(`/scans?${name}=${encodeURIComponent(value)}`)
        if (r.status === 200) continue
        note(r, `a ${name} of ${JSON.stringify(value)}`)
        if (r.status !== 400) {
          problems.push(`GET /scans with ${name}=${JSON.stringify(value)} answered ${r.status} ${r.json?.error?.code}: a bad filter value must be a 400, never anything else.`)
        } else if (r.json?.error?.code === 'invalid_filter') {
          refusable.add(r.json.error.field)
          if (r.json.error.field !== name) problems.push(`GET /scans with ${name}=${JSON.stringify(value)} answered invalid_filter with field "${r.json.error.field}", but the documents say "field names it".`)
        }
      }
    }

    // What each document says.
    const mdRows = mdErrorPairs()
    const schemaRows = schemaPairs()
    const real = [...produced.keys()]
    for (const [where, docPairs] of [[WHERE.mdErrors, mdRows.map((r) => r.pair)], [WHERE.schemaErrors, schemaRows.map((r) => r.pair)]]) {
      for (const pair of real) {
        if (!docPairs.includes(pair)) problems.push(`The real agent routes answer ${pair} (${produced.get(pair)}) but ${where} does not list it: add it.`)
      }
      for (const pair of docPairs) {
        if (!produced.has(pair)) problems.push(`${where} lists ${pair}, but no request of the matrix produces it: remove it, or add the request to the matrix in tests/agent-docs.test.js.`)
      }
    }
    // The filters that invalid_filter names.
    const mdFields = codes(mdRows.find((r) => r.pair === '400 invalid_filter')?.meaning ?? '').filter((n) => n !== 'field')
    const schemaFieldsText = /a bad (.*?)\. The field key names it/.exec(schemaDoc.errors.invalid_filter ?? '')?.[1] ?? ''
    const schemaFields = schemaFieldsText.split(/,| or /).map((s) => s.trim()).filter(Boolean)
    const truth = { where: 'the filters that the real route refused with invalid_filter', names: [...refusable] }
    problems.push(
      ...diffAll('filter that invalid_filter names', truth, [
        { where: `${WHERE.mdErrors}, row 400 invalid_filter`, names: mdFields },
        { where: `${WHERE.schemaErrors}, invalid_filter`, names: schemaFields },
      ]),
    )
    report(problems)
  }, 180_000)
})
