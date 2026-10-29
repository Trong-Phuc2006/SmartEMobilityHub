import { ApiError } from './http.js'

export const vehicleStatus = {
  AVAILABLE: { label: 'Khả dụng', className: 'em-badge-available' },
  RESERVED: { label: 'Đã đặt', className: 'em-badge-reserved' },
  IN_USE: { label: 'Đang sử dụng', className: 'em-badge-in_use' },
  UNAVAILABLE: { label: 'Không khả dụng', className: 'em-badge-maintenance' },
}
const invalid = () => { throw new ApiError('UNEXPECTED_RESPONSE', { kind: 'protocol' }) }
export function vehicleDto(row) {
  if (!row || typeof row.vehicle_id !== 'string' || !row.vehicle_id || typeof row.type !== 'string' ||
    !Number.isInteger(row.battery_level) || row.battery_level < 0 || row.battery_level > 100 || !Object.hasOwn(vehicleStatus, row.state) ||
    typeof row.has_current_reservation !== 'boolean' || typeof row.is_mine !== 'boolean') invalid()
  const open = row.state === 'RESERVED' || row.state === 'IN_USE'
  if (open !== row.has_current_reservation || (row.is_mine && !open) ||
    (row.state === 'IN_USE' ? row.hub_id !== null || row.hub_name !== null : typeof row.hub_id !== 'string' || typeof row.hub_name !== 'string')) invalid()
  const { vehicle_id, type, battery_level, state, hub_id, hub_name, has_current_reservation, is_mine } = row
  return { vehicle_id, type, battery_level, state, hub_id, hub_name, has_current_reservation, is_mine }
}
function unique(rows, project) {
  if (!Array.isArray(rows)) invalid()
  const seen = new Set()
  return rows.map(row => {
    const value = project(row)
    if (seen.has(value.vehicle_id)) invalid()
    seen.add(value.vehicle_id)
    return value
  })
}
export function ownVehiclesDto(rows) {
  return unique(rows, row => {
    const vehicle = vehicleDto(row)
    if (!vehicle.is_mine || row.reservation_state !== (vehicle.state === 'RESERVED' ? 'RESERVED' : 'ACTIVE')) invalid()
    return { ...vehicle, reservation_state: row.reservation_state }
  })
}
export function vehicleSummary(rows) {
  const summary = { total_vehicles: rows.length, available: 0, reserved: 0, in_use: 0, unavailable: 0 }
  rows.forEach(row => { summary[row.state.toLowerCase()]++ })
  return summary
}
export function createVehicleApi(http) {
  return {
    async list(hubId, options) {
      const { data, status } = await http.request('/vehicles' + (hubId === undefined ? '' : '?hub_id=' + encodeURIComponent(hubId)), options)
      if (status !== 200) invalid()
      const vehicles = unique(data.vehicles, vehicleDto)
      if (hubId !== undefined && vehicles.some(v => v.hub_id !== hubId)) invalid()
      const expected = vehicleSummary(vehicles)
      if (!data.summary || Object.keys(expected).some(k => data.summary[k] !== expected[k])) invalid()
      return { vehicles, summary: expected }
    },
    async own(options) {
      const { data, status } = await http.request('/vehicle-reservations', options)
      if (status !== 200) invalid()
      return ownVehiclesDto(data.reservations)
    },
    async mutate(id, action, body = {}, options = {}) {
      if (!['reserve', 'pickup', 'return', 'cancel'].includes(action)) throw new TypeError('Unknown Vehicle operation')
      const payload = action === 'return' ? { hub_id: body.hub_id, battery_level: body.battery_level } : {}
      const { data, status } = await http.request('/vehicles/' + encodeURIComponent(id) + '/' + action, { ...options, method: 'POST', body: payload })
      if (status !== (action === 'reserve' ? 201 : 200)) invalid()
      const vehicle = vehicleDto(data.vehicle), reservations = ownVehiclesDto(data.reservations)
      const next = { reserve: 'RESERVED', pickup: 'IN_USE', return: 'AVAILABLE', cancel: 'AVAILABLE' }[action]
      if (vehicle.vehicle_id !== id || vehicle.state !== next ||
        (['reserve', 'pickup'].includes(action) ? !vehicle.is_mine || !reservations.some(v => v.vehicle_id === id && v.state === next)
          : reservations.some(v => v.vehicle_id === id)) ||
        (action === 'return' && (vehicle.hub_id !== body.hub_id || vehicle.battery_level !== body.battery_level))) invalid()
      return { vehicle, reservations }
    },
  }
}
export const canReserveVehicle = vehicle => vehicle.state === 'AVAILABLE' && vehicle.battery_level >= 20
export const vehicleOwnerLabel = v => v.is_mine ? 'Của bạn' : v.has_current_reservation ? 'Người dùng khác' : '—'
export function filterVehicles(rows, filter, search) {
  const term = search.trim().toLocaleLowerCase('vi')
  return rows.filter(v => (filter === 'all' || (filter === 'available' ? v.state === 'AVAILABLE' : v.is_mine)) &&
    `${v.vehicle_id} ${v.type}`.toLocaleLowerCase('vi').includes(term))
}
export function vehicleErrorMessage(error) {
  return ({
    VEHICLE_UNAVAILABLE: 'Phương tiện vừa được người khác đặt hoặc không còn khả dụng.',
    BATTERY_TOO_LOW: 'Pin dưới 20%, chưa thể đặt xe.',
    ACTIVE_VEHICLE_RESERVATION_EXISTS: 'Bạn đang giữ một phương tiện. Hãy kết thúc lượt thuê trước.',
    VEHICLE_NOT_OWNED: 'Bạn chỉ có thể quản lý phương tiện của mình.',
    INVALID_VEHICLE_TRANSITION: 'Trạng thái đã thay đổi. Hãy tải lại trước khi tiếp tục.',
    VEHICLE_NOT_FOUND: 'Không tìm thấy phương tiện. Hãy tải lại danh sách.',
    HUB_NOT_FOUND: 'Hub không còn khả dụng. Hãy tải lại danh sách Hub.',
    DATA_INTEGRITY_ERROR: 'Dữ liệu phương tiện chưa nhất quán. Vui lòng thử lại sau.',
    VALIDATION_ERROR: 'Vui lòng kiểm tra Hub trả xe và mức pin (số nguyên 0–100).',
    NETWORK_ERROR: 'Không thể kết nối máy chủ. Vui lòng thử lại.',
    SERVICE_UNAVAILABLE: 'Dịch vụ tạm thời bận. Vui lòng thử lại.',
    UNEXPECTED_RESPONSE: 'Máy chủ phản hồi không hợp lệ. Hãy tải lại trạng thái.',
  })[error?.code] || 'Chưa thể xử lý phương tiện. Vui lòng thử lại.'
}

// View request coordinator, not a second session store. A mutation/scope change
// cancels the generation before publication, even if fetch ignores abort.
export function createVehicleLoader(api, { onData, onError }) {
  let generation = 0, active
  function cancel() { generation++; active?.controller.abort(); active = undefined }
  function load(hubId, { replace = false } = {}) {
    if (active && !replace && active.hubId === hubId) return active.promise
    cancel()
    const current = generation, controller = new AbortController()
    const promise = Promise.all([api.list(hubId, { signal: controller.signal }), api.own({ signal: controller.signal })])
      .then(([data, reservations]) => {
        if (generation !== current || controller.signal.aborted) return false
        onData({ ...data, reservations }); return true
      }).catch(error => {
        if (generation !== current || controller.signal.aborted) return false
        // Promise.all rejects before a slow companion request settles. Abort it
        // too, so a late Auth response cannot outlive this failed view refresh.
        onError(error); controller.abort(); throw error
      }).finally(() => { if (active?.generation === current) active = undefined })
    active = { hubId, controller, generation: current, promise }
    return promise
  }
  return { load, cancel }
}
