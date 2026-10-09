// @vitest-environment jsdom
// The committee's Points tab: every point checks the location, and the committee no longer chooses. The form has no "location
// check" field, the pin is required, and what is saved is always `required`. A point that an older installation still holds with
// another mode shows its old mode on its tile and says in its form that it moves to `required` when it is saved. The real
// PointsView, with the network (`api`) answered by the test and the map (Leaflet, which needs a real layout) replaced by a stub that
// "clicks the map" at a fixed place.
import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, within, fireEvent, waitFor, cleanup } from '@testing-library/react'
import PointsView from '../../src/admin/views/PointsView.jsx'
import { ToastProvider, ConfirmProvider } from '../../src/admin/ui.jsx'
import { api } from '../../src/api/client.js'
import { GPS_MODE_REQUIRED, GPS_MODE_OPTIONAL, GPS_MODE_NONE, GPS_MODES, POINT_RADIUS_DEFAULT_M } from '../../shared/contract.js'
import { GPS_MODE_LABELS } from '../../src/admin/auditLabels.js'

vi.mock('../../src/api/client.js', () => ({ api: vi.fn() }))
vi.mock('../../src/admin/MapPicker.jsx', () => ({
  default: ({ onPick, hint }) => (
    <div role="application" aria-label="מפה לסימון מיקום הנקודה">
      <p>{hint}</p>
      <button type="button" onClick={() => onPick({ lat: 32.0853, lng: 34.7818 })}>סימון במפה</button>
    </div>
  ),
}))

const WAIT = { timeout: 4000 }
const NO_PIN_ERROR = 'נקודה צריכה מיקום במפה.'
const OLD_MODE_NOTE = 'בשמירה הנקודה תעבור לבדיקת מיקום חובה.'

const point = (over = {}) => ({
  id: 'p-lobby', name: 'לובי', description: null, is_active: true, gps_mode: GPS_MODE_REQUIRED, lat: 32.0853, lng: 34.7818,
  radius_m: 40, service_type: null, scan_count: 0, provider_ids: [], qr_url: 'https://example.test/scan?code=x', ...over,
})

/** The calls that wrote something (POST, PATCH, DELETE), as `[path, options]`. */
const writes = () => api.mock.calls.filter(([, options]) => options?.method && options.method !== 'GET')

async function show(points) {
  api.mockImplementation(async (path, options = {}) => {
    if (path === '/admin/points' && !options.method) return { points }
    if (path === '/admin/providers') return { providers: [] }
    if (path === '/admin/points' && options.method === 'POST') return { point: point({ ...options.body, id: 'p-new' }) }
    if (path.startsWith('/admin/points/') && options.method === 'PATCH') return { point: point({ ...options.body, id: 'p-lobby' }) }
    throw new Error(`the test does not expect ${options.method ?? 'GET'} ${path}`)
  })
  render(<ToastProvider><ConfirmProvider><PointsView /></ConfirmProvider></ToastProvider>)
  await screen.findByRole('heading', { name: 'נקודות סריקה' })
  if (points.length) await screen.findByText(points[0].name, {}, WAIT)
}
const tile = (name) => screen.getByRole('heading', { name, level: 2 }).closest('article')
const dialog = () => screen.getByRole('dialog')

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

describe('the form of a new point', () => {
  it('has no field for the location check: the map and the coordinates are always there', async () => {
    await show([])
    fireEvent.click(screen.getAllByRole('button', { name: 'נקודה חדשה' })[0])
    const form = within(dialog())

    expect(form.queryByLabelText('בדיקת מיקום')).toBeNull()
    expect(form.queryByText('בדיקת מיקום')).toBeNull()
    for (const mode of GPS_MODES) expect(form.queryByText(GPS_MODE_LABELS[mode]), mode).toBeNull() // no option, no hint that names a mode
    expect(form.queryByRole('combobox', { name: /מיקום/ })).toBeNull()
    expect(form.getByRole('application', { name: 'מפה לסימון מיקום הנקודה' })).toBeTruthy()
    for (const label of ['קו רוחב', 'קו אורך', 'רדיוס (מטרים)']) expect(form.getByLabelText(label), label).toBeTruthy()
    expect(form.getByLabelText('רדיוס (מטרים)').value).toBe(String(POINT_RADIUS_DEFAULT_M))
    expect(form.queryByText(OLD_MODE_NOTE), 'a new point has no old mode to move away from').toBeNull()
  })

  it('refuses to save without a pin on the map, says so, and sends nothing', async () => {
    await show([])
    fireEvent.click(screen.getAllByRole('button', { name: 'נקודה חדשה' })[0])
    fireEvent.change(within(dialog()).getByLabelText('שם הנקודה'), { target: { value: 'חדר מדרגות' } })
    fireEvent.click(within(dialog()).getByRole('button', { name: 'שמירה' }))

    expect(await within(dialog()).findByText(NO_PIN_ERROR)).toBeTruthy()
    expect(within(dialog()).getByLabelText('קו רוחב').getAttribute('aria-invalid')).toBe('true')
    expect(writes()).toEqual([])
  })

  it('still refuses half a pin, with the message for the pair', async () => {
    await show([])
    fireEvent.click(screen.getAllByRole('button', { name: 'נקודה חדשה' })[0])
    fireEvent.change(within(dialog()).getByLabelText('שם הנקודה'), { target: { value: 'חדר מדרגות' } })
    fireEvent.change(within(dialog()).getByLabelText('קו רוחב'), { target: { value: '32.08' } })
    fireEvent.click(within(dialog()).getByRole('button', { name: 'שמירה' }))

    expect(await within(dialog()).findByText(/גם קו רוחב וגם קו אורך/)).toBeTruthy()
    expect(writes()).toEqual([])
  })

  it('still checks the range of the coordinates and of the radius', async () => {
    await show([])
    fireEvent.click(screen.getAllByRole('button', { name: 'נקודה חדשה' })[0])
    const form = within(dialog())
    fireEvent.change(form.getByLabelText('שם הנקודה'), { target: { value: 'חדר מדרגות' } })
    fireEvent.change(form.getByLabelText('קו רוחב'), { target: { value: '95' } })
    fireEvent.change(form.getByLabelText('קו אורך'), { target: { value: '34.78' } })
    fireEvent.change(form.getByLabelText('רדיוס (מטרים)'), { target: { value: '0' } })
    fireEvent.click(form.getByRole('button', { name: 'שמירה' }))

    expect(await form.findByText(/קו רוחב חייב להיות מספר/)).toBeTruthy()
    expect(form.getByText(/רדיוס בין/)).toBeTruthy()
    expect(writes()).toEqual([])
  })

  it('saves with the pin and always sends the mode "required"', async () => {
    await show([])
    fireEvent.click(screen.getAllByRole('button', { name: 'נקודה חדשה' })[0])
    fireEvent.change(within(dialog()).getByLabelText('שם הנקודה'), { target: { value: 'חדר מדרגות' } })
    fireEvent.click(within(dialog()).getByRole('button', { name: 'סימון במפה' }))
    expect(within(dialog()).getByLabelText('קו רוחב').value).toBe('32.0853')
    fireEvent.click(within(dialog()).getByRole('button', { name: 'שמירה' }))

    await waitFor(() => expect(writes()).toHaveLength(1), WAIT)
    const [path, options] = writes()[0]
    expect([path, options.method]).toEqual(['/admin/points', 'POST'])
    expect(options.body).toEqual({
      name: 'חדר מדרגות', description: '', service_type: null, gps_mode: GPS_MODE_REQUIRED, provider_ids: [],
      lat: 32.0853, lng: 34.7818, radius_m: POINT_RADIUS_DEFAULT_M,
    })
  })
})

describe('a point that the database holds with its location check set to "required"', () => {
  it('shows no mode on its tile, and no note in its form, and saves as it is', async () => {
    await show([point({ gps_mode: GPS_MODE_REQUIRED })])
    const card = within(tile('לובי'))
    expect(card.queryByText(GPS_MODE_LABELS[GPS_MODE_REQUIRED]), 'every point is required: nothing to say').toBeNull()
    expect(card.queryByText('חסר מיקום במפה')).toBeNull()
    expect(card.getByText('פעילה')).toBeTruthy()
    expect(card.getByText('רדיוס')).toBeTruthy()

    fireEvent.click(card.getByRole('button', { name: 'עריכה' }))
    expect(within(dialog()).queryByText(OLD_MODE_NOTE)).toBeNull()
    fireEvent.click(within(dialog()).getByRole('button', { name: 'שמירה' }))
    await waitFor(() => expect(writes()).toHaveLength(1), WAIT)
    expect(writes()[0][0]).toBe('/admin/points/p-lobby')
    expect(writes()[0][1].body).toMatchObject({ gps_mode: GPS_MODE_REQUIRED, lat: 32.0853, lng: 34.7818, radius_m: 40 })
  })

  it('warns about a missing pin, and keeps the actions of the tile in their order', async () => {
    await show([point({ lat: null, lng: null })])
    const card = within(tile('לובי'))
    expect(card.getByText('חסר מיקום במפה')).toBeTruthy()
    expect(card.queryByText(GPS_MODE_LABELS[GPS_MODE_REQUIRED])).toBeNull()
    expect(card.getAllByRole('button').map((b) => b.getAttribute('aria-label') ?? b.textContent)).toEqual([
      'QR והדפסה', 'עריכה', 'השבתת הנקודה', 'מחיקת הנקודה',
    ])
  })
})

describe('a point that an older installation holds with another mode', () => {
  it.each([GPS_MODE_OPTIONAL, GPS_MODE_NONE])('shows its old mode "%s" as a warning on its tile', async (mode) => {
    await show([point({ gps_mode: mode })])
    const badge = within(tile('לובי')).getByText(GPS_MODE_LABELS[mode])
    expect(badge.className).toContain('a-badge--warn')
  })

  it('tells in its form that saving moves it to "required", and then saves it as "required"', async () => {
    await show([point({ gps_mode: GPS_MODE_OPTIONAL })])
    fireEvent.click(within(tile('לובי')).getByRole('button', { name: 'עריכה' }))
    expect(within(dialog()).getByText(OLD_MODE_NOTE)).toBeTruthy()
    expect(within(dialog()).queryByLabelText('בדיקת מיקום')).toBeNull()

    fireEvent.click(within(dialog()).getByRole('button', { name: 'שמירה' }))
    await waitFor(() => expect(writes()).toHaveLength(1), WAIT)
    expect(writes()[0][1].body.gps_mode).toBe(GPS_MODE_REQUIRED)
  })

  it('needs a pin, as every point does: a point of the mode "none" with no coordinates cannot be saved without one', async () => {
    await show([point({ gps_mode: GPS_MODE_NONE, lat: null, lng: null })])
    const card = within(tile('לובי'))
    expect(card.getByText(GPS_MODE_LABELS[GPS_MODE_NONE])).toBeTruthy()
    expect(card.getByText('חסר מיקום במפה'), 'a pin is missing whatever the old mode was').toBeTruthy()

    fireEvent.click(card.getByRole('button', { name: 'עריכה' }))
    expect(within(dialog()).getByText(OLD_MODE_NOTE)).toBeTruthy()
    fireEvent.click(within(dialog()).getByRole('button', { name: 'שמירה' }))
    expect(await within(dialog()).findByText(NO_PIN_ERROR)).toBeTruthy()
    expect(writes()).toEqual([])

    fireEvent.click(within(dialog()).getByRole('button', { name: 'סימון במפה' }))
    fireEvent.click(within(dialog()).getByRole('button', { name: 'שמירה' }))
    await waitFor(() => expect(writes()).toHaveLength(1), WAIT)
    expect(writes()[0][1].body).toMatchObject({ gps_mode: GPS_MODE_REQUIRED, lat: 32.0853, lng: 34.7818 })
  })
})
