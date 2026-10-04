import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { qrDataUrl } from './qr.js'
import { useToast } from './ui.jsx'

const LINES = [
  { lang: 'he', dir: 'rtl', text: 'סרקו את הקוד עם מצלמת הטלפון כדי לרשום נוכחות' },
  { lang: 'en', dir: 'ltr', text: 'Scan with your phone camera to check in' },
  { lang: 'ru', dir: 'ltr', text: 'Отсканируйте камерой телефона, чтобы отметиться' },
  { lang: 'ar', dir: 'rtl', text: 'امسح الرمز بكاميرا الهاتف لتسجيل الحضور' },
]

/**
 * Prints wall signs (one per point: name, QR, the instruction in four languages; no coordinates).
 * It renders into a hidden container and calls the browser's own print dialog, so there is no popup
 * for a blocker to kill. While it is mounted the app root carries `.is-printing`, which (see admin.css)
 * makes only this container visible in print; any other Ctrl+P prints the screen as usual.
 * `layout`: 'single' = one sign per A4 page, 'pair' = two per page.
 */
export default function PrintSheet({ points, layout, onDone }) {
  const toast = useToast()
  const [images, setImages] = useState(null)
  const root = useRef(null)

  useEffect(() => {
    let cancelled = false
    Promise.all(points.map((p) => qrDataUrl(p.qr_url, 900)))
      .then((urls) => !cancelled && setImages(urls))
      .catch(() => {
        if (cancelled) return
        toast.error('לא הצלחנו ליצור את קודי ה-QR להדפסה. נסו שוב.')
        onDone()
      })
    return () => {
      cancelled = true
    }
  }, [points, toast, onDone])

  // Print only once every QR image has been decoded: a fixed delay could print blank squares on a slow phone.
  useEffect(() => {
    if (!images || !root.current) return
    const app = document.querySelector('.a-app')
    let cancelled = false
    const done = () => onDone()
    const imgs = [...root.current.querySelectorAll('img')]
    const decoded = Promise.all(imgs.map((i) => i.decode().catch(() => {})))
    // Bounded: a stalled decode (a backgrounded tab) must not leave the sheet mounted forever.
    const bounded = Promise.race([decoded, new Promise((r) => setTimeout(r, 2500))])
    let safety
    bounded.then(() => {
      if (cancelled) return
      app?.classList.add('is-printing')
      window.addEventListener('afterprint', done, { once: true })
      safety = setTimeout(done, 120_000) // a browser that never reports afterprint
      setTimeout(() => window.print(), 50)
    })
    return () => {
      cancelled = true
      clearTimeout(safety)
      app?.classList.remove('is-printing')
      window.removeEventListener('afterprint', done)
    }
  }, [images, onDone])

  if (!images) return null
  return createPortal(
    <div className="a-print-only" aria-hidden="true" ref={root}>
      {points.map((p, i) => (
        <section key={p.id} className={`a-sign a-sign--${layout}`}>
          <h2>{p.name}</h2>
          <img src={images[i]} alt="" />
          <div className="a-sign__langs">
            {LINES.map((l) => (
              <p key={l.lang} lang={l.lang} dir={l.dir}>{l.text}</p>
            ))}
          </div>
        </section>
      ))}
    </div>,
    document.querySelector('.a-app') ?? document.body,
  )
}
