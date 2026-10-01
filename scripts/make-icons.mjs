// Makes the PNG icons from the SVG artwork.   Usage: npm run icons
//
// iOS ignores an SVG as the Home Screen icon: it needs a PNG (180x180) that is a full square. It rounds the corners
// itself and paints every transparent pixel black, so that icon is drawn on a solid background. The manifest gets 192
// and 512 PNGs that keep the artwork's own rounded corners (transparent outside them).
//
// The source is public/pwa-512x512.svg. To change the logo: replace that file, run `npm run icons`, commit the PNGs.
// The drawing is done by the Chromium that Playwright already installs for the end-to-end tests, so there is no
// extra tool to install.
import { chromium } from '@playwright/test'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const publicDir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'public')

// The colour behind the artwork. It fills the rounded-off corners of the SVG in the Home Screen icon, so it has to be
// the artwork's own background colour (the blue of its outer rectangle).
const BRAND = '#007AFF'

const TARGETS = [
  { file: 'apple-touch-icon.png', size: 180, background: BRAND },
  { file: 'pwa-192x192.png', size: 192, background: null },
  { file: 'pwa-512x512.png', size: 512, background: null },
]

const svg = fs.readFileSync(path.join(publicDir, 'pwa-512x512.svg'), 'utf8')
const browser = await chromium.launch()
try {
  for (const { file, size, background } of TARGETS) {
    const page = await browser.newPage({ viewport: { width: size, height: size }, deviceScaleFactor: 1 })
    // The SVG is a vector: drawn at the target size it is sharp, nothing is scaled up from a bitmap.
    const sized = svg.replace('<svg ', `<svg style="width:${size}px;height:${size}px;display:block" `)
    await page.setContent(
      `<!doctype html><html><body style="margin:0;background:${background ?? 'transparent'}">${sized}</body></html>`,
    )
    await page.screenshot({ path: path.join(publicDir, file), omitBackground: background === null })
    await page.close()
    console.log(`${file}  ${size}x${size}  ${background ? `on ${background}` : 'transparent corners'}`)
  }
} finally {
  await browser.close()
}
