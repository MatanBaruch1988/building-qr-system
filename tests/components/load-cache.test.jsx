// @vitest-environment jsdom
// The committee app keeps the last answer of each of its loads in memory (src/admin/loadCache.js), so that a tab that is opened again
// draws it at once and asks the server for the current answer in the background. What this file proves:
//   - `useLoad` with a cache key: a mount that finds an answer starts ready with it and then takes the fresh one; another key does not
//     reuse it; `clearLoadCache` empties it; a failure after cached data keeps the data; `reload()` stores its answer; an answer asked
//     for before the cache was emptied is never stored; a key that changes while mounted is another list; without a key nothing is kept;
//   - the History tab and the audit log keep the first page of each set of filters, and a different filter never shows another's rows;
//   - the real AdminApp: switching back to a tab shows its list with no loading state, a card that was edited in the meantime is not
//     overwritten by the answer that follows, and whatever the way the committee member leaves (signing out, the server ending the
//     session), the next member's first visit of a tab loads from the beginning.
import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, fireEvent, waitFor, cleanup, act } from '@testing-library/react'
import { useLoad, clearLoadCache, setLoadCache, LOAD_KEY } from '../../src/admin/hooks.js'
import { dropLoadCache, loadCacheEpoch, readLoadCache, writeLoadCache } from '../../src/admin/loadCache.js'
import AdminApp from '../../src/pages/AdminApp.jsx'
import HistoryView from '../../src/admin/views/HistoryView.jsx'
import AuditView from '../../src/admin/views/AuditView.jsx'
import { ToastProvider, ConfirmProvider } from '../../src/admin/ui.jsx'
import { api } from '../../src/api/client.js'

vi.mock('../../src/api/client.js', () => ({ api: vi.fn() }))

window.scrollTo = vi.fn() // the shell scrolls to the top on a tab change; jsdom has no scrolling

afterEach(() => {
  cleanup()
  window.history.replaceState(null, '', '/')
  document.title = ''
  vi.clearAllMocks()
})

/** A promise that the test settles by hand: the server's answer that has not come yet. */
function later() {
  let resolve
  let reject
  const promise = new Promise((res, rej) => { resolve = res; reject = rej })
  return { promise, resolve, reject }
}

const refusal = (status, code) => Object.assign(new Error('refused'), { status, code })

// ---- useLoad ---------------------------------------------------------------------------------------------------------------------

/** Draws what `useLoad` says, as text, with a button for `reload`. */
function Probe({ fn, cacheKey, deps }) {
  const { status, data, error, reload } = useLoad(fn, deps, cacheKey === undefined ? undefined : { cacheKey })
  return (
    <div>
      <p>status: {status}</p>
      <p>data: {data ?? 'none'}</p>
      <p>error: {error ? error.message : 'none'}</p>
      <button onClick={reload}>reload</button>
    </div>
  )
}
const answer = (value) => () => Promise.resolve(value)

describe('useLoad with a cache key', () => {
  it('starts a second mount ready with the first answer, and then takes the fresh one', async () => {
    const first = render(<Probe fn={answer('one')} cacheKey="list" />)
    expect(screen.getByText('status: loading')).toBeTruthy() // the first visit has the loading state, as ever
    await screen.findByText('data: one')
    first.unmount()

    const server = later()
    render(<Probe fn={() => server.promise} cacheKey="list" />)
    // before the server has answered
    expect(screen.getByText('status: ready')).toBeTruthy()
    expect(screen.getByText('data: one')).toBeTruthy()
    server.resolve('two')
    await screen.findByText('data: two')
    expect(screen.getByText('status: ready')).toBeTruthy()
  })

  it('asks the server on every mount, cached or not', async () => {
    const fn = vi.fn(answer('one'))
    const first = render(<Probe fn={fn} cacheKey="list" />)
    await screen.findByText('data: one')
    first.unmount()
    render(<Probe fn={fn} cacheKey="list" />)
    await waitFor(() => expect(fn).toHaveBeenCalledTimes(2))
  })

  it('does not give the data of one key to another', async () => {
    const first = render(<Probe fn={answer('one')} cacheKey="list" />)
    await screen.findByText('data: one')
    first.unmount()

    const server = later()
    render(<Probe fn={() => server.promise} cacheKey="other list" />)
    expect(screen.getByText('status: loading')).toBeTruthy()
    expect(screen.getByText('data: none')).toBeTruthy()
    server.resolve('three')
    await screen.findByText('data: three')
  })

  it('keeps nothing without a key: every mount starts loading', async () => {
    const first = render(<Probe fn={answer('one')} />)
    await screen.findByText('data: one')
    first.unmount()
    render(<Probe fn={() => later().promise} />)
    expect(screen.getByText('status: loading')).toBeTruthy()
    expect(screen.getByText('data: none')).toBeTruthy()
  })

  it('is emptied by clearLoadCache: the next mount starts loading', async () => {
    const first = render(<Probe fn={answer('one')} cacheKey="list" />)
    await screen.findByText('data: one')
    first.unmount()
    clearLoadCache()
    render(<Probe fn={() => later().promise} cacheKey="list" />)
    expect(screen.getByText('status: loading')).toBeTruthy()
    expect(screen.getByText('data: none')).toBeTruthy()
  })

  it('keeps the cached data when the fresh request fails, and says error', async () => {
    const first = render(<Probe fn={answer('one')} cacheKey="list" />)
    await screen.findByText('data: one')
    first.unmount()

    render(<Probe fn={() => Promise.reject(new Error('boom'))} cacheKey="list" />)
    await screen.findByText('status: error')
    expect(screen.getByText('data: one')).toBeTruthy()
    expect(screen.getByText('error: boom')).toBeTruthy()
  })

  it('has the error state with no data when the first request fails, as it did before', async () => {
    render(<Probe fn={() => Promise.reject(new Error('boom'))} cacheKey="list" />)
    await screen.findByText('status: error')
    expect(screen.getByText('data: none')).toBeTruthy()
  })

  it('does not store a failure: after one, the next mount still starts loading', async () => {
    const first = render(<Probe fn={() => Promise.reject(new Error('boom'))} cacheKey="list" />)
    await screen.findByText('status: error')
    first.unmount()
    render(<Probe fn={() => later().promise} cacheKey="list" />)
    expect(screen.getByText('status: loading')).toBeTruthy()
  })

  it('stores the answer of reload(), so the next mount draws the new one', async () => {
    let value = 'one'
    const first = render(<Probe fn={() => Promise.resolve(value)} cacheKey="list" />)
    await screen.findByText('data: one')
    value = 'edited'
    fireEvent.click(screen.getByRole('button', { name: 'reload' }))
    await screen.findByText('data: edited')
    first.unmount()

    render(<Probe fn={() => later().promise} cacheKey="list" />)
    expect(screen.getByText('data: edited')).toBeTruthy()
  })

  it('keeps the data on screen while reload() is on its way, as it did before', async () => {
    let next = Promise.resolve('one')
    render(<Probe fn={() => next} cacheKey="list" />)
    await screen.findByText('data: one')
    const second = later()
    next = second.promise
    fireEvent.click(screen.getByRole('button', { name: 'reload' }))
    expect(screen.getByText('status: ready')).toBeTruthy()
    expect(screen.getByText('data: one')).toBeTruthy()
    second.resolve('two')
    await screen.findByText('data: two')
  })

  it('stores an answer that comes after the screen has gone, for the next one', async () => {
    const server = later()
    const first = render(<Probe fn={() => server.promise} cacheKey="list" />)
    first.unmount()
    await act(async () => { server.resolve('late') })
    render(<Probe fn={() => later().promise} cacheKey="list" />)
    expect(screen.getByText('data: late')).toBeTruthy()
  })

  it('never stores an answer that was asked for before the cache was emptied (it may be another member\'s)', async () => {
    const server = later()
    const first = render(<Probe fn={() => server.promise} cacheKey="list" />)
    clearLoadCache()
    first.unmount()
    await act(async () => { server.resolve('the member who left') })
    render(<Probe fn={() => later().promise} cacheKey="list" />)
    expect(screen.getByText('status: loading')).toBeTruthy()
    expect(screen.getByText('data: none')).toBeTruthy()
  })

  it('treats a key that changes while mounted as another list, and drops a late answer of the old key', async () => {
    const seed = render(<Probe fn={answer('b one')} cacheKey="b" />)
    await screen.findByText('data: b one')
    seed.unmount()

    const a = later()
    const view = render(<Probe fn={() => a.promise} cacheKey="a" />)
    const b = later()
    view.rerender(<Probe fn={() => b.promise} cacheKey="b" />)
    // "b" was kept: it is drawn at once, and the answer of "a", which comes late, is not drawn under it
    expect(screen.getByText('data: b one')).toBeTruthy()
    await act(async () => { a.resolve('a late') })
    expect(screen.queryByText('data: a late')).toBeNull()
    b.resolve('b two')
    await screen.findByText('data: b two')

    // and a key that was never kept starts from the loading state, whatever was on screen before
    view.rerender(<Probe fn={() => later().promise} cacheKey="c" />)
    expect(screen.getByText('status: loading')).toBeTruthy()
    expect(screen.getByText('data: none')).toBeTruthy()
  })

  it('loads again when the deps change, as before', async () => {
    const fn = vi.fn(answer('one'))
    const view = render(<Probe fn={fn} deps={[1]} cacheKey="list" />)
    await screen.findByText('data: one')
    view.rerender(<Probe fn={fn} deps={[2]} cacheKey="list" />)
    await waitFor(() => expect(fn).toHaveBeenCalledTimes(2))
  })
})

describe('the cache itself', () => {
  it('forgets the entries of a prefix, and only those', () => {
    const asked = loadCacheEpoch()
    writeLoadCache('history:scans:a', 1, asked)
    writeLoadCache('history:refusals:b', 2, asked)
    writeLoadCache('points', 3, asked)
    dropLoadCache('history:')
    expect(readLoadCache('history:scans:a')).toBeUndefined()
    expect(readLoadCache('history:refusals:b')).toBeUndefined()
    expect(readLoadCache('points')).toBe(3)
  })

  it('keeps a bounded number of entries, the oldest going first', () => {
    const asked = loadCacheEpoch()
    for (let i = 0; i < 100; i++) writeLoadCache(`key ${i}`, i, asked)
    expect(readLoadCache('key 0')).toBeUndefined()
    expect(readLoadCache('key 99')).toBe(99)
  })

  it('does not store undefined, which means that nothing is stored', () => {
    setLoadCache(LOAD_KEY.points, undefined)
    expect(readLoadCache(LOAD_KEY.points)).toBeUndefined()
    setLoadCache(LOAD_KEY.points, { points: [] })
    expect(readLoadCache(LOAD_KEY.points)).toEqual({ points: [] })
  })
})

// ---- History and the audit log ---------------------------------------------------------------------------------------------------

const WAIT = { timeout: 4000 } // the pause before a query is 350 ms
const POINT = { id: '11111111-1111-4111-8111-111111111111', name: 'לובי' }
const PROVIDER = { id: '33333333-3333-4333-8333-333333333333', company: 'ניקיון', contact_name: 'פלוני' }
const scanOf = (id, who) => ({
  id, local_date: '2026-10-05', checked_in_at: '2026-10-05T06:00:00Z', point_id: POINT.id, point_name: POINT.name,
  provider_id: PROVIDER.id, provider_name: who, outcome: 'accepted', source: 'online', distance_m: null, flags: [], voided: false, void_reason: null,
})
const loadingNow = () => screen.queryByText('טוען…')

describe('the History tab', () => {
  const show = () => render(<ToastProvider><ConfirmProvider><HistoryView /></ConfirmProvider></ToastProvider>)
  /** `scans(searchParams)` answers the list of scans, the rest is fixed. */
  function server(scans) {
    api.mockImplementation(async (path) => {
      if (path === '/admin/points') return { points: [POINT] }
      if (path === '/admin/providers') return { providers: [PROVIDER] }
      if (path.startsWith('/admin/scans')) return scans(new URL(path, 'http://x').searchParams)
      throw new Error(`the test does not expect ${path}`)
    })
  }

  it('draws the rows of the last visit at once, with no loading state, and then the fresh ones', async () => {
    server(() => ({ scans: [scanOf('s1', 'נותן ישן')], next_cursor: null }))
    const first = show()
    expect(loadingNow()).not.toBeNull() // the first visit has the loading state
    await screen.findByText('נותן ישן', {}, WAIT)
    first.unmount()

    const fresh = later()
    server(() => fresh.promise)
    show()
    expect(screen.getByText('נותן ישן')).toBeTruthy()
    expect(loadingNow()).toBeNull() // the lists of the filters (points, providers) were kept too
    fresh.resolve({ scans: [scanOf('s2', 'נותן חדש')], next_cursor: null })
    await screen.findByText('נותן חדש', {}, WAIT)
    expect(screen.queryByText('נותן ישן')).toBeNull()
  })

  it('never shows the rows of another filter: a different set of filters starts from the loading state', async () => {
    server((params) => ({ scans: [scanOf(params.get('outcome') === 'all' ? 's-all' : 's-accepted', params.get('outcome') === 'all' ? 'נותן הכול' : 'נותן נרשם')], next_cursor: null }))
    const first = show()
    await screen.findByText('נותן נרשם', {}, WAIT)
    // the filter changes: a pause, then the request for the new one, which has not answered
    const all = later()
    server((params) => (params.get('outcome') === 'all' ? all.promise : { scans: [scanOf('s-accepted', 'נותן נרשם')], next_cursor: null }))
    fireEvent.change(screen.getByLabelText('סוג'), { target: { value: 'all' } })
    await waitFor(() => expect(screen.queryByText('נותן נרשם')).toBeNull(), WAIT)
    expect(loadingNow()).not.toBeNull()
    all.resolve({ scans: [scanOf('s-all', 'נותן הכול')], next_cursor: null })
    await screen.findByText('נותן הכול', {}, WAIT)
    first.unmount()

    // a new visit starts on the default filters: it draws their rows, not the ones of the filter that was open last
    const fresh = later()
    server(() => fresh.promise)
    show()
    expect(screen.getByText('נותן נרשם')).toBeTruthy()
    expect(screen.queryByText('נותן הכול')).toBeNull()
  })

  it('goes to the loading state, as it did before, when the refresh button is pressed', async () => {
    server(() => ({ scans: [scanOf('s1', 'נותן ישן')], next_cursor: null }))
    const first = show()
    await screen.findByText('נותן ישן', {}, WAIT)
    first.unmount()

    const fresh = later()
    server(() => fresh.promise)
    show()
    expect(screen.getByText('נותן ישן')).toBeTruthy()
    const refresh = later()
    server(() => refresh.promise)
    fireEvent.click(screen.getByRole('button', { name: 'רענון' }))
    await waitFor(() => expect(screen.queryByText('נותן ישן')).toBeNull())
    expect(loadingNow()).not.toBeNull()
    refresh.resolve({ scans: [scanOf('s3', 'נותן מרענון')], next_cursor: null })
    await screen.findByText('נותן מרענון', {}, WAIT)
  })

  it('keeps the rows of the last visit, and says so, when the fresh request fails', async () => {
    server(() => ({ scans: [scanOf('s1', 'נותן ישן')], next_cursor: null }))
    const first = show()
    await screen.findByText('נותן ישן', {}, WAIT)
    first.unmount()

    server(() => { throw refusal(0, 'network') })
    show()
    expect(await screen.findByText('אין חיבור לשרת. נסו שוב.', {}, WAIT)).toBeTruthy() // the toast
    expect(screen.getByText('נותן ישן')).toBeTruthy()
    expect(screen.queryByRole('heading', { level: 2, name: 'לא הצלחנו לטעון' })).toBeNull()
  })

  it('shows nothing from the cache to the next visit after the cache was emptied', async () => {
    server(() => ({ scans: [scanOf('s1', 'נותן ישן')], next_cursor: null }))
    const first = show()
    await screen.findByText('נותן ישן', {}, WAIT)
    first.unmount()
    clearLoadCache()

    server(() => later().promise)
    show()
    expect(screen.queryByText('נותן ישן')).toBeNull()
    expect(loadingNow()).not.toBeNull()
  })

  it('keeps a first page of its own for the visits that were not counted', async () => {
    const refusalOf = (who) => ({
      id: 7, at: '2026-10-05T07:00:00.000Z', scan_id: null, source: 'online', code: 'point_inactive', provider_id: PROVIDER.id,
      provider_name: who, point_id: POINT.id, point_name: POINT.name, client_time: null,
    })
    api.mockImplementation(async (path) => {
      if (path === '/admin/points') return { points: [POINT] }
      if (path === '/admin/providers') return { providers: [PROVIDER] }
      if (path.startsWith('/admin/scan-refusals')) return { refusals: [refusalOf('ביקור שלא נקלט')], next_cursor: null }
      if (path.startsWith('/admin/scans')) return { scans: [scanOf('s1', 'נותן נרשם')], next_cursor: null }
      throw new Error(`the test does not expect ${path}`)
    })
    const first = show()
    await screen.findByText('נותן נרשם', {}, WAIT)
    fireEvent.change(screen.getByLabelText('סוג'), { target: { value: 'not_counted' } })
    await screen.findByText('ביקור שלא נקלט', {}, WAIT)
    first.unmount()

    // a new visit starts on the scans: the refusals of the other filter are not shown there
    api.mockImplementation(() => later().promise)
    show()
    expect(screen.getByText('נותן נרשם')).toBeTruthy()
    expect(screen.queryByText('ביקור שלא נקלט')).toBeNull()
  })
})

describe('the audit log', () => {
  const entryOf = (id, name) => ({
    id, at: '2026-10-05T07:14:00.000Z', action: 'point.update', entity: 'point', entity_id: POINT.id, entity_name: name,
    actor_type: 'admin', actor_id: '22222222-2222-4222-8222-222222222222', actor_name: 'דנה לוי', actor_deleted: false, detail: null,
  })
  const show = () => render(<ToastProvider><ConfirmProvider><AuditView /></ConfirmProvider></ToastProvider>)
  function server(audit) {
    api.mockImplementation(async (path) => {
      if (path === '/admin/admins') return { admins: [] }
      if (path.startsWith('/admin/audit')) return audit(new URL(path, 'http://x').searchParams)
      throw new Error(`the test does not expect ${path}`)
    })
  }

  it('draws the entries of the last time it was open at once, then the fresh ones, and starts loading for another filter', async () => {
    server(() => ({ entries: [entryOf(1, 'נקודה ישנה')], next_cursor: null }))
    const first = show()
    expect(loadingNow()).not.toBeNull()
    await screen.findByText('נקודה ישנה', {}, WAIT)
    first.unmount()

    const fresh = later()
    server(() => fresh.promise)
    show()
    expect(screen.getByText('נקודה ישנה')).toBeTruthy()
    expect(loadingNow()).toBeNull()
    fresh.resolve({ entries: [entryOf(2, 'נקודה חדשה')], next_cursor: null })
    await screen.findByText('נקודה חדשה', {}, WAIT)
    expect(screen.queryByText('נקודה ישנה')).toBeNull()

    // another set of filters: nothing of the first one stays under it
    const point = later()
    server((params) => (params.get('group') === 'point' ? point.promise : fresh.promise))
    fireEvent.change(screen.getByLabelText('סוג פעולה'), { target: { value: 'point' } })
    await waitFor(() => expect(screen.queryByText('נקודה חדשה')).toBeNull(), WAIT)
    expect(loadingNow()).not.toBeNull()
  })
})

// ---- the whole committee app -----------------------------------------------------------------------------------------------------

const ADMIN = { id: '00000000-0000-4000-8000-0000000000a1', name: 'Sample Member', email: 'member@example.test' }
const OTHER_ADMIN = { id: '00000000-0000-4000-8000-0000000000b2', name: 'Other Member', email: 'other@example.test' }
const NAV = { points: 'נקודות', providers: 'ספקים', history: 'היסטוריה', agent: 'אייג׳נט', committee: 'ועד' }

/** What the server has now. A test changes it. `held` is the next GET of a path that the test keeps waiting. */
const app = { signedIn: true, who: ADMIN, signInAs: ADMIN, points: [], providers: [], building: { address: '', name: '' }, held: new Map() }
const pointNamed = (name) => ({
  id: `p-${name}`, name, description: null, is_active: true, gps_mode: 'none', lat: null, lng: null, radius_m: 50, service_type: null,
  scan_count: 0, provider_ids: [], qr_url: 'https://example.test/scan?code=x',
})

function answerLikeTheServer() {
  Object.assign(app, { signedIn: true, who: ADMIN, signInAs: ADMIN, points: [], providers: [], building: { address: '', name: '' }, held: new Map() })
  const reply = (path) => {
    if (path === '/admin/config') return { google_client_id: '', dev_login: true }
    if (path === '/admin/me') {
      if (!app.signedIn) throw refusal(401, 'admin_required')
      return { admin: app.who }
    }
    if (path === '/admin/dev-login') {
      app.signedIn = true
      app.who = app.signInAs
      return { admin: app.who }
    }
    if (path === '/admin/logout') {
      app.signedIn = false
      return { ok: true }
    }
    if (path === '/public/building') return { building: { address: '', name: '' } }
    if (path === '/admin/points') return { points: app.points }
    if (path === '/admin/providers') return { providers: app.providers }
    if (path === '/admin/building') return { building: { ...app.building } }
    if (path.startsWith('/admin/scans')) return { scans: [], next_cursor: null }
    if (path === '/admin/api-keys') return { api_keys: [] }
    if (path === '/admin/admins') return { admins: [] }
    if (path === '/admin/client-errors') return { ok: true, recorded: 0 }
    throw new Error(`the test does not expect ${path}`)
  }
  api.mockImplementation(async (path, options = {}) => {
    const body = reply(path) // what the server has when the request reaches it
    const gate = options.method ? undefined : app.held.get(path)
    if (gate) {
      app.held.delete(path)
      await gate.promise // ... and the answer comes when the test lets it
    }
    return body
  })
}
/** Keeps the next GET of `path` waiting until the returned function is called. */
function hold(path) {
  const gate = later()
  app.held.set(path, gate)
  return () => gate.resolve()
}

const goTo = async (tab) => {
  fireEvent.click(screen.getAllByRole('button', { name: NAV[tab] })[0])
  await waitFor(() => expect(window.location.hash).toBe(`#${tab}`))
  await screen.findByRole('heading', { level: 1, name: { points: 'נקודות סריקה', providers: 'נותני שירות', history: 'היסטוריית נוכחות', agent: "גישה לאייג'נט", committee: 'חברי הוועד' }[tab] })
}
const signOut = () => fireEvent.click(screen.getAllByRole('button', { name: 'יציאה' })[0])
const devSignIn = async () => fireEvent.click(await screen.findByRole('button', { name: 'כניסת פיתוח' }))

describe('the committee app', () => {
  it('shows a tab that was open before with its list at once and no loading state, and the first visit of a tab loads as ever', async () => {
    answerLikeTheServer()
    app.points = [pointNamed('לובי')]
    window.history.replaceState(null, '', '/admin#points')
    render(<AdminApp />)
    await screen.findByRole('heading', { level: 2, name: 'לובי' })
    expect(screen.queryByText('טוען…')).toBeNull()

    // the first visit of the Agent tab (the Providers tab shares its list with Points, so it is not a first visit): its loading state
    const keys = hold('/admin/api-keys')
    await goTo('agent')
    expect(screen.getByText('טוען…')).toBeTruthy()
    keys()
    await waitFor(() => expect(screen.queryByText('טוען…')).toBeNull())

    // back to Points: the list is there before the server answers, and the new answer replaces it
    const points = hold('/admin/points')
    app.points = [pointNamed('חדר אופניים')]
    await goTo('points')
    expect(screen.getByRole('heading', { level: 2, name: 'לובי' })).toBeTruthy()
    expect(screen.queryByText('טוען…')).toBeNull()
    points()
    await screen.findByRole('heading', { level: 2, name: 'חדר אופניים' })
    expect(screen.queryByRole('heading', { level: 2, name: 'לובי' })).toBeNull()
  })

  it('draws the building card from the last visit, and an answer that comes while the person types keeps what they typed', async () => {
    answerLikeTheServer()
    app.building = { address: 'רחוב הדוגמה 1', name: 'בניין הדוגמה' }
    window.history.replaceState(null, '', '/admin#committee')
    render(<AdminApp />)
    const address = await screen.findByLabelText('כתובת הבניין', { exact: true })
    await waitFor(() => expect(address.value).toBe('רחוב הדוגמה 1'))
    await goTo('points')

    const building = hold('/admin/building')
    app.building = { address: 'רחוב הדוגמה 2', name: 'בניין הדוגמה' }
    await goTo('committee')
    const again = screen.getByLabelText('כתובת הבניין', { exact: true })
    expect(again.value).toBe('רחוב הדוגמה 1') // the last visit's value, before the server has answered
    expect(screen.getByLabelText('שם הבניין', { exact: true }).value).toBe('בניין הדוגמה')
    fireEvent.change(screen.getByLabelText('שם הבניין', { exact: true }), { target: { value: 'שם שהוקלד' } })
    building()
    // the address was not touched by the person: it takes the new answer; the name, which was typed, stays
    await waitFor(() => expect(screen.getByLabelText('כתובת הבניין', { exact: true }).value).toBe('רחוב הדוגמה 2'))
    expect(screen.getByLabelText('שם הבניין', { exact: true }).value).toBe('שם שהוקלד')
  })

  it('loads every tab from the beginning for the next member after a sign-out', async () => {
    answerLikeTheServer()
    app.points = [pointNamed('לובי של הראשון')]
    window.history.replaceState(null, '', '/admin#points')
    render(<AdminApp />)
    await screen.findByRole('heading', { level: 2, name: 'לובי של הראשון' })

    signOut()
    await screen.findByRole('button', { name: 'כניסת פיתוח' }) // the sign-in screen: nothing of the member who left is kept
    expect(readLoadCache(LOAD_KEY.points)).toBeUndefined()
    // a different member signs in on this computer, and the server has other points for them
    app.points = [pointNamed('לובי של השני')]
    app.signInAs = OTHER_ADMIN
    const points = hold('/admin/points')
    await devSignIn()
    await screen.findByRole('heading', { level: 1, name: 'נקודות סריקה' })
    expect(screen.queryByRole('heading', { level: 2, name: 'לובי של הראשון' })).toBeNull()
    expect(screen.getByText('טוען…')).toBeTruthy()
    points()
    await screen.findByRole('heading', { level: 2, name: 'לובי של השני' })
  })

  it('does the same when the server ends the session', async () => {
    answerLikeTheServer()
    app.points = [pointNamed('לובי של הראשון')]
    window.history.replaceState(null, '', '/admin#points')
    render(<AdminApp />)
    await screen.findByRole('heading', { level: 2, name: 'לובי של הראשון' })

    app.signedIn = false
    await act(async () => { window.dispatchEvent(new Event('admin-session-expired')) })
    await screen.findByText('פג תוקף ההתחברות. היכנסו שוב.')
    expect(readLoadCache(LOAD_KEY.points)).toBeUndefined() // nothing of the member whose session ended is kept
    app.points = [pointNamed('לובי של השני')]
    app.signInAs = OTHER_ADMIN
    const points = hold('/admin/points')
    await devSignIn()
    await screen.findByRole('heading', { level: 1, name: 'נקודות סריקה' })
    expect(screen.queryByRole('heading', { level: 2, name: 'לובי של הראשון' })).toBeNull()
    expect(screen.getByText('טוען…')).toBeTruthy()
    points()
    await screen.findByRole('heading', { level: 2, name: 'לובי של השני' })
  })

  it('does not let a request that was on its way when the member left fill the cache for the next one', async () => {
    answerLikeTheServer()
    app.points = [pointNamed('לובי של הראשון')]
    window.history.replaceState(null, '', '/admin#providers')
    render(<AdminApp />)
    await screen.findByRole('heading', { level: 1, name: 'נותני שירות' })
    const late = hold('/admin/points')
    await goTo('history') // the list of points of the filter is asked for, and the first member's answer is held back
    signOut()
    app.points = [pointNamed('לובי של השני')]
    app.signInAs = OTHER_ADMIN
    await devSignIn() // the hash still says History: the second member's request is answered at once
    await waitFor(() => expect(readLoadCache(LOAD_KEY.points)?.points.map((p) => p.name)).toEqual(['לובי של השני']))
    await act(async () => { late() }) // now the first member's answer arrives, after the second's
    expect(readLoadCache(LOAD_KEY.points).points.map((p) => p.name)).toEqual(['לובי של השני'])
  })
})
