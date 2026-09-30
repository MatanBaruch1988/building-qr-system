import React, { useState } from 'react'
import { adminApi, errorText, copyText } from '../api.js'
import { useLoad, formatDateTime } from '../hooks.js'
import { Modal, Field, Badge, EmptyState, Spinner, useToast, useConfirm, useAction } from '../ui.jsx'
import { IconPlus, IconKey, IconCopy, IconBan, IconAlert, IconInfo } from '../icons.jsx'

function NewKeyDialog({ onClose, onCreated }) {
  const toast = useToast()
  const [name, setName] = useState('')
  const [error, setError] = useState('')
  const [created, setCreated] = useState(null)
  const [busy, run] = useAction(toast, errorText)

  const submit = async (e) => {
    e.preventDefault()
    if (!name.trim()) return setError('תנו למפתח שם, כדי שתדעו למה הוא משמש.')
    const res = await run(() => adminApi('/api-keys', { method: 'POST', body: { name: name.trim() } }))
    if (res) { setCreated(res); onCreated() }
  }

  if (created) {
    return (
      // A different key from the form below: the dialog remounts, so focus moves into it and assistive
      // technology announces that the one-time key is now on screen.
      <Modal key="created" title="המפתח נוצר" onClose={onClose} size="sm" footer={<button className="w-btn w-btn--small" onClick={onClose}>שמרתי אותו</button>}>
        <div className="w-banner w-banner--warn"><IconAlert /><div className="w-banner__body">זו הפעם היחידה שהמפתח מוצג. העתיקו אותו עכשיו ושמרו במקום בטוח.</div></div>
        <div className="a-secret">
          <span className="a-code" data-testid="new-key">{created.key}</span>
          <button className="a-icon-btn" aria-label="העתקת המפתח" onClick={async () => toast.ok((await copyText(created.key)) ? 'המפתח הועתק' : 'ההעתקה נכשלה')}><IconCopy /></button>
        </div>
      </Modal>
    )
  }
  return (
    <Modal key="form" title="מפתח גישה חדש" onClose={onClose} size="sm"
      footer={(
        <>
          <button type="button" className="w-btn w-btn--quiet w-btn--small" onClick={onClose}>ביטול</button>
          <button type="submit" form="key-form" className="w-btn w-btn--small" disabled={busy}>{busy ? 'יוצר…' : 'יצירה'}</button>
        </>
      )}>
      <form id="key-form" className="a-form" onSubmit={submit} noValidate>
        <Field label="שם המפתח" error={error} hint="לדוגמה: הסוכן של הוועד. המפתח נותן קריאה בלבד, אי אפשר לשנות דרכו שום דבר.">
          <input className="a-input" value={name} onChange={(e) => { setName(e.target.value); setError('') }} maxLength={80} />
        </Field>
      </form>
    </Modal>
  )
}

export default function AgentView() {
  const toast = useToast()
  const confirm = useConfirm()
  const keys = useLoad(() => adminApi('/api-keys'))
  const [creating, setCreating] = useState(false)
  const [busy, run] = useAction(toast, errorText)
  const list = keys.data?.api_keys ?? []
  const base = `${window.location.origin}/api/agent/v1`

  const revoke = async (k) => {
    const ok = await confirm({
      title: `לבטל את המפתח "${k.name}"?`,
      body: 'כל מי שמשתמש בו יאבד גישה מיד. אי אפשר לשחזר מפתח שבוטל, אבל אפשר ליצור חדש.',
      confirmLabel: 'ביטול המפתח', danger: true,
    })
    if (ok && await run(() => adminApi(`/api-keys/${k.id}`, { method: 'DELETE' }), 'המפתח בוטל')) keys.reload()
  }

  const prompt = `You have read-only access to the attendance log of our building's service providers (cleaning, gardening).
Base URL: ${base}
Authorization: Bearer <API KEY>
Start with GET ${base}/schema : it explains every field, flag and rule.
Main endpoint: GET ${base}/scans?from=YYYY-MM-DD&to=YYYY-MM-DD (also point_id, provider_id, flag, outcome=all|accepted|rejected, limit, cursor, format=csv).
Times are Israel time (checked_in_local, local_date). Flags are signals, not verdicts: report them, do not treat them as proof of anything.`

  return (
    <>
      <div className="a-head">
        <div>
          <h1>גישה לאייג'נט</h1>
          <p>נתוני הנוכחות זמינים לקריאה בלבד לכל אייג'נט שמחזיק במפתח. האפליקציה עצמה לא מנתחת כלום.</p>
        </div>
        <button className="w-btn w-btn--small" onClick={() => setCreating(true)}><IconPlus size={20} />מפתח חדש</button>
      </div>

      {keys.status === 'loading' && <Spinner />}
      {keys.status === 'error' && !keys.data && (
        <EmptyState icon={IconAlert} title="לא הצלחנו לטעון את המפתחות" action={<button className="w-btn w-btn--small" onClick={keys.reload}>נסו שוב</button>} />
      )}
      {keys.status === 'ready' && list.length === 0 && (
        <EmptyState icon={IconKey} title="עוד אין מפתחות" action={<button className="w-btn w-btn--small" onClick={() => setCreating(true)}><IconPlus size={20} />יצירת מפתח</button>}>
          צרו מפתח ותנו אותו לאייג'נט שיקרא את הנתונים.
        </EmptyState>
      )}

      <div className="a-grid">
        {list.map((k) => (
          <article key={k.id} className={`a-card${k.revoked_at ? ' is-off' : ''}`}>
            <div className="a-card__top">
              <h2 className="a-card__title">{k.name}</h2>
              <Badge tone={k.revoked_at ? 'neutral' : 'ok'}>{k.revoked_at ? 'בוטל' : 'פעיל'}</Badge>
            </div>
            <dl className="a-facts">
              <dt>מפתח</dt><dd className="a-code">{k.key_prefix}…</dd>
              <dt>נוצר</dt><dd>{formatDateTime(k.created_at)}</dd>
              <dt>שימוש אחרון</dt><dd>{k.last_used_at ? formatDateTime(k.last_used_at) : 'עוד לא נעשה בו שימוש'}</dd>
            </dl>
            {!k.revoked_at && (
              <div className="a-card__actions">
                <button className="w-btn w-btn--ghost w-btn--small" onClick={() => revoke(k)} disabled={busy}><IconBan size={20} />ביטול המפתח</button>
              </div>
            )}
          </article>
        ))}
      </div>

      <section className="a-card" style={{ marginBlockStart: 24 }} aria-labelledby="how-to">
        <h2 id="how-to" className="a-card__title"><IconInfo size={20} style={{ verticalAlign: '-3px' }} /> איך האייג'נט מתחבר</h2>
        <p className="w-lead">כתובת ה-API: <span className="a-code">{base}</span></p>
        <p className="w-small">הדביקו לאייג'נט את ההנחיה הבאה (בלי המפתח עצמו, אותו מסרו בנפרד):</p>
        <pre className="a-secret a-code" style={{ whiteSpace: 'pre-wrap', margin: 0, alignItems: 'flex-start' }}>{prompt}</pre>
        <div className="a-card__actions">
          <button className="w-btn w-btn--ghost w-btn--small" onClick={async () => toast.ok((await copyText(prompt)) ? 'ההנחיה הועתקה' : 'ההעתקה נכשלה')}><IconCopy size={20} />העתקת ההנחיה</button>
        </div>
      </section>

      {creating && <NewKeyDialog onClose={() => setCreating(false)} onCreated={keys.reload} />}
    </>
  )
}
