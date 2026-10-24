import test from 'node:test'
import assert from 'node:assert/strict'
import { createAuthRuntime } from '../src/Services/auth.js'
import { createHttpClient } from '../src/Services/http.js'
import { createParkingApi, filterSpaces, ownershipLabel, parkingStatus } from '../src/Services/parking.js'

const hub = { hub_id: 'hub/a ?🔋', name: 'Alpha', location_type: null, total_parking_capacity: 5 }
const rows = [
  { space_id: 'A-Long-UUID', hub_id: hub.hub_id, state: 'AVAILABLE', has_current_reservation: false, is_mine: false },
  { space_id: 'B-Mine', hub_id: hub.hub_id, state: 'RESERVED', has_current_reservation: true, is_mine: true },
  { space_id: 'C-Other', hub_id: hub.hub_id, state: 'OCCUPIED', has_current_reservation: true, is_mine: false },
  { space_id: 'D-Unknown', hub_id: hub.hub_id, state: 'OCCUPIED', has_current_reservation: false, is_mine: false },
]
const payload = { hub, summary: { total_spaces: 4, available: 1, reserved: 1, occupied: 2 }, spaces: rows }
const json = (data, status = 200) => new Response(JSON.stringify({ ok: true, data }), { status, headers: { 'Content-Type': 'application/json' } })

test('Parking API shares credentials/cancellation, exact paths, opaque URL encoding and whitelisted DTOs', async () => {
  const calls = []
  const controller = new AbortController()
  const api = createParkingApi(createHttpClient({ baseUrl: 'http://localhost:3000', fetchImpl: async (url, options) => {
    calls.push({ url, options })
    return url.endsWith('/hubs') ? json({ hubs: [{ ...hub, private: 'ignore' }] }) : json({
      ...payload, spaces: rows.map((row) => ({ ...row, email: 'should-not-be-public@example.com' })),
    })
  } }))
  assert.deepEqual(await api.hubs({ signal: controller.signal }), [hub])
  assert.deepEqual(await api.spaces(hub.hub_id, { signal: controller.signal }), payload)
  assert.equal(calls[1].url, 'http://localhost:3000/hubs/' + encodeURIComponent(hub.hub_id) + '/parking-spaces')
  for (const { options } of calls) {
    assert.equal(options.method, 'GET')
    assert.equal(options.credentials, 'include')
    assert.equal(options.signal, controller.signal)
    assert.equal(Object.hasOwn(options, 'body'), false)
    assert.equal(Object.hasOwn(options.headers, 'Authorization'), false)
  }
})

test('empty Hub list and empty spaces are valid, distinct responses', async () => {
  const api = createParkingApi(createHttpClient({ baseUrl: '', fetchImpl: async (url) => url === '/hubs'
    ? json({ hubs: [] }) : json({ hub, summary: { total_spaces: 0, available: 0, reserved: 0, occupied: 0 }, spaces: [] }) }))
  assert.deepEqual(await api.hubs(), [])
  assert.deepEqual((await api.spaces(hub.hub_id)).spaces, [])
})

test('Parking rejects wrong Hub, counts, states, duplicates or ownership instead of presenting fabricated data', async () => {
  for (const mutate of [
    (p) => { p.hub.hub_id = 'wrong-hub' }, (p) => { p.summary.available = 42 },
    (p) => { p.spaces[0].state = 'available' }, (p) => { p.spaces[0].is_mine = true },
    (p) => { p.spaces[1].space_id = p.spaces[0].space_id }, (p) => { p.spaces[1].hub_id = 'wrong-hub' },
    (p) => { p.spaces[1].has_current_reservation = false },
  ]) {
    const data = structuredClone(payload)
    mutate(data)
    const api = createParkingApi(createHttpClient({ baseUrl: '', fetchImpl: async () => json(data) }))
    await assert.rejects(api.spaces(hub.hub_id), { code: 'UNEXPECTED_RESPONSE' })
  }
})

test('status/ownership labels and badge classes preserve uppercase API enums without private identity', () => {
  assert.deepEqual(rows.map(ownershipLabel), ['—', 'Của bạn', 'Người dùng khác', 'Chưa có thông tin'])
  assert.deepEqual(Object.values(parkingStatus).map((s) => s.label), ['Còn trống', 'Đã đặt', 'Đang sử dụng'])
  assert.deepEqual(Object.values(parkingStatus).map((s) => s.className), ['em-badge-available', 'em-badge-reserved', 'em-badge-occupied'])
})

test('All/Available/Mine and trimmed case-insensitive ID search never change source totals', () => {
  assert.equal(filterSpaces(rows, 'all', '').length, 4)
  assert.deepEqual(filterSpaces(rows, 'available', '').map((r) => r.space_id), ['A-Long-UUID'])
  assert.deepEqual(filterSpaces(rows, 'mine', '').map((r) => r.space_id), ['B-Mine'])
  assert.deepEqual(filterSpaces(rows, 'all', '  LONG-uuid ').map((r) => r.space_id), ['A-Long-UUID'])
  assert.equal(filterSpaces(rows, 'mine', 'Other').length, 0)
  assert.equal(filterSpaces(rows, 'all', 'missing').length, 0)
  assert.equal(payload.summary.total_spaces, 4)
})

test('protected Parking terminal errors use the existing Auth session; transient failures retain identity', async () => {
  let mode = 'success'
  const user = { user_id: 'student', email: 'test@example.com', role: 'STUDENT' }
  const runtime = createAuthRuntime({ baseUrl: '', fetchImpl: async (url) => {
    if (url === '/auth/me') return json({ user })
    if (mode === 'network') throw new TypeError('private detail')
    const terminal = mode === 'SESSION_EXPIRED'
    return new Response(JSON.stringify({ ok: false, error: { code: mode, message: 'fixture', fieldErrors: {} } }), {
      status: terminal ? 401 : 503, headers: { 'Content-Type': 'application/json' },
    })
  } })
  await runtime.session.restore()
  const api = createParkingApi(runtime.http)
  for (mode of ['SERVICE_UNAVAILABLE', 'network']) {
    await assert.rejects(api.hubs())
    assert.equal(runtime.session.getSnapshot().status, 'authenticated')
    assert.deepEqual(runtime.session.getSnapshot().user, user)
  }
  mode = 'SESSION_EXPIRED'
  await assert.rejects(api.spaces(hub.hub_id))
  assert.equal(runtime.session.getSnapshot().status, 'unauthenticated')
  assert.equal(runtime.session.getSnapshot().user, null)
})

test('Parking cancellation propagates AbortError through the existing client', async () => {
  const controller = new AbortController()
  controller.abort()
  const api = createParkingApi(createHttpClient({ baseUrl: '', fetchImpl: async () => { throw new DOMException('Aborted', 'AbortError') } }))
  await assert.rejects(api.hubs({ signal: controller.signal }), { name: 'AbortError' })
})
