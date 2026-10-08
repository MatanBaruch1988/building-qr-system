// CI guard for the size of the app (see .github/workflows/ci.yml, job "guards", and `npm run size`).
//
// Usage: node scripts/check-bundle-size.mjs [--dir <built app folder>]      (default: dist, next to the scripts folder)
// `npm run size` builds the app first (vite build) and then runs this.
//
// Why this exists: the app is a PWA on the phones of service providers, often on mobile data. Every phone downloads the
// whole precache when the app is installed and again with each new version (every deployment is a new version: the build
// id in the JavaScript is the commit). Nothing else notices when the app grows by a library, a font or a picture, so the
// size is a budget that a pull request has to respect, and a bigger budget is a decision somebody makes and explains.
//
// What it measures, in a built app folder, as brotli-compressed bytes (what Vercel sends to a phone):
//   - the provider app's entry: the JavaScript and the CSS that dist/index.html loads (its type="module" script, the
//     modulepreload links that Vite adds when the entry imports a shared chunk, and its stylesheet links);
//   - the committee app's chunk: the JavaScript and the CSS of the AdminApp chunk, which the provider's phone never loads
//     (found by the `AdminApp-` file name prefix that Vite gives the lazily loaded chunk);
//   - the precache: every URL in the precache manifest of dist/sw.js, counted once each (the manifest lists some files
//     twice), as the total of their compressed sizes and as the number of files.
// Each is compared with scripts/check-bundle-size.json (the budgets, in bytes, and the number of files in the precache).
// The table shows what was measured, the budget and the headroom. The check fails (exit 1) when a measurement is over its
// budget, and also when a measured file cannot be found or read: a file that cannot be measured must never drop out of the
// check without anybody noticing. A measurement more than 20 percent under its budget only prints a note that the budget
// can be lowered. Exit 2: the guard could not run at all (a bad argument, an unreadable budget file).
//
// How the budgets were set: on 08/10/2026, on master after #137, from `npm run build`. Each budget is the measured size
// plus about 10 percent, rounded up to a whole KiB; the budget for the number of files is the measured number plus 2. JSON
// has no comments, so that is written here. A budget is raised only in a pull request that says why, and the owner decides
// (AGENTS.md, "Testing" and the P1 review rules); it is lowered when the app gets smaller. The script and the budgets sit
// under scripts/check-*, so the agent loop cannot change them (AGENTS.md, "The agent loop").
//
// Node built-ins only: it runs in the guards job after `npm ci`, and the scripts that CI trusts do not import packages.
import fs from 'node:fs'
import path from 'node:path'
import zlib from 'node:zlib'
import { fileURLToPath } from 'node:url'
import { isMain } from './ci-git.mjs'

const SCRIPTS_DIR = path.dirname(fileURLToPath(import.meta.url))
export const BUDGET_FILE = path.join(SCRIPTS_DIR, 'check-bundle-size.json')
export const DEFAULT_DIR = path.join(SCRIPTS_DIR, '..', 'dist')

/** What is measured, in the order of the table. `key` is the name in scripts/check-bundle-size.json. */
export const MEASUREMENTS = Object.freeze([
  { key: 'entryJs', label: 'Provider app, entry JS', unit: 'bytes' },
  { key: 'entryCss', label: 'Provider app, entry CSS', unit: 'bytes' },
  { key: 'committeeJs', label: 'Committee app, chunk JS', unit: 'bytes' },
  { key: 'committeeCss', label: 'Committee app, chunk CSS', unit: 'bytes' },
  { key: 'precacheBytes', label: 'Precache, total', unit: 'bytes' },
  { key: 'precacheEntries', label: 'Precache, files', unit: 'files' },
])

/** A measurement this much (or more) under its budget gets a note that the budget can be lowered. */
export const NOTE_UNDER_PERCENT = 20

const norm = (p) => String(p).replace(/\\/g, '/')

/** The size of a file's contents after brotli at the highest quality, which is how Vercel compresses text files. */
export function brotliSize(buffer) {
  return zlib.brotliCompressSync(buffer, {
    params: {
      [zlib.constants.BROTLI_PARAM_MODE]: zlib.constants.BROTLI_MODE_GENERIC,
      [zlib.constants.BROTLI_PARAM_QUALITY]: zlib.constants.BROTLI_MAX_QUALITY,
      [zlib.constants.BROTLI_PARAM_LGWIN]: zlib.constants.BROTLI_DEFAULT_WINDOW,
    },
  }).length
}

// ---- reading index.html -------------------------------------------------------------------------------------------

/** The attributes of one tag as written (`<script type="module" src="/a.js">`), names in lower case. */
function attributesOf(tagText) {
  const attributes = {}
  for (const match of tagText.matchAll(/([^\s"'<>/=]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'<>`=]+)))?/g)) {
    attributes[match[1].toLowerCase()] ??= match[2] ?? match[3] ?? match[4] ?? ''
  }
  return attributes
}

/**
 * The files that an HTML page loads on its own: { js, css } as the URLs written in the page, each once, in order.
 * JavaScript is the `<script type="module" src>` and the `<link rel="modulepreload">` (Vite adds the second kind for the
 * chunks that the entry imports), CSS is the `<link rel="stylesheet">`. A comment never counts. A file on another origin
 * cannot be measured from the built folder, so it is an error (and the Content-Security-Policy would not allow it).
 * Throws when the page loads no module script or no stylesheet at all: the guard would measure nothing.
 */
export function entryFiles(html) {
  const js = []
  const css = []
  const external = []
  const add = (list, url) => {
    if (/^(?:[a-z][a-z0-9+.-]*:|\/\/)/i.test(url)) external.push(url)
    else if (!list.includes(url)) list.push(url)
  }
  for (const tag of String(html).replace(/<!--[\s\S]*?-->/g, '').matchAll(/<(script|link)\b[^>]*>/gi)) {
    const attributes = attributesOf(tag[0].slice(1))
    if (tag[1].toLowerCase() === 'script') {
      if (attributes.type?.trim().toLowerCase() === 'module' && attributes.src) add(js, attributes.src)
    } else if (attributes.href) {
      const rel = (attributes.rel ?? '').toLowerCase().split(/\s+/)
      if (rel.includes('stylesheet')) add(css, attributes.href)
      else if (rel.includes('modulepreload')) add(js, attributes.href)
    }
  }
  if (external.length) {
    throw new Error(`index.html loads ${external.join(', ')} from another origin, which this check cannot measure`)
  }
  if (js.length === 0) throw new Error('index.html has no <script type="module" src="..."> (the entry JavaScript)')
  if (css.length === 0) throw new Error('index.html has no <link rel="stylesheet" href="..."> (the entry CSS)')
  return { js, css }
}

// ---- finding the committee app's chunk ----------------------------------------------------------------------------

/**
 * The committee app's files among the files of a built folder (paths relative to it, any separator): { js, css }, one
 * file each. Vite names the lazily loaded AdminApp chunk `assets/AdminApp-<hash>.js` and its stylesheet
 * `assets/AdminApp-<hash>.css`. Throws, saying what it expected, when one is missing or when there is more than one
 * (a leftover of an older build in the folder would be measured twice or not at all).
 */
export function committeeFiles(names) {
  const pick = (extension) => {
    const found = names.map(norm).filter((name) => new RegExp(`^(?:.*/)?AdminApp-[^/]+\\.${extension}$`).test(name))
    if (found.length === 0) {
      throw new Error(`the committee app's chunk is missing: no AdminApp-*.${extension} file in the built folder (renamed, or not built?)`)
    }
    if (found.length > 1) {
      throw new Error(`the committee app's chunk is ambiguous: ${found.length} AdminApp-*.${extension} files (${found.join(', ')}); build into an empty folder`)
    }
    return found[0]
  }
  return { js: pick('js'), css: pick('css') }
}

// ---- reading the precache manifest of sw.js -----------------------------------------------------------------------

/** The index of the bracket that closes the `[` at text[open], skipping strings; -1 when it is not closed. */
function closingBracket(text, open) {
  let depth = 0
  for (let i = open; i < text.length; i++) {
    const ch = text[i]
    if (ch === '"' || ch === "'" || ch === '`') {
      for (i++; i < text.length && text[i] !== ch; i++) if (text[i] === '\\') i++
    } else if (ch === '[') {
      depth++
    } else if (ch === ']' && --depth === 0) {
      return i
    }
  }
  return -1
}

/**
 * The URLs in the precache manifest of a Workbox service worker (the array passed to `precacheAndRoute([...])`), each
 * once, in order: the manifest lists some files twice, and a phone downloads a file once. Throws when the call or its
 * array is not there or lists nothing, so that a different shape of sw.js fails the check instead of measuring nothing.
 */
export function precacheUrls(swText) {
  const text = String(swText)
  const call = /precacheAndRoute\s*\(\s*\[/.exec(text)
  if (!call) throw new Error('sw.js has no precacheAndRoute([...]) call, so the precache cannot be read')
  const open = call.index + call[0].length - 1
  const close = closingBracket(text, open)
  if (close < 0) throw new Error('the precacheAndRoute([...]) list in sw.js is not closed')
  const urls = []
  for (const match of text.slice(open, close + 1).matchAll(/["']?\burl["']?\s*:\s*(?:"((?:[^"\\]|\\.)*)"|'((?:[^'\\]|\\.)*)')/g)) {
    const url = (match[1] ?? match[2]).replace(/\\(.)/g, '$1')
    if (!urls.includes(url)) urls.push(url)
  }
  if (urls.length === 0) throw new Error('the precacheAndRoute([...]) list in sw.js has no { url } entry')
  return urls
}

// ---- measuring a built folder -------------------------------------------------------------------------------------

/** All the files under a folder, as paths relative to it with /. */
function listFiles(dir) {
  return fs
    .readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => norm(path.relative(dir, path.join(entry.parentPath, entry.name))))
}

/**
 * The compressed size of the file that a URL of the page (or of sw.js) points to, inside the built folder. The URL is
 * relative to the folder, or starts with / (the site's root is the folder). Throws when the file is not there, or when
 * the URL leads out of the folder.
 */
export function sizeOfUrl(dir, url) {
  let relative = String(url).replace(/[?#].*$/, '').replace(/^(?:\.?\/)+/, '')
  try {
    relative = decodeURIComponent(relative)
  } catch {
    // not a valid escape: the name is taken as written
  }
  const file = path.resolve(dir, relative)
  const inside = path.relative(path.resolve(dir), file)
  if (!relative || inside.startsWith('..') || path.isAbsolute(inside)) throw new Error(`${url} leads out of the built folder`)
  let buffer
  try {
    buffer = fs.readFileSync(file)
  } catch {
    throw new Error(`${url} is referenced (by index.html or sw.js) but is not in the built folder`)
  }
  return brotliSize(buffer)
}

const sumOf = (dir, urls) => urls.reduce((total, url) => total + sizeOfUrl(dir, url), 0)

/**
 * Measures a built app folder: { values, problems }. `values` holds the number for each key of MEASUREMENTS that could be
 * measured, `problems` says in words what could not be (a missing file, a page or a service worker of a shape this does
 * not know). A group that fails leaves its keys out, and compare() turns every missing key into a failure.
 */
export function measureDir(dir) {
  const values = {}
  const problems = []
  const measure = (what, run) => {
    try {
      Object.assign(values, run())
    } catch (err) {
      problems.push(`${what}: ${err.message}`)
    }
  }
  if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) {
    return { values, problems: [`${norm(dir)} is not a folder: build the app first (npm run build) or pass --dir <folder>`] }
  }
  const read = (name) => {
    try {
      return fs.readFileSync(path.join(dir, name), 'utf8')
    } catch {
      throw new Error(`${name} is not in the built folder`)
    }
  }

  measure('provider app', () => {
    const entry = entryFiles(read('index.html'))
    return { entryJs: sumOf(dir, entry.js), entryCss: sumOf(dir, entry.css) }
  })
  measure('committee app', () => {
    const committee = committeeFiles(listFiles(dir))
    return { committeeJs: sizeOfUrl(dir, committee.js), committeeCss: sizeOfUrl(dir, committee.css) }
  })
  measure('precache', () => {
    const urls = precacheUrls(read('sw.js'))
    return { precacheBytes: sumOf(dir, urls), precacheEntries: urls.length }
  })
  return { values, problems }
}

// ---- comparing with the budgets -----------------------------------------------------------------------------------

const grouped = (n) => String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ',')
/** A size or a count as it is printed: 77,662 B or 15 files. */
const amount = (value, unit) => `${grouped(value)} ${unit === 'bytes' ? 'B' : value === 1 ? 'file' : 'files'}`

/**
 * Compares the measured values with the budgets. Returns { rows, problems, notes }: one row per measurement, in the order
 * of MEASUREMENTS, with `status` 'ok', 'over', 'missing' (not measured) or 'no budget'; `problems` fail the check, `notes`
 * do not. A measurement exactly at its budget is fine. A key that the budget file lacks or has in addition to the
 * measurements is a problem too, so the file and the script cannot drift apart.
 */
export function compare(values, budgets) {
  const rows = []
  const problems = []
  const notes = []
  const known = new Set(MEASUREMENTS.map((m) => m.key))
  for (const key of Object.keys(budgets ?? {})) {
    if (!known.has(key)) problems.push(`scripts/check-bundle-size.json has a budget "${key}" that nothing measures`)
  }
  for (const { key, label, unit } of MEASUREMENTS) {
    const budget = budgets?.[key]
    const measured = values[key]
    const row = { key, label, unit, measured, budget, headroom: null, status: 'ok' }
    rows.push(row)
    if (!Number.isSafeInteger(budget) || budget <= 0) {
      row.status = 'no budget'
      problems.push(`${label}: scripts/check-bundle-size.json has no budget for "${key}" (a positive whole number is needed)`)
    } else if (!Number.isFinite(measured)) {
      row.status = 'missing'
      problems.push(`${label}: could not be measured`)
    } else {
      row.headroom = budget - measured
      if (measured > budget) {
        row.status = 'over'
        problems.push(`${label}: ${amount(measured, unit)} is over the budget of ${amount(budget, unit)} (${amount(measured - budget, unit)} too many)`)
      } else if (measured * 100 < budget * (100 - NOTE_UNDER_PERCENT)) {
        notes.push(
          `${label}: ${amount(measured, unit)} is more than ${NOTE_UNDER_PERCENT}% under the budget of ${amount(budget, unit)}; consider lowering the budget in scripts/check-bundle-size.json.`,
        )
      }
    }
  }
  return { rows, problems, notes }
}

/** The table that is printed: what was measured, the budget and the headroom, for each row of compare(). */
export function formatTable(rows) {
  const cell = (value, unit) => (Number.isFinite(value) ? amount(value, unit) : '-')
  const headroomCell = (row) => (row.headroom === null ? '-' : `${row.headroom >= 0 ? '+' : '-'}${grouped(Math.abs(row.headroom))}`)
  const body = rows.map((row) => [
    row.label,
    cell(row.measured, row.unit),
    cell(row.budget, row.unit),
    headroomCell(row),
    row.status === 'ok' ? 'ok' : row.status.toUpperCase(),
  ])
  const lines = [['', 'measured', 'budget', 'headroom', ''], ...body]
  const widths = lines[0].map((_, column) => Math.max(...lines.map((line) => line[column].length)))
  return lines
    .map((line) => line.map((text, column) => (column === 0 || column === 4 ? text.padEnd(widths[column]) : text.padStart(widths[column]))).join('  ').trimEnd())
    .join('\n')
}

/** The arguments of the command line: { dir } (the folder to measure, or undefined for the default). Throws on a bad one. */
export function parseArgs(argv) {
  const args = [...argv]
  let dir
  while (args.length) {
    const arg = args.shift()
    if (arg === '--dir') dir = args.shift()
    else if (arg.startsWith('--dir=')) dir = arg.slice('--dir='.length)
    else throw new Error(`unknown argument ${arg}`)
    if (!dir || dir.startsWith('--')) throw new Error('--dir needs a folder')
  }
  return { dir }
}

function main() {
  let dir
  let budgets
  try {
    dir = parseArgs(process.argv.slice(2)).dir
  } catch (err) {
    console.error(`${err.message}\nUsage: node scripts/check-bundle-size.mjs [--dir <built app folder>]   (default: dist)`)
    process.exit(2)
  }
  try {
    budgets = JSON.parse(fs.readFileSync(BUDGET_FILE, 'utf8'))
  } catch (err) {
    console.error(`Could not read the budgets in ${norm(path.relative(process.cwd(), BUDGET_FILE))}: ${err.message}`)
    process.exit(2)
  }

  const folder = dir ? path.resolve(dir) : DEFAULT_DIR
  const { values, problems: unreadable } = measureDir(folder)
  const { rows, problems, notes } = compare(values, budgets)

  console.log(`Size of the app in ${norm(path.relative(process.cwd(), folder)) || '.'}, brotli-compressed (what Vercel sends):\n`)
  console.log(formatTable(rows))
  for (const note of notes) console.log(`\nNote: ${note}`)
  const failures = [...unreadable, ...problems]
  if (failures.length) {
    console.error(`\nSize check failed (${failures.length}):`)
    for (const failure of failures) console.error(`  - ${failure}`)
    console.error('If the growth is on purpose, raise the budget in scripts/check-bundle-size.json in a pull request that says why (AGENTS.md); otherwise make the app smaller.')
    process.exit(1)
  }
  console.log('\nSize OK.')
}

if (isMain(import.meta.url)) main()
