import React, { useEffect, useRef } from 'react'

function Modal({ show, onClose, title, children, footer }) {
  const modalRef = useRef(null)
  const previousFocusRef = useRef(null)
  const onCloseRef = useRef(onClose)

  // Sync ref on every render — without causing effect re-runs
  useEffect(() => { onCloseRef.current = onClose })

  // Effect 1: open/close lifecycle — runs only when `show` changes
  useEffect(() => {
    if (!show) return

    // Save currently focused element
    previousFocusRef.current = document.activeElement

    const timer = setTimeout(() => {
      if (modalRef.current) {
        // Focus first INPUT (not the × button)
        const firstInput = modalRef.current.querySelector('input, select, textarea')
        const firstFocusable = modalRef.current.querySelector(
          'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])'
        )
        ;(firstInput || firstFocusable)?.focus()
      }
    }, 50)

    return () => {
      clearTimeout(timer)
      // Restore focus to element that was focused before modal opened
      previousFocusRef.current?.focus()
    }
  }, [show]) // NO onClose dependency

  // Effect 2: keyboard handler — runs only when `show` changes
  useEffect(() => {
    if (!show) return

    const handleKeyDown = (e) => {
      if (e.key === 'Escape') {
        onCloseRef.current()
        return
      }

      // Focus trapping
      if (e.key === 'Tab' && modalRef.current) {
        const focusableElements = modalRef.current.querySelectorAll(
          'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])'
        )
        const firstElement = focusableElements[0]
        const lastElement = focusableElements[focusableElements.length - 1]

        if (e.shiftKey && document.activeElement === firstElement) {
          e.preventDefault()
          lastElement.focus()
        } else if (!e.shiftKey && document.activeElement === lastElement) {
          e.preventDefault()
          firstElement.focus()
        }
      }
    }

    document.addEventListener('keydown', handleKeyDown)
    return () => document.removeEventListener('keydown', handleKeyDown)
  }, [show]) // NO onClose dependency

  if (!show) return null

  return (
    <div className="modal-overlay" onClick={onClose} role="dialog" aria-modal="true" aria-labelledby="modal-title">
      <div className="modal" onClick={e => e.stopPropagation()} ref={modalRef}>
        <div className="modal-header">
          <h3 id="modal-title">{title}</h3>
          <button className="modal-close" onClick={onClose} aria-label="סגור">&times;</button>
        </div>
        <div className="modal-body">
          {children}
        </div>
        {footer && (
          <div className="modal-footer">
            {footer}
          </div>
        )}
      </div>
    </div>
  )
}

export default Modal
