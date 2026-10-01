// What makes the app a PWA, checked on the production build: the manifest, the service worker, and offline use.
import { test, expect, he, OFFLINE_NOISE, skipOfflineOnWebKit, allowConsoleErrors } from './fixtures.js'

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
    for (const icon of manifest.icons) {
      const file = await page.request.get(new URL(icon.src, new URL(href, page.url())).href)
      expect(file.ok(), `icon ${icon.src} loads`).toBeTruthy()
      expect(file.headers()['content-type'], `icon ${icon.src} type`).toContain(icon.type)
    }
  })

  // KNOWN APP ISSUE (reported, not fixed here): iOS ignores an SVG apple-touch-icon and falls back to a screenshot of
  // the page for the Home Screen icon; it needs a PNG (180x180). While the app links the SVG this test is expected to
  // fail. When a PNG is added, Playwright reports "unexpectedly passed": delete the test.fail line then.
  test('links a PNG apple-touch-icon, which iOS needs for its Home Screen icon', async ({ page }) => {
    test.fail(true, 'the app links pwa-192x192.svg as its apple-touch-icon, which iOS does not use')
    await page.goto('/')
    const href = await page.locator('link[rel="apple-touch-icon"]').getAttribute('href')
    expect(href).toMatch(/\.png(\?|$)/)
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
    await page.evaluate(() => navigator.serviceWorker.ready)
    await page.reload() // now controlled by the service worker, with the shell cached
    await expect(page.getByRole('heading', { name: he['login.title'] })).toBeVisible()

    await context.setOffline(true)
    await page.reload()
    await expect(page.getByRole('heading', { name: he['login.title'] })).toBeVisible()
    await expect(page.getByText(he['brand.address'])).toBeVisible()
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
