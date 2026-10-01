import React, { useCallback, useState } from 'react'
import { adminApi, errorText, copyText } from '../api.js'
import { useLoad, SERVICE_TYPES, serviceLabel } from '../hooks.js'
import { Modal, Field, Badge, Switch, EmptyState, Spinner, useToast, useConfirm, useAction } from '../ui.jsx'
import { downloadDataUrl, safeFileName, useQrImage } from '../qr.js'
import MapPicker from '../MapPicker.jsx'
import PrintSheet from '../PrintSheet.jsx'
import { IconPlus, IconEdit, IconQr, IconPrinter, IconDownload, IconCopy, IconRefresh, IconLocate, IconPin, IconAlert } from '../icons.jsx'

const GPS = {
  required: { label: 'מיקום חובה', hint: 'לנקודות עם קליטה: חובה להיות בתוך הרדיוס של הנקודה (בתוספת 15 מטר לדיוק הסיכה ולסטיית ה-GPS של הטלפון). בלי מיקום תקין הנוכחות לא נרשמת.' },
  optional: { label: 'מיקום אם אפשר', hint: 'ברירת המחדל. אם יש מיקום הוא נבדק, ואם אין קליטה הנוכחות נרשמת ומסומנת "מיקום לא מאומת".' },
  none: { label: 'בלי מיקום', hint: 'למרתפים וחדרים בלי קליטה: המיקום לא נבדק בכלל.' },
}

const EMPTY = { name: '', description: '', service_type: '', gps_mode: 'optional', lat: '', lng: '', radius_m: '50', provider_ids: [], is_active: true }
const fromPoint = (p) => ({
  name: p.name, description: p.description ?? '', service_type: p.service_type ?? '', gps_mode: p.gps_mode,
  lat: p.lat ?? '', lng: p.lng ?? '', radius_m: String(p.radius_m), provider_ids: p.provider_ids, is_active: p.is_active,
})

/* ------------------------------------------------------------ edit form */

function PointForm({ point, providers, onClose, onSaved }) {
  const toast = useToast()
  const [form, setForm] = useState(point ? fromPoint(point) : EMPTY)
  const [errors, setErrors] = useState({})
  const [busy, run] = useAction(toast, errorText)
  // Editing either coordinate clears both messages (one rule covers the pair).
  const set = (k, v) => {
    setForm((f) => ({ ...f, [k]: v }))
    setErrors((e) => ({ ...e, [k]: undefined, ...(k === 'lat' || k === 'lng' ? { lat: undefined, lng: undefined } : {}) }))
  }

  // Blank (or only spaces) means "no coordinate". Number(' ') would be 0, which is a real place in the ocean.
  const coord = (v) => (String(v ?? '').trim() === '' ? null : Number(String(v).trim()))
  const lat = coord(form.lat)
  const lng = coord(form.lng)
  const radius = Number(String(form.radius_m).trim() || NaN)
  const usesLocation = form.gps_mode !== 'none' // with "no location" the map and its fields are hidden: do not check them
  // The demo account may scan every point, so it has no place in a per-point list.
  const assignable = providers.filter((p) => !p.is_demo)
  const hasDemo = assignable.length !== providers.length

  const locate = () => {
    if (!navigator.geolocation) return toast.error('הדפדפן לא תומך במיקום.')
    navigator.geolocation.getCurrentPosition(
      (p) => { set('lat', +p.coords.latitude.toFixed(6)); set('lng', +p.coords.longitude.toFixed(6)) },
      () => toast.error('לא הצלחנו לקבל את המיקום שלכם. אשרו גישה למיקום או סמנו במפה.'),
      { enableHighAccuracy: true, timeout: 10_000 },
    )
  }

  const submit = async (e) => {
    e.preventDefault()
    const next = {}
    if (!form.name.trim()) next.name = 'צריך שם לנקודה.'
    if (usesLocation) {
      if ((lat === null) !== (lng === null)) next[lat === null ? 'lat' : 'lng'] = 'יש להזין גם קו רוחב וגם קו אורך, או להשאיר את שניהם ריקים.'
      else if (form.gps_mode === 'required' && lat === null) next.lat = 'נקודה שמחייבת מיקום צריכה מיקום במפה.'
      if (lat !== null && !(Number.isFinite(lat) && lat >= -90 && lat <= 90)) next.lat = 'קו רוחב חייב להיות מספר בין -90 ל-90.'
      if (lng !== null && !(Number.isFinite(lng) && lng >= -180 && lng <= 180)) next.lng = 'קו אורך חייב להיות מספר בין -180 ל-180.'
      if (!Number.isInteger(radius) || radius < 1 || radius > 1000) next.radius_m = 'רדיוס בין 1 ל-1000 מטר.'
    }
    setErrors(next)
    if (Object.keys(next).length) {
      // Put the keyboard/screen reader on the first problem instead of leaving the person to hunt for it.
      requestAnimationFrame(() => document.querySelector('#point-form [aria-invalid="true"]')?.focus())
      return
    }

    const body = {
      name: form.name.trim(), description: form.description.trim(), service_type: form.service_type || null,
      gps_mode: form.gps_mode, provider_ids: form.provider_ids,
      // Switching to "no location" keeps whatever coordinates the point already had (the person may switch back).
      ...(usesLocation
        ? { lat, lng, radius_m: radius }
        : { lat: point?.lat ?? null, lng: point?.lng ?? null, radius_m: point?.radius_m ?? 50 }),
      ...(point ? { is_active: form.is_active } : {}),
    }
    const res = await run(
      () => adminApi(point ? `/points/${point.id}` : '/points', { method: point ? 'PATCH' : 'POST', body }),
      point ? 'הנקודה עודכנה' : 'הנקודה נוצרה. עכשיו אפשר להדפיס את ה-QR שלה.',
    )
    if (res) onSaved(res.point, !point)
  }

  const toggleProvider = (id, on) =>
    set('provider_ids', on ? [...form.provider_ids, id] : form.provider_ids.filter((x) => x !== id))

  return (
    <Modal
      title={point ? `עריכת נקודה: ${point.name}` : 'נקודה חדשה'}
      onClose={onClose}
      footer={(
        <>
          <button type="button" className="w-btn w-btn--quiet w-btn--small" onClick={onClose}>ביטול</button>
          <button type="submit" form="point-form" className="w-btn w-btn--small" disabled={busy}>{busy ? 'שומר…' : 'שמירה'}</button>
        </>
      )}
    >
      <form id="point-form" className="a-form" onSubmit={submit} noValidate>
        <Field label="שם הנקודה" error={errors.name}>
          <input className="a-input" value={form.name} onChange={(e) => set('name', e.target.value)} maxLength={120} placeholder="לדוגמה: לובי, חדר מדרגות, מינוס 1" />
        </Field>
        <Field label="תיאור (לא חובה)">
          <textarea className="a-input" value={form.description} onChange={(e) => set('description', e.target.value)} maxLength={500} />
        </Field>
        <Field label="סוג שירות">
          <select className="a-input" value={form.service_type} onChange={(e) => set('service_type', e.target.value)}>
            <option value="">לא מוגדר</option>
            {SERVICE_TYPES.map((s) => <option key={s.value} value={s.value}>{s.label}</option>)}
          </select>
        </Field>

        <Field label="בדיקת מיקום" hint={GPS[form.gps_mode].hint}>
          <select className="a-input" value={form.gps_mode} onChange={(e) => set('gps_mode', e.target.value)}>
            {Object.entries(GPS).map(([value, g]) => <option key={value} value={value}>{g.label}</option>)}
          </select>
        </Field>

        {form.gps_mode !== 'none' && (
          <>
            <MapPicker
              lat={lat} lng={lng} radius={radius}
              onPick={(p) => { set('lat', +p.lat.toFixed(6)); set('lng', +p.lng.toFixed(6)) }}
              hint="לחצו על המפה כדי לסמן איפה הנקודה. העיגול הוא הרדיוס שבו נחשבת נוכחות."
            />
            <div className="a-form-row">
              <Field label="קו רוחב" error={errors.lat}>
                <input className="a-input" dir="ltr" inputMode="decimal" value={form.lat} onChange={(e) => set('lat', e.target.value)} />
              </Field>
              <Field label="קו אורך" error={errors.lng}>
                <input className="a-input" dir="ltr" inputMode="decimal" value={form.lng} onChange={(e) => set('lng', e.target.value)} />
              </Field>
            </div>
            <div className="a-form-row">
              <Field label="רדיוס (מטרים)" error={errors.radius_m}>
                <input className="a-input" dir="ltr" inputMode="numeric" value={form.radius_m} onChange={(e) => set('radius_m', e.target.value)} />
              </Field>
              <div style={{ display: 'flex', alignItems: 'flex-end' }}>
                <button type="button" className="w-btn w-btn--ghost w-btn--small" onClick={locate} style={{ width: '100%' }}>
                  <IconLocate size={20} />המיקום שלי כעת
                </button>
              </div>
            </div>
          </>
        )}

        <fieldset style={{ border: 0, padding: 0, margin: 0 }}>
          <legend className="w-label" style={{ marginBlockEnd: 6 }}>מי רשאי לסרוק כאן</legend>
          <div className="a-check-list">
            {assignable.length === 0 && <p className="w-small" style={{ padding: 8 }}>עוד אין נותני שירות.</p>}
            {assignable.map((p) => (
              <Switch key={p.id} checked={form.provider_ids.includes(p.id)} onChange={(on) => toggleProvider(p.id, on)}
                label={`${p.contact_name || p.company}${p.contact_name ? ` · ${p.company}` : ''}${p.is_active ? '' : ' (מושבת)'}`} />
            ))}
          </div>
          <p className="w-small" style={{ marginBlockStart: 6 }}>{!form.provider_ids.some((id) => assignable.some((p) => p.id === id)) ? 'לא נבחר אף אחד: כל נותני השירות רשאים לסרוק.' : 'רק הנבחרים רשאים לסרוק בנקודה הזו.'}</p>
          {hasDemo && <p className="w-small" style={{ marginBlockStart: 4 }}>חשבון הדמו מורשה לסרוק בכל הנקודות, ולכן אינו מופיע ברשימה.</p>}
        </fieldset>

        {point && (
          <Switch checked={form.is_active} onChange={(v) => set('is_active', v)} label="הנקודה פעילה"
            hint="נקודה לא פעילה נשארת במערכת עם כל ההיסטוריה שלה, אבל אי אפשר לסרוק בה." />
        )}
      </form>
    </Modal>
  )
}

/* ------------------------------------------------------------- QR dialog */

// A sign printed with a local or preview address would not work on the wall. The server uses APP_BASE_URL when it
// is set; otherwise it falls back to the address this page was opened on.
const isLocalAddress = (url) => {
  try {
    const h = new URL(url).hostname
    return h === 'localhost' || /^127\./.test(h) || /^192\.168\./.test(h) || /^10\./.test(h) || h.endsWith('.local')
  } catch {
    return false
  }
}

function QrDialog({ point, onClose, onPrint, onChanged }) {
  const toast = useToast()
  const confirm = useConfirm()
  const src = useQrImage(point.qr_url)
  const [busy, run] = useAction(toast, errorText)
  const local = isLocalAddress(point.qr_url)

  const regenerate = async () => {
    const ok = await confirm({
      title: 'להחליף את קוד ה-QR?',
      body: 'ה-QR המודפס הנוכחי יפסיק לעבוד מיד, ותצטרכו להדפיס ולתלות שלט חדש. השתמשו בזה רק אם יש חשש שהקוד דלף.',
      confirmLabel: 'החלפה', danger: true,
    })
    if (!ok) return
    const res = await run(() => adminApi(`/points/${point.id}/regenerate-qr`, { method: 'POST' }), 'הקוד הוחלף. הדפיסו שלט חדש.')
    if (res) onChanged(res.point)
  }

  return (
    <Modal title={`QR: ${point.name}`} onClose={onClose} size="sm"
      footer={<button className="w-btn w-btn--quiet w-btn--small" onClick={onClose}>סגירה</button>}>
      {local && (
        <div className="w-banner w-banner--warn" role="alert">
          <IconAlert />
          <div className="w-banner__body">הקוד מצביע על כתובת מקומית (<bdi dir="ltr">{new URL(point.qr_url).host}</bdi>), ושלט שיודפס כך לא יעבוד בבניין. הגדירו את <bdi>APP_BASE_URL</bdi> בשרת ופתחו את הקוד מחדש.</div>
        </div>
      )}
      <div className="a-qr">
        {src ? <img src={src} alt={`קוד QR של הנקודה ${point.name}`} /> : <Spinner />}
        <div className="a-actions" style={{ justifyContent: 'center' }}>
          <button className="w-btn w-btn--small" onClick={() => onPrint([point], 'single')}><IconPrinter size={20} />הדפסת שלט</button>
          <button className="w-btn w-btn--ghost w-btn--small" disabled={!src} onClick={() => downloadDataUrl(src, `qr-${safeFileName(point.name)}.png`)}>
            <IconDownload size={20} />הורדה
          </button>
          <button className="w-btn w-btn--ghost w-btn--small" onClick={async () => toast.ok((await copyText(point.qr_url)) ? 'הקישור הועתק' : 'ההעתקה נכשלה')}>
            <IconCopy size={20} />העתקת קישור
          </button>
        </div>
        <p className="w-small a-code">{point.qr_url}</p>
      </div>
      <button className="w-btn w-btn--ghost w-btn--small" onClick={regenerate} disabled={busy}><IconRefresh size={20} />החלפת קוד ה-QR</button>
    </Modal>
  )
}

/* ------------------------------------------------------------------ view */

export default function PointsView() {
  const toast = useToast()
  const points = useLoad(() => adminApi('/points'))
  const providers = useLoad(() => adminApi('/providers'))
  const [editing, setEditing] = useState(null) // null | 'new' | point
  const [qrFor, setQrFor] = useState(null)
  const [printJob, setPrintJob] = useState(null)

  const startPrint = useCallback((list, layout) => {
    if (!list.length) return toast.error('אין נקודות פעילות להדפסה.')
    if (list.some((p) => isLocalAddress(p.qr_url))) {
      toast.error('שימו לב: הקודים מצביעים על כתובת מקומית ולא יעבדו בבניין. הגדירו APP_BASE_URL בשרת.')
    }
    setQrFor(null)
    setPrintJob({ points: list, layout })
  }, [toast])
  const endPrint = useCallback(() => setPrintJob(null), [])

  const list = points.data?.points ?? []
  const names = Object.fromEntries((providers.data?.providers ?? []).map((p) => [p.id, p.contact_name || p.company]))

  return (
    <>
      <div className="a-head">
        <div>
          <h1>נקודות סריקה</h1>
          <p>המקומות בבניין שבהם נותני השירות סורקים QR. כל נקודה מקבלת שלט מודפס.</p>
        </div>
        <div className="a-actions">
          <button className="w-btn w-btn--ghost w-btn--small" onClick={() => startPrint(list.filter((p) => p.is_active), 'pair')} disabled={!list.length}>
            <IconPrinter size={20} />הדפסת כל השלטים
          </button>
          <button className="w-btn w-btn--small" onClick={() => setEditing('new')}><IconPlus size={20} />נקודה חדשה</button>
        </div>
      </div>

      {points.status === 'loading' && <Spinner />}
      {points.status === 'error' && !points.data && (
        <EmptyState icon={IconAlert} title="לא הצלחנו לטעון את הנקודות" action={<button className="w-btn w-btn--small" onClick={points.reload}>נסו שוב</button>} />
      )}
      {points.status !== 'loading' && list.length === 0 && !points.error && (
        <EmptyState icon={IconPin} title="עוד אין נקודות"
          action={<button className="w-btn w-btn--small" onClick={() => setEditing('new')}><IconPlus size={20} />הוסיפו את הנקודה הראשונה</button>}>
          לכל מקום שצריך לבדוק בו נוכחות (לובי, חדר מדרגות, גינה) מגדירים נקודה ומדפיסים לה שלט QR.
        </EmptyState>
      )}

      <div className="a-grid">
        {list.map((p) => {
          const missingCoords = p.gps_mode !== 'none' && (p.lat == null || p.lng == null)
          return (
            <article key={p.id} className={`a-card${p.is_active ? '' : ' is-off'}`}>
              <div className="a-card__top">
                <div>
                  <h2 className="a-card__title">{p.name}</h2>
                  {p.description && <p className="a-card__sub">{p.description}</p>}
                </div>
                <Badge tone={p.is_active ? 'ok' : 'neutral'}>{p.is_active ? 'פעילה' : 'לא פעילה'}</Badge>
              </div>
              <div className="a-meta">
                {p.service_type && <Badge tone="info">{serviceLabel(p.service_type)}</Badge>}
                <Badge>{GPS[p.gps_mode].label}</Badge>
                {missingCoords && <Badge tone="warn">חסר מיקום במפה</Badge>}
              </div>
              <dl className="a-facts">
                <dt>מי סורק</dt>
                <dd>{p.provider_ids.length ? p.provider_ids.map((id) => names[id] ?? '…').join(', ') : 'כל נותני השירות'}</dd>
                {p.gps_mode !== 'none' && (<><dt>רדיוס</dt><dd>{p.radius_m} מ׳</dd></>)}
              </dl>
              <div className="a-card__actions">
                <button className="w-btn w-btn--small" onClick={() => setQrFor(p)}><IconQr size={20} />QR והדפסה</button>
                <button className="w-btn w-btn--ghost w-btn--small" onClick={() => setEditing(p)}><IconEdit size={20} />עריכה</button>
              </div>
            </article>
          )
        })}
      </div>

      {editing && (
        <PointForm
          point={editing === 'new' ? null : editing}
          providers={providers.data?.providers ?? []}
          onClose={() => setEditing(null)}
          onSaved={(saved, created) => { setEditing(null); points.reload(); if (created) setQrFor(saved) }}
        />
      )}
      {qrFor && (
        <QrDialog
          point={qrFor}
          onClose={() => setQrFor(null)}
          onPrint={startPrint}
          onChanged={(p) => { setQrFor(p); points.reload() }}
        />
      )}
      {printJob && <PrintSheet points={printJob.points} layout={printJob.layout} onDone={endPrint} />}
    </>
  )
}
