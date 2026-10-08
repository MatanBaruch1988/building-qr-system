// The Content-Security-Policy and the other security headers that Vercel sends on every page and file (vercel.json, the
// rule "/(.*)"). The browser loads only what the policy allows (AGENTS.md, "Rules for every change"), so this test pins
// it: every directive and every source, each origin with the reason it is there. A new origin that the page loads or talks
// to goes into vercel.json and into ALLOWED below in the same pull request, with its reason. `vite preview` sends the same
// headers (vite.config.js, tests/app-build.test.js), so the E2E tests run under this policy and a page that breaks it fails.
import { describe, it, expect } from 'vitest'
import fs from 'node:fs'

const root = decodeURIComponent(new URL('..', import.meta.url).pathname).replace(/^\/([A-Za-z]:)/, '$1')
const vercel = JSON.parse(fs.readFileSync(`${root}/vercel.json`, 'utf8'))
const everyPage = vercel.headers.filter((rule) => rule.source === '/(.*)')
const headers = Object.fromEntries((everyPage[0]?.headers ?? []).map(({ key, value }) => [key, value]))

// The policy is enforced. A report-only header is not a step on the way: Safari (WebKit) ignores a report-only policy
// that names no address to report to, and prints a warning on every page; an address to report to would be a public
// endpoint that writes, which the app does not have (AGENTS.md, Safety). Going back to report-only is a review finding
// (AGENTS.md, P1), and so is a second policy next to this one.
const NAMES = ['Content-Security-Policy', 'Content-Security-Policy-Report-Only']
const sent = NAMES.filter((name) => name in headers)
const policyText = sent.length === 1 ? headers[sent[0]] : ''

/**
 * The HTML without its comments; one that is not closed runs to the end, as in a browser. A loop and not one replace: a
 * single pass of a regular expression can leave a "<!--" behind when removing one comment joins the pieces of another.
 */
function withoutComments(html) {
  let text = String(html)
  for (let start = text.indexOf('<!--'); start !== -1; start = text.indexOf('<!--')) {
    const end = text.indexOf('-->', start + 4)
    text = end === -1 ? text.slice(0, start) : text.slice(0, start) + text.slice(end + 3)
  }
  return text
}

/** "a b c; d e" as { a: ['b', 'c'], d: ['e'] }; a directive given twice is kept twice under a numbered name, so it fails. */
function parsePolicy(text) {
  const directives = {}
  for (const part of text.split(';')) {
    const [name, ...sources] = part.trim().split(/\s+/)
    if (!name) continue
    const key = name.toLowerCase() in directives ? `${name.toLowerCase()} (again)` : name.toLowerCase()
    directives[key] = sources
  }
  return directives
}
const policy = parsePolicy(policyText)

// Every directive and its sources, and why. Anything not listed falls back to default-src 'self'.
const ALLOWED = {
  'default-src': ["'self'"],
  // The app's own bundle, and Google's sign-in script for the committee (src/admin/LoginScreen.jsx adds it at runtime).
  'script-src': ["'self'", 'https://accounts.google.com/gsi/client'],
  // The app's own CSS (every style that a component sets goes through the CSSOM, which style-src does not govern), and the
  // stylesheet of Google's sign-in button.
  'style-src': ["'self'", 'https://accounts.google.com/gsi/style'],
  // The app's icons; data: for the QR codes (src/admin/qr.js makes PNG data URLs), the map's marker pictures (bundled
  // as data: URLs, src/admin/MapPicker.jsx) and the small pictures inside Leaflet's and the app's CSS; and the map's tiles
  // from OpenStreetMap's one address.
  'img-src': ["'self'", 'data:', 'https://tile.openstreetmap.org'],
  // The API (same origin), and what Google's sign-in script asks its own server.
  'connect-src': ["'self'", 'https://accounts.google.com/gsi/'],
  // The frame of Google's sign-in button.
  'frame-src': ['https://accounts.google.com/gsi/'],
  // Heebo comes with the app (@fontsource-variable/heebo).
  'font-src': ["'self'"],
  'manifest-src': ["'self'"],
  // The service worker (sw.js, and the workbox file that it imports).
  'worker-src': ["'self'"],
  'object-src': ["'none'"],
  'base-uri': ["'none'"],
  'form-action': ["'self'"],
  // Nobody may show the app in a frame (X-Frame-Options DENY says the same to older browsers).
  'frame-ancestors': ["'none'"],
}

describe('the Content-Security-Policy in vercel.json', () => {
  it('is set once, in one rule for every page and file', () => {
    expect(everyPage, 'exactly one headers rule for "/(.*)"').toHaveLength(1)
    expect(sent, 'exactly one policy header, and the enforcing one').toEqual(['Content-Security-Policy'])
    expect(policyText.length).toBeGreaterThan(0)
  })

  it('has exactly the directives and sources that are listed here with their reasons', () => {
    expect(policy).toEqual(ALLOWED)
  })

  it('never allows a string to run as code, nor an inline script', () => {
    for (const [directive, sources] of Object.entries(policy)) {
      expect(sources, directive).not.toContain("'unsafe-eval'")
      expect(sources, directive).not.toContain("'wasm-unsafe-eval'")
      expect(sources, directive).not.toContain("'unsafe-hashes'")
    }
    expect(policy['script-src']).not.toContain("'unsafe-inline'")
    expect(policy['style-src']).not.toContain("'unsafe-inline'")
  })

  it('has no wildcard and no source that allows a whole scheme', () => {
    for (const [directive, sources] of Object.entries(policy)) {
      for (const source of sources) {
        expect(source.includes('*'), `${directive} ${source}`).toBe(false)
        expect(['https:', 'http:', 'blob:', 'filesystem:', 'ws:', 'wss:'].includes(source), `${directive} ${source}`).toBe(false)
        if (source === 'data:') expect(directive, 'data: is allowed only for pictures').toBe('img-src')
      }
    }
  })

  it('names every other origin by https and a full host, never a bare host or plain http', () => {
    for (const [directive, sources] of Object.entries(policy)) {
      for (const source of sources) {
        if (source.startsWith("'") || source === 'data:') continue
        const url = new URL(source)
        expect(url.protocol, `${directive} ${source}`).toBe('https:')
        expect(url.hostname.split('.').length, `${directive} ${source}`).toBeGreaterThanOrEqual(2)
        expect(url.username + url.password + url.search + url.hash, `${directive} ${source}`).toBe('')
      }
    }
  })

  it('locks the page against frames, plugins and a changed base, with or without the policy', () => {
    expect(policy['frame-ancestors']).toEqual(["'none'"])
    expect(policy['object-src']).toEqual(["'none'"])
    expect(policy['base-uri']).toEqual(["'none'"])
    expect(headers['X-Frame-Options']).toBe('DENY')
    expect(headers['X-Content-Type-Options']).toBe('nosniff')
  })
})

describe('what the policy relies on in the page', () => {
  it('index.html runs no inline script (every script is a file)', () => {
    const html = withoutComments(fs.readFileSync(`${root}/index.html`, 'utf8'))
    const scripts = [...html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script\b[^>]*>/gi)]
    expect(scripts.length).toBeGreaterThan(0)
    for (const [, attributes, body] of scripts) {
      expect(attributes, 'a script without src').toMatch(/\bsrc\s*=/i)
      expect(body.trim(), 'a script with a body').toBe('')
    }
  })

  it('index.html has no inline event handler and no style element', () => {
    const html = withoutComments(fs.readFileSync(`${root}/index.html`, 'utf8'))
    expect(html).not.toMatch(/\son[a-z]+\s*=/i)
    expect(html).not.toMatch(/<style\b/i)
  })

  it('the map loads nothing from a CDN: Leaflet and its marker pictures come with the app', () => {
    const map = fs.readFileSync(`${root}/src/admin/MapPicker.jsx`, 'utf8')
    expect(map).not.toMatch(/https?:\/\/[^\s'"`]*(cdnjs|unpkg|jsdelivr)/) // an address, not a word in a comment
    expect(map).toContain("'https://tile.openstreetmap.org/{z}/{x}/{y}.png'")
  })

  it("Google's sign-in script is loaded from the address that the policy allows", () => {
    const login = fs.readFileSync(`${root}/src/admin/LoginScreen.jsx`, 'utf8')
    expect(login).toContain('https://accounts.google.com/gsi/client')
  })
})
