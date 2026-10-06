// @vitest-environment jsdom
// The building's name and address in the header of the provider app: the name is a line of its own above the address, each is
// shown when the committee set it and absent (no empty line) when not, and both are kept on the phone so that they are there on
// the first paint and with no signal. A value that an older version of the app saved (the address alone) is still read.
import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, waitFor, cleanup, act } from '@testing-library/react'
import { I18nProvider } from '../../src/i18n/index.jsx'
import { TopBar } from '../../src/worker/components.jsx'
import { useBuilding } from '../../src/worker/hooks.js'
import { getCachedBuilding, setCachedBuilding, parseBuilding } from '../../src/worker/buildingCache.js'
import he from '../../src/i18n/he.js'
import en from '../../src/i18n/en.js'
import { api } from '../../src/api/client.js'

vi.mock('../../src/api/client.js', () => ({ api: vi.fn() }))

const KEY = 'qr.building.v1'
const ADDRESS = 'רחוב הדוגמה 1, עיר לדוגמה'
const NAME = 'בניין הדוגמה'

afterEach(() => {
  cleanup()
  window.localStorage.clear()
  document.title = ''
  vi.resetAllMocks()
})

// What WorkerApp and WorkerShell do: ask once, hand the answer to the header.
function Header() {
  const building = useBuilding()
  return <TopBar name={building.name} address={building.address} />
}
const bar = (ui) => render(<I18nProvider>{ui}</I18nProvider>)
const lines = () => [...screen.getByRole('banner').querySelectorAll('p')]
const line = () => lines()[0] ?? null
const never = () => new Promise(() => {})
// Lets the answer (or the failure) of the mocked request reach the component before the test looks.
const settled = () => act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)) })
const saved = () => JSON.parse(window.localStorage.getItem(KEY))

describe('TopBar', () => {
  it('shows the address the committee typed, as typed, and lets each script lay itself out', () => {
    bar(<TopBar address={ADDRESS} />)
    expect(screen.getByText(ADDRESS)).toBeTruthy()
    expect(line().textContent).toBe(ADDRESS)
    expect(line().getAttribute('dir')).toBe('auto')
  })

  it('shows an address in another language the same way', () => {
    bar(<TopBar address="Example Street 5, Sample Town" />)
    expect(line().textContent).toBe('Example Street 5, Sample Town')
  })

  it('shows the name as a line of its own above the address, each as typed and each laying itself out', () => {
    bar(<TopBar name={NAME} address={ADDRESS} />)
    expect(lines().map((p) => p.textContent)).toEqual([NAME, ADDRESS])
    expect(lines().map((p) => p.getAttribute('dir'))).toEqual(['auto', 'auto'])
    // the name is the title of the header and the address is the quieter line under it
    expect(lines()[0].className).toBe('w-brand')
    expect(lines()[1].className).toContain('w-brand--sub')
  })

  it('shows the name alone, and an address alone as the title it always was', () => {
    bar(<TopBar name="Sample Tower" />)
    expect(lines().map((p) => p.textContent)).toEqual(['Sample Tower'])
    cleanup()
    bar(<TopBar address={ADDRESS} />)
    expect(lines().map((p) => p.className)).toEqual(['w-brand']) // no name: the address is not demoted
  })

  it('has no line at all when there is neither a name nor an address: no empty paragraph', () => {
    for (const props of [{}, { name: '', address: '' }, { name: undefined, address: undefined }]) {
      bar(<TopBar {...props} />)
      expect(lines(), JSON.stringify(props)).toHaveLength(0)
      expect(screen.getByRole('banner').querySelector('.w-brandbox'), JSON.stringify(props)).toBeNull()
      cleanup()
    }
  })

  it('has no address line when there is a name and no address, and no name line when there is an address and no name', () => {
    for (const address of [undefined, '']) {
      bar(<TopBar address={address} name={NAME} />)
      expect(lines().map((p) => p.textContent), JSON.stringify(address)).toEqual([NAME])
      cleanup()
    }
    for (const name of [undefined, '']) {
      bar(<TopBar name={name} address={ADDRESS} />)
      expect(lines().map((p) => p.textContent), JSON.stringify(name)).toEqual([ADDRESS])
      cleanup()
    }
  })

  it('keeps the language and light/dark pickers with or without the name and the address', () => {
    for (const props of [{}, { address: ADDRESS }, { name: NAME }, { name: NAME, address: ADDRESS }]) {
      bar(<TopBar {...props} />)
      expect(screen.getByLabelText(he['lang.label'], { selector: 'select' }), JSON.stringify(props)).toBeTruthy()
      expect(screen.getByLabelText(he['theme.label'], { selector: 'select' }), JSON.stringify(props)).toBeTruthy()
      cleanup()
    }
  })

  it('has no name or address of its own: nothing from the translations', () => {
    bar(<TopBar />)
    expect(Object.keys(he).filter((key) => key.startsWith('brand.'))).toEqual([])
    expect(line()).toBeNull()
  })
})

describe('the name and the address on the phone', () => {
  it('shows the saved name and address on the first paint, before the network has answered', () => {
    window.localStorage.setItem(KEY, JSON.stringify({ address: ADDRESS, name: NAME }))
    api.mockReturnValue(never())
    bar(<Header />)
    expect(lines().map((p) => p.textContent)).toEqual([NAME, ADDRESS]) // no waiting: they are in the first render
    expect(api).toHaveBeenCalledWith('/public/building', expect.objectContaining({ timeoutMs: 8000 }))
    expect(api).toHaveBeenCalledTimes(1)
  })

  it('shows nothing on the very first visit, until the answer comes, then shows it and saves it', async () => {
    let answer
    api.mockReturnValue(new Promise((resolve) => (answer = resolve)))
    bar(<Header />)
    expect(line()).toBeNull()
    expect(window.localStorage.getItem(KEY)).toBeNull()

    answer({ building: { address: ADDRESS, name: NAME } })
    expect(await screen.findByText(NAME)).toBeTruthy()
    expect(lines().map((p) => p.textContent)).toEqual([NAME, ADDRESS])
    expect(saved()).toEqual({ address: ADDRESS, name: NAME })
  })

  it('reads a value that an older version saved (the address alone) as an address with no name, and keeps showing it', () => {
    window.localStorage.setItem(KEY, JSON.stringify({ address: ADDRESS }))
    expect(getCachedBuilding()).toEqual({ address: ADDRESS, name: '' })
    api.mockReturnValue(never())
    bar(<Header />)
    expect(lines().map((p) => p.textContent)).toEqual([ADDRESS]) // no name line, and no crash
  })

  it('takes a name that arrives for a phone that saved only the address, and saves both', async () => {
    window.localStorage.setItem(KEY, JSON.stringify({ address: ADDRESS }))
    api.mockResolvedValue({ building: { address: ADDRESS, name: NAME } })
    bar(<Header />)
    expect(await screen.findByText(NAME)).toBeTruthy()
    expect(lines().map((p) => p.textContent)).toEqual([NAME, ADDRESS])
    expect(saved()).toEqual({ address: ADDRESS, name: NAME })
  })

  it('replaces the saved name and address with the new ones', async () => {
    window.localStorage.setItem(KEY, JSON.stringify({ address: 'כתובת ישנה 1', name: 'שם ישן' }))
    api.mockResolvedValue({ building: { address: ADDRESS, name: NAME } })
    bar(<Header />)
    expect(await screen.findByText(NAME)).toBeTruthy()
    expect(screen.queryByText('כתובת ישנה 1')).toBeNull()
    expect(screen.queryByText('שם ישן')).toBeNull()
    expect(getCachedBuilding()).toEqual({ address: ADDRESS, name: NAME })
  })

  it('removes the address line, and forgets the address, when the committee has cleared it, and the name stays', async () => {
    window.localStorage.setItem(KEY, JSON.stringify({ address: ADDRESS, name: NAME }))
    api.mockResolvedValue({ building: { address: '', name: NAME } })
    bar(<Header />)
    expect(screen.getByText(ADDRESS)).toBeTruthy() // the saved one first
    await waitFor(() => expect(screen.queryByText(ADDRESS)).toBeNull())
    expect(lines().map((p) => p.textContent)).toEqual([NAME])
    expect(saved()).toEqual({ address: '', name: NAME })
  })

  it('removes the name line, and forgets the name, when the committee has cleared it, and the address is the title again', async () => {
    window.localStorage.setItem(KEY, JSON.stringify({ address: ADDRESS, name: NAME }))
    api.mockResolvedValue({ building: { address: ADDRESS, name: '' } })
    bar(<Header />)
    expect(screen.getByText(NAME)).toBeTruthy()
    await waitFor(() => expect(screen.queryByText(NAME)).toBeNull())
    expect(lines().map((p) => p.className)).toEqual(['w-brand'])
    expect(saved()).toEqual({ address: ADDRESS, name: '' })
  })

  it('treats an answer with no name at all (a server from before names existed) as no name', async () => {
    window.localStorage.setItem(KEY, JSON.stringify({ address: ADDRESS, name: NAME }))
    api.mockResolvedValue({ building: { address: ADDRESS } })
    bar(<Header />)
    await waitFor(() => expect(screen.queryByText(NAME)).toBeNull())
    expect(lines().map((p) => p.textContent)).toEqual([ADDRESS])
    expect(saved()).toEqual({ address: ADDRESS, name: '' })
  })

  it('keeps the saved name and address when there is no signal or the server hiccups', async () => {
    window.localStorage.setItem(KEY, JSON.stringify({ address: ADDRESS, name: NAME }))
    for (const failure of [
      Object.assign(new Error('offline'), { status: 0, code: 'network' }),
      Object.assign(new Error('boom'), { status: 500, code: 'server_error' }),
    ]) {
      api.mockRejectedValue(failure)
      bar(<Header />)
      await waitFor(() => expect(api).toHaveBeenCalled())
      await settled()
      expect(lines().map((p) => p.textContent), failure.code).toEqual([NAME, ADDRESS])
      expect(getCachedBuilding(), failure.code).toEqual({ address: ADDRESS, name: NAME })
      cleanup()
      api.mockClear()
    }
  })

  it('keeps the saved name and address when the answer is not the one we expect', async () => {
    window.localStorage.setItem(KEY, JSON.stringify({ address: ADDRESS, name: NAME }))
    const answers = [
      {}, { building: null }, { building: {} }, { building: { address: 5 } },
      { building: { address: ADDRESS, name: 5 } }, { building: { address: ADDRESS, name: null } }, null,
    ]
    for (const answer of answers) {
      api.mockResolvedValue(answer)
      bar(<Header />)
      await waitFor(() => expect(api).toHaveBeenCalled())
      await settled()
      expect(lines().map((p) => p.textContent), JSON.stringify(answer)).toEqual([NAME, ADDRESS])
      expect(getCachedBuilding(), JSON.stringify(answer)).toEqual({ address: ADDRESS, name: NAME })
      cleanup()
      api.mockClear()
    }
  })

  it('asks once when the app starts, not on every render', async () => {
    api.mockResolvedValue({ building: { address: ADDRESS, name: NAME } })
    const view = bar(<Header />)
    await screen.findByText(ADDRESS)
    view.rerender(<I18nProvider><Header /></I18nProvider>)
    expect(api).toHaveBeenCalledTimes(1)
  })
})

describe('the saved building', () => {
  const fake = () => {
    const items = new Map()
    return {
      getItem: (key) => (items.has(key) ? items.get(key) : null),
      setItem: (key, value) => void items.set(key, value),
    }
  }

  it('is stored under the same key with a version as before, as { address, name }', () => {
    const storage = fake()
    setCachedBuilding({ address: ADDRESS, name: NAME }, storage)
    expect(JSON.parse(storage.getItem('qr.building.v1'))).toEqual({ address: ADDRESS, name: NAME })
    expect(getCachedBuilding(storage)).toEqual({ address: ADDRESS, name: NAME })
  })

  it('stores an empty name and an empty address too: the phone must follow a committee that cleared them', () => {
    const storage = fake()
    setCachedBuilding({ address: '', name: '' }, storage)
    expect(JSON.parse(storage.getItem('qr.building.v1'))).toEqual({ address: '', name: '' })
  })

  it("reads a value saved before names existed (the address alone) as an address with the name ''", () => {
    const storage = fake()
    storage.setItem('qr.building.v1', JSON.stringify({ address: ADDRESS }))
    expect(getCachedBuilding(storage)).toEqual({ address: ADDRESS, name: '' })
  })

  it('is empty when nothing was saved, or what was saved is not ours', () => {
    expect(getCachedBuilding(fake())).toEqual({ address: '', name: '' })
    for (const junk of ['not json', '{', 'null', '[]', '{"address":5}', '{"address":null}', '"text"', '{}', '{"name":5}', '{"name":null,"address":null}']) {
      const storage = fake()
      storage.setItem('qr.building.v1', junk)
      expect(getCachedBuilding(storage), junk).toEqual({ address: '', name: '' })
    }
  })

  it('keeps the half that is text when the other half is not', () => {
    for (const [value, expected] of [
      ['{"address":"A","name":5}', { address: 'A', name: '' }],
      ['{"address":5,"name":"N"}', { address: '', name: 'N' }],
    ]) {
      const storage = fake()
      storage.setItem('qr.building.v1', value)
      expect(getCachedBuilding(storage), value).toEqual(expected)
    }
  })

  it('is read with no error when the phone refuses to store things', () => {
    const refusing = { getItem: () => { throw new Error('blocked') }, setItem: () => { throw new Error('blocked') } }
    expect(getCachedBuilding(refusing)).toEqual({ address: '', name: '' })
  })
})

describe('what the server answered', () => {
  it('is the address and the name, when both are text', () => {
    expect(parseBuilding({ address: ADDRESS, name: NAME })).toEqual({ address: ADDRESS, name: NAME })
    expect(parseBuilding({ address: '', name: '' })).toEqual({ address: '', name: '' })
  })

  it('is no name when the answer has none, and is not ours when a text is not text', () => {
    expect(parseBuilding({ address: ADDRESS })).toEqual({ address: ADDRESS, name: '' })
    for (const bad of [undefined, null, 'text', 5, {}, { name: NAME }, { address: 5 }, { address: ADDRESS, name: 5 }, { address: ADDRESS, name: null }]) {
      expect(parseBuilding(bad), JSON.stringify(bad)).toBeNull()
    }
  })
})

describe('the title of the window', () => {
  it("starts with the building's name and then the name of the app, and follows a name that arrives or is cleared", () => {
    const view = render(<I18nProvider buildingName={NAME}><p>x</p></I18nProvider>)
    expect(document.title).toBe(`${NAME} · ${he['app.name']}`)
    // the name arrives after the first paint: the title follows
    view.rerender(<I18nProvider buildingName="Sample Tower"><p>x</p></I18nProvider>)
    expect(document.title).toBe(`Sample Tower · ${he['app.name']}`)
    // and a cleared name takes it away
    view.rerender(<I18nProvider buildingName=""><p>x</p></I18nProvider>)
    expect(document.title).toBe(he['app.name'])
  })

  it('is the name of the app alone when there is no name, as before', () => {
    render(<I18nProvider><p>x</p></I18nProvider>)
    expect(document.title).toBe(he['app.name'])
  })

  it('follows the language: the name is data and stays, the name of the app is translated', () => {
    window.localStorage.setItem('qr.lang', 'en')
    render(<I18nProvider buildingName={NAME}><p>x</p></I18nProvider>)
    expect(document.title).toBe(`${NAME} · ${en['app.name']}`)
  })
})
