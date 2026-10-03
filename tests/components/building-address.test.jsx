// @vitest-environment jsdom
// The building's address in the header of the provider app: shown when the committee set one, absent (no empty line) when
// not, and kept on the phone so that it is there on the first paint and with no signal.
import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, waitFor, cleanup, act } from '@testing-library/react'
import { I18nProvider } from '../../src/i18n/index.jsx'
import { TopBar } from '../../src/worker/components.jsx'
import { useBuildingAddress } from '../../src/worker/hooks.js'
import { getCachedAddress, setCachedAddress } from '../../src/worker/buildingCache.js'
import he from '../../src/i18n/he.js'
import { api } from '../../src/api/client.js'

vi.mock('../../src/api/client.js', () => ({ api: vi.fn() }))

const KEY = 'qr.building.v1'
const ADDRESS = 'רחוב הדוגמה 1, עיר לדוגמה'

afterEach(() => {
  cleanup()
  window.localStorage.clear()
  vi.resetAllMocks()
})

// What WorkerShell does: ask once, hand the answer to the header.
function Header() {
  const address = useBuildingAddress()
  return <TopBar address={address} />
}
const bar = (ui) => render(<I18nProvider>{ui}</I18nProvider>)
const line = () => screen.getByRole('banner').querySelector('p')
const never = () => new Promise(() => {})
// Lets the answer (or the failure) of the mocked request reach the component before the test looks.
const settled = () => act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)) })

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

  it('has no address line at all when there is none: no empty paragraph', () => {
    for (const address of [undefined, '']) {
      bar(<TopBar address={address} />)
      expect(line(), JSON.stringify(address)).toBeNull()
      expect(screen.getByRole('banner').textContent.trim(), JSON.stringify(address)).not.toBe(ADDRESS)
      cleanup()
    }
  })

  it('keeps the language and light/dark pickers with or without the address', () => {
    for (const address of ['', ADDRESS]) {
      bar(<TopBar address={address} />)
      expect(screen.getByLabelText(he['lang.label'], { selector: 'select' }), JSON.stringify(address)).toBeTruthy()
      expect(screen.getByLabelText(he['theme.label'], { selector: 'select' }), JSON.stringify(address)).toBeTruthy()
      cleanup()
    }
  })

  it('has no address of its own: nothing from the translations', () => {
    bar(<TopBar />)
    expect(Object.keys(he).filter((key) => key.startsWith('brand.'))).toEqual([])
    expect(line()).toBeNull()
  })
})

describe('the address on the phone', () => {
  it('shows the saved address on the first paint, before the network has answered', () => {
    window.localStorage.setItem(KEY, JSON.stringify({ address: ADDRESS }))
    api.mockReturnValue(never())
    bar(<Header />)
    expect(screen.getByText(ADDRESS)).toBeTruthy() // no waiting: it is in the first render
    expect(api).toHaveBeenCalledWith('/public/building', expect.objectContaining({ timeoutMs: 8000 }))
    expect(api).toHaveBeenCalledTimes(1)
  })

  it('shows nothing on the very first visit, until the answer comes, then shows it and saves it', async () => {
    let answer
    api.mockReturnValue(new Promise((resolve) => (answer = resolve)))
    bar(<Header />)
    expect(line()).toBeNull()
    expect(window.localStorage.getItem(KEY)).toBeNull()

    answer({ building: { address: ADDRESS } })
    expect(await screen.findByText(ADDRESS)).toBeTruthy()
    expect(JSON.parse(window.localStorage.getItem(KEY))).toEqual({ address: ADDRESS })
  })

  it('replaces the saved address with the new one', async () => {
    window.localStorage.setItem(KEY, JSON.stringify({ address: 'כתובת ישנה 1' }))
    api.mockResolvedValue({ building: { address: ADDRESS } })
    bar(<Header />)
    expect(await screen.findByText(ADDRESS)).toBeTruthy()
    expect(screen.queryByText('כתובת ישנה 1')).toBeNull()
    expect(getCachedAddress()).toBe(ADDRESS)
  })

  it('removes the line, and forgets the address, when the committee has cleared it', async () => {
    window.localStorage.setItem(KEY, JSON.stringify({ address: ADDRESS }))
    api.mockResolvedValue({ building: { address: '' } })
    bar(<Header />)
    expect(screen.getByText(ADDRESS)).toBeTruthy() // the saved one first
    await waitFor(() => expect(line()).toBeNull())
    expect(JSON.parse(window.localStorage.getItem(KEY))).toEqual({ address: '' })
  })

  it('keeps the saved address when there is no signal or the server hiccups', async () => {
    window.localStorage.setItem(KEY, JSON.stringify({ address: ADDRESS }))
    for (const failure of [
      Object.assign(new Error('offline'), { status: 0, code: 'network' }),
      Object.assign(new Error('boom'), { status: 500, code: 'server_error' }),
    ]) {
      api.mockRejectedValue(failure)
      bar(<Header />)
      await waitFor(() => expect(api).toHaveBeenCalled())
      await settled()
      expect(screen.getByText(ADDRESS), failure.code).toBeTruthy()
      expect(getCachedAddress(), failure.code).toBe(ADDRESS)
      cleanup()
      api.mockClear()
    }
  })

  it('keeps the saved address when the answer is not the one we expect', async () => {
    window.localStorage.setItem(KEY, JSON.stringify({ address: ADDRESS }))
    for (const answer of [{}, { building: null }, { building: {} }, { building: { address: 5 } }, null]) {
      api.mockResolvedValue(answer)
      bar(<Header />)
      await waitFor(() => expect(api).toHaveBeenCalled())
      await settled()
      expect(screen.getByText(ADDRESS), JSON.stringify(answer)).toBeTruthy()
      expect(getCachedAddress(), JSON.stringify(answer)).toBe(ADDRESS)
      cleanup()
      api.mockClear()
    }
  })

  it('asks once when the app starts, not on every render', async () => {
    api.mockResolvedValue({ building: { address: ADDRESS } })
    const view = bar(<Header />)
    await screen.findByText(ADDRESS)
    view.rerender(<I18nProvider><Header /></I18nProvider>)
    expect(api).toHaveBeenCalledTimes(1)
  })
})

describe('the saved address', () => {
  const fake = () => {
    const items = new Map()
    return {
      getItem: (key) => (items.has(key) ? items.get(key) : null),
      setItem: (key, value) => void items.set(key, value),
    }
  }

  it('is stored under a key with a version, as { address }', () => {
    const storage = fake()
    setCachedAddress(ADDRESS, storage)
    expect(JSON.parse(storage.getItem('qr.building.v1'))).toEqual({ address: ADDRESS })
    expect(getCachedAddress(storage)).toBe(ADDRESS)
  })

  it('is empty when nothing was saved, or what was saved is not ours', () => {
    expect(getCachedAddress(fake())).toBe('')
    for (const junk of ['not json', '{', 'null', '[]', '{"address":5}', '{"address":null}', '"text"', '{}']) {
      const storage = fake()
      storage.setItem('qr.building.v1', junk)
      expect(getCachedAddress(storage), junk).toBe('')
    }
  })

  it('is read with no error when the phone refuses to store things', () => {
    const refusing = { getItem: () => { throw new Error('blocked') }, setItem: () => { throw new Error('blocked') } }
    expect(getCachedAddress(refusing)).toBe('')
  })
})
