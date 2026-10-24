import { useState } from 'react'

export default function FormField({ name, label, value, onChange, onBlur, password = false, autoComplete, error, hint }) {
  const [visible, setVisible] = useState(false)
  const id = 'auth-' + name
  const describedBy = [hint && id + '-hint', error && id + '-error'].filter(Boolean).join(' ') || undefined
  return (
    <div className="form-field">
      <label htmlFor={id}>{label}</label>
      <div className="input-wrap">
        <input id={id} name={name} type={password ? (visible ? 'text' : 'password') : 'email'}
          value={value} required autoComplete={autoComplete}
          autoCapitalize="none" spellCheck={false}
          aria-invalid={Boolean(error)} aria-describedby={describedBy}
          onChange={(event) => onChange(event.target.value)} onBlur={onBlur} />
        {password && <button className="password-toggle" type="button" aria-pressed={visible}
          aria-label={(visible ? 'Ẩn ' : 'Hiện ') + label.toLowerCase()}
          onClick={() => setVisible(!visible)}>{visible ? 'Ẩn' : 'Hiện'}</button>}
      </div>
      {hint && <p className="field-hint" id={id + '-hint'}>{hint}</p>}
      {error && <p className="field-error" id={id + '-error'}>{error}</p>}
    </div>
  )
}
