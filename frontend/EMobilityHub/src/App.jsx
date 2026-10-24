import { useEffect, useState, useSyncExternalStore } from 'react'
import Login from './Pages/Login.jsx'
import Register from './Pages/Register.jsx'
import ParkingDashboard from './Pages/ParkingDashboard.jsx'
import SessionGate from './Components/SessionGate.jsx'
import { createAuthRuntime, normalizeEmail } from './Services/auth.js'
import { sessionMessage } from './Services/auth-validation.js'
import { getHash, navigate, resolveRoute, subscribeHash } from './Services/navigation.js'
import './App.css'

function App() {
  const [runtime] = useState(() => createAuthRuntime({ baseUrl: import.meta.env.VITE_API_BASE_URL }))
  const [registration, setRegistration] = useState(null)
  const { session, api } = runtime
  const state = useSyncExternalStore(session.subscribe, session.getSnapshot)
  const hash = useSyncExternalStore(subscribeHash, getHash)
  const route = resolveRoute(hash, state.status)
  useEffect(() => {
    void session.restore()
    const recheck = () => {
      const current = session.getSnapshot()
      if (current.status === 'authenticated' && !current.logoutPending) void session.restore()
    }
    const visible = () => { if (document.visibilityState === 'visible') recheck() }
    window.addEventListener('hashchange', recheck)
    window.addEventListener('focus', recheck)
    document.addEventListener('visibilitychange', visible)
    return () => {
      session.cancel()
      window.removeEventListener('hashchange', recheck)
      window.removeEventListener('focus', recheck)
      document.removeEventListener('visibilitychange', visible)
    }
  }, [session])
  useEffect(() => {
    if (!['restoring', 'error'].includes(state.status) && hash !== route) navigate(route, true)
  }, [hash, route, state.status])
  function loggedOut() {
    setRegistration(null)
    navigate('#/login', true)
  }
  async function logout() {
    if (await session.logout()) loggedOut()
  }
  if (['restoring', 'error'].includes(state.status)) {
    return <SessionGate state={state} session={session} onLoggedOut={loggedOut} />
  }
  if (state.status === 'authenticated') {
    return <ParkingDashboard http={runtime.http} user={state.user} route={route} pending={state.logoutPending} onLogout={logout} />
  }
  if (route === '#/register') {
    return <Register onSubmit={api.register} onSuccess={(email) => {
      setRegistration({ email: normalizeEmail(email) })
      navigate('#/login', true)
    }} />
  }
  return <Login email={registration?.email} notice={sessionMessage(state.notice) || (registration
    ? 'Tạo tài khoản thành công. Vui lòng đăng nhập.' : '')}
    onSubmit={session.login} onSuccess={() => {
      setRegistration(null)
      navigate('#/parking', true)
    }} />
}

export default App
