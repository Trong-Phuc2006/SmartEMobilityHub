import { ApiError } from './http.js'

const states = ['AVAILABLE', 'RESERVED', 'OCCUPIED']
const integer = (value) => Number.isSafeInteger(value) && value >= 0
function hubDto(hub) {
  if (!hub || typeof hub.hub_id !== 'string' || typeof hub.name !== 'string' ||
    !(hub.location_type === null || typeof hub.location_type === 'string') || !integer(hub.total_parking_capacity)) {
    throw new ApiError('UNEXPECTED_RESPONSE', { kind: 'protocol' })
  }
  const { hub_id, name, location_type, total_parking_capacity } = hub
  return { hub_id, name, location_type, total_parking_capacity }
}

function parkingDto(data, hubId) {
  const hub = hubDto(data?.hub)
  const summary = data.summary
  if (hub.hub_id !== hubId || !Array.isArray(data.spaces) || !summary ||
    !['total_spaces', 'available', 'reserved', 'occupied'].every((key) => integer(summary[key])) ||
    summary.total_spaces !== summary.available + summary.reserved + summary.occupied ||
    summary.total_spaces !== data.spaces.length) throw new ApiError('UNEXPECTED_RESPONSE')
  const seen = new Set()
  const counts = { AVAILABLE: 0, RESERVED: 0, OCCUPIED: 0 }
  const spaces = data.spaces.map((row) => {
    if (!row || typeof row.space_id !== 'string' || seen.has(row.space_id) || row.hub_id !== hubId ||
      !states.includes(row.state) || typeof row.has_current_reservation !== 'boolean' || typeof row.is_mine !== 'boolean' ||
      (row.is_mine && !row.has_current_reservation) ||
      (row.state === 'AVAILABLE' && (row.has_current_reservation || row.is_mine))) throw new ApiError('UNEXPECTED_RESPONSE')
    seen.add(row.space_id)
    counts[row.state]++
    const { space_id, hub_id, state, has_current_reservation, is_mine } = row
    return { space_id, hub_id, state, has_current_reservation, is_mine }
  })
  if (states.some((state) => counts[state] !== summary[state.toLowerCase()])) throw new ApiError('UNEXPECTED_RESPONSE')
  return { hub, summary: Object.fromEntries(['total_spaces', 'available', 'reserved', 'occupied'].map((key) => [key, summary[key]])), spaces }
}

export function createParkingApi(http) {
  return {
    async hubs(options) {
      const { data, status } = await http.request('/hubs', options)
      if (status !== 200 || !Array.isArray(data.hubs)) throw new ApiError('UNEXPECTED_RESPONSE')
      return data.hubs.map(hubDto)
    },
    async reservations(options) {
      const { data, status } = await http.request('/parking-reservations', options)
      if (status !== 200) throw new ApiError('UNEXPECTED_RESPONSE')
      return reservationsDto(data.reservations)
    },
    async mutate(hubId, spaceId, action, options = {}) {
      if (!['reserve', 'arrive', 'release'].includes(action)) throw new TypeError('Unknown Parking operation')
      const { data, status } = await http.request('/hubs/' + encodeURIComponent(hubId) + '/parking-spaces/' + encodeURIComponent(spaceId) + '/' + action,
        { ...options, method: 'POST', body: {} })
      if (status !== (action === 'reserve' ? 201 : 200)) throw new ApiError('UNEXPECTED_RESPONSE')
      return { parking: parkingDto(data.parking, hubId), reservations: reservationsDto(data.reservations) }
    },
    async spaces(hubId, options) {
      const { data, status } = await http.request('/hubs/' + encodeURIComponent(hubId) + '/parking-spaces', options)
      if (status !== 200) throw new ApiError('UNEXPECTED_RESPONSE')
      return parkingDto(data, hubId)
    },
  }
}

export const parkingStatus = {
  AVAILABLE: { label: 'Còn trống', className: 'em-badge-available' },
  RESERVED: { label: 'Đã đặt', className: 'em-badge-reserved' },
  OCCUPIED: { label: 'Đang sử dụng', className: 'em-badge-occupied' },
}

export function ownershipLabel(space) {
  if (space.state === 'AVAILABLE') return '—'
  return space.is_mine ? 'Của bạn' : space.has_current_reservation ? 'Người dùng khác' : 'Chưa có thông tin'
}

export function filterSpaces(spaces, filter, search) {
  const term = search.trim().toLowerCase()
  return spaces.filter((space) => (filter === 'all' || (filter === 'available' ? space.state === 'AVAILABLE' : space.is_mine)) &&
    space.space_id.toLowerCase().includes(term))
}

export function parkingErrorMessage(error) {
  return ({
    SPACE_UNAVAILABLE: 'Chỗ đỗ vừa được người khác đặt. Hãy tải lại trạng thái.',
    ACTIVE_RESERVATION_EXISTS: 'Bạn đang giữ một chỗ đỗ tại một Hub. Hãy trả chỗ trước khi đặt mới.',
    PARKING_NOT_OWNED: 'Bạn chỉ có thể quản lý chỗ đỗ của mình.',
    INVALID_PARKING_TRANSITION: 'Trạng thái đã thay đổi. Hãy tải lại trước khi thao tác tiếp.',
    SPACE_NOT_FOUND: 'Chỗ đỗ không còn khả dụng. Hãy tải lại trạng thái.',
    HUB_NOT_FOUND: 'Hub này không còn khả dụng. Vui lòng tải lại danh sách Hub.',
    DATA_INTEGRITY_ERROR: 'Dữ liệu bãi đỗ xe chưa nhất quán. Vui lòng thử lại sau.',
    NETWORK_ERROR: 'Không thể kết nối máy chủ. Vui lòng kiểm tra kết nối và thử lại.',
    SERVICE_UNAVAILABLE: 'Dịch vụ tạm thời bận. Vui lòng thử lại.',
  })[error?.code] || 'Chưa thể tải dữ liệu bãi đỗ xe. Vui lòng thử lại.'
}

function reservationsDto(rows) {
  if (!Array.isArray(rows)) throw new ApiError('UNEXPECTED_RESPONSE')
  const seen = new Set()
  return rows.map((row) => {
    if (!row || !['space_id', 'hub_id', 'hub_name'].every(key => typeof row[key] === 'string') ||
      !['RESERVED', 'OCCUPIED'].includes(row.state) || seen.has(row.space_id)) throw new ApiError('UNEXPECTED_RESPONSE')
    seen.add(row.space_id)
    const { space_id, hub_id, hub_name, state } = row
    return { space_id, hub_id, hub_name, state }
  })
}
