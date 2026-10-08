import { useEffect, useRef } from 'react'
import L from 'leaflet'
import 'leaflet/dist/leaflet.css' // bundled with the committee app only (the provider app never loads it)
import markerIconUrl from 'leaflet/dist/images/marker-icon.png'
import markerIcon2xUrl from 'leaflet/dist/images/marker-icon-2x.png'
import markerShadowUrl from 'leaflet/dist/images/marker-shadow.png'
import { POINT_RADIUS_DEFAULT_M } from '../../shared/contract.js'

// Leaflet's default marker images do not survive bundling (it guesses their address from the stylesheet's URL), so point
// them at the PNGs of the leaflet package: Vite bundles them (each is under 4 KB, so they are inlined as data: URLs in
// the committee chunk). The markers work offline, the page loads nothing from cdnjs, and a Content-Security-Policy later
// needs no entry for it.
delete L.Icon.Default.prototype._getIconUrl
L.Icon.Default.mergeOptions({
  iconRetinaUrl: markerIcon2xUrl,
  iconUrl: markerIconUrl,
  shadowUrl: markerShadowUrl,
})

const FALLBACK_CENTER = [32.0853, 34.7818]

// The check-in circle is drawn by Leaflet, not CSS: take its colour from the theme's focus colour.
const ringColor = (el) => (el && getComputedStyle(el).getPropertyValue('--w-focus').trim()) || '#7cc0ff'

/**
 * Click the map to place a point. The map is created once and updated in place: (unlike the old version)
 * typing in a coordinate field no longer snaps the view back or cancels the user's panning.
 * Shows the check-in radius as a circle, since that is what the coordinates are for.
 */
export default function MapPicker({ lat, lng, radius, onPick, hint }) {
  const box = useRef(null)
  const state = useRef({})
  const pick = useRef(onPick)
  pick.current = onPick

  useEffect(() => {
    const has = Number.isFinite(lat) && Number.isFinite(lng)
    // No "Leaflet" prefix link, and the OSM credit opens in a new tab: a mis-tap on a phone must not leave the
    // page and throw away a half-filled form.
    const map = L.map(box.current, { scrollWheelZoom: false, attributionControl: false }).setView(has ? [lat, lng] : FALLBACK_CENTER, has ? 18 : 13)
    L.control.attribution({ prefix: false }).addTo(map)
    L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
      maxZoom: 19,
      attribution: '&copy; <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener noreferrer">OpenStreetMap</a>',
    }).addTo(map)
    map.on('click', (e) => pick.current({ lat: e.latlng.lat, lng: e.latlng.lng }))
    state.current = { map, marker: null, circle: null }
    // Switching light/dark while the map is open: recolour the circle.
    const recolour = () => state.current.circle?.setStyle({ color: ringColor(box.current) })
    window.addEventListener('qr-theme-change', recolour)
    // The dialog is still animating in when this runs: recompute the map size afterwards.
    const t = setTimeout(() => map.invalidateSize(), 120)
    return () => {
      window.removeEventListener('qr-theme-change', recolour)
      clearTimeout(t)
      map.remove()
      state.current = {}
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- the map is made once: lat and lng only set its first view, the next effect follows them
  }, [])

  useEffect(() => {
    const { map } = state.current
    if (!map) return
    const has = Number.isFinite(lat) && Number.isFinite(lng)
    if (!has) {
      state.current.marker?.remove()
      state.current.circle?.remove()
      state.current.marker = state.current.circle = null
      return
    }
    const at = [lat, lng]
    if (state.current.marker) state.current.marker.setLatLng(at)
    else state.current.marker = L.marker(at).addTo(map)
    const r = Number.isFinite(radius) ? radius : POINT_RADIUS_DEFAULT_M
    if (state.current.circle) state.current.circle.setLatLng(at).setRadius(r)
    else state.current.circle = L.circle(at, { radius: r, color: ringColor(box.current), weight: 2, fillOpacity: 0.12 }).addTo(map)
    if (!map.getBounds().contains(at)) map.setView(at) // only recentre when the point left the view
  }, [lat, lng, radius])

  return (
    <div>
      <div className="a-map" ref={box} role="application" aria-label="מפה לסימון מיקום הנקודה" />
      {hint && <p className="w-small" style={{ marginBlockStart: 6 }}>{hint}</p>}
    </div>
  )
}
