import { useEffect, useRef, useState } from 'react'
import AuthLayout from './AuthLayout.jsx'
import FormField from './FormField.jsx'
import { errorMessage, fieldMessage, validateAuthForm } from '../Services/auth-validation.js'

export default function AuthForm({ mode, email = '', notice, onSubmit, onSuccess }) {
  const registering = mode === 'register'
  const [values, setValues] = useState({ email, password: '', confirmPassword: '' })
  const [errors, setErrors] = useState({})
  const [apiError, setApiError] = useState(null)
  const [pending, setPending] = useState(false)
  const busy = useRef(false)
  const mounted = useRef(false)
  const form = useRef(null)
  useEffect(() => {
    mounted.current = true
    return () => { mounted.current = false }
  }, [])
  function change(name, value) {
    setValues((previous) => ({ ...previous, [name]: value }))
    setErrors((previous) => ({ ...previous, [name]: undefined,
      ...(name === 'password' ? { confirmPassword: undefined } : {}) }))
    setApiError(null)
  }
  function blur(name) {
    const found = validateAuthForm(mode, values)
    setErrors((previous) => ({ ...previous, [name]: found[name] }))
  }
  function focusInvalid(found) {
    const name = ['email', 'password', 'confirmPassword'].find((key) => found[key])
    if (name) form.current?.elements.namedItem(name)?.focus()
  }
  async function submit(event) {
    event.preventDefault()
    if (busy.current) return
    const found = validateAuthForm(mode, values)
    setErrors(found)
    setApiError(null)
    if (Object.keys(found).length) { focusInvalid(found); return }
    busy.current = true
    setPending(true)
    try {
      const result = await onSubmit({ email: values.email, password: values.password })
      if (mounted.current && result !== false) {
        setValues((previous) => ({ ...previous, password: '', confirmPassword: '' }))
        onSuccess(values.email)
      }
    } catch (error) {
      if (!mounted.current || error.name === 'AbortError') return
      const fields = error.code === 'EMAIL_EXISTS' ? { email: 'EMAIL_EXISTS' } : error.fieldErrors || {}
      setErrors(fields)
      setApiError(error)
      // Inputs are re-enabled after the pending render; focus in the next frame.
      requestAnimationFrame(() => { if (mounted.current) focusInvalid(fields) })
    } finally {
      busy.current = false
      if (mounted.current) setPending(false)
    }
  }
  return (
    <AuthLayout title={registering ? 'Tạo tài khoản sinh viên' : 'Đăng nhập'}
      description={registering ? 'Đăng ký để sử dụng Smart E-Mobility Hub.' : 'Chào mừng bạn đến với Smart E-Mobility Hub.'}>
      {notice && <p className="notice" role="status">{notice}</p>}
      {apiError && <p className="notice notice-error" role="alert">{errorMessage(apiError)}</p>}
      <form ref={form} onSubmit={submit} noValidate aria-busy={pending}>
        <fieldset disabled={pending} className="auth-fields">
          <FormField name="email" label="Email" value={values.email} autoComplete="username"
            onChange={(value) => change('email', value)} onBlur={() => blur('email')}
            error={errors.email && fieldMessage(errors.email, mode)} />
          <FormField name="password" label="Mật khẩu" value={values.password} password
            autoComplete={registering ? 'new-password' : 'current-password'}
            hint={registering ? 'Từ 8 đến 128 ký tự.' : undefined}
            onChange={(value) => change('password', value)} onBlur={() => blur('password')}
            error={errors.password && fieldMessage(errors.password, mode)} />
          {registering && <FormField name="confirmPassword" label="Xác nhận mật khẩu" value={values.confirmPassword}
            password autoComplete="new-password"
            onChange={(value) => change('confirmPassword', value)} onBlur={() => blur('confirmPassword')}
            error={errors.confirmPassword && fieldMessage(errors.confirmPassword, mode)} />}
          <button className="button button-primary auth-submit" type="submit">
            {pending ? (registering ? 'Đang tạo tài khoản…' : 'Đang đăng nhập…') : (registering ? 'Tạo tài khoản' : 'Đăng nhập')}
          </button>
        </fieldset>
      </form>
      <p className="auth-footer">
        {registering ? 'Đã có tài khoản? ' : 'Chưa có tài khoản? '}
        <a href={registering ? '#/login' : '#/register'} aria-disabled={pending}
          onClick={(event) => { if (pending) event.preventDefault() }}>
          {registering ? 'Đăng nhập' : 'Tạo tài khoản'}
        </a>
      </p>
    </AuthLayout>
  )
}
