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
          type="text"
          value={form.code}
          onChange={e => onChange({ ...form, code: e.target.value })}
          placeholder="לדוגמא: 1234"
          required
        />
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
