import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { adminApi, errorText, scanRefusals } from '../api.js'
import { useLoad, LOAD_KEY } from '../hooks.js'
import { dropLoadCache, loadCacheEpoch, readLoadCache, writeLoadCache } from '../loadCache.js'
import { Modal, Field, Badge, Switch, EmptyState, Spinner, IconButton, DateInput, useToast, useConfirm, useAction } from '../ui.jsx'
import { IconList, IconDownload, IconRefresh, IconBan, IconUndo, IconAlert, IconTrash } from '../icons.jsx'
import { formatDay, formatDateTime, formatTime, isoDay } from '../../../shared/datetime.js'
import {
  OUTCOME_ACCEPTED, OUTCOME_REJECTED_FAR, OUTCOME_REJECTED_NO_LOCATION, VOID_REASON_MAX_LENGTH,
  SCAN_ERROR_INVALID_CODE, SCAN_ERROR_UNKNOWN_CODE, SCAN_ERROR_POINT_INACTIVE, SCAN_ERROR_NOT_ASSIGNED,
  SCAN_ERROR_INVALID_SCAN_ID, SCAN_ERROR_SCAN_ID_CONFLICT, SCAN_ERROR_INVALID_ITEM, SOURCE_ONLINE, SOURCE_OFFLINE_SYNC,
} from '../../../shared/contract.js'

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
const OUTCOMES = { [OUTCOME_REJECTED_FAR]: 'נדחתה: רחוק מהנקודה', [OUTCOME_REJECTED_NO_LOCATION]: 'נדחתה: חסר מיקום' }

// The fourth choice of the "type" filter, and the only one that is not a kind of scan: the visits that the server refused (a
// point that was switched off, a person who is not assigned, a code that names nothing, ...). They are another list (GET
// /api/admin/scan-refusals), not scans, so this screen shows that list instead and offers nothing that is about a scan.
const NOT_COUNTED = 'not_counted'

// Why a visit was not counted, in the words of the committee. Keyed by the codes of the contract, never by strings. A code
// that is not here (a newer server) gets OTHER_REASON. "warn" is a reason that the committee can act on (switch the point
// on, assign the person, print the code again); "neutral" is a fault of the data, which nobody on the committee can mend.
const REFUSAL_REASONS = new Map([
  [SCAN_ERROR_POINT_INACTIVE, { label: 'נקודה כבויה', tone: 'warn' }],
  [SCAN_ERROR_NOT_ASSIGNED, { label: 'לא משויך לנקודה', tone: 'warn' }],
  [SCAN_ERROR_UNKNOWN_CODE, { label: 'קוד לא מוכר', tone: 'warn' }],
  [SCAN_ERROR_INVALID_CODE, { label: 'קוד לא מוכר', tone: 'warn' }],
  [SCAN_ERROR_INVALID_SCAN_ID, { label: 'נתונים לא תקינים', tone: 'neutral' }],
  [SCAN_ERROR_SCAN_ID_CONFLICT, { label: 'נתונים לא תקינים', tone: 'neutral' }],
  [SCAN_ERROR_INVALID_ITEM, { label: 'נתונים לא תקינים', tone: 'neutral' }],
])
const OTHER_REASON = { label: 'סיבה אחרת', tone: 'neutral' }
// How the visit reached the server. A source that is not here shows no badge.
const REFUSAL_SOURCES = new Map([
  [SOURCE_OFFLINE_SYNC, { label: 'מהתור בטלפון', tone: 'info' }],
  [SOURCE_ONLINE, { label: 'בזמן אמת', tone: 'neutral' }],
])
const NO_POINT = 'קוד לא מוכר' // a refusal that named no point: the code that was scanned is not one of ours

const DEFAULTS = () => ({ from: daysAgo(6), to: isoDay(new Date()), point_id: '', provider_id: '', outcome: OUTCOME_ACCEPTED, include_voided: false, include_demo: false })
const PAGE = 100

// A date typed digit by digit passes through nonsense ("0002-…"); only complete, sensible dates are sent.
const goodDate = (v) => /^\d{4}-\d{2}-\d{2}$/.test(v) && Number(v.slice(0, 4)) >= 2000

/** The filters that are set, as the API takes them: nothing empty or off, and only a complete, sensible date. */
function params(f, extra = {}) {
  const out = {}
  for (const [k, v] of Object.entries({ ...f, ...extra })) {
    if (v === '' || v === false || v == null) continue
    if ((k === 'from' || k === 'to') && !goodDate(v)) continue
    out[k] = String(v)
  }
  return out
}
const query = (f, extra) => new URLSearchParams(params(f, extra)).toString()

// The first page of each set of filters is kept for the session (src/admin/loadCache.js), so that coming back to this tab draws it at
// once while the current one is asked for. The key says the kind of list and every filter that is set, so a filter never shows the rows
// of another. Only the first page is kept: "load more" pages are not (they are asked for again when the person wants them).
const CACHE_PREFIX = 'history:'
const cacheKey = (f) => `${CACHE_PREFIX}${f.outcome === NOT_COUNTED ? 'refusals' : 'scans'}:${query(f, { limit: PAGE })}`
/** The first page that this screen showed for these filters before, as the state of the list; `null` when there is none. */
function rememberedList(f) {
  const kept = readLoadCache(cacheKey(f))
  return kept ? { rows: kept.rows, cursor: kept.cursor, status: 'ready', kind: kept.kind } : null
}

/** The refused visits for the same dates, point and provider (the other filters are about scans), one page. */
function refusalsPage(f, extra) {
  const { from, to, point_id, provider_id, limit, cursor } = params(f, extra)
  return scanRefusals({ from, to, point_id, provider_id, limit, cursor })
}

/** One refused visit: read only, so there are no actions on it. The time is the server's; the phone's own clock is added
 * when it tells something (the visit came from the queue, or the phone's minute is not the server's). */
function RefusalRow({ r }) {
  const reason = REFUSAL_REASONS.get(r.code) ?? OTHER_REASON
  const source = REFUSAL_SOURCES.get(r.source)
  const onPhone = r.client_time && (r.source === SOURCE_OFFLINE_SYNC || formatDateTime(r.client_time) !== formatDateTime(r.at))
  return (
    <li className="a-scan a-scan--readonly">
      <span className="a-scan__time">{formatTime(r.at)}</span>
      <div className="a-scan__main">
        <div className="a-scan__point">{r.point_name || NO_POINT}</div>
        <div className="a-scan__who">{r.provider_name}</div>
        {onPhone && <div className="a-scan__who">נסרק בטלפון: <span className="a-scan__stamp">{formatDateTime(r.client_time)}</span></div>}
      </div>
      <div className="a-scan__flags">
        <Badge tone={reason.tone}>{reason.label}</Badge>
        {source && <Badge tone={source.tone}>{source.label}</Badge>}
      </div>
    </li>
  )
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
          <textarea className="a-input" value={reason} onChange={(e) => setReason(e.target.value)} maxLength={VOID_REASON_MAX_LENGTH} placeholder="לדוגמה: נסרק בטעות" />
        </Field>
      </form>
    </Modal>
  )
}

export default function HistoryView() {
  const toast = useToast()
  const points = useLoad(() => adminApi('/points'), [], { cacheKey: LOAD_KEY.points })
  const providers = useLoad(() => adminApi('/providers'), [], { cacheKey: LOAD_KEY.providers })
  const [filters, setFilters] = useState(DEFAULTS) // what the inputs show
  const [applied, setApplied] = useState(filters) // what is actually queried (after a short pause in typing)
  // A date field that is half typed shows something other than what is queried (the last good date). The list may stay,
  // but the export must not quietly use a range that differs from the fields, so it waits until both are finished.
  const [unfinished, setUnfinished] = useState({ from: false, to: false })
  // `kind` says which list the rows are (scans or refusals), set when they arrive: the filter can already say another one
  // while the pause before a query runs, and rows are never drawn as the wrong kind.
  // The list starts with the page that was kept for the first filters, if there is one (the tab was open before in this session).
  const [{ rows, cursor, status, kind }, setList] = useState(() => rememberedList(filters) ?? { rows: [], cursor: null, status: 'loading', kind: 'scans' })
  const [voiding, setVoiding] = useState(null)
  const confirm = useConfirm()
  const [busy, run] = useAction(toast, errorText)
  const seq = useRef(0) // numbers the queries: an answer to an older one is ignored

  useEffect(() => {
    const t = setTimeout(() => setApplied(filters), 350)
    return () => clearTimeout(t)
  }, [filters])

  // Asks for the first page of the applied filters. `shown` is the page that was kept for them (see `rememberedList`): it stays on
  // screen while the answer comes, and if the request fails it stays. Without it the list starts from the loading state and a failure
  // empties it.
  const fetchFirstPage = useCallback(async (shown) => {
    const mine = ++seq.current
    const refused = applied.outcome === NOT_COUNTED
    const kind = refused ? 'refusals' : 'scans'
    const key = cacheKey(applied)
    const asked = loadCacheEpoch()
    setList(shown ?? { rows: [], cursor: null, status: 'loading', kind }) // never show the old filter's rows under the new one
    try {
      const res = refused ? await refusalsPage(applied, { limit: PAGE }) : await adminApi(`/scans?${query(applied, { limit: PAGE })}`)
      const page = { rows: refused ? res.refusals : res.scans, cursor: res.next_cursor, kind }
      writeLoadCache(key, page, asked) // for these filters, whatever the screen is doing by now
      if (mine !== seq.current) return
      setList({ ...page, status: 'ready' })
      if (shown) seq.current += 1 // a "load more" that was asked for the page above belongs to a list that has just been replaced
    } catch (err) {
      if (mine !== seq.current) return
      if (!shown) setList({ rows: [], cursor: null, status: 'error', kind })
      toast.error(errorText(err))
    }
  }, [applied, toast])
  const load = useCallback(() => fetchFirstPage(null), [fetchFirstPage]) // the refresh button and "try again": from the loading state, as ever
  useEffect(() => { fetchFirstPage(rememberedList(applied)) }, [fetchFirstPage, applied])

  const more = async () => {
    const mine = seq.current
    const refused = kind === 'refusals'
    const res = await run(() => (refused ? refusalsPage(applied, { limit: PAGE, cursor }) : adminApi(`/scans?${query(applied, { limit: PAGE, cursor })}`)))
    if (!res || mine !== seq.current) return // the filters changed meanwhile: this page belongs to an old query
    const page = refused ? res.refusals : res.scans
    setList((s) => {
      const have = new Set(s.rows.map((r) => r.id))
      return { ...s, rows: [...s.rows, ...page.filter((r) => !have.has(r.id))], cursor: res.next_cursor }
    })
  }

  // Update the one row in place instead of reloading: the loaded pages and the scroll position stay.
  const patch = (scan) => {
    dropLoadCache(CACHE_PREFIX) // the pages that were kept show this scan as it was
    setList((s) => ({
      ...s,
      rows: applied.include_voided ? s.rows.map((r) => (r.id === scan.id ? scan : r)) : s.rows.filter((r) => r.id !== scan.id),
    }))
  }
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
      dropLoadCache(CACHE_PREFIX)
      setList((st) => ({ ...st, rows: st.rows.filter((r) => r.id !== s.id) }))
    }
  }

  const set = (k, v) => setFilters((f) => ({ ...f, [k]: v }))
  const refusals = kind === 'refusals'
  const groups = useMemo(() => {
    const out = []
    for (const s of rows) {
      const date = refusals ? isoDay(s.at) : s.local_date // a refusal has no local_date: its building day comes from its time
      const last = out[out.length - 1]
      if (last && last.date === date) last.items.push(s)
      else out.push({ date, items: [s] })
    }
    return out
  }, [rows, refusals])
  // What the filter says now (not what was last loaded): the controls that are about scans leave at once.
  const choseRefusals = filters.outcome === NOT_COUNTED

  return (
    <>
      <div className="a-head">
        <div>
          <h1>היסטוריית נוכחות</h1>
          {choseRefusals
            ? <p>ביקורים שהשרת לא קלט, למשל בגלל נקודה כבויה. הם לא נספרים כנוכחות, והרשימה רק לקריאה.</p>
            : <p>כל הנוכחויות שנרשמו. אפשר לבטל נוכחות ולשחזר אותה, או למחוק שורה לצמיתות.</p>}
        </div>
        <div className="a-actions">
          <IconButton icon={IconRefresh} label="רענון" onClick={load} />
          {/* The file is of scans only: it has no refused visits, so there is nothing to export in this view. */}
          {!choseRefusals && applied.outcome !== NOT_COUNTED && (
            <IconButton icon={IconDownload} label="ייצוא ל-Excel" href={`/api/admin/scans?${query(applied, { format: 'csv' })}`} download="scans.csv" disabled={unfinished.from || unfinished.to} />
          )}
        </div>
      </div>

      <div className="a-filters">
        <Field label="מתאריך"><DateInput value={filters.from} onChange={(v) => set('from', v)} onPendingChange={(p) => setUnfinished((u) => ({ ...u, from: p }))} /></Field>
        <Field label="עד תאריך"><DateInput value={filters.to} onChange={(v) => set('to', v)} onPendingChange={(p) => setUnfinished((u) => ({ ...u, to: p }))} /></Field>
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
            <option value={OUTCOME_ACCEPTED}>נוכחויות שנרשמו</option>
            <option value="rejected">ניסיונות שנדחו</option>
            <option value="all">הכול</option>
            <option value={NOT_COUNTED}>לא נקלטו</option>
          </select>
        </Field>
        {!choseRefusals && (
          <div className="a-stack" style={{ gap: 0 }}>
            <Switch checked={filters.include_voided} onChange={(v) => set('include_voided', v)} label="כולל מבוטלות" />
            <Switch checked={filters.include_demo} onChange={(v) => set('include_demo', v)} label="כולל חשבון דמו" />
          </div>
        )}
      </div>

      {status === 'loading' && <Spinner />}
      {status === 'error' && (
        <EmptyState icon={IconAlert} title="לא הצלחנו לטעון" action={<button className="w-btn w-btn--small" onClick={load}>נסו שוב</button>} />
      )}
      {status === 'ready' && rows.length === 0 && (refusals
        ? <EmptyState icon={IconList} title="אין ביקורים שלא נקלטו בטווח הזה">נסו להרחיב את טווח התאריכים או לשנות את הסינון.</EmptyState>
        : <EmptyState icon={IconList} title="אין נוכחויות בטווח הזה">נסו להרחיב את טווח התאריכים או לשנות את הסינון.</EmptyState>)}

      {groups.map((g) => (
        <section key={g.date} aria-label={dayLabel(g.date)}>
          <h2 className="a-day">{dayLabel(g.date)} · {g.items.length}</h2>
          <ul className="a-scans">
            {refusals ? g.items.map((r) => <RefusalRow key={r.id} r={r} />) : g.items.map((s) => (
              <li key={s.id} className={`a-scan${s.voided ? ' is-void' : ''}`}>
                <span className="a-scan__time">{formatTime(s.checked_in_at)}</span>
                <div className="a-scan__main">
                  <div className="a-scan__point">{s.point_name}</div>
                  <div className="a-scan__who">{s.provider_name}</div>
                </div>
                <div className="a-scan__flags">
                  {s.outcome !== OUTCOME_ACCEPTED && <Badge tone="danger">{OUTCOMES[s.outcome] ?? s.outcome}</Badge>}
                  {s.voided && <Badge tone="danger">מבוטלת{s.void_reason ? `: ${s.void_reason}` : ''}</Badge>}
                  {s.distance_m != null && <Badge>{s.distance_m} מ׳ מהנקודה</Badge>}
                  {s.flags.map((f) => <Badge key={f} tone={FLAGS[f]?.tone}>{FLAGS[f]?.label ?? f}</Badge>)}
                </div>
                <div className="a-scan__tools">
                  {s.outcome === OUTCOME_ACCEPTED && (s.voided
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
