import {
  cloneElement, createContext, useCallback, useContext, useEffect, useId, useLayoutEffect, useMemo, useRef, useState,
} from 'react'
import { createPortal } from 'react-dom'
import { IconAlert, IconCheck, IconX } from './icons.jsx'
import { formatDay, parseDay, editDay } from '../../shared/datetime.js'

const appRoot = () => document.querySelector('.a-app') ?? document.body // portals must stay inside .a-app (design tokens)

/* ---------------------------------------------------------- icon button */

/**
 * An action shown as just its icon: the app's way of offering the secondary actions on a tile and in a page header.
 * `label` is both the accessible name and the tooltip. The icon is grey and turns the palette blue on hover, while
 * pressed and on focus; there is no frame or fill.
 *   tone "default": grey.      tone "danger": red, used only for removing something.
 *   tone "primary": a filled blue round button, the single main action of a page (adding something).
 * With `href` it is a link (a download), otherwise a button.
 */
export function IconButton({ icon: Icon, label, onClick, tone = 'default', size = 24, href, download, disabled, ...rest }) {
  const className = `a-icon-btn${tone === 'default' ? '' : ` a-icon-btn--${tone}`}`
  const icon = <Icon size={size} />
  if (href && !disabled) {
    return <a className={className} href={href} download={download} aria-label={label} title={label} {...rest}>{icon}</a>
  }
  return <button type="button" className={className} onClick={onClick} disabled={disabled} aria-label={label} title={label} {...rest}>{icon}</button>
}

/* ------------------------------------------------------------ date field */

/**
 * A date field that always reads DD/MM/YYYY, whatever the phone's region is (the browser's own date field shows the
 * device's format, and on some phones it is month first). The person types the digits and the slashes come by
 * themselves; deleting a slash deletes the digit before it, and the cursor stays by the digit it was at (editDay).
 *
 * `value` and `onChange` use 'YYYY-MM-DD', what the API takes: onChange is called only with a real date, or with '' when
 * the field is emptied, never with half a date typed digit by digit. While the text is not yet a real date the value
 * stays the last good one, so `onPendingChange(true)` tells the screen that what it shows is not what the field says
 * (the history screen holds its export back until the field is finished).
 */
export function DateInput({ value, onChange, onPendingChange, 'aria-invalid': invalid, ...rest }) {
  const [text, setText] = useState(() => (value ? formatDay(value) : ''))
  const inputRef = useRef(null)
  const caretRef = useRef(null)
  // The value can also change from outside (a reset): then the field follows it.
  useEffect(() => {
    if (parseDay(text) !== (value || null)) setText(value ? formatDay(value) : '')
    // eslint-disable-next-line react-hooks/exhaustive-deps -- run when `value` changes from outside, never when `text` changes (the person typing)
  }, [value])
  const pending = text !== '' && !parseDay(text)
  // eslint-disable-next-line react-hooks/exhaustive-deps -- fires when `pending` changes; the callers pass a new function on every render, so listing it would loop
  useEffect(() => { onPendingChange?.(pending) }, [pending])
  // After the text is re-written (slashes added or taken away) the cursor goes back by the digit it was at.
  useLayoutEffect(() => {
    const input = inputRef.current
    if (caretRef.current !== null && input && document.activeElement === input) input.setSelectionRange(caretRef.current, caretRef.current)
    caretRef.current = null
  })
  const change = (event) => {
    const input = event.target
    const next = editDay(text, input.value, input.selectionStart ?? input.value.length)
    caretRef.current = next.caret
    setText(next.text)
    if (next.text === '') onChange('')
    else if (parseDay(next.text)) onChange(parseDay(next.text))
  }
  const unfinished = text.length === 10 && !parseDay(text) // 10 characters, and still not a real date: 31/02/2026
  return (
    <input
      ref={inputRef} className="a-input a-input--date" type="text" inputMode="numeric" autoComplete="off" spellCheck="false"
      placeholder="DD/MM/YYYY" maxLength={10} dir="ltr"
      {...rest} value={text} onChange={change} aria-invalid={invalid || unfinished ? true : undefined}
    />
  )
}

/* ---------------------------------------------------------------- modal */

const FOCUSABLE = 'a[href],button:not([disabled]),input:not([disabled]),select:not([disabled]),textarea:not([disabled]),[tabindex]:not([tabindex="-1"])'

// Open dialogs, oldest first. Only the top one reacts to the keyboard, so Esc on a confirmation that sits on top
// of another dialog closes just the confirmation.
const modalStack = []

/** Accessible dialog: focus moves in and is trapped, Esc / backdrop close it, focus returns, page scroll locks. */
export function Modal({ title, onClose, children, footer, size = 'md' }) {
  const ref = useRef(null)
  const titleId = useId()
  const closeRef = useRef(onClose)
  closeRef.current = onClose

  useEffect(() => {
    const me = Symbol('modal')
    modalStack.push(me)
    const opener = document.activeElement
    const scrollLock = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    const el = ref.current
    const items = () => [...el.querySelectorAll(FOCUSABLE)]
    // Prefer the first form field over the close button.
    ;(el.querySelector('input:not([disabled]),select:not([disabled]),textarea:not([disabled])') ?? items()[1] ?? items()[0] ?? el).focus()

    const onKey = (e) => {
      if (modalStack[modalStack.length - 1] !== me) return
      if (e.key === 'Escape') {
        e.stopPropagation()
        closeRef.current()
      } else if (e.key === 'Tab') {
        const list = items()
        if (!list.length) return e.preventDefault()
        const first = list[0]
        const last = list[list.length - 1]
        const active = document.activeElement
        // Focus can sit on the dialog itself (after a click on plain text) or, in principle, outside it.
        if (!el.contains(active) || active === el) {
          e.preventDefault()
          ;(e.shiftKey ? last : first).focus()
        } else if (e.shiftKey && active === first) { e.preventDefault(); last.focus() }
        else if (!e.shiftKey && active === last) { e.preventDefault(); first.focus() }
      }
    }
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('keydown', onKey)
      modalStack.splice(modalStack.indexOf(me), 1)
      document.body.style.overflow = scrollLock
      opener?.focus?.()
    }
  }, [])

  return createPortal(
    <div className="a-overlay" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className={`a-modal a-modal--${size}`} role="dialog" aria-modal="true" aria-labelledby={titleId} ref={ref} tabIndex={-1}>
        {/* Plain <div>s, not <header> and <footer>: inside a role="dialog" (which is not sectioning content) those two
            become the page's banner and contentinfo landmarks, a second banner next to the top bar of the phone layout. */}
        <div className="a-modal__head">
          <h2 id={titleId}>{title}</h2>
          <IconButton icon={IconX} label="סגירה" onClick={onClose} />
        </div>
        <div className="a-modal__body">{children}</div>
        {footer && <div className="a-modal__foot">{footer}</div>}
      </div>
    </div>,
    appRoot(),
  )
}

/* ---------------------------------------------------------------- toast */

const ToastContext = createContext(null)

export function ToastProvider({ children }) {
  const [items, setItems] = useState([])
  const push = useCallback((text, tone = 'ok') => {
    const id = Math.random().toString(36).slice(2)
    setItems((list) => [...list, { id, text, tone }])
    setTimeout(() => setItems((list) => list.filter((i) => i.id !== id)), tone === 'error' ? 9000 : 4500)
  }, [])
  const value = useMemo(() => ({ ok: (t) => push(t, 'ok'), error: (t) => push(t, 'error') }), [push])
  return (
    <ToastContext.Provider value={value}>
      {children}
      <div className="a-toasts">
        {items.map((i) => (
          <div key={i.id} className={`a-toast a-toast--${i.tone}`} role={i.tone === 'error' ? 'alert' : 'status'}>
            {i.tone === 'error' ? <IconAlert size={20} /> : <IconCheck size={20} />}
            <span>{i.text}</span>
            <button type="button" onClick={() => setItems((list) => list.filter((x) => x.id !== i.id))} aria-label="סגירת ההודעה"><IconX size={18} /></button>
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  )
}
export const useToast = () => useContext(ToastContext)

/* -------------------------------------------------------------- confirm */

const ConfirmContext = createContext(null)

/** `await confirm({ title, body, confirmLabel, danger })` → true / false. Replaces window.confirm. */
export function ConfirmProvider({ children }) {
  const [dialog, setDialog] = useState(null)
  const confirm = useCallback((opts) => new Promise((resolve) => {
    // A second question while one is open answers the first with "no" instead of leaving it hanging forever.
    setDialog((prev) => {
      prev?.resolve(false)
      return { ...opts, resolve }
    })
  }), [])
  const close = (result) => {
    dialog.resolve(result)
    setDialog(null)
  }
  return (
    <ConfirmContext.Provider value={confirm}>
      {children}
      {dialog && (
        <Modal
          size="sm"
          title={dialog.title}
          onClose={() => close(false)}
          footer={(
            <>
              <button className="w-btn w-btn--quiet w-btn--small" onClick={() => close(false)}>ביטול</button>
              <button className={`w-btn w-btn--small${dialog.danger ? ' w-btn--danger' : ''}`} onClick={() => close(true)}>
                {dialog.confirmLabel ?? 'אישור'}
              </button>
            </>
          )}
        >
          <p className="w-lead">{dialog.body}</p>
        </Modal>
      )}
    </ConfirmContext.Provider>
  )
}
export const useConfirm = () => useContext(ConfirmContext)

/* ---------------------------------------------------------- small parts */

export function Field({ label, hint, error, children }) {
  const id = useId()
  return (
    <div className="w-field">
      <label className="w-label" htmlFor={id}>{label}</label>
      {cloneElement(children, {
        id,
        'aria-invalid': error ? true : undefined,
        'aria-describedby': [hint && `${id}-hint`, error && `${id}-err`].filter(Boolean).join(' ') || undefined,
      })}
      {hint && <p className="w-small" id={`${id}-hint`}>{hint}</p>}
      {error && <p className="w-error" id={`${id}-err`} role="alert"><IconAlert size={18} />{error}</p>}
    </div>
  )
}

export const Badge = ({ tone = 'neutral', children }) => <span className={`a-badge a-badge--${tone}`}>{children}</span>

export function Switch({ checked, onChange, label, hint, disabled }) {
  return (
    <label className={`w-switch${disabled ? ' is-disabled' : ''}`}>
      <input type="checkbox" checked={checked} disabled={disabled} onChange={(e) => onChange(e.target.checked)} />
      <span className="w-switch__text">
        <span>{label}</span>
        {hint && <span className="w-small">{hint}</span>}
      </span>
    </label>
  )
}

/** An empty list, or a list that could not load. It stands where the cards of a screen would, directly under the page's
 * <h1>, so its title is an <h2>, like the title of a card. */
export function EmptyState({ icon: Icon, title, children, action }) {
  return (
    <div className="a-empty">
      {Icon && <span className="a-empty__icon"><Icon size={30} /></span>}
      <h2 className="a-empty__title">{title}</h2>
      {children && <p className="w-lead">{children}</p>}
      {action}
    </div>
  )
}

export const Spinner = ({ label = 'טוען…' }) => (
  <div className="a-loading" role="status"><span className="w-spinner" aria-hidden="true" /><span className="w-sr">{label}</span></div>
)

/** Runs an async action with a busy flag and toast feedback, so every button behaves the same way. */
export function useAction(toast, errorText) {
  const [busy, setBusy] = useState(false)
  const run = useCallback(async (fn, okMessage) => {
    setBusy(true)
    try {
      const result = await fn()
      if (okMessage) toast.ok(okMessage)
      return result
    } catch (err) {
      toast.error(errorText(err))
      return undefined
    } finally {
      setBusy(false)
    }
  }, [toast, errorText])
  return [busy, run]
}
