import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { adminApi, errorText } from '../api.js'
import { useLoad } from '../hooks.js'
import { Modal, Field, Badge, Switch, EmptyState, Spinner, IconButton, DateInput, useToast, useConfirm, useAction } from '../ui.jsx'
import { IconList, IconDownload, IconRefresh, IconBan, IconUndo, IconAlert, IconTrash } from '../icons.jsx'
import { formatDay, formatDateTime, formatTime, isoDay } from '../../../shared/datetime.js'

const daysAgo = (n) => isoDay(new Date(Date.now() - n * 86_400_000))
const dayLabel = formatDay // the heading of a day: DD/MM/YYYY

// What the agent-facing flags mean, in words a committee member understands.
const FLAGS = {
  location_unverified: { label: 'מיקום לא מאומת', tone: 'warn' },
  location_outside_radius: { label: 'מחוץ לרדיוס', tone: 'warn' },
  location_stale: { label: 'מיקום ישן', tone: 'warn' },
  offline_sync: { label: 'נשלח אחרי חוסר קליטה', tone: 'info' },
  clock_skew: { label: 'שעון הטלפון לא תקין', tone: 'warn' },
  demo: { label: 'דמו', tone: 'neutral' },
  legacy_import: { label: 'מהמערכת הישנה', tone: 'neutral' },
}
const OUTCOMES = { rejected_far: 'נדחתה: רחוק מהנקודה', rejected_no_location: 'נדחתה: חסר מיקום' }

const DEFAULTS = () => ({ from: daysAgo(6), to: isoDay(new Date()), point_id: '', provider_id: '', outcome: 'accepted', include_voided: false, include_demo: false })
const PAGE = 100

// A date typed digit by digit passes through nonsense ("0002-…"); only complete, sensible dates are sent.
const goodDate = (v) => /^\d{4}-\d{2}-\d{2}$/.test(v) && Number(v.slice(0, 4)) >= 2000

function query(f, extra = {}) {
  const p = new URLSearchParams()
  for (const [k, v] of Object.entries({ ...f, ...extra })) {
    if (v === '' || v === false || v == null) continue
    if ((k === 'from' || k === 'to') && !goodDate(v)) continue
    p.set(k, String(v))
  }
  return p.toString()
}

function VoidDialog({ scan, onClose, onDone }) {
  const toast = useToast()
  const [reason, setReason] = useState('')
  const [busy, run] = useAction(toast, errorText)
  const submit = async (e) => {
    e.preventDefault()
    const res = await run(() => adminApi(`/scans/${scan.id}/void`, { method: 'POST', body: { reason } }), 'הנוכחות בוטלה')
    if (res) onDone(res.scan)
  }
  return (
    <Modal title="ביטול נוכחות" onClose={onClose} size="sm"
      footer={(
        <>
          <button type="button" className="w-btn w-btn--quiet w-btn--small" onClick={onClose}>חזרה</button>
          <button type="submit" form="void-form" className="w-btn w-btn--danger w-btn--small" disabled={busy}>{busy ? 'מבטל…' : 'ביטול הנוכחות'}</button>
        </>
      )}>
      <p className="w-lead">{scan.point_name} · {scan.provider_name} · {formatDateTime(scan.checked_in_at)}</p>
      <form id="void-form" className="a-form" onSubmit={submit}>
        <Field label="סיבה (לא חובה)" hint="הרשומה לא נמחקת: היא נשארת בהיסטוריה מסומנת כמבוטלת ואפשר לשחזר אותה.">
          <textarea className="a-input" value={reason} onChange={(e) => setReason(e.target.value)} maxLength={300} placeholder="לדוגמה: נסרק בטעות" />
        </Field>
      </form>
    </Modal>
  )
}

export default function HistoryView() {
  const toast = useToast()
  const points = useLoad(() => adminApi('/points'))
  const providers = useLoad(() => adminApi('/providers'))
  const [filters, setFilters] = useState(DEFAULTS) // what the inputs show
  const [applied, setApplied] = useState(filters) // what is actually queried (after a short pause in typing)
  const [{ rows, cursor, status }, setList] = useState({ rows: [], cursor: null, status: 'loading' })
  const [voiding, setVoiding] = useState(null)
  const confirm = useConfirm()
  const [busy, run] = useAction(toast, errorText)
  const seq = useRef(0) // numbers the queries: an answer to an older one is ignored

  useEffect(() => {
    const t = setTimeout(() => setApplied(filters), 350)
    return () => clearTimeout(t)
  }, [filters])

  const load = useCallback(async () => {
    const mine = ++seq.current
    setList({ rows: [], cursor: null, status: 'loading' }) // never show the old filter's rows under the new one
    try {
      const res = await adminApi(`/scans?${query(applied, { limit: PAGE })}`)
      if (mine === seq.current) setList({ rows: res.scans, cursor: res.next_cursor, status: 'ready' })
    } catch (err) {
      if (mine !== seq.current) return
      setList({ rows: [], cursor: null, status: 'error' })
      toast.error(errorText(err))
    }
  }, [applied, toast])
  useEffect(() => { load() }, [load])

  const more = async () => {
    const mine = seq.current
    const res = await run(() => adminApi(`/scans?${query(applied, { limit: PAGE, cursor })}`))
    if (!res || mine !== seq.current) return // the filters changed meanwhile: this page belongs to an old query
    setList((s) => {
      const have = new Set(s.rows.map((r) => r.id))
      return { ...s, rows: [...s.rows, ...res.scans.filter((r) => !have.has(r.id))], cursor: res.next_cursor }
    })
  }

  // Update the one row in place instead of reloading: the loaded pages and the scroll position stay.
  const patch = (scan) =>
    setList((s) => ({
      ...s,
      rows: applied.include_voided ? s.rows.map((r) => (r.id === scan.id ? scan : r)) : s.rows.filter((r) => r.id !== scan.id),
    }))
  const restore = async (s) => {
    const res = await run(() => adminApi(`/scans/${s.id}/unvoid`, { method: 'POST', body: {} }), 'הנוכחות שוחזרה')
    if (res) patch(res.scan)
  }
  // For rows that should never have been there (test scans). Gone for good, unlike "cancel", which can be undone.
  const remove = async (s) => {
    const ok = await confirm({
      title: 'למחוק את הנוכחות לצמיתות?',
      body: `${s.point_name} · ${s.provider_name} · ${formatDateTime(s.checked_in_at)}. אי אפשר לשחזר אותה. אם רק רוצים להוציא אותה מהדוחות, אפשר לבטל אותה במקום.`,
      confirmLabel: 'מחיקה', danger: true,
    })
    if (ok && await run(() => adminApi(`/scans/${s.id}`, { method: 'DELETE' }), 'הנוכחות נמחקה')) {
      setList((st) => ({ ...st, rows: st.rows.filter((r) => r.id !== s.id) }))
    }
  }

  const set = (k, v) => setFilters((f) => ({ ...f, [k]: v }))
  const groups = useMemo(() => {
    const out = []
    for (const s of rows) {
      const last = out[out.length - 1]
      if (last && last.date === s.local_date) last.items.push(s)
      else out.push({ date: s.local_date, items: [s] })
    }
    return out
  }, [rows])

  return (
    <>
      <div className="a-head">
        <div>
          <h1>היסטוריית נוכחות</h1>
          <p>כל הנוכחויות שנרשמו. אפשר לבטל נוכחות ולשחזר אותה, או למחוק שורה לצמיתות.</p>
        </div>
        <div className="a-actions">
          <IconButton icon={IconRefresh} label="רענון" onClick={load} />
          <IconButton icon={IconDownload} label="ייצוא ל-Excel" href={`/api/admin/scans?${query(applied, { format: 'csv' })}`} download="scans.csv" />
        </div>
      </div>

      <div className="a-filters">
        <Field label="מתאריך"><DateInput value={filters.from} onChange={(v) => set('from', v)} /></Field>
        <Field label="עד תאריך"><DateInput value={filters.to} onChange={(v) => set('to', v)} /></Field>
        <Field label="נקודה">
          <select className="a-input" value={filters.point_id} onChange={(e) => set('point_id', e.target.value)}>
            <option value="">כל הנקודות</option>
            {(points.data?.points ?? []).map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
          </select>
        </Field>
        <Field label="נותן שירות">
          <select className="a-input" value={filters.provider_id} onChange={(e) => set('provider_id', e.target.value)}>
            <option value="">כולם</option>
            {(providers.data?.providers ?? []).map((p) => <option key={p.id} value={p.id}>{p.contact_name || p.company}</option>)}
          </select>
        </Field>
        <Field label="סוג">
          <select className="a-input" value={filters.outcome} onChange={(e) => set('outcome', e.target.value)}>
            <option value="accepted">נוכחויות שנרשמו</option>
            <option value="rejected">ניסיונות שנדחו</option>
            <option value="all">הכול</option>
          </select>
        </Field>
        <div className="a-stack" style={{ gap: 0 }}>
          <Switch checked={filters.include_voided} onChange={(v) => set('include_voided', v)} label="כולל מבוטלות" />
          <Switch checked={filters.include_demo} onChange={(v) => set('include_demo', v)} label="כולל חשבון דמו" />
        </div>
      </div>

      {status === 'loading' && <Spinner />}
      {status === 'error' && (
        <EmptyState icon={IconAlert} title="לא הצלחנו לטעון" action={<button className="w-btn w-btn--small" onClick={load}>נסו שוב</button>} />
      )}
      {status === 'ready' && rows.length === 0 && (
        <EmptyState icon={IconList} title="אין נוכחויות בטווח הזה">נסו להרחיב את טווח התאריכים או לשנות את הסינון.</EmptyState>
      )}

      {groups.map((g) => (
        <section key={g.date} aria-label={dayLabel(g.date)}>
          <h2 className="a-day">{dayLabel(g.date)} · {g.items.length}</h2>
          <ul className="a-scans">
            {g.items.map((s) => (
              <li key={s.id} className={`a-scan${s.voided ? ' is-void' : ''}`}>
                <span className="a-scan__time">{formatTime(s.checked_in_at)}</span>
                <div className="a-scan__main">
                  <div className="a-scan__point">{s.point_name}</div>
                  <div className="a-scan__who">{s.provider_name}</div>
                </div>
                <div className="a-scan__flags">
                  {s.outcome !== 'accepted' && <Badge tone="danger">{OUTCOMES[s.outcome] ?? s.outcome}</Badge>}
                  {s.voided && <Badge tone="danger">מבוטלת{s.void_reason ? `: ${s.void_reason}` : ''}</Badge>}
                  {s.distance_m != null && <Badge>{s.distance_m} מ׳ מהנקודה</Badge>}
                  {s.flags.map((f) => <Badge key={f} tone={FLAGS[f]?.tone}>{FLAGS[f]?.label ?? f}</Badge>)}
                </div>
                <div className="a-scan__tools">
                  {s.outcome === 'accepted' && (s.voided
                    ? <IconButton icon={IconUndo} label="שחזור הנוכחות" onClick={() => restore(s)} disabled={busy} />
                    : <IconButton icon={IconBan} label="ביטול הנוכחות" onClick={() => setVoiding(s)} />)}
                  <IconButton icon={IconTrash} label="מחיקת הנוכחות לצמיתות" tone="danger" onClick={() => remove(s)} disabled={busy} />
                </div>
              </li>
            ))}
          </ul>
        </section>
      ))}

      {cursor && status === 'ready' && (
        <div style={{ display: 'grid', placeItems: 'center', marginBlockStart: 18 }}>
          <button className="w-btn w-btn--ghost w-btn--small" onClick={more} disabled={busy}>{busy ? 'טוען…' : 'טעינת עוד'}</button>
        </div>
      )}

      {voiding && <VoidDialog scan={voiding} onClose={() => setVoiding(null)} onDone={(scan) => { setVoiding(null); patch(scan) }} />}
    </>
  )
}
