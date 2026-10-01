// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, fireEvent, cleanup } from '@testing-library/react'
import { IconButton } from '../../src/admin/ui.jsx'
import { IconEdit, IconTrash, IconPlus } from '../../src/admin/icons.jsx'

afterEach(cleanup)

describe('IconButton', () => {
  it('is found by its label, which is also its tooltip, and shows nothing but the icon', () => {
    render(<IconButton icon={IconEdit} label="עריכה" onClick={() => {}} />)
    const button = screen.getByRole('button', { name: 'עריכה' })
    expect(button).toHaveProperty('title', 'עריכה')
    expect(button.textContent).toBe('')
    expect(button.querySelector('svg')).not.toBeNull()
  })

  it('calls its handler once per click', () => {
    const onClick = vi.fn()
    render(<IconButton icon={IconEdit} label="עריכה" onClick={onClick} />)
    fireEvent.click(screen.getByRole('button', { name: 'עריכה' }))
    expect(onClick).toHaveBeenCalledTimes(1)
  })

  it('does nothing while disabled', () => {
    const onClick = vi.fn()
    render(<IconButton icon={IconTrash} label="מחיקה" onClick={onClick} disabled />)
    const button = screen.getByRole('button', { name: 'מחיקה' })
    expect(button.disabled).toBe(true)
    fireEvent.click(button)
    expect(onClick).not.toHaveBeenCalled()
  })

  it('is a link when given an address (a download), still named by its label', () => {
    render(<IconButton icon={IconEdit} label="ייצוא ל-Excel" href="/api/admin/scans?format=csv" download="scans.csv" />)
    const link = screen.getByRole('link', { name: 'ייצוא ל-Excel' })
    expect(link.getAttribute('href')).toBe('/api/admin/scans?format=csv')
    expect(link.getAttribute('download')).toBe('scans.csv')
  })

  it('has a grey default, a red danger tone and a filled primary tone', () => {
    render(
      <>
        <IconButton icon={IconEdit} label="a" />
        <IconButton icon={IconTrash} label="b" tone="danger" />
        <IconButton icon={IconPlus} label="c" tone="primary" />
      </>,
    )
    expect(screen.getByRole('button', { name: 'a' }).className).toBe('a-icon-btn')
    expect(screen.getByRole('button', { name: 'b' }).className).toBe('a-icon-btn a-icon-btn--danger')
    expect(screen.getByRole('button', { name: 'c' }).className).toBe('a-icon-btn a-icon-btn--primary')
  })

  it('never submits a form by accident', () => {
    render(<IconButton icon={IconEdit} label="עריכה" />)
    expect(screen.getByRole('button', { name: 'עריכה' }).getAttribute('type')).toBe('button')
  })
})
