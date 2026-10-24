export function resolveRoute(hash, status) {
  const publicRoute = hash === '#/login' || hash === '#/register'
  const protectedRoute = hash === '#/parking' || hash === '#/overview'
  if (status === 'authenticated') return protectedRoute ? hash : '#/parking'
  return publicRoute ? hash : '#/login'
}

export function navigate(hash, replace = false) {
  if (window.location.hash === hash) return
  if (replace) {
    window.history.replaceState(null, '', hash)
    window.dispatchEvent(new HashChangeEvent('hashchange'))
  } else window.location.hash = hash
}

export function subscribeHash(listener) {
  window.addEventListener('hashchange', listener)
  return () => window.removeEventListener('hashchange', listener)
}

export const getHash = () => window.location.hash
