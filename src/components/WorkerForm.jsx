import React from 'react'

function WorkerForm({ form, onChange }) {
  return (
    <>
      <div className="form-group">
        <label>שם משתמש *</label>
        <input
          type="text"
          value={form.company}
          onChange={e => onChange({ ...form, company: e.target.value })}
          placeholder="לדוגמא: חברת ניקיון ABC"
          required
        />
      </div>
      <div className="form-group">
        <label>קוד כניסה *</label>
        <input
          type="password"
          inputMode="numeric"
          pattern="[0-9]*"
          maxLength={10}
          value={form.code}
          onChange={e => onChange({ ...form, code: e.target.value.replace(/\D/g, '').slice(0, 10) })}
          placeholder="4-10 ספרות"
          required
        />
        <small style={{ color: 'var(--text-tertiary)', marginTop: '4px', display: 'block' }}>
          קוד כניסה: בין 4 ל-10 ספרות
        </small>
      </div>
      <div className="form-group">
        <label>שם איש קשר</label>
        <input
          type="text"
          value={form.name}
          onChange={e => onChange({ ...form, name: e.target.value })}
          placeholder="לדוגמא: יוסי כהן"
        />
      </div>
    </>
  )
}

export default WorkerForm
