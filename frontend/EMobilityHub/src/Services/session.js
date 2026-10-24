import { isSessionFailure } from './http.js'

export function createAuthSession(api) {
  let state = { status: 'restoring', user: null, error: null, notice: null, logoutPending: false }
  let version = 0
  let active
  let mutation
  const listeners = new Set()
  const publish = (next) => {
    state = { ...state, ...next }
    listeners.forEach((listener) => listener())
  }
  function cancel() {
    version++
    active?.abort()
    active = undefined
  }
  function invalidate(error) {
    cancel()
    publish({ status: 'unauthenticated', user: null, error: null, notice: error.code, logoutPending: false })
  }
  async function restore() {
    if (mutation) return
    cancel()
    const current = version
    const controller = new AbortController()
    active = controller
    publish({ status: 'restoring', error: null })
    try {
      const user = await api.me({ signal: controller.signal })
      if (current === version && !controller.signal.aborted) {
        publish({ status: 'authenticated', user, error: null, notice: null, logoutPending: false })
      }
    } catch (error) {
      if (current !== version || controller.signal.aborted) return
      if (isSessionFailure(error)) invalidate(error)
      else publish({ status: 'error', error: { operation: 'restore', cause: error } })
    }
  }
  function login(values) {
    if (mutation) return mutation
    cancel()
    const current = version
    const controller = new AbortController()
    active = controller
    mutation = (async () => {
      try {
        const user = await api.login(values, { signal: controller.signal })
        if (current !== version || controller.signal.aborted) return false
        publish({ status: 'authenticated', user, error: null, notice: null })
        return true
      } finally {
        mutation = undefined
      }
    })()
    return mutation
  }
  function logout() {
    if (mutation) return mutation
    cancel()
    const current = version
    const controller = new AbortController()
    active = controller
    publish({ logoutPending: true, error: null })
    mutation = (async () => {
      try {
        await api.logout({ signal: controller.signal })
        if (current !== version || controller.signal.aborted) return false
        publish({ status: 'unauthenticated', user: null, error: null, notice: null, logoutPending: false })
        return true
      } catch (error) {
        if (current !== version || controller.signal.aborted) return false
        if (isSessionFailure(error)) invalidate(error)
        else publish({ status: 'error', error: { operation: 'logout', cause: error }, logoutPending: false })
        return false
      } finally {
        mutation = undefined
      }
    })()
    return mutation
  }
  return {
    getSnapshot: () => state,
    subscribe: (listener) => { listeners.add(listener); return () => listeners.delete(listener) },
    restore, login, logout, invalidate, cancel,
  }
}
