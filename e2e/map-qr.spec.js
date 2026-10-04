// The map and the QR image of the committee app, rendered by the production build.
//
// Two components default-import a CommonJS or UMD package: `import L from 'leaflet'` (src/admin/MapPicker.jsx) and
// `import QRCode from 'qrcode'` (src/admin/qr.js). How a bundler turns that import into a default export is what changes
// between Vite major versions, and a broken one shows only when the component runs: the unit tests never load either
// package, and no other spec opens the point form or the QR dialog. So these tests render both on the real bundle.
import { test, expect, SAMPLE_POINT, POINTS, adminSignIn, allowConsoleErrors } from './fixtures.js'

// A 1x1 transparent PNG: the answer to every image that the map would fetch from the internet.
const PIXEL = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=', 'base64')

/**
 * Answers the images of the map locally, so that no test depends on a server outside this machine: the tiles come from
 * OpenStreetMap and the marker pictures from cdnjs (the URLs in MapPicker.jsx). Returns the list of URLs it answered.
 */
async function stubMapImages(page) {
  const served = []
  const answer = (route) => {
    served.push(route.request().url())
    return route.fulfill({ contentType: 'image/png', body: PIXEL })
  }
  await page.route('https://*.tile.openstreetmap.org/**', answer)
  await page.route('https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.9.4/images/**', answer)
  return served
}

test.beforeEach(async ({ page }) => {
  // The sign-in screen asks /api/admin/me before anyone is signed in: the browser notes that 401 as a console error.
  allowConsoleErrors(page, /status of 401/)
})

/** The tile of the seeded point "לובי": its actions are icons with names. */
const lobbyTile = (page) => page.getByRole('article').filter({ hasText: 'לובי' })

test('the point form shows the map with the marker and the circle at the point, and a click on the map moves them', async ({ page }) => {
  const served = await stubMapImages(page)
  await adminSignIn(page)
  await lobbyTile(page).getByRole('button', { name: 'עריכה' }).click()
  const dialog = page.getByRole('dialog', { name: 'עריכת נקודה: לובי' })

  // The map has no accessible markup of its own beyond the label that MapPicker gives it. The class names below are
  // Leaflet's, the only handle on what the library drew: the container, the loaded tiles and the radius circle.
  const map = dialog.getByRole('application', { name: 'מפה לסימון מיקום הנקודה' })
  await expect(map).toHaveClass(/leaflet-container/) // L.map ran on the element
  await expect(map.locator('img.leaflet-tile-loaded').first()).toBeAttached() // the tile layer asked for tiles and drew them
  await expect(map.locator('svg path.leaflet-interactive')).toHaveCount(1) // the check-in radius, drawn by L.circle

  // The marker is Leaflet's own: a button that the keyboard reaches, named by its alt text ("Marker").
  const marker = map.getByRole('button', { name: 'Marker' })
  await expect(marker).toHaveCount(1)
  // its picture is the CDN copy that MapPicker points the default icon to (the retina one on a phone)
  await expect(marker).toHaveAttribute('src', /^https:\/\/cdnjs\.cloudflare\.com\/ajax\/libs\/leaflet\/1\.9\.4\/images\/marker-icon(-2x)?\.png$/)

  // the form fields hold the coordinates of the point, the same ones the marker stands at
  const lat = dialog.getByLabel('קו רוחב')
  const lng = dialog.getByLabel('קו אורך')
  await expect(lat).toHaveValue(String(SAMPLE_POINT.lat))
  await expect(lng).toHaveValue(String(SAMPLE_POINT.lng))

  // a click on the map is Leaflet's event: the fields follow it and the marker moves, it is not drawn a second time
  const before = await marker.boundingBox()
  const size = await map.boundingBox()
  await map.click({ position: { x: size.width * 0.25, y: size.height * 0.25 } })
  await expect(lat).not.toHaveValue(String(SAMPLE_POINT.lat))
  await expect(lng).not.toHaveValue(String(SAMPLE_POINT.lng))
  // still the same neighbourhood: the map is zoomed in on the point, so a click inside it is metres away, not degrees
  expect(Math.abs(Number(await lat.inputValue()) - SAMPLE_POINT.lat)).toBeLessThan(0.01)
  expect(Math.abs(Number(await lng.inputValue()) - SAMPLE_POINT.lng)).toBeLessThan(0.01)
  await expect(marker).toHaveCount(1)
  await expect.poll(async () => (await marker.boundingBox()).x).not.toBe(before.x)

  // every image of the map was answered here, none came from the internet
  expect(served.some((url) => new URL(url).hostname.endsWith('.tile.openstreetmap.org')), 'tiles were requested').toBe(true)
  expect(served.some((url) => url.includes('/images/marker-icon')), 'the marker picture was requested').toBe(true)

  // leave without saving: the other specs rely on the point staying where the seed put it
  await dialog.getByRole('button', { name: 'ביטול' }).click()
  await expect(dialog).toHaveCount(0)
})

test('the QR dialog draws the QR image of the point as a PNG and shows the address it holds', async ({ page }) => {
  await adminSignIn(page)
  await lobbyTile(page).getByRole('button', { name: 'QR והדפסה' }).click()
  const dialog = page.getByRole('dialog', { name: 'QR: לובי' })

  // QRCode.toDataURL made the picture: a PNG as a data URL that the browser decoded into pixels
  const qr = dialog.getByRole('img', { name: 'קוד QR של הנקודה לובי' })
  await expect(qr).toHaveAttribute('src', /^data:image\/png;base64,.{100,}/)
  await expect.poll(() => qr.evaluate((img) => img.naturalWidth)).toBeGreaterThan(0)
  // the address that the code holds is printed under it, and it carries the point's own token
  await expect(dialog).toContainText(POINTS.lobby)
  await expect(dialog.getByRole('button', { name: 'הדפסת שלט' })).toBeVisible()
})

test('printing a sign builds the sheet with the name of the point and its QR image, and then asks the browser to print', async ({ page }) => {
  // The browser's print dialog is outside the page and a headless browser has none: count the call instead of making it.
  await page.addInitScript(() => {
    window.__prints = 0
    window.print = () => { window.__prints += 1 }
  })
  await adminSignIn(page)
  await lobbyTile(page).getByRole('button', { name: 'QR והדפסה' }).click()
  await page.getByRole('dialog', { name: 'QR: לובי' }).getByRole('button', { name: 'הדפסת שלט' }).click()

  // The sheet is hidden on a screen (it shows only in print), aria-hidden too, so a role or a visible text cannot find it:
  // its own class names are the handle.
  const sign = page.locator('.a-print-only .a-sign')
  await expect(sign).toHaveCount(1)
  await expect(sign.locator('h2')).toHaveText('לובי')
  await expect(sign.locator('img')).toHaveAttribute('src', /^data:image\/png;base64,.{100,}/)
  await expect.poll(() => sign.locator('img').evaluate((img) => img.naturalWidth)).toBeGreaterThan(0)
  await expect(sign.locator('p')).toHaveCount(4) // the instruction in the four languages
  // PrintSheet waits until the images are decoded and only then prints
  await expect.poll(() => page.evaluate(() => window.__prints)).toBe(1)
})
