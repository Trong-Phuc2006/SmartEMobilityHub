import test from 'node:test'
import assert from 'node:assert/strict'
import { ApiError, createHttpClient } from '../src/Services/http.js'
import { createAuthApi } from '../src/Services/auth.js'
import { createAuthSession } from '../src/Services/session.js'
import { resolveRoute } from '../src/Services/navigation.js'
import { validateAuthForm } from '../src/Services/auth-validation.js'

const user = { user_id: 'test-id', email: 'student@example.com', role: 'STUDENT' }
const credentials = { email: ' Student@Example.COM ', password: 'fixture-password', confirmPassword: 'fixture-password' }
const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
const failure = (code, status) => new ApiError(code, { status })
function deferred() {
  let resolve, reject
  const promise = new Promise((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}

test('Auth API sends exact JSON fields/credentials, no Origin/Authorization and no GET body', async () => {
  const calls = []
  const http = createHttpClient({ baseUrl: 'http://localhost:3000', fetchImpl: async (url, options) => {
    calls.push({ url, options })
    return json({ ok: true, data: url.endsWith('logout') ? { logged_out: true } : { user } },
      url.endsWith('register') ? 201 : 200)
  } })
  const api = createAuthApi(http)
  assert.deepEqual(await api.register({ ...credentials, role: 'OPERATOR' }), user)
  await api.login(credentials)
  await api.me()
  await api.logout()
  assert.deepEqual(calls.map(({ url }) => new URL(url).pathname), ['/auth/register', '/auth/login', '/auth/me', '/auth/logout'])
  for (const { options } of calls) {
    assert.equal(options.credentials, 'include')
    assert.equal(Object.hasOwn(options.headers, 'Origin'), false)
    assert.equal(Object.hasOwn(options.headers, 'Authorization'), false)
  }
  for (const index of [0, 1]) {
    const body = JSON.parse(calls[index].options.body)
    assert.deepEqual(Object.keys(body).sort(), ['email', 'password'])
    assert.equal(body.email, user.email)
    assert.equal(body.password === credentials.password, true)
    assert.equal(calls[index].options.headers['Content-Type'], 'application/json')
  }
  assert.equal(Object.hasOwn(calls[2].options, 'body'), false)
  assert.equal(calls[2].options.method, 'GET')
  assert.deepEqual(JSON.parse(calls[3].options.body), {})
})

test('HTTP client preserves safe error codes/fields, distinguishes network/protocol/cancellation', async () => {
  const api = createHttpClient({ baseUrl: '', fetchImpl: async () => json({
    ok: false, error: { code: 'EMAIL_EXISTS', message: 'not parsed by UI', fieldErrors: { email: 'EMAIL_EXISTS' } },
  }, 409) })
  await assert.rejects(api.request('/auth/register'), (error) => error.code === 'EMAIL_EXISTS' &&
    error.status === 409 && error.fieldErrors.email === 'EMAIL_EXISTS')
  const network = createHttpClient({ baseUrl: '', fetchImpl: async () => { throw new TypeError('private network detail') } })
  await assert.rejects(network.request('/'), (error) => error.code === 'NETWORK_ERROR' && error.kind === 'network')
  for (const response of [new Response('<html>stack</html>', { status: 503 }), json({ unexpected: true })]) {
    const invalid = createHttpClient({ baseUrl: '', fetchImpl: async () => response })
    await assert.rejects(invalid.request('/'), (error) => error.code === 'UNEXPECTED_RESPONSE')
  }
  const controller = new AbortController()
  controller.abort()
  const abort = createHttpClient({ baseUrl: '', fetchImpl: async () => { throw new DOMException('Aborted', 'AbortError') } })
  await assert.rejects(abort.request('/', { signal: controller.signal }), { name: 'AbortError' })
})

test('public user projection rejects incompatible data and cannot expose extra credentials', async () => {
  const valid = createAuthApi(createHttpClient({ baseUrl: '', fetchImpl: async () => json({
    ok: true, data: { user: { ...user, unnecessary_private_field: 'fixture' } },
  }) }))
  assert.deepEqual(await valid.me(), user)
  const invalid = createAuthApi(createHttpClient({ baseUrl: '', fetchImpl: async () => json({
    ok: true, data: { user: { ...user, role: 'OPERATOR' } },
  }) }))
  await assert.rejects(invalid.me(), (error) => error.code === 'UNEXPECTED_RESPONSE')
})

test('shared validation follows email rules, Unicode password boundaries and UI-only confirmation', () => {
  assert.deepEqual(validateAuthForm('register', credentials), {})
  assert.equal(validateAuthForm('register', { ...credentials, email: 'bad' }).email, 'INVALID_EMAIL')
  assert.equal(validateAuthForm('register', { email: '', password: '', confirmPassword: '' }).email, 'REQUIRED')
  assert.equal(validateAuthForm('register', { ...credentials, password: 'short' }).password, 'PASSWORD_LENGTH')
  assert.equal(validateAuthForm('register', { ...credentials, confirmPassword: 'other' }).confirmPassword, 'PASSWORD_MISMATCH')
  for (const length of [8, 128]) {
    const password = '🔋'.repeat(length)
    assert.deepEqual(validateAuthForm('register', { ...credentials, password, confirmPassword: password }), {})
  }
  assert.equal(validateAuthForm('register', { ...credentials, password: '🔋'.repeat(129) }).password, 'PASSWORD_LENGTH')
  assert.deepEqual(validateAuthForm('login', { email: credentials.email, password: 'x' }), {})
})

test('session restore is StrictMode-safe and ignores cancelled/out-of-order responses', async () => {
  const first = deferred(), second = deferred()
  let calls = 0
  const session = createAuthSession({ me: () => (++calls === 1 ? first.promise : second.promise) })
  const stale = session.restore()
  session.cancel() // StrictMode effect cleanup
  const fresh = session.restore()
  second.reject(failure('AUTH_REQUIRED', 401))
  await fresh
  first.resolve(user)
  await stale
  assert.equal(session.getSnapshot().status, 'unauthenticated')
  assert.equal(session.getSnapshot().user, null)
})

test('an older Me response cannot override a newer Login or Logout result', async () => {
  const old = deferred()
  const session = createAuthSession({ me: () => old.promise, login: async () => user, logout: async () => {} })
  const restoring = session.restore()
  await session.login(credentials)
  assert.equal(session.getSnapshot().status, 'authenticated')
  await session.logout()
  old.resolve(user)
  await restoring
  assert.equal(session.getSnapshot().status, 'unauthenticated')
  assert.equal(session.getSnapshot().user, null)
})

test('transient restore failure remains unknown with Retry, while terminal failures clear identity', async () => {
  let response = 'success'
  const session = createAuthSession({
    me: async () => {
      if (response === 'success') return user
      throw failure(response, response === 'SERVICE_UNAVAILABLE' ? 503 : 401)
    },
  })
  await session.restore()
  response = 'SERVICE_UNAVAILABLE'
  await session.restore()
  assert.equal(session.getSnapshot().status, 'error')
  assert.deepEqual(session.getSnapshot().user, user)
  response = 'success'
  await session.restore()
  assert.equal(session.getSnapshot().status, 'authenticated')
  response = 'SESSION_EXPIRED'
  await session.restore()
  assert.equal(session.getSnapshot().status, 'unauthenticated')
  assert.equal(session.getSnapshot().notice, 'SESSION_EXPIRED')
})

test('logout failure does not fabricate success and repeated mutations do not duplicate requests', async () => {
  let mode = 'failure', count = 0
  const pending = deferred()
  const session = createAuthSession({
    me: async () => user,
    logout: async () => { count++; if (mode === 'failure') throw failure('NETWORK_ERROR', 0); await pending.promise },
  })
  await session.restore()
  assert.equal(await session.logout(), false)
  assert.equal(session.getSnapshot().status, 'error')
  assert.deepEqual(session.getSnapshot().user, user)
  assert.equal(session.getSnapshot().error.operation, 'logout')
  mode = 'success'
  const first = session.logout(), second = session.logout()
  assert.equal(first, second)
  await session.restore() // focus/route restore cannot overtake pending Logout
  pending.resolve()
  await first
  assert.equal(count, 2)
  assert.equal(session.getSnapshot().user, null)
  assert.equal(session.getSnapshot().status, 'unauthenticated')
})

test('shared client terminal failures can invalidate a future protected API without a second client', async () => {
  let called = false
  const http = createHttpClient({ baseUrl: '', onAuthFailure: () => { called = true }, fetchImpl: async () => json({
    ok: false, error: { code: 'SESSION_EXPIRED', message: 'fixture', fieldErrors: {} },
  }, 401) })
  await assert.rejects(http.request('/protected'))
  assert.equal(called, true)
  called = false
  await assert.rejects(http.request('/auth/me', { notifyAuthFailure: false }))
  assert.equal(called, false)
})

test('hash guards allow only approved public/protected destinations', () => {
  for (const hash of ['#/parking', '#/overview', '#/bad', '']) {
    assert.equal(resolveRoute(hash, 'unauthenticated'), '#/login')
  }
  assert.equal(resolveRoute('#/register', 'unauthenticated'), '#/register')
  assert.equal(resolveRoute('#/overview', 'authenticated'), '#/overview')
  for (const hash of ['#/login', '#/register', '#/bad', '']) {
    assert.equal(resolveRoute(hash, 'authenticated'), '#/parking')
  }
})
