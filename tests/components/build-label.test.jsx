// @vitest-environment jsdom
// The build id on screen: the home screen of the provider app (in each of its four languages) and the Committee tab of the
// committee app. An installed phone keeps running old JavaScript for days or weeks, and this line is how the committee and
// the owner tell which version it is.
import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, cleanup, waitFor } from '@testing-library/react'
import { I18nProvider } from '../../src/i18n/index.jsx'
import { DICTS, LANGS, LANG_STORAGE_KEY } from '../../src/i18n/core.js'
import { HomeView } from '../../src/worker/components.jsx'
import CommitteeView from '../../src/admin/views/CommitteeView.jsx'
import { ToastProvider, ConfirmProvider } from '../../src/admin/ui.jsx'
import { adminApi } from '../../src/admin/api.js'

const BUILD = 'a1b2c3d'

// A unit test has no build id of its own (it is 'dev', see tests/app-build.test.js): give the screens one that looks like a commit.
vi.mock('../../src/ui/build.js', () => ({ APP_BUILD: 'a1b2c3d' }))
vi.mock('../../src/api/client.js', () => ({ api: vi.fn() }))
vi.mock('../../src/admin/api.js', async (importOriginal) => ({ ...(await importOriginal()), adminApi: vi.fn() }))

afterEach(() => {
  cleanup()
  window.localStorage.clear()
  vi.clearAllMocks()
})

const provider = { id: 'p1', contact_name: 'Dana', company: 'Cleaning Co' }
const home = (lang) => {
  window.localStorage.setItem(LANG_STORAGE_KEY, lang)
  return render(
    <I18nProvider>
      <HomeView session={{ token: 'qrp_x', provider }} visits={[]} pending={0} syncing={false} onSync={() => {}}
        notice={null} onDismissNotice={() => {}} onSwitch={() => {}} />
    </I18nProvider>,
  )
}
const line = (label) => screen.getByText(label).closest('p')

describe('the home screen of the provider app', () => {
  it.each(LANGS.map((l) => [l.code, l.dir]))('says "version" and the build id in %s (%s), the id as a left-to-right run of its own', (lang, dir) => {
    home(lang)
    const label = DICTS[lang]['app.version']
    expect(document.documentElement.dir).toBe(dir)
    expect(line(label).textContent).toBe(`${label} ${BUILD}`)
    const id = screen.getByText(BUILD)
    expect(id.tagName).toBe('BDI') // isolated from the direction of the sentence around it
    expect(id.getAttribute('dir')).toBe('ltr') // Hebrew and Arabic must not reorder or mirror it
  })

  it('has the word "version" in all four languages, each its own', () => {
    const words = LANGS.map((l) => DICTS[l.code]['app.version'])
    expect(words.every((w) => typeof w === 'string' && w.trim() !== '')).toBe(true)
    expect(new Set(words).size).toBe(4)
  })

  it('shows it once, in the foot of the screen, after the committee entry link', () => {
    home('en')
    expect(screen.getAllByText(BUILD)).toHaveLength(1)
    const p = line('Version')
    expect(p.className).toContain('w-build')
    const entry = screen.getByRole('link', { name: DICTS.en['footer.admin'] })
    expect(entry.compareDocumentPosition(p) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
  })
})

describe('the committee app', () => {
  const view = () => {
    adminApi.mockImplementation(async (path) => {
      if (path === '/admins') return { admins: [] }
      if (path === '/building') return { building: { address: '' } }
      throw new Error(`unexpected call ${path}`)
    })
    render(
      <ToastProvider>
        <ConfirmProvider>
          <CommitteeView admin={{ id: 'a1', name: 'Dana', email: 'dana@example.com' }} />
        </ConfirmProvider>
      </ToastProvider>,
    )
  }

  it('shows the build id in Hebrew at the foot of the Committee tab, the id as a left-to-right run of its own', async () => {
    view()
    await screen.findByLabelText('כתובת הבניין') // the tab has finished loading
    const label = screen.getByText('גרסה')
    expect(label.closest('p').textContent).toBe(`גרסה ${BUILD}`)
    const id = screen.getByText(BUILD)
    expect(id.tagName).toBe('BDI')
    expect(id.getAttribute('dir')).toBe('ltr')
  })

  it('is after the building card, and the word is the same Hebrew word as in the provider app', async () => {
    view()
    const field = await screen.findByLabelText('כתובת הבניין')
    const p = screen.getByText(BUILD).closest('p')
    expect(field.compareDocumentPosition(p) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    expect(p.textContent).toBe(`${DICTS.he['app.version']} ${BUILD}`)
  })

  it('shows it while the list is still loading and when the list cannot be loaded', async () => {
    adminApi.mockRejectedValue(Object.assign(new Error('offline'), { status: 0, code: 'network' }))
    render(
      <ToastProvider>
        <ConfirmProvider>
          <CommitteeView admin={{ id: 'a1' }} />
        </ConfirmProvider>
      </ToastProvider>,
    )
    expect(screen.getByText(BUILD)).toBeTruthy() // in the first render, before any answer
    await waitFor(() => expect(screen.getAllByText('נסו שוב').length).toBeGreaterThan(0))
    expect(screen.getByText(BUILD)).toBeTruthy()
  })
})
