import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { adminApi, auditLog, errorText } from '../api.js'
import { useLoad, LOAD_KEY } from '../hooks.js'
import { loadCacheEpoch, readLoadCache, writeLoadCache } from '../loadCache.js'
import { Field, EmptyState, Spinner, IconButton, DateInput, useToast, useAction } from '../ui.jsx'
import { IconClock, IconRefresh, IconAlert } from '../icons.jsx'
import { formatDay, formatTime, isoDay } from '../../../shared/datetime.js'
import { GROUP_OPTIONS } from '../auditLabels.js'
import { describeEntry, actorText } from '../auditDescribe.js'

// The audit log: what the committee's members (and the system) did, and when (ADR 0007, decision 4). Read only, so a row has no
// actions and there is no file to export: it answers "who switched this point off?" and "who removed this member?".
// Built like the history screen: filters that query after a short pause, rows grouped by building day, and a page at a time.
//
// It is the body of the section "יומן פעולות" at the foot of the Committee tab (CommitteeView.jsx), not a tab of its own: six
// tabs do not fit the phone's bar at 360 px without wrapping a label (see the pull request), so the section has the heading
// (an <h2>, the opening button) and this component has what is under it, with the days as <h3>.

const PAGE = 50
const EMPTY_FILTERS = { from: '', to: '', group: '', actor_id: '' }

// A date typed digit by digit passes through nonsense ("0002-…"); only complete, sensible dates are sent.
const goodDate = (v) => /^\d{4}-\d{2}-\d{2}$/.test(v) && Number(v.slice(0, 4)) >= 2000

/** The filters that are set, as the API takes them: nothing empty, and only a complete, sensible date. */
function params(filters) {
  const out = {}
  for (const [key, value] of Object.entries(filters)) {
    if (!value) continue
    if ((key === 'from' || key === 'to') && !goodDate(value)) continue
    out[key] = value
  }
  return out
}

// The first page of each set of filters is kept for the session (src/admin/loadCache.js), so that opening the log again draws it at once
// while the current one is asked for. The key is every filter that is set, so a filter never shows the entries of another. Only the first
// page is kept: "load more" pages are not.
const cacheKey = (filters) => `audit:${new URLSearchParams({ ...params(filters), limit: String(PAGE) }).toString()}`
/** The first page that this screen showed for these filters before, as the state of the list; `null` when there is none. */
function rememberedList(filters) {
  const kept = readLoadCache(cacheKey(filters))
  return kept ? { entries: kept.entries, cursor: kept.cursor, status: 'ready' } : null
}

/** One line of detail. The values are bidi-isolated: a name or a number inside Hebrew keeps its own direction. */
function Line({ line }) {
  if (line.kind === 'text') return <div>{line.text}</div>
  if (line.kind === 'field') return <div>{line.label}: <bdi>{line.value}</bdi></div>
  return (
    <div>
      {line.label}: <bdi>{line.from}</bdi> <span className="a-audit__arrow" role="img" aria-label="הפך ל">←</span> <bdi>{line.to}</bdi>
    </div>
  )
}

/** One entry: read only. The time, what was done and about what, who did it, and the detail. Everything is text. */
function EntryRow({ entry }) {
  const { phrase, subject, actor, lines } = describeEntry(entry)
  return (
    <li className="a-audit">
      <span className="a-scan__time a-audit__time">{formatTime(entry.at)}</span>
      <div className="a-audit__what">
        {phrase.known
          ? <span className="a-audit__action">{phrase.text}</span>
          : <span className="a-audit__action a-audit__action--raw" dir="ltr">{phrase.text}</span>}
        {subject && <> <span aria-hidden="true">·</span> <bdi className="a-audit__subject">{subject}</bdi></>}
      </div>
      <div className="a-audit__who">על ידי <bdi>{actorText(actor)}</bdi></div>
      {lines.length > 0 && (
        <div className="a-audit__detail">
          {lines.map((line, i) => <Line key={i} line={line} />)}
        </div>
      )}
    </li>
  )
}

export default function AuditView() {
  const toast = useToast()
  const members = useLoad(() => adminApi('/admins'), [], { cacheKey: LOAD_KEY.admins }) // the same list as the Committee tab
  const [filters, setFilters] = useState(EMPTY_FILTERS) // what the inputs show
  const [applied, setApplied] = useState(filters) // what is actually queried (after a short pause in typing)
  // The list starts with the page that was kept for the first filters, if there is one (the log was open before in this session).
  const [{ entries, cursor, status }, setList] = useState(() => rememberedList(filters) ?? { entries: [], cursor: null, status: 'loading' })
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
    const key = cacheKey(applied)
    const asked = loadCacheEpoch()
    setList(shown ?? { entries: [], cursor: null, status: 'loading' }) // never show the old filter's rows under the new one
    try {
      const res = await auditLog({ ...params(applied), limit: PAGE })
      const page = { entries: res.entries, cursor: res.next_cursor }
      writeLoadCache(key, page, asked) // for these filters, whatever the screen is doing by now
      if (mine !== seq.current) return
      setList({ ...page, status: 'ready' })
      if (shown) seq.current += 1 // a "load more" that was asked for the page above belongs to a list that has just been replaced
    } catch (err) {
      if (mine !== seq.current) return
      if (!shown) setList({ entries: [], cursor: null, status: 'error' })
      toast.error(errorText(err))
    }
  }, [applied, toast])
  const load = useCallback(() => fetchFirstPage(null), [fetchFirstPage]) // the refresh button and "try again": from the loading state, as ever
  useEffect(() => { fetchFirstPage(rememberedList(applied)) }, [fetchFirstPage, applied])

  const more = async () => {
    const mine = seq.current
    const res = await run(() => auditLog({ ...params(applied), limit: PAGE, cursor }))
    if (!res || mine !== seq.current) return // the filters changed meanwhile: this page belongs to an old query
    setList((s) => {
      const have = new Set(s.entries.map((e) => e.id))
      return { ...s, entries: [...s.entries, ...res.entries.filter((e) => !have.has(e.id))], cursor: res.next_cursor }
    })
  }

  const set = (key, value) => setFilters((f) => ({ ...f, [key]: value }))
  const filtered = Object.keys(params(applied)).length > 0

  // Rows of one building day sit together under the date, newest day first (the API's order).
  const days = useMemo(() => {
    const out = []
    for (const entry of entries) {
      const date = isoDay(entry.at)
      const last = out[out.length - 1]
      if (last && last.date === date) last.items.push(entry)
      else out.push({ date, items: [entry] })
    }
    return out
  }, [entries])

  return (
    <>
      <div className="a-head">
        <div>
          <p>מי עשה מה ומתי: שינויים של חברי הוועד ופעולות אוטומטיות של המערכת. הרשימה לקריאה בלבד.</p>
        </div>
        <div className="a-actions">
          <IconButton icon={IconRefresh} label="רענון היומן" onClick={load} />
        </div>
      </div>

      <div className="a-filters">
        <Field label="מתאריך"><DateInput value={filters.from} onChange={(v) => set('from', v)} /></Field>
        <Field label="עד תאריך"><DateInput value={filters.to} onChange={(v) => set('to', v)} /></Field>
        <Field label="סוג פעולה">
          <select className="a-input" value={filters.group} onChange={(e) => set('group', e.target.value)}>
            {GROUP_OPTIONS.map((g) => <option key={g.value} value={g.value}>{g.label}</option>)}
          </select>
        </Field>
        <Field label="חבר ועד">
          <select className="a-input" value={filters.actor_id} onChange={(e) => set('actor_id', e.target.value)}>
            <option value="">כל החברים</option>
            {(members.data?.admins ?? []).map((a) => <option key={a.id} value={a.id}>{a.name || a.email}</option>)}
          </select>
        </Field>
      </div>

      {status === 'loading' && <Spinner />}
      {status === 'error' && (
        <EmptyState icon={IconAlert} title="לא הצלחנו לטעון" action={<button className="w-btn w-btn--small" onClick={load}>נסו שוב</button>} />
      )}
      {status === 'ready' && entries.length === 0 && (filtered
        ? <EmptyState icon={IconClock} title="אין פעולות בטווח הזה">נסו להרחיב את טווח התאריכים או לשנות את הסינון.</EmptyState>
        : <EmptyState icon={IconClock} title="עוד לא נרשמו פעולות">פעולות של חברי הוועד יופיעו כאן.</EmptyState>)}

      {days.map((day) => (
        <section key={day.date} aria-label={formatDay(day.date)}>
          <h3 className="a-day">{formatDay(day.date)} · {day.items.length}</h3>
          <ul className="a-scans">
            {day.items.map((entry) => <EntryRow key={entry.id} entry={entry} />)}
          </ul>
        </section>
      ))}

      {cursor && status === 'ready' && (
        <div style={{ display: 'grid', placeItems: 'center', marginBlockStart: 18 }}>
          <button className="w-btn w-btn--ghost w-btn--small" onClick={more} disabled={busy}>{busy ? 'טוען…' : 'טעינת עוד'}</button>
        </div>
      )}
    </>
  )
}
