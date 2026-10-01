import React, { useState } from 'react'
import { adminApi, errorText } from '../api.js'
import { useLoad, formatDateTime } from '../hooks.js'
import { Modal, Field, Badge, EmptyState, Spinner, IconButton, useToast, useConfirm, useAction } from '../ui.jsx'
import { IconPlus, IconBan, IconCheck, IconShield, IconAlert, IconTrash } from '../icons.jsx'

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

function AddDialog({ onClose, onAdded }) {
  const toast = useToast()
  const [email, setEmail] = useState('')
  const [name, setName] = useState('')
  const [error, setError] = useState('')
  const [busy, run] = useAction(toast, errorText)
  const submit = async (e) => {
    e.preventDefault()
    if (!EMAIL_RE.test(email.trim())) return setError('כתובת מייל לא תקינה.')
    const res = await run(() => adminApi('/admins', { method: 'POST', body: { email: email.trim(), name: name.trim() } }), 'חבר הוועד נוסף')
    if (res) onAdded()
  }
  return (
    <Modal title="חבר ועד חדש" onClose={onClose} size="sm"
      footer={(
        <>
          <button type="button" className="w-btn w-btn--quiet w-btn--small" onClick={onClose}>ביטול</button>
          <button type="submit" form="admin-form" className="w-btn w-btn--small" disabled={busy}>{busy ? 'מוסיף…' : 'הוספה'}</button>
        </>
      )}>
      <form id="admin-form" className="a-form" onSubmit={submit} noValidate>
        <Field label="כתובת Gmail" error={error} hint="האדם ייכנס עם חשבון Google של הכתובת הזו. אין סיסמה שצריך לשלוח.">
          <input className="a-input" type="email" dir="ltr" value={email} onChange={(e) => { setEmail(e.target.value); setError('') }} autoComplete="off" />
        </Field>
        <Field label="שם (לא חובה)">
          <input className="a-input" value={name} onChange={(e) => setName(e.target.value)} maxLength={120} />
        </Field>
      </form>
    </Modal>
  )
}

export default function CommitteeView({ admin }) {
  const toast = useToast()
  const confirm = useConfirm()
  const admins = useLoad(() => adminApi('/admins'))
  const [adding, setAdding] = useState(false)
  const [busy, run] = useAction(toast, errorText)
  const list = admins.data?.admins ?? []

  const toggle = async (a) => {
    if (a.is_active) {
      const ok = await confirm({
        title: `להסיר את הגישה של ${a.name || a.email}?`,
        body: 'הוא ינותק מיד ולא יוכל להיכנס לניהול. אפשר להחזיר את הגישה בכל עת.',
        confirmLabel: 'הסרת גישה', danger: true,
      })
      if (!ok) return
    }
    if (await run(() => adminApi(`/admins/${a.id}`, { method: 'PATCH', body: { is_active: !a.is_active } }), a.is_active ? 'הגישה הוסרה' : 'הגישה הוחזרה')) admins.reload()
  }

  // Deleting takes the person off the list for good (you cannot delete yourself); removing access only shuts them out.
  const deleteMember = async (a) => {
    const ok = await confirm({
      title: `למחוק את ${a.name || a.email} מהוועד?`,
      body: 'הכתובת נמחקת מהרשימה והחשבון מתנתק מיד. אפשר להוסיף את אותה כתובת שוב בכל עת. כדי רק לעצור את הכניסה, אפשר להסיר גישה במקום.',
      confirmLabel: 'מחיקה מהוועד', danger: true,
    })
    if (ok && await run(() => adminApi(`/admins/${a.id}`, { method: 'DELETE' }), 'חבר הוועד נמחק')) admins.reload()
  }

  return (
    <>
      <div className="a-head">
        <div>
          <h1>חברי הוועד</h1>
          <p>מי רשאי להיכנס לניהול. הכניסה תמיד עם חשבון Google.</p>
        </div>
        <div className="a-actions"><IconButton icon={IconPlus} label="חבר ועד חדש" tone="primary" onClick={() => setAdding(true)} /></div>
      </div>

      {admins.status === 'loading' && <Spinner />}
      {admins.status === 'error' && !admins.data && (
        <EmptyState icon={IconAlert} title="לא הצלחנו לטעון" action={<button className="w-btn w-btn--small" onClick={admins.reload}>נסו שוב</button>} />
      )}
      {admins.status === 'ready' && list.length === 0 && <EmptyState icon={IconShield} title="הרשימה ריקה" />}

      <div className="a-grid">
        {list.map((a) => {
          const me = a.id === admin.id
          return (
            <article key={a.id} className={`a-card${a.is_active ? '' : ' is-off'}`}>
              <div className="a-card__top">
                <div>
                  <h2 className="a-card__title">{a.name || 'חבר ועד'}{me && ' (אתם)'}</h2>
                  {/* an address reads left to right, but it lines up with the title like the other cards' second line */}
                  <p className="a-card__sub"><bdi dir="ltr">{a.email}</bdi></p>
                </div>
                {/* your own card has no icons: you cannot remove or delete yourself */}
                {!me && (
                  <div className="a-card__tools">
                    <IconButton icon={a.is_active ? IconBan : IconCheck} label={a.is_active ? 'הסרת גישה' : 'החזרת גישה'} onClick={() => toggle(a)} disabled={busy} />
                    <IconButton icon={IconTrash} label="מחיקה מהוועד" tone="danger" onClick={() => deleteMember(a)} disabled={busy} />
                  </div>
                )}
              </div>
              <div className="a-meta"><Badge tone={a.is_active ? 'ok' : 'neutral'}>{a.is_active ? 'פעיל' : 'הוסר'}</Badge></div>
              <dl className="a-facts"><dt>כניסה אחרונה</dt><dd>{a.last_login_at ? formatDateTime(a.last_login_at) : 'עוד לא נכנס'}</dd></dl>
            </article>
          )
        })}
      </div>

      {adding && <AddDialog onClose={() => setAdding(false)} onAdded={() => { setAdding(false); admins.reload() }} />}
    </>
  )
}
