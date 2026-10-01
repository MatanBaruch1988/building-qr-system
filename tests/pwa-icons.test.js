// The PNG icons (npm run icons) and the places that point at them. iOS ignores an SVG as the Home Screen icon, so the
// app links a 180x180 PNG; the manifest lists 192 and 512 PNGs. The browser test (e2e/pwa.spec.js) checks what a real
// browser sees, this one checks the files themselves, with no browser.
import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'

const root = decodeURIComponent(new URL('..', import.meta.url).pathname).replace(/^\/([A-Za-z]:)/, '$1')
const read = (...parts) => fs.readFileSync(path.join(root, ...parts))
const text = (...parts) => read(...parts).toString('utf8')

/** The width and height written in a PNG's header (IHDR), after checking the file really is a PNG. */
function pngSize(file) {
  const bytes = read('public', file)
  expect(bytes.subarray(0, 8).toString('hex'), `${file} is a PNG file`).toBe('89504e470d0a1a0a')
  expect(bytes.subarray(12, 16).toString('ascii'), `${file} starts with its header chunk`).toBe('IHDR')
  return [bytes.readUInt32BE(16), bytes.readUInt32BE(20)]
}

describe('PNG icons', () => {
  it('are real PNG files of the sizes they are named and listed for', () => {
    expect(pngSize('apple-touch-icon.png')).toEqual([180, 180])
    expect(pngSize('pwa-192x192.png')).toEqual([192, 192])
    expect(pngSize('pwa-512x512.png')).toEqual([512, 512])
  })

  it('the page links the 180x180 PNG as its Home Screen icon, and keeps the SVG as the browser tab icon', () => {
    const html = text('index.html')
    expect(html).toMatch(/<link rel="apple-touch-icon" sizes="180x180" href="\/apple-touch-icon\.png" \/>/)
    expect(html).toMatch(/<link rel="icon" type="image\/svg\+xml" href="\/pwa-192x192\.svg" \/>/)
  })

  it('the manifest lists the 192 and 512 PNGs, and the build ships the Home Screen icon', () => {
    const config = text('vite.config.js')
    expect(config).toContain("{ src: 'pwa-192x192.png', sizes: '192x192', type: 'image/png', purpose: 'any' }")
    expect(config).toContain("{ src: 'pwa-512x512.png', sizes: '512x512', type: 'image/png', purpose: 'any' }")
    expect(config).toMatch(/includeAssets: \[[^\]]*'apple-touch-icon\.png'/)
  })

  it('can be made again from the SVG with one command', () => {
    expect(JSON.parse(text('package.json')).scripts.icons).toBe('node scripts/make-icons.mjs')
    expect(text('scripts', 'make-icons.mjs')).toContain("'pwa-512x512.svg'")
    expect(fs.existsSync(path.join(root, 'public', 'pwa-512x512.svg'))).toBe(true)
  })
})
