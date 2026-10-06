// The two choices a person makes on their own phone: language and light/dark. Both are remembered.
import ar from '../src/i18n/ar.js'
import { test, expect, he, en, ru, PEOPLE, signIn } from './fixtures.js'

const noHorizontalScroll = (page) => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)

test.describe('language', () => {
  // The device says English, and the app still opens in Hebrew: the language is the person's choice, not the browser's.
  test.use({ locale: 'en-US' })

  test('opens in Hebrew even on an English device, and the choice sticks', async ({ page }) => {
    await page.goto('/')
    await expect(page.locator('html')).toHaveAttribute('lang', 'he')
    await expect(page.getByRole('heading', { name: he['login.title'] })).toBeVisible()

    await page.getByLabel(he['lang.label']).selectOption('en')
    await expect(page.getByRole('heading', { name: 'Choose your name' })).toBeVisible()
    await expect(page.locator('html')).toHaveAttribute('lang', 'en')
    await expect(page.locator('html')).toHaveAttribute('dir', 'ltr')

    await page.reload()
    await expect(page.getByRole('heading', { name: 'Choose your name' })).toBeVisible()
  })

  test('Arabic and Russian switch the direction and the text', async ({ page }) => {
    await page.goto('/')
    await page.getByLabel(he['lang.label']).selectOption('ar')
    await expect(page.locator('html')).toHaveAttribute('dir', 'rtl')
    await expect(page.locator('html')).toHaveAttribute('lang', 'ar')
    await page.getByLabel('اللغة').selectOption('ru')
    await expect(page.locator('html')).toHaveAttribute('dir', 'ltr')
    await expect(page.getByRole('heading', { name: 'Выберите своё имя' })).toBeVisible()
  })

  // The two pickers in the header are invisible <select>s over an icon, each in a 44 px box. WebKit lays the text of the chosen option
  // out in a block of its own inside the select and, before the box clipped it (src/ui/ui.css), that block widened the page: by 30 px
  // in Russian, where the label of "match the device" is the longest, and at the end of the line on the left or the right alike.
  for (const [phone, size] of [['the phone of the project', null], ['a 360 px phone', { width: 360, height: 740 }]]) {
    test(`the header of the provider app fits ${phone} in every language and every look, and the two pickers stay a 44 px target`, async ({ page }) => {
      if (size) await page.setViewportSize(size)
      await page.goto('/')
      let words = he
      for (const [code, next] of [['he', he], ['en', en], ['ru', ru], ['ar', ar]]) {
        if (code !== 'he') await page.getByLabel(words['lang.label']).selectOption(code)
        words = next
        await expect(page.getByRole('heading', { name: words['login.title'] })).toBeVisible()
        for (const look of ['system', 'light', 'dark']) {
          await page.getByLabel(words['theme.label']).selectOption(look)
          expect(await noHorizontalScroll(page), `the page does not scroll sideways in ${code}, look ${look}`).toBe(true)
          for (const label of [words['theme.label'], words['lang.label']]) {
            const box = await page.getByLabel(label).boundingBox()
            expect(box.width, `${code}: the picker "${label}" is a 44 px target`).toBeGreaterThanOrEqual(44)
            expect(box.height, `${code}: the picker "${label}" is a 44 px target`).toBeGreaterThanOrEqual(44)
          }
        }
      }
    })
  }
})

test.describe('light and dark', () => {
  test.use({ colorScheme: 'dark' })

  test('follows the device by default, and the person can override it for good', async ({ page }) => {
    await page.goto('/')
    const theme = page.locator('html')
    await expect(theme).toHaveAttribute('data-theme', 'dark') // the device is dark and nothing was chosen

    await page.getByLabel(he['theme.label']).selectOption('light')
    await expect(theme).toHaveAttribute('data-theme', 'light')
    await expect(page.locator('body')).toHaveCSS('background-color', 'rgb(244, 245, 247)')

    await page.reload()
    await expect(theme).toHaveAttribute('data-theme', 'light') // remembered, though the device is still dark

    await page.getByLabel(he['theme.label']).selectOption('system')
    await expect(theme).toHaveAttribute('data-theme', 'dark') // back to following the device
  })

  test('a device that is light gives a light page with nothing chosen', async ({ page }) => {
    await page.emulateMedia({ colorScheme: 'light' })
    await page.goto('/')
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'light')
  })
})

test.describe('kept on the phone', () => {
  // The same as the sign-in: once a person changes language or light/dark it stays on their phone, also when someone
  // signs out, and nothing is saved for someone who never changed anything.
  test.use({ colorScheme: 'dark', locale: 'en-US' })

  test('nothing is saved until the person changes something', async ({ page }) => {
    await page.goto('/')
    await expect(page.getByRole('heading', { name: he['login.title'] })).toBeVisible()
    const saved = await page.evaluate(() => ({ lang: localStorage.getItem('qr.lang'), theme: localStorage.getItem('qr.theme') }))
    expect(saved).toEqual({ lang: null, theme: null })
  })

  test('language and light/dark stay after signing out, and for the next person who signs in on the phone', async ({ page }) => {
    await page.goto('/')
    await page.getByLabel(he['lang.label']).selectOption('ru')
    await page.getByLabel(ru['theme.label']).selectOption('light')
    await signIn(page, PEOPLE.ploni, ru)
    await expect(page.getByRole('heading', { name: /Здравствуйте/ })).toBeVisible()

    await page.getByRole('button', { name: ru['home.switchWorker'] }).click()
    await expect(page.getByRole('heading', { name: ru['login.title'] })).toBeVisible() // signed out, still Russian
    await expect(page.locator('html')).toHaveAttribute('lang', 'ru')
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'light')

    await page.reload()
    await expect(page.getByRole('heading', { name: ru['login.title'] })).toBeVisible()
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'light')
    const saved = await page.evaluate(() => ({ lang: localStorage.getItem('qr.lang'), theme: localStorage.getItem('qr.theme') }))
    expect(saved).toEqual({ lang: 'ru', theme: 'light' })
  })
})
