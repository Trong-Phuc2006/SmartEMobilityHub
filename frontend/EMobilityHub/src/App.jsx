import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react'
import Login from './Pages/Login.jsx'
import Register from './Pages/Register.jsx'
import ParkingDashboard from './Pages/ParkingDashboard.jsx'
import VehicleDashboard from './Pages/VehicleDashboard.jsx'
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
  const [hubSelection, setHubSelection] = useState(null)
  const [vehicleView, setVehicleView] = useState(null)
  const userId = state.user?.user_id
  const selectHub = useCallback(hubId => setHubSelection({ userId, hubId }), [userId])
  const selectVehicleScope = useCallback(scope => setVehicleView({ userId, scope }), [userId])
  const actionBusy = useRef(false)
  const [operationRoute, setOperationRoute] = useState(null)
  const reportBusy = useCallback(value => {
    actionBusy.current = value
    setOperationRoute(value ? window.location.hash : null)
  }, [])
  useEffect(() => {
    void session.restore()
    const recheck = () => {
      const current = session.getSnapshot()
      if (current.status === 'authenticated' && !current.logoutPending && !actionBusy.current) void session.restore()
    }
    const visible = () => { if (document.visibilityState === 'visible') recheck() }
    // Chromium can emit window focus when a native dialog closes without ever
    // blurring the window. Rechecking then remounts Parking and loses dialog focus.
    // A real return from another window still revalidates the current account.
    let wasBlurred = false
    const blurred = () => { wasBlurred = true }
    const focused = () => { if (wasBlurred) { wasBlurred = false; recheck() } }
    window.addEventListener('hashchange', recheck)
    window.addEventListener('blur', blurred)
    window.addEventListener('focus', focused)
    document.addEventListener('visibilitychange', visible)
    return () => {
      session.cancel()
      window.removeEventListener('hashchange', recheck)
      window.removeEventListener('blur', blurred)
      window.removeEventListener('focus', focused)
      document.removeEventListener('visibilitychange', visible)
    }
  }, [session])
  useEffect(() => {
    const target = state.status === 'authenticated' && operationRoute ? operationRoute : route
    if (!['restoring', 'error'].includes(state.status) && hash !== target) navigate(target, true)
  }, [hash, route, state.status, operationRoute])
  function loggedOut() {
    setRegistration(null)
    setHubSelection(null)
    setVehicleView(null)
    navigate('#/login', true)
  }
  async function logout() {
    if (await session.logout()) loggedOut()
  }
  if (['restoring', 'error'].includes(state.status)) {
    return <SessionGate state={state} session={session} onLoggedOut={loggedOut} />
  }
  if (state.status === 'authenticated') {
    const displayedRoute = operationRoute || route
    const Dashboard = displayedRoute === '#/vehicle' || displayedRoute === '#/overview/vehicle' ? VehicleDashboard : ParkingDashboard
    return <Dashboard http={runtime.http} user={state.user} route={displayedRoute} pending={state.logoutPending} onLogout={logout}
      initialHub={hubSelection?.userId === userId ? hubSelection.hubId : ''} onSelectedHub={selectHub} onBusy={reportBusy}
      initialScope={vehicleView?.userId === userId ? vehicleView.scope : 'hub'} onVehicleScope={selectVehicleScope} />
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
      setHubSelection(null)
      setVehicleView(null)
      navigate('#/parking', true)
    }} />
}

export default App
