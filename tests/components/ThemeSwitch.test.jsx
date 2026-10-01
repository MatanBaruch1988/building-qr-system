// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent, cleanup, act } from '@testing-library/react'
import ThemeSwitch, { HEBREW_THEME_LABELS } from '../../src/ui/ThemeSwitch.jsx'
import { THEME_KEY, setTheme } from '../../src/ui/theme.js'

// The theme store lives at module level (one per page), so each test starts from "follow the device"
beforeEach(() => act(() => setTheme('system')))
afterEach(() => {
  cleanup()
  window.localStorage.clear()
  delete document.documentElement.dataset.theme
})

const picker = () => screen.getByRole('combobox', { name: HEBREW_THEME_LABELS.label })

describe('ThemeSwitch', () => {
  it('is one picker named after the label, offering follow-the-device, light and dark', () => {
    render(<ThemeSwitch labels={HEBREW_THEME_LABELS} />)
    const options = [...picker().querySelectorAll('option')].map((option) => [option.value, option.textContent])
    expect(options).toEqual([
      ['system', HEBREW_THEME_LABELS.system],
      ['light', HEBREW_THEME_LABELS.light],
      ['dark', HEBREW_THEME_LABELS.dark],
    ])
    expect(picker().value).toBe('system')
  })

  it('applies a choice to the page and remembers it', () => {
    render(<ThemeSwitch labels={HEBREW_THEME_LABELS} />)

    fireEvent.change(picker(), { target: { value: 'light' } })
    expect(document.documentElement.dataset.theme).toBe('light')
    expect(window.localStorage.getItem(THEME_KEY)).toBe('light')
    expect(picker().value).toBe('light')

    fireEvent.change(picker(), { target: { value: 'dark' } })
    expect(document.documentElement.dataset.theme).toBe('dark')
    expect(window.localStorage.getItem(THEME_KEY)).toBe('dark')
  })

  it('shows the icon of the current mode, so the mode can be read without opening the picker', () => {
    const { container } = render(<ThemeSwitch labels={HEBREW_THEME_LABELS} />)
    const seen = new Set()
    for (const value of ['system', 'light', 'dark']) {
      fireEvent.change(picker(), { target: { value } })
      seen.add(container.querySelector('svg').innerHTML)
    }
    expect(seen.size).toBe(3)
  })

  it('keeps the icon out of the accessibility tree: the picker is named by its label alone', () => {
    const { container } = render(<ThemeSwitch labels={HEBREW_THEME_LABELS} />)
    expect(container.querySelector('svg').getAttribute('aria-hidden')).toBe('true')
  })

  it('uses the labels it is given (the provider app passes translated ones)', () => {
    const labels = { label: 'Display mode', system: 'Device', light: 'Light', dark: 'Dark' }
    render(<ThemeSwitch labels={labels} />)
    expect(screen.getByRole('combobox', { name: 'Display mode' })).toBeTruthy()
    expect(screen.getByRole('option', { name: 'Dark' })).toBeTruthy()
  })
})
