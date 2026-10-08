// The size budget that CI checks on every pull request (scripts/check-bundle-size.mjs, its budgets in
// scripts/check-bundle-size.json, run by `npm run size` in the guards job of .github/workflows/ci.yml).
// No build happens here: the pure functions are tried on a fake built folder that is made in a temporary directory and
// removed afterwards, and the command is run on it as a child process.
import { describe, it, expect, afterEach } from 'vitest'
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import zlib from 'node:zlib'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import {
  MEASUREMENTS,
  brotliSize,
  committeeFiles,
  compare,
  entryFiles,
  formatTable,
  measureDir,
  parseArgs,
  precacheUrls,
  sizeOfUrl,
} from '../scripts/check-bundle-size.mjs'

const root = fileURLToPath(new URL('..', import.meta.url))
const SCRIPT = path.join(root, 'scripts', 'check-bundle-size.mjs')
const budgetsOnDisk = () => JSON.parse(fs.readFileSync(path.join(root, 'scripts', 'check-bundle-size.json'), 'utf8'))

// ---- a fake built folder ------------------------------------------------------------------------------------------

const made = []
afterEach(() => {
  while (made.length) fs.rmSync(made.pop(), { recursive: true, force: true })
})

/** Text that brotli can shrink, and that differs from one seed to the next. */
const text = (seed, lines = 400) => Array.from({ length: lines }, (_, i) => `const v${i}=${(i * seed) % 97};f(v${i});`).join('\n')

const INDEX_HTML = `<!DOCTYPE html>
<html lang="he" dir="rtl">
  <head>
    <meta charset="UTF-8" />
    <!-- <script type="module" src="/assets/commented-out.js"></script> -->
    <script src="/theme-init.js"></script>
    <link rel="icon" type="image/svg+xml" href="/pwa-192x192.svg" />
    <title>Fake</title>
    <script type="module" crossorigin src="/assets/index-AAA111.js"></script>
    <link rel="stylesheet" crossorigin href="/assets/index-AAA111.css">
  <link rel="manifest" href="/manifest.webmanifest"></head>
  <body><div id="root"></div></body>
</html>`

// What Workbox writes into sw.js: one line of minified JavaScript with the list of files; some of them are listed twice.
const precacheList = (urls) => urls.map((url) => `{url:"${url}",revision:null}`).join(',')
const swFor = (urls) => `define(["./workbox-1"],function(e){"use strict";e.precacheAndRoute([${precacheList(urls)}],{}),e.cleanupOutdatedCaches()})`

const PRECACHED = [
  'index.html',
  'assets/index-AAA111.js',
  'assets/index-AAA111.css',
  'assets/AdminApp-BBB222.js',
  'assets/AdminApp-BBB222.css',
  'assets/heebo-hebrew-CCC333.woff2',
  'pwa-192x192.svg',
  'pwa-192x192.png',
]

function defaultFiles() {
  return {
    'index.html': INDEX_HTML,
    'assets/index-AAA111.js': text(3),
    'assets/index-AAA111.css': text(5, 100),
    'assets/AdminApp-BBB222.js': text(7, 300),
    'assets/AdminApp-BBB222.css': text(11, 80),
    'assets/heebo-hebrew-CCC333.woff2': crypto.randomBytes(3000),
    'pwa-192x192.svg': text(13, 20),
    'pwa-192x192.png': crypto.randomBytes(500),
    // the two icons are listed a second time, as they are in the real manifest
    'sw.js': swFor([...PRECACHED, 'pwa-192x192.png', 'pwa-192x192.svg']),
    'workbox-1.js': text(17, 50),
  }
}

/** Makes a folder `dist` inside a new temporary directory; `files` overrides the default ones, `null` leaves one out. */
function makeDist(files = {}) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'bqr-size-'))
  made.push(base)
  const dir = path.join(base, 'dist')
  for (const [name, content] of Object.entries({ ...defaultFiles(), ...files })) {
    if (content === null) continue
    fs.mkdirSync(path.dirname(path.join(dir, name)), { recursive: true })
    fs.writeFileSync(path.join(dir, name), content)
  }
  return { base, dir }
}

const sizeOnDisk = (dir, name) => brotliSize(fs.readFileSync(path.join(dir, name)))

// ---- reading index.html -------------------------------------------------------------------------------------------

describe('check-bundle-size: the files that index.html loads', () => {
  it('finds the module script and the stylesheet, and nothing else', () => {
    expect(entryFiles(INDEX_HTML)).toEqual({ js: ['/assets/index-AAA111.js'], css: ['/assets/index-AAA111.css'] })
  })

  it('reads the real output shape of Vite: unquoted or single-quoted values, any order, self-closing tags', () => {
    const html = `<script crossorigin src='/assets/a.js' type=module></script>
      <link href=/assets/a.css rel=stylesheet>
      <LINK REL="stylesheet" HREF="/assets/b.css" />`
    expect(entryFiles(html)).toEqual({ js: ['/assets/a.js'], css: ['/assets/a.css', '/assets/b.css'] })
  })

  it('counts the chunks that the entry imports (modulepreload) as entry JavaScript, once each', () => {
    const html = `<script type="module" src="/assets/index-1.js"></script>
      <link rel="modulepreload" crossorigin href="/assets/vendor-2.js">
      <link rel="modulepreload" href="/assets/vendor-2.js">
      <link rel="stylesheet" href="/assets/index-1.css">`
    expect(entryFiles(html).js).toEqual(['/assets/index-1.js', '/assets/vendor-2.js'])
  })

  it('ignores classic scripts, inline scripts, other links and anything in a comment', () => {
    const html = `<!-- <link rel="stylesheet" href="/assets/old.css"> -->
      <script src="/classic.js"></script><script>var x = 1</script>
      <link rel="icon" href="/icon.svg"><link rel="preload" as="font" href="/f.woff2">
      <script type="module" src="/assets/index.js"></script><link rel="stylesheet" href="/assets/index.css">`
    expect(entryFiles(html)).toEqual({ js: ['/assets/index.js'], css: ['/assets/index.css'] })
  })

  it('fails when there is no module script or no stylesheet, so that nothing is measured by accident', () => {
    expect(() => entryFiles('<link rel="stylesheet" href="/a.css">')).toThrow(/module/)
    expect(() => entryFiles('<script type="module" src="/a.js"></script>')).toThrow(/stylesheet/)
    expect(() => entryFiles('')).toThrow()
  })

  it('fails on a file from another origin, which cannot be measured', () => {
    expect(() => entryFiles('<script type="module" src="https://cdn.example.test/a.js"></script><link rel="stylesheet" href="/a.css">')).toThrow(
      /another origin/,
    )
    expect(() => entryFiles('<script type="module" src="/a.js"></script><link rel="stylesheet" href="//cdn.example.test/a.css">')).toThrow(/another origin/)
  })
})

// ---- finding the committee app's chunk ----------------------------------------------------------------------------

describe('check-bundle-size: the committee app chunk', () => {
  const NAMES = [
    'index.html',
    'sw.js',
    'assets/index-AAA111.js',
    'assets/index-AAA111.css',
    'assets/AdminApp-BBB222.js',
    'assets/AdminApp-BBB222.css',
    'assets/heebo-hebrew-CCC333.woff2',
  ]

  it('finds the JavaScript and the CSS by the AdminApp- prefix', () => {
    expect(committeeFiles(NAMES)).toEqual({ js: 'assets/AdminApp-BBB222.js', css: 'assets/AdminApp-BBB222.css' })
  })

  it('accepts Windows separators and a hash with a dash, and does not take a name that merely ends in AdminApp-', () => {
    const names = ['assets\\AdminApp-BNtCX-gm.js', 'assets\\AdminApp-lytByPB1.css', 'assets/NotAdminApp-xyz.js', 'assets/AdminApp.js']
    expect(committeeFiles(names)).toEqual({ js: 'assets/AdminApp-BNtCX-gm.js', css: 'assets/AdminApp-lytByPB1.css' })
  })

  it('fails clearly when the JavaScript or the CSS is missing', () => {
    expect(() => committeeFiles(NAMES.filter((name) => !name.endsWith('AdminApp-BBB222.js')))).toThrow(/AdminApp-\*\.js/)
    expect(() => committeeFiles(NAMES.filter((name) => !name.endsWith('AdminApp-BBB222.css')))).toThrow(/AdminApp-\*\.css/)
    expect(() => committeeFiles([])).toThrow(/missing/)
  })

  it('fails when there are two of them (a leftover of an older build)', () => {
    expect(() => committeeFiles([...NAMES, 'assets/AdminApp-OLD999.js'])).toThrow(/ambiguous/)
    expect(() => committeeFiles([...NAMES, 'assets/AdminApp-OLD999.css'])).toThrow(/ambiguous/)
  })
})

// ---- reading the precache manifest --------------------------------------------------------------------------------

describe('check-bundle-size: the precache manifest of sw.js', () => {
  it('lists the URLs once each, in order, even when the manifest lists a file twice', () => {
    const urls = ['a.png', 'assets/b.js', 'c.svg']
    expect(precacheUrls(swFor([...urls, 'a.png', 'c.svg']))).toEqual(urls)
  })

  it('reads the manifest of a real Workbox build (the shape of the file in dist/sw.js)', () => {
    const sw =
      'if(!self.define){let e,s={};}define(["./workbox-2fbc6a65"],function(e){"use strict";self.addEventListener("message",e=>{e.data&&"SKIP_WAITING"===e.data.type&&self.skipWaiting()}),' +
      'e.precacheAndRoute([{url:"pwa-512x512.svg",revision:"647445c2781e9cd266567014f0668a02"},{url:"assets/index-BZ10jFWj.css",revision:null},' +
      '{url:"pwa-512x512.svg",revision:"647445c2781e9cd266567014f0668a02"},{url:"manifest.webmanifest",revision:"27b361f65138f0b65061350f52409d60"}],{}),' +
      'e.cleanupOutdatedCaches(),e.registerRoute(new e.NavigationRoute(e.createHandlerBoundToURL("index.html"),{denylist:[/^\\/api\\//]}))});'
    expect(precacheUrls(sw)).toEqual(['pwa-512x512.svg', 'assets/index-BZ10jFWj.css', 'manifest.webmanifest'])
  })

  it('reads a manifest that is not minified, with quoted keys, single quotes and escapes', () => {
    const sw = `precacheAndRoute([\n  { "url": "a.js", "revision": null },\n  { url: 'b c.js', revision: '1' },\n  { url: "q\\"uote.js" },\n], {})`
    expect(precacheUrls(sw)).toEqual(['a.js', 'b c.js', 'q"uote.js'])
  })

  it('is not confused by a bracket inside a URL, and stops at the end of the list', () => {
    const sw = `e.precacheAndRoute([{url:"a].js",revision:null},{url:"b.js",revision:null}],{}),e.registerRoute(x,{url:"not-in-the-list.js"})`
    expect(precacheUrls(sw)).toEqual(['a].js', 'b.js'])
  })

  it('fails when the call, its closing bracket or its entries are not there', () => {
    expect(() => precacheUrls('console.log("not a service worker")')).toThrow(/precacheAndRoute/)
    expect(() => precacheUrls('e.precacheAndRoute([{url:"a.js"')).toThrow(/not closed/)
    expect(() => precacheUrls('e.precacheAndRoute([],{})')).toThrow(/no \{ url \}/)
    expect(() => precacheUrls('')).toThrow()
  })
})

// ---- the size of a file -------------------------------------------------------------------------------------------

describe('check-bundle-size: sizes', () => {
  it('is the length of the brotli-compressed contents', () => {
    const buffer = Buffer.from(text(3))
    expect(brotliSize(buffer)).toBe(zlib.brotliCompressSync(buffer).length)
    expect(brotliSize(buffer)).toBeLessThan(buffer.length / 4)
    expect(brotliSize(buffer)).toBe(brotliSize(Buffer.from(text(3))))
  })

  it('resolves a URL inside the folder: with or without a leading slash, with a query, with an escape', () => {
    const { dir } = makeDist({ 'assets/we ird.js': text(19, 30) })
    const expected = sizeOnDisk(dir, 'assets/we ird.js')
    for (const url of ['assets/we ird.js', '/assets/we ird.js', './assets/we ird.js', '/assets/we%20ird.js', '/assets/we ird.js?v=1#x']) {
      expect(sizeOfUrl(dir, url), url).toBe(expected)
    }
  })

  it('fails on a file that is not there, and on a URL that leads out of the folder', () => {
    const { base, dir } = makeDist()
    fs.writeFileSync(path.join(base, 'outside.js'), 'x')
    expect(() => sizeOfUrl(dir, '/assets/gone.js')).toThrow(/not in the built folder/)
    expect(() => sizeOfUrl(dir, '../outside.js')).toThrow(/leads out/)
    expect(() => sizeOfUrl(dir, '/../outside.js')).toThrow(/leads out/)
    expect(() => sizeOfUrl(dir, '')).toThrow()
  })
})

// ---- measuring a built folder -------------------------------------------------------------------------------------

describe('check-bundle-size: measuring a built folder', () => {
  it('measures the entry, the committee chunk and the precache as brotli bytes', () => {
    const { dir } = makeDist()
    const { values, problems } = measureDir(dir)
    expect(problems).toEqual([])
    expect(values).toEqual({
      entryJs: sizeOnDisk(dir, 'assets/index-AAA111.js'),
      entryCss: sizeOnDisk(dir, 'assets/index-AAA111.css'),
      committeeJs: sizeOnDisk(dir, 'assets/AdminApp-BBB222.js'),
      committeeCss: sizeOnDisk(dir, 'assets/AdminApp-BBB222.css'),
      // each file once: the two icons that the manifest lists twice are counted once, and sw.js itself is not in it
      precacheBytes: PRECACHED.reduce((total, name) => total + sizeOnDisk(dir, name), 0),
      precacheEntries: PRECACHED.length,
    })
    expect(Object.keys(values).sort()).toEqual(MEASUREMENTS.map((m) => m.key).sort())
  })

  it('does not count a file twice that two entries of the manifest name in different ways', () => {
    const { dir } = makeDist({ 'sw.js': swFor(['index.html', 'assets/index-AAA111.js', 'assets/index-AAA111.css', 'index.html']) })
    expect(measureDir(dir).values.precacheEntries).toBe(3)
  })

  it('measures the sum of the entry files when the entry imports a shared chunk', () => {
    const html = INDEX_HTML.replace('<link rel="stylesheet"', '<link rel="modulepreload" crossorigin href="/assets/vendor-DDD444.js">\n<link rel="stylesheet"')
    const { dir } = makeDist({ 'index.html': html, 'assets/vendor-DDD444.js': text(23, 200) })
    expect(measureDir(dir).values.entryJs).toBe(sizeOnDisk(dir, 'assets/index-AAA111.js') + sizeOnDisk(dir, 'assets/vendor-DDD444.js'))
  })

  it('reports a file that index.html loads and that is not there, and leaves that measurement out', () => {
    const { dir } = makeDist({ 'assets/index-AAA111.css': null })
    const { values, problems } = measureDir(dir)
    expect(problems.some((p) => p.startsWith('provider app:') && p.includes('/assets/index-AAA111.css'))).toBe(true)
    expect(values).not.toHaveProperty('entryJs')
    expect(values).not.toHaveProperty('entryCss')
    expect(values).toHaveProperty('committeeJs')
  })

  it('reports a missing committee chunk, JavaScript or CSS', () => {
    for (const name of ['assets/AdminApp-BBB222.js', 'assets/AdminApp-BBB222.css']) {
      const { values, problems } = measureDir(makeDist({ [name]: null }).dir)
      expect(problems.some((p) => p.startsWith('committee app:') && p.includes('missing')), name).toBe(true)
      expect(values, name).not.toHaveProperty('committeeJs')
      expect(values, name).not.toHaveProperty('committeeCss')
    }
  })

  it('reports a missing sw.js, and a file in the precache that is not there', () => {
    const noSw = measureDir(makeDist({ 'sw.js': null }).dir)
    expect(noSw.problems.some((p) => p.startsWith('precache:') && p.includes('sw.js'))).toBe(true)
    expect(noSw.values).not.toHaveProperty('precacheBytes')
    expect(noSw.values).not.toHaveProperty('precacheEntries')

    const noFont = measureDir(makeDist({ 'assets/heebo-hebrew-CCC333.woff2': null }).dir)
    expect(noFont.problems.some((p) => p.startsWith('precache:') && p.includes('heebo-hebrew-CCC333.woff2'))).toBe(true)
    expect(noFont.values).not.toHaveProperty('precacheEntries')
    expect(noFont.values).toHaveProperty('entryJs')
  })

  it('reports a precache URL that leads out of the folder instead of reading it', () => {
    const { base, dir } = makeDist({ 'sw.js': swFor([...PRECACHED, '../outside.js']) })
    fs.writeFileSync(path.join(base, 'outside.js'), 'x')
    const { problems } = measureDir(dir)
    expect(problems.some((p) => p.includes('leads out'))).toBe(true)
  })

  it('reports a folder that does not exist, or that is a file', () => {
    const { base, dir } = makeDist()
    for (const missing of [path.join(base, 'nope'), path.join(dir, 'sw.js')]) {
      const { values, problems } = measureDir(missing)
      expect(values).toEqual({})
      expect(problems).toHaveLength(1)
      expect(problems[0]).toContain('is not a folder')
    }
  })
})

// ---- comparing with the budgets -----------------------------------------------------------------------------------

describe('check-bundle-size: comparing with the budgets', () => {
  const BUDGETS = { entryJs: 1000, entryCss: 100, committeeJs: 2000, committeeCss: 200, precacheBytes: 5000, precacheEntries: 10 }
  const VALUES = { entryJs: 900, entryCss: 90, committeeJs: 1800, committeeCss: 180, precacheBytes: 4500, precacheEntries: 9 }

  it('passes when every measurement is under its budget, with the headroom in the rows', () => {
    const { rows, problems, notes } = compare(VALUES, BUDGETS)
    expect(problems).toEqual([])
    expect(notes).toEqual([])
    expect(rows.map((row) => row.key)).toEqual(MEASUREMENTS.map((m) => m.key))
    expect(rows.map((row) => row.status)).toEqual(Array(6).fill('ok'))
    expect(rows.map((row) => row.headroom)).toEqual([100, 10, 200, 20, 500, 1])
  })

  it('passes at the budget exactly, and fails one byte over', () => {
    const at = compare({ ...VALUES, entryJs: 1000 }, BUDGETS)
    expect(at.problems).toEqual([])
    expect(at.rows[0]).toMatchObject({ status: 'ok', headroom: 0 })

    const over = compare({ ...VALUES, entryJs: 1001 }, BUDGETS)
    expect(over.problems).toHaveLength(1)
    expect(over.problems[0]).toContain('Provider app, entry JS')
    expect(over.problems[0]).toContain('over the budget')
    expect(over.rows[0]).toMatchObject({ status: 'over', headroom: -1 })
  })

  it('fails on each measurement that is over, whichever it is', () => {
    for (const { key, label } of MEASUREMENTS) {
      const { problems, rows } = compare({ ...VALUES, [key]: BUDGETS[key] + 1 }, BUDGETS)
      expect(problems, key).toHaveLength(1)
      expect(problems[0], key).toContain(label)
      expect(rows.find((row) => row.key === key).status, key).toBe('over')
    }
  })

  it('says files, not bytes, for the number of files in the precache', () => {
    const { problems } = compare({ ...VALUES, precacheEntries: 11 }, BUDGETS)
    expect(problems[0]).toContain('11 files')
    expect(problems[0]).toContain('10 files')
  })

  it('fails on a measurement that is missing, however it is missing', () => {
    for (const missing of [undefined, null, Number.NaN, '900']) {
      const { problems, rows } = compare({ ...VALUES, entryCss: missing }, BUDGETS)
      expect(problems, String(missing)).toHaveLength(1)
      expect(problems[0], String(missing)).toContain('could not be measured')
      expect(rows[1].status, String(missing)).toBe('missing')
    }
    const nothing = compare({}, BUDGETS)
    expect(nothing.problems).toHaveLength(MEASUREMENTS.length)
  })

  it('prints a note, and does not fail, when a measurement is more than 20% under its budget', () => {
    const under = compare({ ...VALUES, entryJs: 799 }, BUDGETS)
    expect(under.problems).toEqual([])
    expect(under.notes).toHaveLength(1)
    expect(under.notes[0]).toContain('Provider app, entry JS')
    expect(under.notes[0]).toContain('lowering the budget')
    expect(under.rows[0].status).toBe('ok')
  })

  it('has no note at exactly 20% under, or less', () => {
    expect(compare({ ...VALUES, entryJs: 800 }, BUDGETS).notes).toEqual([])
    expect(compare({ ...VALUES, entryJs: 801 }, BUDGETS).notes).toEqual([])
    expect(compare({ ...VALUES, precacheEntries: 8 }, BUDGETS).notes).toEqual([])
    expect(compare({ ...VALUES, precacheEntries: 7 }, BUDGETS).notes).toHaveLength(1)
  })

  it('fails when the budget file lacks a budget, has one that nothing measures, or has one that is not a whole number', () => {
    const lacking = { ...BUDGETS }
    delete lacking.committeeCss
    const noBudget = compare(VALUES, lacking)
    expect(noBudget.problems).toHaveLength(1)
    expect(noBudget.problems[0]).toContain('Committee app, chunk CSS')
    expect(noBudget.rows[3].status).toBe('no budget')

    const extra = compare(VALUES, { ...BUDGETS, fonts: 1000 })
    expect(extra.problems).toHaveLength(1)
    expect(extra.problems[0]).toContain('"fonts"')

    for (const bad of ['1000', 0, -5, 1.5, null, Number.POSITIVE_INFINITY]) {
      expect(compare(VALUES, { ...BUDGETS, entryJs: bad }).problems, String(bad)).toHaveLength(1)
    }
    expect(compare(VALUES, null).problems.length).toBeGreaterThanOrEqual(MEASUREMENTS.length)
  })

  it('prints a table with what was measured, the budget and the headroom', () => {
    const table = formatTable(compare({ ...VALUES, entryJs: 77662, precacheEntries: 15 }, { ...BUDGETS, entryJs: 86016, precacheEntries: 17 }).rows)
    const lines = table.split('\n')
    expect(lines[0]).toMatch(/measured\s+budget\s+headroom/)
    expect(lines).toHaveLength(MEASUREMENTS.length + 1)
    const first = lines[1]
    expect(first).toContain('Provider app, entry JS')
    expect(first).toContain('77,662 B')
    expect(first).toContain('86,016 B')
    expect(first).toContain('+8,354')
    expect(first.trimEnd().endsWith('ok')).toBe(true)
    expect(lines[6]).toContain('15 files')
    expect(lines[6]).toContain('17 files')
  })

  it('marks what is over, missing or without a budget in the table', () => {
    const lacking = { ...BUDGETS }
    delete lacking.entryCss
    const table = formatTable(compare({ ...VALUES, entryJs: 1500, committeeJs: undefined }, lacking).rows)
    expect(table).toMatch(/entry JS .*-500\s+OVER/)
    expect(table).toMatch(/entry CSS .*NO BUDGET/)
    expect(table).toMatch(/chunk JS .*MISSING/)
  })
})

// ---- the budgets in the repository --------------------------------------------------------------------------------

describe('check-bundle-size: the budget file', () => {
  it('measures what the app is meant to be held to (a measurement cannot be dropped without changing this test)', () => {
    expect(MEASUREMENTS.map((m) => m.key)).toEqual(['entryJs', 'entryCss', 'committeeJs', 'committeeCss', 'precacheBytes', 'precacheEntries'])
  })

  it('has a budget for every measurement and none for anything else', () => {
    const budgets = budgetsOnDisk()
    expect(Object.keys(budgets).sort()).toEqual(MEASUREMENTS.map((m) => m.key).sort())
    for (const [key, value] of Object.entries(budgets)) {
      expect(Number.isSafeInteger(value) && value > 0, `${key} is a positive whole number`).toBe(true)
    }
    // compare() accepts the file as it is (no budget is missing, none is unknown): an app exactly at every budget passes
    expect(compare(budgets, budgets).problems).toEqual([])
  })
})

// ---- the command --------------------------------------------------------------------------------------------------

describe('check-bundle-size: the command', () => {
  const run = (...args) => spawnSync(process.execPath, [SCRIPT, ...args], { encoding: 'utf8' })

  it('parses its arguments', () => {
    expect(parseArgs([])).toEqual({ dir: undefined })
    expect(parseArgs(['--dir', 'out'])).toEqual({ dir: 'out' })
    expect(parseArgs(['--dir=out dir'])).toEqual({ dir: 'out dir' })
    for (const bad of [['--dir'], ['--dir='], ['--dir', '--other'], ['dist'], ['--dr', 'dist'], ['--dir', 'a', 'b']]) {
      expect(() => parseArgs(bad), bad.join(' ')).toThrow()
    }
  })

  it('exits 0 and prints the table when the folder is within its budgets', () => {
    const result = run('--dir', makeDist().dir)
    expect(result.status, result.stderr).toBe(0)
    expect(result.stdout).toContain('Provider app, entry JS')
    expect(result.stdout).toMatch(/measured\s+budget\s+headroom/)
    expect(result.stdout).toContain('Size OK.')
  })

  it('exits 1 when a measurement is over its budget, and says which', () => {
    // random bytes do not compress: this much of them is over the budget whatever the budget is
    const { dir } = makeDist({ 'assets/index-AAA111.js': crypto.randomBytes(budgetsOnDisk().entryJs + 4096) })
    const result = run('--dir', dir)
    expect(result.status).toBe(1)
    expect(result.stdout).toContain('OVER')
    expect(result.stderr).toContain('Provider app, entry JS')
    expect(result.stderr).toContain('over the budget')
    expect(result.stderr).toContain('scripts/check-bundle-size.json')
    expect(result.stdout).not.toContain('Size OK.')
  })

  it('exits 1 when a measured file is missing, instead of leaving it out', () => {
    for (const name of ['assets/AdminApp-BBB222.css', 'assets/index-AAA111.js', 'sw.js']) {
      const result = run('--dir', makeDist({ [name]: null }).dir)
      expect(result.status, name).toBe(1)
      expect(result.stderr, name).toContain('could not be measured')
      expect(result.stdout, name).toContain('MISSING')
    }
  })

  it('exits 1 for a folder that is not there', () => {
    const result = run('--dir', path.join(makeDist().base, 'nope'))
    expect(result.status).toBe(1)
    expect(result.stderr).toContain('is not a folder')
  })

  it('exits 2 for an argument it does not know', () => {
    const result = run('--bad')
    expect(result.status).toBe(2)
    expect(result.stderr).toContain('Usage')
  })
})

// ---- CI and package.json ------------------------------------------------------------------------------------------

describe('check-bundle-size: the guards job of CI', () => {
  /** The lines of one job of a workflow file, without the comments. */
  function jobLines(yaml, name) {
    const lines = yaml.replace(/\r\n/g, '\n').split('\n')
    const start = lines.findIndex((line) => line === `  ${name}:`)
    expect(start, `job ${name}`).toBeGreaterThanOrEqual(0)
    const end = lines.findIndex((line, i) => i > start && /^ {2}[A-Za-z0-9_-]+:\s*$/.test(line))
    return lines.slice(start, end < 0 ? lines.length : end).filter((line) => !/^\s*#/.test(line))
  }
  /** The steps of a job: the lines of each, from its `- ` to the line before the next one. */
  function steps(lines) {
    const result = []
    for (const line of lines) {
      if (/^ {6}- /.test(line)) result.push([line])
      else if (result.length) result[result.length - 1].push(line)
    }
    return result.map((step) => step.join('\n'))
  }

  const ci = fs.readFileSync(path.join(root, '.github', 'workflows', 'ci.yml'), 'utf8')
  const guards = steps(jobLines(ci, 'guards'))
  const indexOfRun = (command) => guards.findIndex((step) => new RegExp(`^\\s+(?:- )?run: ${command}\\s*$`, 'm').test(step))

  it('runs npm run size, once, as a step of its own', () => {
    const matching = guards.filter((step) => /^\s+(?:- )?run: npm run size\s*$/m.test(step))
    expect(matching).toHaveLength(1)
    expect(matching[0]).toMatch(/^ {6}- name: \S/)
  })

  it('runs it after the type check, with the dependencies installed', () => {
    const size = indexOfRun('npm run size')
    expect(indexOfRun('npm ci')).toBeGreaterThanOrEqual(0)
    expect(indexOfRun('npm ci')).toBeLessThan(size)
    expect(indexOfRun('npm run typecheck')).toBeGreaterThanOrEqual(0)
    expect(indexOfRun('npm run typecheck')).toBeLessThan(size)
  })

  it('cannot be skipped or ignored: no condition, no continue-on-error', () => {
    const step = guards[indexOfRun('npm run size')]
    expect(step).not.toMatch(/^\s+if:/m)
    expect(step).not.toMatch(/continue-on-error/)
  })

  it('has a package.json script that builds first and then checks that build', () => {
    const scripts = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).scripts
    expect(scripts.size).toBe('vite build && node scripts/check-bundle-size.mjs')
    expect(scripts.build).toBe('vite build')
  })
})
