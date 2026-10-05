import { useId, useState } from 'react'
import { adminApi, errorText } from '../api.js'
import { useLoad, formatDateTime } from '../hooks.js'
import { Modal, Field, Badge, EmptyState, Spinner, IconButton, useToast, useConfirm, useAction } from '../ui.jsx'
import { IconPlus, IconBan, IconCheck, IconShield, IconAlert, IconTrash } from '../icons.jsx'
import { ADDRESS_MAX_LENGTH, NAME_MAX_LENGTH } from '../../../shared/contract.js'
import BuildLabel from '../../ui/BuildLabel.jsx'

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

// The same limits as the server (shared/contract.js), so that the person is told before sending.
const CONTROL_RE = /[\p{Cc}\p{Zl}\p{Zp}]/u

/**
 * The building's address: shown at the top of the service providers' app, kept in the database of this committee.
 * It can stay empty, and then that app shows no address. One field and a save button, so there are no row actions here
 * (and the card is not an <article>: the committee members' cards are).
 */
function BuildingCard() {
  const titleId = useId()
  const toast = useToast()
  const [busy, run] = useAction(toast, errorText)
  const [stored, setStored] = useState('') // as the server has it
  const [text, setText] = useState('') // what the field says now
  const [error, setError] = useState('')
  const loaded = useLoad(async () => {
    const { building } = await adminApi('/building')
    setStored(building.address)
    setText(building.address)
    return building
  })

  const address = text.trim()
  const changed = address !== stored
  const submit = async (e) => {
    e.preventDefault()
    if (busy || !changed) return
    if (CONTROL_RE.test(address)) return setError('הכתובת מכילה תווים שאי אפשר לשמור, למשל ירידת שורה.')
    const res = await run(
      () => adminApi('/building', { method: 'PUT', body: { address } }),
      address ? 'כתובת הבניין נשמרה' : 'כתובת הבניין הוסרה',
    )
    if (res) {
      setStored(res.building.address)
      setText(res.building.address)
    }
  }

  return (
    <section className="a-card a-card--form" aria-labelledby={titleId}>
      <h2 className="a-card__title" id={titleId}>פרטי הבניין</h2>
      {loaded.status === 'loading' && <Spinner />}
      {loaded.status === 'error' && !loaded.data && (
        <>
          <p className="w-error" role="alert"><IconAlert size={18} />לא הצלחנו לטעון את פרטי הבניין.</p>
          <div className="a-actions"><button type="button" className="w-btn w-btn--small w-btn--quiet" onClick={loaded.reload}>נסו שוב</button></div>
        </>
      )}
      {loaded.data && (
        <form className="a-form" onSubmit={submit} noValidate>
          <Field label="כתובת הבניין" error={error}
            hint="הכתובת מופיעה בראש האפליקציה של נותני השירות, בדרך כלל תוך דקה מהשמירה. אפשר להשאיר ריק, ואז לא תוצג כתובת.">
            {/* dir="auto": the address is typed in any language, and each one should read the right way round */}
            <input className="a-input" dir="auto" value={text} maxLength={ADDRESS_MAX_LENGTH} autoComplete="off"
              onChange={(e) => { setText(e.target.value); setError('') }} />
          </Field>
          <div className="a-actions">
            <button type="submit" className="w-btn w-btn--small" disabled={busy || !changed}>{busy ? 'שומר…' : 'שמירה'}</button>
          </div>
        </form>
      )}
    </section>
  )
}

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
          <input className="a-input" value={name} onChange={(e) => setName(e.target.value)} maxLength={NAME_MAX_LENGTH} />
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

      <BuildingCard />

      {/* Which build this computer or phone runs. The one place that both layouts reach (the tab bar and the side rail). */}
      <BuildLabel label="גרסה" className="a-build" />

      {adding && <AddDialog onClose={() => setAdding(false)} onAdded={() => { setAdding(false); admins.reload() }} />}
    </>
  )
}
