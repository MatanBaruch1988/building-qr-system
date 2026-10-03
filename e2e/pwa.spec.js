// What makes the app a PWA, checked on the production build: the manifest, the service worker, and offline use.
import { test, expect, he, BUILDING_ADDRESS, OFFLINE_NOISE, skipOfflineOnWebKit, allowConsoleErrors } from './fixtures.js'

test.describe('manifest', () => {
  test('is linked, loads, and describes a standalone app with working icons', async ({ page }) => {
    await page.goto('/')
    const href = await page.locator('link[rel="manifest"]').getAttribute('href')
    expect(href, 'the page links a manifest').toBeTruthy()

    const response = await page.request.get(href)
    expect(response.ok()).toBeTruthy()
    const manifest = await response.json()

    expect(manifest).toMatchObject({
      name: 'נוכחות בבניין',
      short_name: 'נוכחות',
      display: 'standalone',
      start_url: '/',
      scope: '/',
      lang: 'he',
      dir: 'rtl',
      theme_color: '#0b0b0d',
      background_color: '#0b0b0d',
    })
    const sizes = manifest.icons.map((icon) => icon.sizes)
    expect(sizes).toEqual(expect.arrayContaining(['192x192', '512x512']))
    expect(manifest.icons.every((icon) => icon.type === 'image/png'), 'the manifest icons are PNG, which every platform reads').toBe(true)
    for (const icon of manifest.icons) {
      const file = await page.request.get(new URL(icon.src, new URL(href, page.url())).href)
      expect(file.ok(), `icon ${icon.src} loads`).toBeTruthy()
      expect(file.headers()['content-type'], `icon ${icon.src} type`).toContain(icon.type)
    }
  })

  // iOS shows this file as the Home Screen icon. It ignores an SVG (and then uses a screenshot of the page), wants
  // 180x180, and paints every transparent pixel black, so the corners of the file must be solid and not see-through.
  test('links a PNG apple-touch-icon that iOS can use: 180x180, with solid corners', async ({ page }) => {
    await page.goto('/')
    const link = page.locator('link[rel="apple-touch-icon"]')
    const href = await link.getAttribute('href')
    expect(href).toMatch(/\.png(\?|$)/)
    expect(await link.getAttribute('sizes')).toBe('180x180')

    const response = await page.request.get(new URL(href, page.url()).href)
    expect(response.ok()).toBeTruthy()
    expect(response.headers()['content-type']).toContain('image/png')

    // look at the pixels the way a browser sees them
    const icon = await page.evaluate(async (url) => {
      const bitmap = await createImageBitmap(await (await fetch(url)).blob())
      const canvas = document.createElement('canvas')
      canvas.width = bitmap.width
      canvas.height = bitmap.height
      const context = canvas.getContext('2d')
      context.drawImage(bitmap, 0, 0)
      const at = (x, y) => [...context.getImageData(x, y, 1, 1).data]
      const last = bitmap.width - 1
      return { width: bitmap.width, height: bitmap.height, corners: [at(0, 0), at(last, 0), at(0, last), at(last, last)] }
    }, href)
    expect([icon.width, icon.height]).toEqual([180, 180])
    for (const [red, green, blue, alpha] of icon.corners) {
      expect(alpha, 'a corner is fully opaque').toBe(255)
      // the brand blue (#007AFF), not black
      expect([red, green, blue]).toEqual([0, 122, 255])
    }
  })
})

test.describe('service worker', () => {
  test('registers, activates and takes control of the page', async ({ page }) => {
    await page.goto('/')
    // `ready` resolves as soon as a worker exists, which can still be "activating": wait for the last state
    await page.waitForFunction(async () => (await navigator.serviceWorker.ready).active?.state === 'activated')
    const registration = await page.evaluate(async () => {
      const reg = await navigator.serviceWorker.ready
      return { scope: reg.scope, state: reg.active?.state, script: reg.active?.scriptURL }
    })
    expect(registration.state).toBe('activated')
    expect(new URL(registration.scope).pathname).toBe('/')
    expect(new URL(registration.script).pathname).toBe('/sw.js')

    await page.reload() // a page is controlled from its second load on
    expect(await page.evaluate(() => navigator.serviceWorker.controller !== null)).toBe(true)
  })

  test('precaches the app shell', async ({ page }) => {
    await page.goto('/')
    await page.evaluate(() => navigator.serviceWorker.ready)
    const cached = await page.evaluate(async () => {
      const names = await caches.keys()
      const precache = names.find((name) => name.includes('precache'))
      const keys = precache ? await (await caches.open(precache)).keys() : []
      return keys.map((request) => new URL(request.url).pathname)
    })
    expect(cached.some((path) => path.endsWith('.js'))).toBe(true)
    expect(cached.some((path) => path.endsWith('.css'))).toBe(true)
    expect(cached.some((path) => path === '/index.html' || path === '/')).toBe(true)
  })
})

test.describe('offline', () => {
  // With the network off the app refreshes its list of names, fails, and carries on with the saved one: the browser
  // logs that failed request as a console error, which is expected here and only here.
  test('the app opens and shows the sign-in screen with no network, after the first load', async ({ page, context, browserName }) => {
    skipOfflineOnWebKit(browserName)
    allowConsoleErrors(page, OFFLINE_NOISE)
    await page.goto('/')
    // wait for the names themselves: they are saved on the phone only once they have arrived
    await expect(page.getByRole('list').getByRole('button').first()).toBeVisible()
    await expect(page.getByText(BUILDING_ADDRESS)).toBeVisible() // the address is saved on the phone once it has arrived
    await page.evaluate(() => navigator.serviceWorker.ready)
    await page.reload() // now controlled by the service worker, with the shell cached
    await expect(page.getByRole('heading', { name: he['login.title'] })).toBeVisible()

    await context.setOffline(true)
    await page.reload()
    await expect(page.getByRole('heading', { name: he['login.title'] })).toBeVisible()
    await expect(page.getByText(BUILDING_ADDRESS)).toBeVisible() // the saved address, since the network is off
    // the list of names was saved on the first visit, so the person can still choose who they are
    await expect(page.getByRole('list').getByRole('button').first()).toBeVisible()
  })

  test('a scan link opens offline too', async ({ page, context, browserName }) => {
    skipOfflineOnWebKit(browserName)
    allowConsoleErrors(page, OFFLINE_NOISE)
    await page.goto('/')
    await page.evaluate(() => navigator.serviceWorker.ready)
    await page.reload()
    await context.setOffline(true)
    await page.goto('/scan?code=BQR-dev00000000000000000001')
    await expect(page.getByRole('heading', { name: he['login.title'] })).toBeVisible()
  })
})
