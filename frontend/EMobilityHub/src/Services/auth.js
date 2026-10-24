import { ApiError, createHttpClient } from './http.js'
import { createAuthSession } from './session.js'

export function normalizeEmail(email) {
  return email.trim().toLowerCase()
}

export function createAuthApi(http) {
  async function userRequest(path, method, body, status, options) {
    const result = await http.request(path, { ...options, method, body, notifyAuthFailure: false })
    const user = result.data.user
    if (result.status !== status || !user || typeof user.user_id !== 'string' ||
      typeof user.email !== 'string' || user.role !== 'STUDENT') {
      throw new ApiError('UNEXPECTED_RESPONSE', { status: result.status, kind: 'protocol' })
    }
    return { user_id: user.user_id, email: user.email, role: user.role }
  }
  return {
    register: ({ email, password }, options) => userRequest('/auth/register', 'POST',
      { email: normalizeEmail(email), password }, 201, options),
    login: ({ email, password }, options) => userRequest('/auth/login', 'POST',
      { email: normalizeEmail(email), password }, 200, options),
    me: (options) => userRequest('/auth/me', 'GET', undefined, 200, options),
    async logout(options) {
      const result = await http.request('/auth/logout', {
        ...options, method: 'POST', body: {}, notifyAuthFailure: false,
      })
      if (result.status !== 200 || result.data.logged_out !== true) {
        throw new ApiError('UNEXPECTED_RESPONSE', { status: result.status, kind: 'protocol' })
      }
    },
  }
}

export function createAuthRuntime(options) {
  let session
  const http = createHttpClient({ ...options, onAuthFailure: (error) => session.invalidate(error) })
  const api = createAuthApi(http)
  session = createAuthSession(api)
  return { http, api, session }
}
