// The PNG icons (npm run icons) and the places that point at them. iOS ignores an SVG as the Home Screen icon, so the
// app links a 180x180 PNG; the manifest lists 192 and 512 PNGs, and a maskable 512 one that Android can crop to the shape
// of its launcher. The browser test (e2e/pwa.spec.js) checks what a real browser sees, this one checks the files
// themselves, with no browser.
import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import zlib from 'node:zlib'

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

/**
 * The pixels of a PNG as the icons script writes them (8 bits a channel, RGB or RGBA, not interlaced): `at(x, y)` is
 * [red, green, blue, alpha]. A few lines of decoder instead of a new dependency, so the test can look at the icon itself.
 */
function decodePng(file) {
  const [width, height] = pngSize(file)
  const bytes = read('public', file)
  const [bitDepth, colorType, interlace] = [bytes[24], bytes[25], bytes[28]]
  expect([bitDepth, interlace], `${file} has 8 bits a channel and is not interlaced`).toEqual([8, 0])
  const channels = colorType === 2 ? 3 : colorType === 6 ? 4 : 0
  expect(channels, `${file} is RGB or RGBA`).toBeGreaterThan(0)

  const data = []
  for (let at = 8; at < bytes.length; at += 12 + bytes.readUInt32BE(at)) {
    if (bytes.subarray(at + 4, at + 8).toString('ascii') === 'IDAT') data.push(bytes.subarray(at + 8, at + 8 + bytes.readUInt32BE(at)))
  }
  const raw = zlib.inflateSync(Buffer.concat(data))
  const stride = width * channels
  const pixels = Buffer.alloc(stride * height)
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)]
    expect([0, 1, 2, 3, 4], `${file} uses a known PNG filter`).toContain(filter)
    for (let i = 0; i < stride; i++) {
      const left = i >= channels ? pixels[y * stride + i - channels] : 0
      const up = y > 0 ? pixels[(y - 1) * stride + i] : 0
      const upLeft = y > 0 && i >= channels ? pixels[(y - 1) * stride + i - channels] : 0
      const guess = left + up - upLeft
      const paeth = [left, up, upLeft].reduce((best, near) => (Math.abs(guess - near) < Math.abs(guess - best) ? near : best))
      const add = [0, left, up, (left + up) >> 1, paeth][filter]
      pixels[y * stride + i] = (raw[y * (stride + 1) + 1 + i] + add) & 255
    }
  }
  return {
    width,
    height,
    at: (x, y) => {
      const offset = y * stride + x * channels
      return [pixels[offset], pixels[offset + 1], pixels[offset + 2], channels === 4 ? pixels[offset + 3] : 255]
    },
  }
}

describe('PNG icons', () => {
  it('are real PNG files of the sizes they are named and listed for', () => {
    expect(pngSize('apple-touch-icon.png')).toEqual([180, 180])
    expect(pngSize('pwa-192x192.png')).toEqual([192, 192])
    expect(pngSize('pwa-512x512.png')).toEqual([512, 512])
    expect(pngSize('pwa-maskable-512x512.png')).toEqual([512, 512])
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

describe('the maskable icon', () => {
  const FILE = 'pwa-maskable-512x512.png'
  const SIZE = 512
  // The artwork's own blue (BRAND in scripts/make-icons.mjs), the colour of the whole icon outside the white QR tile.
  const BLUE = [0, 122, 255]
  // What every launcher shape keeps, whatever it is: the circle in the centre with a diameter of 80% of the width.
  const SAFE_RADIUS = 0.4 * SIZE

  it('is listed in the manifest as a maskable 512x512 PNG, and the script that makes the PNGs makes it', () => {
    const config = text('vite.config.js')
    expect(config).toContain("{ src: 'pwa-maskable-512x512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' }")
    const script = text('scripts', 'make-icons.mjs')
    expect(script).toMatch(/file: 'pwa-maskable-512x512\.png', size: 512, background: BRAND/)
  })

  it('is a full square without one transparent pixel, because a launcher paints transparent pixels in its own colour', () => {
    const icon = decodePng(FILE)
    expect([icon.width, icon.height]).toEqual([SIZE, SIZE])
    const see = []
    for (let y = 0; y < SIZE; y++) for (let x = 0; x < SIZE; x++) if (icon.at(x, y)[3] !== 255) see.push([x, y])
    expect(see, 'pixels that are not fully opaque').toEqual([])
    const last = SIZE - 1
    for (const [x, y] of [[0, 0], [last, 0], [0, last], [last, last]]) expect(icon.at(x, y), `the corner ${x},${y}`).toEqual([...BLUE, 255])
  })

  it('keeps all of its artwork inside the safe zone, and the artwork is there, centred and not tiny', () => {
    const icon = decodePng(FILE)
    let farthest = 0
    let [left, top, right, bottom] = [SIZE, SIZE, -1, -1]
    for (let y = 0; y < SIZE; y++) {
      for (let x = 0; x < SIZE; x++) {
        const pixel = icon.at(x, y)
        // Blending the artwork's rounded blue corners over the same blue can be one level off in a channel: still the background
        if (BLUE.every((level, channel) => Math.abs(pixel[channel] - level) <= 2)) continue
        // the far corner of the pixel, so that a pixel that only touches the circle with its corner counts as outside it
        farthest = Math.max(farthest, Math.hypot(Math.abs(x + 0.5 - SIZE / 2) + 0.5, Math.abs(y + 0.5 - SIZE / 2) + 0.5))
        left = Math.min(left, x)
        top = Math.min(top, y)
        right = Math.max(right, x)
        bottom = Math.max(bottom, y)
      }
    }
    expect(right, 'the icon is not just one colour').toBeGreaterThan(left)
    expect(farthest, 'every pixel that is not the background blue lies inside the centre circle of 80% of the width').toBeLessThanOrEqual(SAFE_RADIUS)
    // the white tile is a square that fills about half of the width: not shrunk to a speck, and in the middle
    expect(right - left + 1).toBeGreaterThanOrEqual(0.4 * SIZE)
    expect(bottom - top + 1).toBeGreaterThanOrEqual(0.4 * SIZE)
    expect(Math.abs(left + right + 1 - SIZE), 'centred left and right').toBeLessThanOrEqual(2)
    expect(Math.abs(top + bottom + 1 - SIZE), 'centred top and bottom').toBeLessThanOrEqual(2)
  })
})

describe('the manifest and the precache', () => {
  const config = text('vite.config.js')

  it('has an explicit id that is the same identity as the start URL gave before, so installed copies are not duplicated', () => {
    expect(config).toMatch(/\bid: '\/',\s*start_url: '\/',/)
  })

  it('keeps the maskable icon out of the precache: the system fetches it at install time, no page shows it', () => {
    // globIgnores keeps it out of the globbed files; the plugin's own addition of every manifest icon is off, because
    // globIgnores does not apply to what is added by hand (e2e/pwa.spec.js checks the built service worker)
    expect(config).toMatch(/globIgnores: \[[^\]]*'\*\*\/pwa-maskable-\*'/)
    expect(config).toContain('includeManifestIcons: false')
  })
})
