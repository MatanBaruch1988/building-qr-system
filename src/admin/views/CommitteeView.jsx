import { useId, useState } from 'react'
import { adminApi, errorText } from '../api.js'
import { useLoad, formatDateTime } from '../hooks.js'
import { Modal, Field, Badge, EmptyState, Spinner, IconButton, useToast, useConfirm, useAction } from '../ui.jsx'
import { IconPlus, IconBan, IconCheck, IconShield, IconAlert, IconTrash, IconClock, IconChevron } from '../icons.jsx'
import { ADDRESS_MAX_LENGTH, BUILDING_NAME_MAX_LENGTH, NAME_MAX_LENGTH } from '../../../shared/contract.js'
import { useBuildingName } from '../buildingName.jsx'
import BuildLabel from '../../ui/BuildLabel.jsx'
import AuditView from './AuditView.jsx'
import HelpSection from './HelpSection.jsx'

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

// The same limits as the server (shared/contract.js), so that the person is told before sending.
const CONTROL_RE = /[\p{Cc}\p{Zl}\p{Zp}]/u

// What the field says when the server refused it (a limit or a character that the form could not know about).
const FIELD_REFUSED = {
  address: 'הכתובת לא נשמרה: היא ארוכה מדי או מכילה תווים שאי אפשר לשמור.',
  name: 'השם לא נשמר: הוא ארוך מדי או מכיל תווים שאי אפשר לשמור.',
}

/** What the toast says after a save, by what the person changed: the address alone, the name alone, or both. */
function savedMessage({ addressChanged, nameChanged }, building) {
  if (addressChanged && nameChanged) return 'פרטי הבניין נשמרו'
  if (nameChanged) return building.name ? 'שם הבניין נשמר' : 'שם הבניין הוסר'
  return building.address ? 'כתובת הבניין נשמרה' : 'כתובת הבניין הוסרה'
}

/**
 * The building's name and address: shown at the top of the service providers' app (the name above the address) and, the name, in the
 * committee app too. Both are kept in the database of this committee and either can stay empty (the apps then show nothing for it).
 * One form and one save button for the two, so there are no row actions here (and the card is not an <article>: the committee
 * members' cards are). A save tells the committee app the name that the server now has, so its brand follows with no reload.
 */
function BuildingCard() {
  const titleId = useId()
  const toast = useToast()
  const { setName: showName } = useBuildingName()
  const [busy, run] = useAction(toast, errorText)
  const [stored, setStored] = useState({ address: '', name: '' }) // as the server has it
  const [addressText, setAddressText] = useState('') // what the fields say now
  const [nameText, setNameText] = useState('')
  const [errors, setErrors] = useState({ address: '', name: '' })

  // Takes what the server has (a load, a save) into the fields and the brand. A server from before names existed sends no name.
  const take = (building) => {
    const next = { address: building.address, name: building.name ?? '' }
    setStored(next)
    setAddressText(next.address)
    setNameText(next.name)
    showName(next.name)
  }
  const loaded = useLoad(async () => {
    const { building } = await adminApi('/building')
    take(building)
    return building
  })

  const address = addressText.trim()
  const name = nameText.trim()
  const addressChanged = address !== stored.address
  const nameChanged = name !== stored.name
  const changed = addressChanged || nameChanged
  const submit = async (e) => {
    e.preventDefault()
    if (busy || !changed) return
    const next = {
      address: CONTROL_RE.test(address) ? 'הכתובת מכילה תווים שאי אפשר לשמור, למשל ירידת שורה.' : '',
      name: CONTROL_RE.test(name) ? 'השם מכיל תווים שאי אפשר לשמור, למשל ירידת שורה.' : '',
    }
    if (next.address || next.name) return setErrors(next)
    // The server says which field it refused (`invalid_field` with `field`): that one shows under its own field, and nothing else
    // is said. Any other failure is the usual toast.
    const res = await run(async () => {
      try {
        return await adminApi('/building', { method: 'PUT', body: { address, name } })
      } catch (err) {
        const field = err?.code === 'invalid_field' ? err.extra?.field : undefined
        if (field !== 'address' && field !== 'name') throw err
        setErrors({ address: '', name: '', [field]: FIELD_REFUSED[field] })
        return null
      }
    })
    if (!res) return
    take(res.building)
    toast.ok(savedMessage({ addressChanged, nameChanged }, res.building))
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
          <Field label="שם הבניין" error={errors.name}
            hint="השם מופיע בראש שתי האפליקציות, מעל הכתובת. בלי שם, הכותרת בוועד היא נוכחות בבניין.">
            {/* dir="auto": the name is typed in any language, and each one should read the right way round */}
            <input className="a-input" dir="auto" value={nameText} maxLength={BUILDING_NAME_MAX_LENGTH} autoComplete="off"
              onChange={(e) => { setNameText(e.target.value); setErrors((r) => ({ ...r, name: '' })) }} />
          </Field>
          <Field label="כתובת הבניין" error={errors.address}
            hint="הכתובת מופיעה בראש האפליקציה של נותני השירות, בדרך כלל תוך דקה מהשמירה. אפשר להשאיר ריק, ואז לא תוצג כתובת.">
            {/* dir="auto": the address is typed in any language, and each one should read the right way round */}
            <input className="a-input" dir="auto" value={addressText} maxLength={ADDRESS_MAX_LENGTH} autoComplete="off"
              onChange={(e) => { setAddressText(e.target.value); setErrors((r) => ({ ...r, address: '' })) }} />
          </Field>
          <div className="a-actions">
            <button type="submit" className="w-btn w-btn--small" disabled={busy || !changed}>{busy ? 'שומר…' : 'שמירה'}</button>
          </div>
        </form>
      )}
    </section>
  )
}

/**
 * The audit log (who did what, and when), a section that a button opens: read only, so it has no row actions. It is here and not
 * a tab of its own because six tabs do not fit the phone's bar at 360 px. The button is the heading of the section (the usual
 * way to build one that opens), and the log is loaded only when it is opened.
 */
function AuditSection() {
  const id = useId()
  const [open, setOpen] = useState(false)
  return (
    <section className="a-audit-section" aria-labelledby={`${id}-title`}>
      <h2 className="a-disclosure" id={`${id}-title`}>
        <button type="button" className="a-disclosure__btn" aria-expanded={open} aria-controls={`${id}-panel`} onClick={() => setOpen((o) => !o)}>
          <IconClock size={24} />
          <span className="a-disclosure__text">יומן פעולות</span>
          <IconChevron size={22} className="a-disclosure__chevron" />
        </button>
      </h2>
      <div id={`${id}-panel`} hidden={!open}>{open && <AuditView />}</div>
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

      <HelpSection />

      {/* Which build this computer or phone runs. The one place that both layouts reach (the tab bar and the side rail). */}
      <BuildLabel label="גרסה" className="a-build" />

      <AuditSection />

      {adding && <AddDialog onClose={() => setAdding(false)} onAdded={() => { setAdding(false); admins.reload() }} />}
    </>
  )
}
