import React from 'react'
import { THEMES, useTheme } from './theme.js'
import { translate } from '../i18n/core.js'

/** The committee screens are Hebrew-only: their labels come from the same dictionary as the provider app's. */
export const HEBREW_THEME_LABELS = Object.fromEntries(['label', 'system', 'light', 'dark'].map((k) => [k, translate('he', `theme.${k}`)]))

// The same pattern as the language picker: a native <select> (so the phone's own picker opens), here dressed as an
// icon that shows the current mode. Used by the provider app (translated labels) and the committee app (Hebrew).

const Svg = ({ size = 22, children }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"
    strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false">
    {children}
  </svg>
)

const ICONS = {
  light: (p) => (
    <Svg {...p}>
      <circle cx="12" cy="12" r="4" />
      <path d="M12 2.5v2.2M12 19.3v2.2M2.5 12h2.2M19.3 12h2.2M5.3 5.3l1.6 1.6M17.1 17.1l1.6 1.6M18.7 5.3l-1.6 1.6M6.9 17.1l-1.6 1.6" />
    </Svg>
  ),
  dark: (p) => (
    <Svg {...p}><path d="M20.5 14.2A8.5 8.5 0 0 1 9.8 3.5a8.5 8.5 0 1 0 10.7 10.7z" /></Svg>
  ),
  system: (p) => (
    <Svg {...p}>
      <circle cx="12" cy="12" r="8.5" />
      <path d="M12 3.5v17a8.5 8.5 0 0 0 0-17z" fill="currentColor" stroke="none" />
    </Svg>
  ),
}

/**
 * labels: { label, system, light, dark } (already translated). Only the icon of the current mode, on a 44px touch
 * target: the same on a phone and on a computer, in both apps.
 */
export default function ThemeSwitch({ labels }) {
  const { theme, setTheme } = useTheme()
  const Icon = ICONS[theme]
  return (
    <label className="w-theme w-theme--bare">
      <Icon size={24} />
      {/* blur: after a choice the picker must not stay "focused", or the icon would stay blue */}
      <select value={theme} onChange={(e) => { setTheme(e.target.value); e.target.blur() }} aria-label={labels.label}>
        {THEMES.map((value) => <option key={value} value={value}>{labels[value]}</option>)}
      </select>
    </label>
  )
}
