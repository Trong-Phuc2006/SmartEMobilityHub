import test from 'node:test'
import assert from 'node:assert/strict'
import { createHttpClient } from '../src/Services/http.js'
import { createAuthRuntime } from '../src/Services/auth.js'
import { createVehicleApi, vehicleDto, ownVehiclesDto, vehicleSummary, filterVehicles, canReserveVehicle, vehicleStatus, createVehicleLoader } from '../src/Services/vehicle.js'
import { resolveRoute } from '../src/Services/navigation.js'

const vehicle = (id, state = 'AVAILABLE', battery = 20, mine = false) => ({ vehicle_id: id, type: 'Xe đạp điện', battery_level: battery, state,
  hub_id: state === 'IN_USE' ? null : 'h/a ?', hub_name: state === 'IN_USE' ? null : 'Campus', has_current_reservation: ['RESERVED', 'IN_USE'].includes(state), is_mine: mine })
const rows = [vehicle('v19', 'AVAILABLE', 19), vehicle('v20'), vehicle('mine', 'IN_USE', 0, true), vehicle('other', 'RESERVED'), vehicle('offline', 'UNAVAILABLE', 100)]
const own = { ...rows[2], reservation_state: 'ACTIVE' }
const response = (data, status = 200) => new Response(JSON.stringify({ ok: true, data }), { status, headers: { 'Content-Type': 'application/json' } })
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no }); return { promise, resolve, reject } }

test('Vehicle exact GET/POST paths, credentials, encoded IDs, payload/status and private-field whitelist', async () => {
  const calls = []
  const api = createVehicleApi(createHttpClient({ baseUrl: '', fetchImpl: async (url, options) => {
    calls.push({ url, options })
    if (url === '/vehicle-reservations') return response({ reservations: [own] })
    if (options.method === 'GET') return response({ vehicles: rows.map(v => ({ ...v, private: 'omit' })), summary: vehicleSummary(rows) })
    const action = url.split('/').at(-1), id = 'id /?'
    const v = vehicle(id, { reserve: 'RESERVED', pickup: 'IN_USE', return: 'AVAILABLE', cancel: 'AVAILABLE' }[action], action === 'return' ? 65 : 20, ['reserve', 'pickup'].includes(action))
    return response({ vehicle: v, reservations: v.is_mine ? [{ ...v, reservation_state: action === 'reserve' ? 'RESERVED' : 'ACTIVE' }] : [] }, action === 'reserve' ? 201 : 200)
  } }))
  assert.deepEqual((await api.list()).vehicles, rows)
  assert.deepEqual(await api.own(), [own])
  for (const action of ['reserve', 'pickup', 'return', 'cancel']) {
    await api.mutate('id /?', action, { hub_id: 'h/a ?', battery_level: 65, user_id: 'never-send' })
    const { url, options } = calls.at(-1)
    assert.equal(url, '/vehicles/id%20%2F%3F/' + action); assert.equal(options.method, 'POST'); assert.equal(options.credentials, 'include')
    assert.deepEqual(JSON.parse(options.body), action === 'return' ? { hub_id: 'h/a ?', battery_level: 65 } : {})
    assert.equal(Object.hasOwn(options.headers, 'Authorization'), false)
  }
  await assert.rejects(api.mutate('id', 'invalid'), TypeError)
  const scoped = createVehicleApi(createHttpClient({ baseUrl: '', fetchImpl: async (url, options) => {
    assert.equal(url, '/vehicles?hub_id=h%2Fa%20%3F'); assert.equal(Object.hasOwn(options, 'body'), false)
    return response({ vehicles: [rows[0]], summary: vehicleSummary([rows[0]]) })
  } }))
  await scoped.list('h/a ?')
})

test('Vehicle DTO rejects malformed state/battery/location/ownership/summary/own rows and wrong success statuses', async () => {
  for (const patch of [{ battery_level: 20.5 }, { battery_level: '20' }, { battery_level: -1 }, { battery_level: 101 }, { state: 'available' }, { state: '__proto__' }, { hub_id: null }, { has_current_reservation: true }, { is_mine: true }]) assert.throws(() => vehicleDto({ ...rows[0], ...patch }), { code: 'UNEXPECTED_RESPONSE' })
  assert.deepEqual(vehicleDto({ ...rows[2], email: 'omit' }), rows[2])
  assert.throws(() => vehicleDto({ ...rows[2], hub_id: 'fake' }), { code: 'UNEXPECTED_RESPONSE' })
  for (const value of [null, [rows[0]], [{ ...own, reservation_state: 'RESERVED' }], [own, own]]) assert.throws(() => ownVehiclesDto(value), { code: 'UNEXPECTED_RESPONSE' })
  for (const data of [{ vehicles: rows, summary: {} }, { vehicles: [rows[0], rows[0]], summary: vehicleSummary([rows[0], rows[0]]) }]) {
    const api = createVehicleApi(createHttpClient({ baseUrl: '', fetchImpl: async () => response(data) }))
    await assert.rejects(api.list(), { code: 'UNEXPECTED_RESPONSE' })
  }
  for (const [status, data] of [[200, { vehicle: vehicle('v', 'RESERVED', 20, true), reservations: [] }], [201, { vehicle: rows[0], reservations: [] }]]) {
    const api = createVehicleApi(createHttpClient({ baseUrl: '', fetchImpl: async () => response(data, status) }))
    await assert.rejects(api.mutate('v', 'reserve'), { code: 'UNEXPECTED_RESPONSE' })
  }
})

test('Vehicle search/type, state filters, low battery eligibility, labels and protected routes', () => {
  assert.equal(filterVehicles(rows, 'all', '').length, 5); assert.equal(filterVehicles(rows, 'available', '').length, 2)
  assert.deepEqual(filterVehicles(rows, 'mine', ''), [rows[2]])
  assert.equal(filterVehicles(rows, 'all', '  ĐẠP ĐIỆN  ').length, 5)
  assert.deepEqual(filterVehicles(rows, 'all', ' V20 '), [rows[1]])
  assert.deepEqual(rows.map(canReserveVehicle), [false, true, false, false, false])
  assert.equal(vehicleSummary(rows).available, 2); assert.equal(vehicleStatus.IN_USE.label, 'Đang sử dụng')
  for (const route of ['#/vehicle', '#/overview/vehicle']) { assert.equal(resolveRoute(route, 'authenticated'), route); assert.equal(resolveRoute(route, 'unauthenticated'), '#/login') }
})

test('Vehicle domain conflict retains Auth; terminal error uses the existing session runtime', async () => {
  let code = 'ACTIVE_VEHICLE_RESERVATION_EXISTS'
  const user = { user_id: 'u', email: 'u@example.com', role: 'STUDENT' }
  const runtime = createAuthRuntime({ baseUrl: '', fetchImpl: async url => url === '/auth/me' ? response({ user }) : new Response(JSON.stringify({ ok: false, error: { code, fieldErrors: {} } }), { status: code === 'SESSION_EXPIRED' ? 401 : 409, headers: { 'Content-Type': 'application/json' } }) })
  await runtime.session.restore(); const api = createVehicleApi(runtime.http)
  await assert.rejects(api.mutate('v', 'reserve'), { code }); assert.equal(runtime.session.getSnapshot().status, 'authenticated')
  code = 'SESSION_EXPIRED'; await assert.rejects(api.own(), { code }); assert.equal(runtime.session.getSnapshot().status, 'unauthenticated')
})

test('Vehicle loader deduplicates overlapping polls, cancels Hub changes and cannot overwrite a mutation with late GET', async () => {
  const pending = [], published = [], errors = []
  const api = { list: id => { const d = deferred(); pending.push({ id, d }); return d.promise }, own: async () => [] }
  const loader = createVehicleLoader(api, { onData: d => published.push(d), onError: e => errors.push(e) })
  const old = loader.load('a'); assert.equal(loader.load('a'), old); assert.equal(pending.length, 1)
  const newer = loader.load('b'); pending[1].d.resolve({ vehicles: [], summary: vehicleSummary([]) }); assert.equal(await newer, true)
  pending[0].d.resolve({ vehicles: [rows[0]], summary: vehicleSummary([rows[0]]) }); assert.equal(await old, false); assert.equal(published.length, 1)
  const beforeMutation = loader.load('b'); loader.cancel(); published.push({ mutation: true })
  pending[2].d.resolve({ vehicles: [rows[0]] }); assert.equal(await beforeMutation, false); assert.deepEqual(published.at(-1), { mutation: true })
  const failed = loader.load('b'); pending[3].d.reject(new Error('offline')); await assert.rejects(failed, /offline/); assert.equal(errors.length, 1)
})

test('uncertain mutation is never automatically retried; reconciliation is GET-only', async () => {
  const methods = []
  const api = createVehicleApi(createHttpClient({ baseUrl: '', fetchImpl: async (url, options) => {
    methods.push(options.method)
    if (options.method === 'POST') throw new TypeError('lost response after commit')
    return url === '/vehicle-reservations' ? response({ reservations: [own] }) : response({ vehicles: rows, summary: vehicleSummary(rows) })
  } }))
  await assert.rejects(api.mutate('mine', 'pickup'), { code: 'NETWORK_ERROR' }); await api.list(); await api.own()
  assert.deepEqual(methods, ['POST', 'GET', 'GET'])
})

test('a failed Vehicle read aborts its still-pending companion before a later session can be invalidated', async () => {
  let companionSignal
  const hold = deferred()
  const loader = createVehicleLoader({ list: async () => { throw new Error('read failed') }, own: ({ signal }) => { companionSignal = signal; return hold.promise } }, { onData: () => assert.fail('failed batch published'), onError: () => {} })
  await assert.rejects(loader.load('h'), /read failed/)
  assert.equal(companionSignal.aborted, true)
  hold.resolve([])
})
