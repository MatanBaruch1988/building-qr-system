import React, { useState } from 'react'
import { adminApi, errorText, copyText } from '../api.js'
import { useLoad, SERVICE_TYPES, serviceLabel, LANG_OPTIONS, formatDateTime } from '../hooks.js'
import { Modal, Field, Badge, Switch, EmptyState, Spinner, IconButton, useToast, useConfirm, useAction } from '../ui.jsx'
import { IconPlus, IconEdit, IconKey, IconDevice, IconBan, IconCheck, IconCopy, IconRefresh, IconUsers, IconAlert } from '../icons.jsx'

// No look-alike characters (0/o, 1/l/i): the password gets read out or typed from a message.
const ALPHABET = 'abcdefghjkmnpqrstuvwxyz23456789'
function generatePassword() {
  const bytes = crypto.getRandomValues(new Uint32Array(8))
  const s = [...bytes].map((n) => ALPHABET[n % ALPHABET.length]).join('')
  return `${s.slice(0, 4)}-${s.slice(4)}`
}

function PasswordBox({ value, onChange, id, ...aria }) {
  const toast = useToast()
  return (
    <div className="a-secret" style={{ padding: 8 }}>
      <input id={id} className="a-input a-code" value={value} onChange={(e) => onChange(e.target.value)} maxLength={200} autoComplete="new-password" spellCheck="false" {...aria} />
      <button type="button" className="w-btn w-btn--ghost w-btn--small" onClick={() => onChange(generatePassword())}><IconRefresh size={18} />יצירה</button>
      <button type="button" className="a-icon-btn" aria-label="העתקת הסיסמה" disabled={!value}
        onClick={async () => toast.ok((await copyText(value)) ? 'הסיסמה הועתקה' : 'ההעתקה נכשלה')}><IconCopy /></button>
    </div>
  )
}

/** The password only exists in this screen: the server keeps a hash. Show it once, clearly. */
function PasswordHandover({ provider, password, onClose }) {
  const toast = useToast()
  return (
    <Modal title="הסיסמה נשמרה" onClose={onClose} size="sm" footer={<button className="w-btn w-btn--small" onClick={onClose}>סיימתי</button>}>
      <p className="w-lead">מסרו את הסיסמה ל<strong>{provider.contact_name || provider.company}</strong>. היא לא תוצג שוב, אבל אפשר תמיד להגדיר חדשה.</p>
      <div className="a-secret">
        <span className="a-code" style={{ fontSize: '1.375rem', fontWeight: 600 }}>{password}</span>
        <button className="a-icon-btn" aria-label="העתקת הסיסמה" onClick={async () => toast.ok((await copyText(password)) ? 'הסיסמה הועתקה' : 'ההעתקה נכשלה')}><IconCopy /></button>
      </div>
    </Modal>
  )
}

/* ------------------------------------------------------------ edit form */

function ProviderForm({ provider, onClose, onSaved }) {
  const toast = useToast()
  const [form, setForm] = useState(provider
    ? { company: provider.company, contact_name: provider.contact_name, service_type: provider.service_type ?? '', lang: provider.lang, password: '', is_demo: provider.is_demo, is_active: provider.is_active }
    : { company: '', contact_name: '', service_type: '', lang: 'he', password: generatePassword(), is_demo: false, is_active: true })
  const [errors, setErrors] = useState({})
  const [busy, run] = useAction(toast, errorText)
  const set = (k, v) => { setForm((f) => ({ ...f, [k]: v })); setErrors((e) => ({ ...e, [k]: undefined })) }

  const submit = async (e) => {
    e.preventDefault()
    const next = {}
    if (!form.company.trim()) next.company = 'צריך שם חברה או שם.'
    if (!provider && form.password.length < 8) next.password = 'סיסמה של 8 תווים לפחות.'
    if (provider && form.password && form.password.length < 8) next.password = 'סיסמה של 8 תווים לפחות, או להשאיר ריק.'
    setErrors(next)
    if (Object.keys(next).length) return
    const body = {
      company: form.company.trim(), contact_name: form.contact_name.trim(), service_type: form.service_type || null,
      lang: form.lang, is_demo: form.is_demo, ...(provider ? { is_active: form.is_active } : {}),
      ...(form.password ? { password: form.password } : {}),
    }
    const res = await run(
      () => adminApi(provider ? `/providers/${provider.id}` : '/providers', { method: provider ? 'PATCH' : 'POST', body }),
      provider ? 'נותן השירות עודכן' : 'נותן השירות נוסף',
    )
    if (res) onSaved(res.provider, form.password || null)
  }

  return (
    <Modal
      title={provider ? `עריכה: ${provider.contact_name || provider.company}` : 'נותן שירות חדש'}
      onClose={onClose}
      footer={(
        <>
          <button type="button" className="w-btn w-btn--quiet w-btn--small" onClick={onClose}>ביטול</button>
          <button type="submit" form="provider-form" className="w-btn w-btn--small" disabled={busy}>{busy ? 'שומר…' : 'שמירה'}</button>
        </>
      )}
    >
      <form id="provider-form" className="a-form" onSubmit={submit} noValidate>
        <Field label="חברה" error={errors.company}>
          <input className="a-input" value={form.company} onChange={(e) => set('company', e.target.value)} maxLength={120} placeholder="לדוגמה: ניקיון אלון" />
        </Field>
        <Field label="שם העובד" hint="השם שיופיע ברשימה במסך הכניסה של הטלפון.">
          <input className="a-input" value={form.contact_name} onChange={(e) => set('contact_name', e.target.value)} maxLength={120} />
        </Field>
        <div className="a-form-row">
          <Field label="סוג שירות">
            <select className="a-input" value={form.service_type} onChange={(e) => set('service_type', e.target.value)}>
              <option value="">לא מוגדר</option>
              {SERVICE_TYPES.map((s) => <option key={s.value} value={s.value}>{s.label}</option>)}
            </select>
          </Field>
          <Field label="שפת הממשק בטלפון">
            <select className="a-input" value={form.lang} onChange={(e) => set('lang', e.target.value)}>
              {LANG_OPTIONS.map((l) => <option key={l.value} value={l.value}>{l.label}</option>)}
            </select>
          </Field>
        </div>
        <Field label={provider ? 'סיסמה חדשה (לא חובה)' : 'סיסמה'} error={errors.password}
          hint={provider ? 'להשאיר ריק כדי לא לשנות. שינוי סיסמה מנתק את העובד מכל המכשירים.' : 'העובד יזין אותה פעם אחת בטלפון. אפשר ליצור סיסמה קלה להקלדה.'}>
          <PasswordBox value={form.password} onChange={(v) => set('password', v)} />
        </Field>
        <Switch checked={form.is_demo} onChange={(v) => set('is_demo', v)} label="חשבון דמו"
          hint="לניסויים והדגמות. מורשה לסרוק בכל הנקודות, והסריקות שלו מסומנות ולא נכנסות לדוחות ולנתוני האייג'נט." />
        {provider && (
          <Switch checked={form.is_active} onChange={(v) => set('is_active', v)} label="פעיל"
            hint="מושבת אינו יכול להיכנס, וההיסטוריה שלו נשמרת." />
        )}
      </form>
    </Modal>
  )
}

/** Quick "new password" flow for someone who forgot theirs. */
function PasswordDialog({ provider, onClose, onSaved }) {
  const toast = useToast()
  const [password, setPassword] = useState(generatePassword)
  const [error, setError] = useState('')
  const [busy, run] = useAction(toast, errorText)
  const submit = async (e) => {
    e.preventDefault()
    if (password.length < 8) return setError('סיסמה של 8 תווים לפחות.')
    const res = await run(() => adminApi(`/providers/${provider.id}`, { method: 'PATCH', body: { password } }))
    if (res) onSaved(res.provider, password)
  }
  return (
    <Modal title={`סיסמה חדשה: ${provider.contact_name || provider.company}`} onClose={onClose} size="sm"
      footer={(
        <>
          <button type="button" className="w-btn w-btn--quiet w-btn--small" onClick={onClose}>ביטול</button>
          <button type="submit" form="password-form" className="w-btn w-btn--small" disabled={busy}>{busy ? 'שומר…' : 'שמירה וניתוק מכשירים'}</button>
        </>
      )}>
      <form id="password-form" className="a-form" onSubmit={submit} noValidate>
        <Field label="סיסמה" error={error} hint="הסיסמה הישנה תפסיק לעבוד והעובד ינותק מכל המכשירים.">
          <PasswordBox value={password} onChange={(v) => { setPassword(v); setError('') }} />
        </Field>
      </form>
    </Modal>
  )
}

/* ------------------------------------------------------------------ view */

export default function ProvidersView() {
  const toast = useToast()
  const confirm = useConfirm()
  const providers = useLoad(() => adminApi('/providers'))
  const [editing, setEditing] = useState(null)
  const [resetting, setResetting] = useState(null)
  const [handover, setHandover] = useState(null)
  const [busy, run] = useAction(toast, errorText)
  const list = providers.data?.providers ?? []

  const toggleActive = async (p) => {
    if (p.is_active) {
      const ok = await confirm({
        title: `להשבית את ${p.contact_name || p.company}?`,
        body: 'העובד ינותק מכל המכשירים ולא יוכל להיכנס. כל הנוכחויות שלו נשמרות, ואפשר להפעיל אותו שוב בכל עת.',
        confirmLabel: 'השבתה', danger: true,
      })
      if (!ok) return
    }
    if (await run(() => adminApi(`/providers/${p.id}`, { method: 'PATCH', body: { is_active: !p.is_active } }), p.is_active ? 'נותן השירות הושבת' : 'נותן השירות הופעל')) providers.reload()
  }

  const revokeDevices = async (p) => {
    const ok = await confirm({
      title: 'לנתק את כל המכשירים?',
      body: `${p.contact_name || p.company} יצטרך להיכנס שוב עם הסיסמה בכל טלפון. מתאים למכשיר שאבד.`,
      confirmLabel: 'ניתוק', danger: true,
    })
    if (ok && await run(() => adminApi(`/providers/${p.id}/revoke-devices`, { method: 'POST' }), 'המכשירים נותקו')) providers.reload()
  }

  return (
    <>
      <div className="a-head">
        <div>
          <h1>נותני שירות</h1>
          <p>מי רשאי לרשום נוכחות. כל אחד נכנס בטלפון עם שם וסיסמה אישית.</p>
        </div>
        <div className="a-actions"><IconButton icon={IconPlus} label="נותן שירות חדש" tone="primary" onClick={() => setEditing('new')} /></div>
      </div>

      {providers.status === 'loading' && <Spinner />}
      {providers.status === 'error' && !providers.data && (
        <EmptyState icon={IconAlert} title="לא הצלחנו לטעון" action={<button className="w-btn w-btn--small" onClick={providers.reload}>נסו שוב</button>} />
      )}
      {providers.status !== 'loading' && list.length === 0 && !providers.error && (
        <EmptyState icon={IconUsers} title="עוד אין נותני שירות"
          action={<button className="w-btn w-btn--small" onClick={() => setEditing('new')}><IconPlus size={20} />הוסיפו נותן שירות</button>}>
          הוסיפו את חברת הניקיון והגנן, והגדירו לכל אחד סיסמה אישית.
        </EmptyState>
      )}

      <div className="a-grid">
        {list.map((p) => (
          <article key={p.id} className={`a-card${p.is_active ? '' : ' is-off'}`}>
            <div className="a-card__top">
              <div>
                <h2 className="a-card__title">{p.contact_name || p.company}</h2>
                {p.contact_name && <p className="a-card__sub">{p.company}</p>}
              </div>
              <div className="a-card__tools">
                <IconButton icon={IconEdit} label="עריכה" onClick={() => setEditing(p)} />
                <IconButton icon={IconKey} label="סיסמה חדשה" onClick={() => setResetting(p)} />
                {p.active_devices > 0 && <IconButton icon={IconDevice} label="ניתוק מכשירים" onClick={() => revokeDevices(p)} disabled={busy} />}
                <IconButton icon={p.is_active ? IconBan : IconCheck} label={p.is_active ? 'השבתה' : 'הפעלה'} onClick={() => toggleActive(p)} disabled={busy} />
              </div>
            </div>
            <div className="a-meta">
              <Badge tone={p.is_active ? 'ok' : 'neutral'}>{p.is_active ? 'פעיל' : 'מושבת'}</Badge>
              {p.service_type && <Badge tone="info">{serviceLabel(p.service_type)}</Badge>}
              <Badge>{LANG_OPTIONS.find((l) => l.value === p.lang)?.label}</Badge>
              {p.is_demo && <Badge tone="warn">דמו</Badge>}
              {!p.has_password && <Badge tone="danger">אין סיסמה</Badge>}
            </div>
            <dl className="a-facts">
              <dt>נוכחות אחרונה</dt><dd>{formatDateTime(p.last_scan_at)}</dd>
              <dt>מכשירים מחוברים</dt><dd>{p.active_devices}</dd>
            </dl>
          </article>
        ))}
      </div>

      {editing && (
        <ProviderForm
          provider={editing === 'new' ? null : editing}
          onClose={() => setEditing(null)}
          onSaved={(saved, password) => { setEditing(null); providers.reload(); if (password) setHandover({ provider: saved, password }) }}
        />
      )}
      {resetting && (
        <PasswordDialog
          provider={resetting}
          onClose={() => setResetting(null)}
          onSaved={(saved, password) => { setResetting(null); providers.reload(); setHandover({ provider: saved, password }) }}
        />
      )}
      {handover && <PasswordHandover {...handover} onClose={() => setHandover(null)} />}
    </>
  )
}
